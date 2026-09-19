import { query, type CanUseTool, type PermissionResult, type PermissionUpdate, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PendingRequestBody, ProviderEvent, QuestionSpec, Resolution } from '@agentdeck/shared';
import { createNormalizer } from './normalize';

export type ClaudeSession = {
  send(text: string): void;
  close(): void;
};

type StartOptions = {
  cwd: string;
  onEvent(event: ProviderEvent): void;
  /** 审批 / 提问：等用户在某个设备上处理；signal 触发（如 turn 被中断）时 resolve 为 null */
  onPending(body: PendingRequestBody, signal: AbortSignal): Promise<Resolution | null>;
  /** 子进程结束（正常关闭或抛错）后调用一次 */
  onExit(error?: unknown): void;
};

// 一个 Streaming Input 长驻 session（方案 §6.1）。消息通过 inbox 推入，SDK 消息经 normalizer 转成统一事件回调出去。
export function startClaudeSession({ cwd, onEvent, onPending, onExit }: StartOptions): ClaudeSession {
  const inbox = createInbox();
  const normalize = createNormalizer();

  // 审批与 AskUserQuestion 都从这里进来（方案 §6.4）；AskUserQuestion 的回答通过 updatedInput.answers 交还
  const canUseTool: CanUseTool = async (toolName, input, { signal, suggestions = [], toolUseID, title, description, decisionReason }) => {
    if (toolName === 'AskUserQuestion') {
      const questions = input.questions as QuestionSpec[];
      const r = await onPending({ kind: 'question', toolUseId: toolUseID, questions }, signal);
      if (r?.kind !== 'question') return deny();
      const answers = Object.fromEntries(Object.entries(r.answers).map(([q, labels]) => [q, labels.join(', ')]));
      return { behavior: 'allow', updatedInput: { questions, answers, ...(r.response ? { response: r.response } : {}) } };
    }
    const r = await onPending(
      { kind: 'approval', toolName, toolUseId: toolUseID, input, title, description, decisionReason, sessionAllowPatterns: describeRules(suggestions), suggestions },
      signal,
    );
    if (r?.kind !== 'approval' || r.decision === 'deny') return deny();
    return {
      behavior: 'allow',
      updatedInput: input,
      // "本会话允许"只写 session 级规则，不落到本机 settings 文件
      ...(r.decision === 'allow_session' ? { updatedPermissions: suggestions.map((s) => ({ ...s, destination: 'session' as const })) } : {}),
    };
  };

  const q = query({
    prompt: inbox,
    options: {
      cwd,
      env: childEnv(),
      permissionMode: 'default',
      includePartialMessages: true,
      // 只加载工作区的 project 设置：本机 user 设置是 bypassPermissions，会让审批静默通过（AGENTS.md 规则 2）
      settingSources: ['project'],
      canUseTool,
    },
  });

  (async () => {
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init' && m.permissionMode !== 'default') {
          onEvent({ type: 'error', payload: { message: `工作区 settings 把 permissionMode 改成了 ${m.permissionMode}，Hub 只接受 default，已拒绝启动` } });
          inbox.close();
          return;
        }
        for (const e of normalize(m)) onEvent(e);
      }
      onExit();
    } catch (err) {
      onExit(err);
    }
  })();

  return {
    send(text) {
      inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    },
    close() {
      inbox.close();
    },
  };
}

const deny = (): PermissionResult => ({ behavior: 'deny', message: '用户在 AgentDeck 中拒绝了此操作' });

// 把 Provider 建议的规则压成 UI 可读的 pattern，例如 Bash(git status:*)
function describeRules(suggestions: PermissionUpdate[]): string[] {
  return suggestions.flatMap((s) =>
    s.type === 'addRules' || s.type === 'replaceRules'
      ? s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
      : [],
  );
}

// 子进程环境：去掉 CLAUDE* 避免被识别为嵌套 Claude Code 会话；去掉 API Key，复用本机 claude.ai 登录（AGENTS.md 规则 4）
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^CLAUDE/.test(k) && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  }
  return env;
}

// 可从外部 push 的 AsyncIterable，SDK 在这个流上等待下一条用户消息
function createInbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(m: SDKUserMessage) {
      queue.push(m);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}
