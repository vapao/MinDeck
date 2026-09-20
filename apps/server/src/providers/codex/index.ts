import type { ApprovalDecision, QuestionSpec, Resolution } from '@agentdeck/shared';
import type { ProviderSession, StartOptions } from '../types';
import { RpcError, spawnAppServer, type AppServerRpc } from './rpc';
import { createNormalizer, stripShellWrapper } from './normalize';
import type { ServerNotification, ServerRequest } from './schema';
import type { ThreadStartResponse, TurnStartResponse, UserInput } from './schema/v2';

// 一个 Hub 进程只维持一个 app-server（方案 §5.1），多个 thread 共用；通知与服务端请求按 threadId 分发到各会话。

type ThreadHandler = {
  onNotification(n: ServerNotification): void;
  onRequest(r: ServerRequest): Promise<unknown>;
  onExit(error?: unknown): void;
};

let shared: { rpc: AppServerRpc; ready: Promise<void>; threads: Map<string, ThreadHandler> } | null = null;

function appServer() {
  if (shared) return shared;
  const threads = new Map<string, ThreadHandler>();
  const threadIdOf = (params: unknown) => (params as { threadId?: string } | undefined)?.threadId;
  const rpc = spawnAppServer({
    onNotification(n) {
      // 额度是账号级通知，没有 threadId：广播给所有会话，各自的 normalizer 去重
      if (n.method === 'account/rateLimits/updated') {
        for (const t of threads.values()) t.onNotification(n);
        return;
      }
      const t = threads.get(threadIdOf(n.params) ?? '');
      t?.onNotification(n);
    },
    async onRequest(r) {
      const t = threads.get(threadIdOf(r.params) ?? '');
      if (!t) throw new RpcError(-32001, 'Thread does not belong to any AgentDeck session');
      return t.onRequest(r);
    },
    onExit(error) {
      shared = null;
      for (const t of threads.values()) t.onExit(error);
      threads.clear();
    },
  });
  const ready = rpc
    .request('initialize', { clientInfo: { name: 'agentdeck', title: 'AgentDeck', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    .then(() => rpc.notify('initialized', {}));
  shared = { rpc, ready, threads };
  return shared;
}

/** Hub 关闭时结束共享的 app-server；没启动过就什么都不做 */
export function shutdownCodex() {
  shared?.rpc.kill();
}

export function startCodexSession({ cwd, resume, model, effort, permissionMode, onEvent, onPending, onExit }: StartOptions): ProviderSession {
  const { rpc, ready, threads } = appServer();
  const { normalize } = createNormalizer();
  let threadId: string | null = null;
  let turnId: string | null = null;
  // 每轮一个 controller：interrupt 时触发，让 Hub 作废本轮还在等的审批
  let abort = new AbortController();

  const handler: ThreadHandler = {
    onNotification(n) {
      if (n.method === 'turn/completed') turnId = null;
      for (const e of normalize(n)) onEvent(e);
    },
    async onRequest(r) {
      switch (r.method) {
        case 'item/commandExecution/requestApproval': {
          // availableDecisions 是实际回包里有、schema 未声明的字段：只有它给了 acceptForSession 才提供"本会话允许"
          const p = r.params as typeof r.params & { availableDecisions?: unknown[] };
          const forSession = p.availableDecisions?.includes('acceptForSession') ?? false;
          const command = stripShellWrapper(p.command ?? '');
          const res = await onPending(
            { kind: 'approval', toolName: 'shell', toolUseId: p.itemId, input: { command, cwd: p.cwd }, description: p.reason ?? undefined, sessionAllowPatterns: forSession ? [command] : [], suggestions: [] },
            abort.signal,
          );
          return { decision: res === null ? 'cancel' : commandDecision(res, forSession) };
        }
        case 'item/fileChange/requestApproval': {
          const p = r.params;
          const res = await onPending(
            { kind: 'approval', toolName: 'apply_patch', toolUseId: p.itemId, input: { grantRoot: p.grantRoot ?? null }, description: p.reason ?? undefined, sessionAllowPatterns: ['apply_patch'], suggestions: [] },
            abort.signal,
          );
          return { decision: res === null ? 'cancel' : commandDecision(res, true) };
        }
        case 'item/tool/requestUserInput': {
          // Codex 按问题 id 收答案，Hub 的 QuestionAnswers 按问题文本；这里做双向映射。Codex 的问题都是单选，"其它"自由文本走 response
          const questions: QuestionSpec[] = r.params.questions.map((q) => ({ question: q.question, header: q.header, multiSelect: false, options: q.options ?? [] }));
          const res = await onPending({ kind: 'question', toolUseId: r.params.itemId, questions }, abort.signal);
          if (res?.kind !== 'question') throw new RpcError(-32000, 'The user did not answer');
          const answers = Object.fromEntries(
            r.params.questions.map((q) => [q.id, { answers: res.answers[q.question]?.length ? res.answers[q.question] : res.response ? [res.response] : [] }]),
          );
          return { answers };
        }
        default:
          // 其余服务端请求（MCP elicitation、动态工具等）一律按不支持回复，Codex 会把该调用当失败继续
          throw new RpcError(-32601, `AgentDeck does not support ${r.method}`);
      }
    },
    onExit,
  };

  // 本机 ~/.codex/config.toml 是 approval_policy=never + danger-full-access（AGENTS.md 规则 10）：thread 级显式覆盖，并校验回包。
  // bypass 是会话级选了"完全跳过审批"时才用，等价本机那份危险配置，风险自负（AgentDeck 设置里配的）
  const bypass = permissionMode === 'bypass';
  const policy = {
    cwd,
    approvalPolicy: (bypass ? 'never' : 'on-request') as 'never' | 'on-request',
    sandbox: (bypass ? 'danger-full-access' : 'workspace-write') as 'danger-full-access' | 'workspace-write',
    approvalsReviewer: 'user' as const,
  };
  const expectedSandboxType = bypass ? 'dangerFullAccess' : 'workspaceWrite';
  const opened = ready.then(async () => {
    const res = (resume ? await rpc.request('thread/resume', { threadId: resume, ...policy }) : await rpc.request('thread/start', policy)) as ThreadStartResponse;
    if (res.approvalPolicy !== policy.approvalPolicy || res.sandbox.type !== expectedSandboxType) {
      throw new Error(`Codex did not accept the Hub approval policy (approvalPolicy=${JSON.stringify(res.approvalPolicy)}, sandbox=${res.sandbox.type}); refusing to start`);
    }
    threadId = res.thread.id;
    threads.set(threadId, handler);
    onEvent({ type: resume ? 'session.resumed' : 'session.started', payload: { providerSessionId: threadId, model: res.model } });
  });
  opened.catch((err) => onExit(err));

  return {
    send({ text, images }) {
      abort = new AbortController();
      // 图片已在本机磁盘，直接走 localImage（方案 §5.3）
      const input: UserInput[] = [
        ...(text ? [{ type: 'text' as const, text, text_elements: [] }] : []),
        ...images.map((img) => ({ type: 'localImage' as const, path: img.path })),
      ];
      opened
        .then(
          async () => {
            // model / effort 是"本轮及之后"的覆盖，每轮都带上保证 resume 后也一致
            const res = (await rpc.request('turn/start', { threadId: threadId!, input, model, effort })) as TurnStartResponse;
            turnId = res.turn.id;
          },
          () => {}, // thread 没开起来已经走了 onExit，不再重复报
        )
        .catch((err: Error) => onEvent({ type: 'turn.failed', payload: { message: `Codex refused to start the turn: ${err.message}` } }));
    },
    async interrupt() {
      if (!threadId || !turnId) return;
      abort.abort();
      await rpc.request('turn/interrupt', { threadId, turnId });
    },
    close() {
      if (threadId) threads.delete(threadId);
    },
  };
}

function commandDecision(res: Resolution, forSession: boolean): 'accept' | 'acceptForSession' | 'decline' {
  const d: ApprovalDecision = res.kind === 'approval' ? res.decision : 'deny';
  if (d === 'deny') return 'decline';
  return d === 'allow_session' && forSession ? 'acceptForSession' : 'accept';
}
