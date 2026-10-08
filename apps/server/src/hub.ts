import { generateTitle } from './providers/title';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getEffortOptions, isCompactCommand, modelOptions, permissionModeOptions, type AgentEvent, type Attachment, type MessageDelta, type PendingRequest, type PendingRequestBody, type PermissionMode, type ProviderEvent, type ProviderOutput, type Resolution, type Session, type SessionStatus, type Settings, type UpdateSettingsBody, type UsageInfo } from '@agentdeck/shared';
import type { Store } from './store/db';
import type { AttachmentStore } from './store/attachments';
import type { AgentdeckMcp, ProviderSession, StartOptions } from './providers/types';
import { forkClaudeSession, startClaudeSession } from './providers/claude';
import { forkCodexThread, shutdownCodex, startCodexSession } from './providers/codex';

const providers: Record<Session['provider'], (o: StartOptions) => ProviderSession> = { claude: startClaudeSession, codex: startCodexSession, deepseek: startClaudeSession };
/** 从 anchor 分叉出新的 Provider 会话，返回其 id；原会话记录不动 */
const forks: Record<Session['provider'], (providerSessionId: string, anchor: string, cwd: string) => Promise<string>> = { claude: forkClaudeSession, codex: forkCodexThread, deepseek: forkClaudeSession };

export class HubError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function workspacePath(path: string): string {
  try { return realpathSync(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw err;
  }
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

// Hub：Session 元数据 + append-only 事件流 + 多端 fan-out。Provider 会话在首条消息时才拉起。
export function createHub(store: Store, attachments: AttachmentStore, mcpFor: (sessionId: string) => AgentdeckMcp) {
  const live = new Map<string, ProviderSession>();
  /** 订阅者收到的是落库后的事件（带 seq）或不落库的流式片段 */
  type LiveMessage = { type: 'event'; event: AgentEvent } | MessageDelta;
  const listeners = new Map<string, Set<(m: LiveMessage) => void>>();
  // 会话被删除时通知仍订阅着它的客户端（没有事件可落库，单独一路回调）
  const deletedListeners = new Map<string, Set<() => void>>();
  // 正在等用户处理的 Provider 回调；Hub 重启后这些 Promise 不复存在，对应的行在启动时作废
  const waiting = new Map<string, (r: Resolution | null) => void>();
  // 账号级额度，按 rateLimitType 保留最新值，GET /api/usage 直接返回
  const usage: Record<string, UsageInfo> = {};
  const titleJobs = new Map<string, AbortController>();
  // 子会话结束后回调父会话（MCP notify）：子会话 id → 父会话 id → 登记时子会话的 lastSeq。一次性，只在内存里，Hub 重启即丢
  const watchers = new Map<string, Map<string, number>>();
  // 父会话在用户没插话的情况下被自动回调唤醒的次数：两个 Agent 可能互相派活、来回唤醒，bypass 下没人拦
  const autoWakes = new Map<string, number>();
  const maxAutoWakes = 5;
  // 用户在派生审批卡上选了"本会话允许"的会话：之后 create_session 免审批，用于用户离开时让监督会话自主派活。只在内存，Hub 重启即丢
  const spawnGrants = new Set<string>();
  // 各会话 Agent 自己起的后台任务数：Hub 重启时子进程连同后台任务一起没了，所以只放内存
  const background = new Map<string, number>();
  const repositoryWrites = new Map<string, string>();
  const writeBlocked = (cwd: string) => [...repositoryWrites].find(([root]) => overlaps(root, workspacePath(cwd)))?.[1];
  function repositoryBusyReason(root: string): string | undefined {
    if (writeBlocked(root)) return 'A file operation is already in progress';
    return store.listSessions().some((s) => (s.status === 'running' || s.status === 'waiting_user' || (background.get(s.id) ?? 0) > 0) && overlaps(workspacePath(root), workspacePath(s.cwd)))
      ? 'Wait for all tasks in this workspace to finish before changing files' : undefined;
  }
  // 有派生授权的会话本来就是要无人值守地派活、收结果，5 次不够；仍留上限防两个 Agent 失控互相唤醒
  const maxGrantedAutoWakes = 30;
  let closing = false;

  store.expireAllPending();
  // 上次 Hub 退出时还在跑的 turn 已随子进程消失（方案 §12.2）：记一条中断，让会话回到可继续的状态
  for (const s of store.listSessions()) {
    if (s.status === 'running' || s.status === 'waiting_user') {
      store.appendEvent(s.id, { type: 'turn.completed', payload: { reason: 'interrupted', durationMs: 0, costUsd: 0 } });
      store.setSessionStatus(s.id, 'idle');
      store.appendEvent(s.id, { type: 'session.status', payload: { status: 'idle' } });
    }
  }

  function emit(sessionId: string, event: ProviderEvent): AgentEvent {
    const stored = store.appendEvent(sessionId, event);
    for (const fn of listeners.get(sessionId) ?? []) fn({ type: 'event', event: stored });
    return stored;
  }

  // 流式片段只广播不落库：message.completed 会带全文，存 delta 只会把库和回放撑大
  function broadcast(sessionId: string, output: ProviderEvent | MessageDelta) {
    if (output.type !== 'message.delta') return emit(sessionId, output);
    for (const fn of listeners.get(sessionId) ?? []) fn(output);
  }

  function setStatus(sessionId: string, status: SessionStatus) {
    store.setSessionStatus(sessionId, status);
    emit(sessionId, { type: 'session.status', payload: { status } });
    // 插入的追加指令处理完才算结束（Provider 只在那时报 turn 结束）；waiting_user 不回调：父会话代批不了，靠用户自己处理
    if (status === 'idle' || status === 'error') notifyWatchers(sessionId, status);
  }

  function notifyWatchers(childId: string, status: 'idle' | 'error') {
    const parents = watchers.get(childId);
    if (!parents) return;
    if ([...parents.keys()].some((id) => { const parent = store.getSession(id); return parent && writeBlocked(parent.cwd); })) return;
    watchers.delete(childId);
    const child = getSession(childId);
    for (const [parentId, sinceSeq] of parents) {
      if (!store.getSession(parentId)) continue;
      const wakes = autoWakes.get(parentId) ?? 0;
      const limit = spawnGrants.has(parentId) ? maxGrantedAutoWakes : maxAutoWakes;
      if (wakes >= limit) {
        emit(parentId, { type: 'error', payload: { message: `Skipped the result of session ${childId}: ${limit} automatic wake-ups in a row without your input. Send a message to continue.` } });
        continue;
      }
      autoWakes.set(parentId, wakes + 1);
      const events = store.eventsAfter(childId, sinceSeq);
      const reply = events.findLast((e) => e.type === 'message.completed')?.payload.text;
      const interrupted = events.some((e) => e.type === 'turn.completed' && e.payload.reason === 'interrupted');
      const outcome = status === 'error' ? 'failed' : interrupted ? 'was interrupted' : 'finished';
      const text = [
        `[AgentDeck] Session ${childId} (${child.provider}${child.title ? `, "${child.title}"` : ''}) ${outcome}.`,
        reply ? `Last reply:\n${reply}` : 'No reply.',
        `Use get_session with afterSeq ${sinceSeq} for details.`,
      ].join('\n\n');
      sendMessage(parentId, text, [], 'agent');
    }
  }

  const emptyDefaults: Settings = { titles: { enabled: false, provider: 'claude', model: 'claude-haiku-4-5' }, claude: { model: '', effort: '', permissionMode: 'approval' }, codex: { model: '', effort: '', permissionMode: 'approval' }, deepseek: { model: 'deepseek-flash', effort: '', permissionMode: 'approval', baseUrl: 'https://api.deepseek.com/anthropic', apiKeyConfigured: false } };
  function settings(): Settings {
    const stored = store.getSettings();
    // 补 permissionMode 这种后加的字段：旧库存的 JSON 里没有，兜底成安全默认值，不然老装置升级后直接 undefined
    return {
      titles: { ...emptyDefaults.titles, ...stored?.titles },
      claude: { ...emptyDefaults.claude, ...stored?.claude },
      codex: { ...emptyDefaults.codex, ...stored?.codex },
      deepseek: { ...emptyDefaults.deepseek, ...stored?.deepseek, apiKeyConfigured: !!store.getDeepseekApiKey() },
    };
  }

  function getSession(id: string): Session {
    const session = store.getSession(id);
    if (!session) throw new HubError(404, 'Session not found');
    return session;
  }

  const withBackground = (session: Session): Session => ({ ...session, backgroundTasks: background.get(session.id) ?? 0 });

  function requestedEvent(request: PendingRequest): ProviderEvent {
    return request.kind === 'approval'
      ? { type: 'approval.requested', payload: { request } }
      : { type: 'user_input.requested', payload: { request } };
  }

  function resolvedEvent(request: PendingRequest, resolution: Resolution | null): ProviderEvent {
    if (request.kind === 'approval') {
      return { type: 'approval.resolved', payload: { requestId: request.id, decision: resolution?.kind === 'approval' ? resolution.decision : 'expired' } };
    }
    const r = resolution?.kind === 'question' ? resolution : null;
    return { type: 'user_input.resolved', payload: { requestId: request.id, answers: r?.answers ?? null, ...(r?.response ? { response: r.response } : {}) } };
  }

  // 先落库再广播（方案 §10.1），然后挂起等待某个设备 resolve
  function createPending(sessionId: string, body: PendingRequestBody, signal: AbortSignal): Promise<Resolution | null> {
    if (signal.aborted) return Promise.resolve(null);
    const request: PendingRequest = { ...body, id: randomUUID(), sessionId, status: 'pending', createdAt: new Date().toISOString(), resolvedAt: null };
    store.createPending(request);
    emit(sessionId, requestedEvent(request));
    if (body.kind !== 'question' || body.delivery !== 'async') setStatus(sessionId, 'waiting_user');
    return new Promise((resolve) => {
      const expire = () => settle(request.id, null);
      waiting.set(request.id, (resolution) => {
        signal.removeEventListener('abort', expire);
        resolve(resolution);
      });
      // turn 被中断等情况下 Provider 会放弃这次请求：作废并通知各端
      signal.addEventListener('abort', expire, { once: true });
    });
  }

  /** 原子 resolve：只有第一个到达的处理生效，其余返回 false（"已在别处处理"） */
  function settle(requestId: string, resolution: Resolution | null): boolean {
    const request = store.getPending(requestId);
    if (!request) throw new HubError(404, 'Request not found');
    if (!store.resolvePending(requestId, resolution, resolution ? 'resolved' : 'expired')) return false;
    emit(request.sessionId, resolvedEvent(request, resolution));
    if (getSession(request.sessionId).status === 'waiting_user' &&
        !store.pendingBySession(request.sessionId).some((p) => p.kind !== 'question' || p.delivery !== 'async')) {
      setStatus(request.sessionId, 'running');
    }
    waiting.get(requestId)?.(resolution);
    waiting.delete(requestId);
    return true;
  }

  function ensureProvider(session: Session): ProviderSession {
    const existing = live.get(session.id);
    if (existing) return existing;
    const deepseek = session.provider === 'deepseek' ? { baseUrl: settings().deepseek.baseUrl, apiKey: store.getDeepseekApiKey() } : undefined;
    if (deepseek && !deepseek.apiKey) throw new HubError(400, '请先在设置中配置 DeepSeek API Key');
    const provider = providers[session.provider]({
      deepseek,
      cwd: session.cwd,
      resume: session.providerSessionId ?? undefined,
      model: session.model ?? undefined,
      effort: session.effort ?? undefined,
      permissionMode: session.permissionMode,
      agentdeckMcp: mcpFor(session.id),
      onPending: (body, signal) => createPending(session.id, body, signal),
      onEvent(event) {
        // 会话已被删除：Provider 收尾时可能还有零星消息，直接丢弃，不能再往已删的 session 写
        if (!store.getSession(session.id)) return;
        if (event.type === 'session.started') store.setProviderSessionId(session.id, event.payload.providerSessionId);
        if (event.type === 'usage.updated') usage[event.payload.rateLimitType] = event.payload;
        if (event.type === 'background.changed') {
          if (event.count) background.set(session.id, event.count);
          else background.delete(session.id);
          return;
        }
        // Provider 自己续上的一轮（后台任务结束后唤醒）要补回 running；Hub 发起的轮次 dispatch 时已记过，不重复
        if (event.type === 'turn.started') {
          const status = getSession(session.id).status;
          if (status === 'running' || status === 'waiting_user') return;
          broadcast(session.id, event);
          setStatus(session.id, 'running');
          return;
        }
        broadcast(session.id, event);
        if (event.type === 'turn.completed') setStatus(session.id, 'idle');
        if (event.type === 'turn.failed') setStatus(session.id, 'error');
        if (event.type === 'error') setStatus(session.id, 'error');
      },
      onExit(error) {
        live.delete(session.id);
        background.delete(session.id);
        if (error && !closing && store.getSession(session.id)) {
          emit(session.id, { type: 'error', payload: { message: `${session.provider} process exited: ${error instanceof Error ? error.message : String(error)}` } });
          setStatus(session.id, 'error');
        }
      },
    });
    live.set(session.id, provider);
    return provider;
  }

  function dispatch(sessionId: string, provider: ProviderSession, { text, files }: { text: string; files: Attachment[] }) {
    emit(sessionId, { type: 'turn.started', payload: {} });
    setStatus(sessionId, 'running');
    provider.send({ text, images: files.map((a) => ({ mimeType: a.mimeType, path: attachments.pathOf(a) })) });
  }

  // Provider 进程在首条消息时才惰性启动，之前会话配置只是几列
  const isEmptySession = (session: Session) => !session.providerSessionId && !live.has(session.id) && store.lastSeq(session.id) === 0;

  /** 空字符串 = 交给 Provider 默认，落库为 null；DeepSeek 没有 Provider 默认，回到 Flash */
  function normalizeModel(provider: Session['provider'], model: string): string | null {
    const value = model.trim() || (provider === 'deepseek' ? 'deepseek-flash' : null);
    if (value && !modelOptions[provider].some((o) => o.value === value)) throw new HubError(400, `${provider} does not support model ${value}`);
    return value;
  }

  /** origin 'user' 是用户从界面发的，会清零自动唤醒计数；'agent' 是 MCP send_message 或子会话回调 */
  function sendMessage(sessionId: string, text: string, attachmentIds: string[], origin: 'user' | 'agent' = 'user'): { seq: number; steered: boolean } {
    const session = getSession(sessionId);
    const fileOperation = writeBlocked(session.cwd);
    if (fileOperation) throw new HubError(409, `${fileOperation} in this workspace; try again when it finishes`);
    if (origin === 'user') autoWakes.delete(sessionId);
    let files;
    try {
      files = attachments.forMessage(sessionId, attachmentIds);
    } catch (err) {
      throw new HubError(400, (err as Error).message);
    }
    if (files.length && session.provider === 'deepseek' && session.model === 'deepseek-v4-pro') throw new HubError(400, 'DeepSeek Pro 不支持图片，请新建 Flash 会话');
    if (isCompactCommand(text)) {
      // 压缩是独占的一轮：插进进行中的轮次在两边都没有明确语义
      if (session.status === 'running' || session.status === 'waiting_user') throw new HubError(409, "Can't compact while a turn is running");
      if (isEmptySession(session)) throw new HubError(409, 'Nothing to compact yet');
      if (files.length) throw new HubError(400, "/compact doesn't take attachments");
      if (session.provider === 'codex' && text.trim() !== '/compact') throw new HubError(400, "Codex's /compact doesn't take instructions");
    }
    const provider = ensureProvider(session);
    // 从归档里点进来继续聊：一旦又活起来就得回到侧栏，否则会在看不见的地方跑
    if (session.archivedAt) store.setSessionArchivedAt(sessionId, null);
    const firstText = !!text.trim() && !store.hasUserText(sessionId);
    const { seq } = emit(sessionId, { type: 'message.user', payload: { text, attachments: files } });
    // 一轮进行中直接交给 Provider 插入当前轮，Agent 下一步就能看到，不等这一轮结束
    const steered = session.status === 'running' || session.status === 'waiting_user';
    if (steered) provider.send({ text, images: files.map((a) => ({ mimeType: a.mimeType, path: attachments.pathOf(a) })) });
    else dispatch(sessionId, provider, { text, files });
    const config = settings();
    if (firstText && config.titles.enabled) {
      const controller = new AbortController();
      titleJobs.set(sessionId, controller);
      const connection = config.titles.provider === 'deepseek' ? { baseUrl: config.deepseek.baseUrl, apiKey: store.getDeepseekApiKey() } : undefined;
      void generateTitle(config.titles, text, controller, connection).then(
        (title) => { if (!closing && !controller.signal.aborted) store.setSessionTitle(sessionId, title); },
        () => { if (!closing && !controller.signal.aborted) console.warn(`Title generation failed for session ${sessionId}; keeping message preview`); },
      ).finally(() => titleJobs.delete(sessionId));
    }
    return { seq, steered };
  }

  return {
    /** model / effort 省略时取设置里的默认值；空字符串 = 交给 Provider 默认，落库为 null。permissionMode 省略时也取默认值，没有"交给 Provider 默认"这一说 */
    createSession(provider: Session['provider'], cwd: string, override: { model?: string; effort?: string; permissionMode?: PermissionMode } = {}): Session {
      if (!(provider in providers)) throw new HubError(400, `Unknown provider ${provider}`);
      // cwd 只能是 UI 里添加过的工作区（方案 §11.3 allowlist）
      if (!store.getWorkspaceByPath(cwd)) throw new HubError(400, `cwd is not a registered workspace`);
      const defaults = settings()[provider];
      const model = normalizeModel(provider, override.model ?? defaults.model);
      const effort = (override.effort ?? defaults.effort).trim() || null;
      const permissionMode = override.permissionMode ?? defaults.permissionMode;
      if (effort && !getEffortOptions(provider, model).some((o) => o.value === effort)) throw new HubError(400, `${provider} model ${model ?? 'Default'} does not support effort ${effort}`);
      if (!permissionModeOptions.some((o) => o.value === permissionMode)) throw new HubError(400, `Unsupported permission mode ${permissionMode}`);
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), provider, cwd, providerSessionId: null, status: 'idle', title: null, model, effort, permissionMode, archivedAt: null, createdAt: now, updatedAt: now };
      store.createSession(session);
      return session;
    },

    settings,
    updateSettings(next: UpdateSettingsBody) {
      for (const provider of ['claude', 'codex', 'deepseek'] as const) {
        const model = next[provider].model.trim();
        const effort = next[provider].effort.trim();
        const permissionMode = next[provider].permissionMode;
        if (model && !modelOptions[provider].some((o) => o.value === model)) throw new HubError(400, `${provider} does not support model ${model}`);
        if (effort && !getEffortOptions(provider, model).some((o) => o.value === effort)) throw new HubError(400, `${provider} model ${model ?? 'Default'} does not support effort ${effort}`);
        if (!permissionModeOptions.some((o) => o.value === permissionMode)) throw new HubError(400, `Unsupported permission mode ${permissionMode}`);
      }
      const titles = next.titles ?? settings().titles;
      if (typeof titles.enabled !== 'boolean' || !Object.hasOwn(modelOptions, titles.provider) || !modelOptions[titles.provider].some((o) => o.value === titles.model)) throw new HubError(400, 'Invalid title provider or model');
      if (titles.enabled && titles.provider === 'deepseek' && !(next.deepseek.apiKey === undefined ? store.getDeepseekApiKey() : next.deepseek.apiKey.trim())) throw new HubError(400, '请先配置 DeepSeek API Key');
      const baseUrl = next.deepseek.baseUrl.trim().replace(/\/+$/, '');
      let url: URL;
      try { url = new URL(baseUrl); } catch { throw new HubError(400, 'DeepSeek API 地址不是有效 URL'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HubError(400, 'DeepSeek API 地址必须是无凭据、查询参数或片段的 HTTP(S) URL');
      const { apiKey, ...deepseek } = next.deepseek;
      if (apiKey !== undefined) store.setDeepseekApiKey(apiKey.trim());
      store.setSettings({ titles, claude: next.claude, codex: next.codex, deepseek: { ...deepseek, baseUrl, model: deepseek.model.trim() || 'deepseek-flash', apiKeyConfigured: !!store.getDeepseekApiKey() } });
    },

    getSession: (id: string) => withBackground(getSession(id)),
    listSessions: () => store.listSessions().map(withBackground),
    repositoryBusyReason,
    async withIdleRepository(root: string, write: () => Promise<void>, operation = 'Discarding changes'): Promise<void> {
      root = workspacePath(root);
      const reason = repositoryBusyReason(root);
      if (reason) throw new HubError(409, reason);
      repositoryWrites.set(root, operation);
      try { await write(); } finally {
        repositoryWrites.delete(root);
        for (const id of watchers.keys()) {
          const status = store.getSession(id)?.status;
          if (status === 'idle' || status === 'error') notifyWatchers(id, status);
        }
      }
    },
    usage,

    /** 归档只是隐藏：跟删除一样只允许 idle / error，避免运行中的会话从侧栏消失后没人盯；取消归档没有限制 */
    setArchived(sessionId: string, archived: boolean): Session {
      const session = getSession(sessionId);
      if (archived && (session.status === 'running' || session.status === 'waiting_user')) throw new HubError(409, 'Session is running; stop it or wait for it to finish before archiving');
      store.setSessionArchivedAt(sessionId, archived ? new Date().toISOString() : null);
      return getSession(sessionId);
    },

    /** 换 Provider 只对空会话开放：Provider 进程在首条消息时才惰性启动，之前换只是改一列；有过消息就不该换（上下文在 Provider 那边） */
    setProvider(sessionId: string, provider: Session['provider']): Session {
      if (!(provider in providers)) throw new HubError(400, `Unknown provider ${provider}`);
      const session = getSession(sessionId);
      if (session.provider === provider) return session;
      if (!isEmptySession(session)) throw new HubError(409, 'Session already has messages; start a new session to use another agent');
      // model / effort 两个 Provider 不通用，按新 Provider 的设置默认值重来；permissionMode 与 Provider 无关，保留
      const defaults = settings()[provider];
      store.setSessionProvider(sessionId, provider, defaults.model.trim() || null, defaults.effort.trim() || null);
      return getSession(sessionId);
    },

    /** 换模型 / 思考等级同样只对空会话开放（理由同 setProvider）；effort 不被新模型支持时回到 Provider 默认，而不是报错 */
    setModel(sessionId: string, model: string, effort: string): Session {
      const session = getSession(sessionId);
      if (!isEmptySession(session)) throw new HubError(409, 'Session already has messages; start a new session to change the model');
      const nextModel = normalizeModel(session.provider, model);
      const nextEffort = effort.trim() && getEffortOptions(session.provider, nextModel).some((o) => o.value === effort.trim()) ? effort.trim() : null;
      store.setSessionProvider(sessionId, session.provider, nextModel, nextEffort);
      return getSession(sessionId);
    },

    /**
     * 从 beforeSeq 那条开启一轮的用户消息之前分叉：Provider 侧按上一轮结束时记下的锚点复制出新会话，Hub 侧复制此前的事件与附件。
     * 分叉点前一轮没有锚点（功能上线前的轮、被 Hub 重启打断的轮）时 409；第一轮之前分叉 = 同配置的空会话
     */
    async forkSession(sessionId: string, beforeSeq: number, rewind: boolean): Promise<Session> {
      const source = getSession(sessionId);
      if (source.status === 'running' || source.status === 'waiting_user') throw new HubError(409, 'Session is running; stop it or wait for it to finish before forking');
      const events = store.eventsAfter(sessionId, 0);
      const i = events.findIndex((e) => e.seq === beforeSeq);
      // 一轮中途插入的消息已被 Provider 并进那一轮，没法从中间切开
      if (i === -1 || events[i].type !== 'message.user' || events[i + 1]?.type !== 'turn.started') throw new HubError(400, 'Can only fork before a message that started a turn');
      const kept = events.slice(0, i);
      const lastStart = kept.findLast((e) => e.type === 'turn.started');
      const lastEnd = kept.findLast((e) => e.type === 'turn.completed' || e.type === 'turn.failed');
      let providerSessionId: string | null = null;
      if (lastStart) {
        const anchor = lastEnd && lastEnd.seq > lastStart.seq ? lastEnd.payload.anchor : undefined;
        if (!anchor || !source.providerSessionId) throw new HubError(409, 'Cannot fork here: the previous turn has no fork point (it ran before forking was supported, or was cut short by a Hub restart)');
        providerSessionId = await forks[source.provider](source.providerSessionId, anchor, source.cwd);
      }
      const now = new Date().toISOString();
      const session: Session = {
        ...source,
        id: randomUUID(),
        providerSessionId,
        status: kept.findLast((e) => e.type === 'session.status')?.payload.status ?? 'idle',
        // 没保留任何一轮就是全新对话，标题留给首条消息；title 可能是首条消息预览（没有 AI 标题时），照样沿用
        title: !lastStart || !source.title ? null : rewind ? source.title : `${source.title} (fork)`,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const copied = [];
      for (const e of kept) {
        if (e.type !== 'message.user' || !e.payload.attachments.length) copied.push(e);
        else copied.push({ ...e, payload: { ...e.payload, attachments: e.payload.attachments.map((a) => attachments.copyTo(a, session.id)) } });
      }
      // 截断处仍在等待的请求（如 Codex 异步提问）在新会话里没有对应的行，记为过期，否则会显示成可答的卡片
      const resolved = new Set(kept.flatMap((e) => (e.type === 'approval.resolved' || e.type === 'user_input.resolved' ? [e.payload.requestId] : [])));
      for (const e of kept) {
        if ((e.type === 'approval.requested' || e.type === 'user_input.requested') && !resolved.has(e.payload.request.id)) copied.push({ ...resolvedEvent(e.payload.request, null), createdAt: now });
      }
      store.copySession(session, copied, copied.flatMap((e) => (e.type === 'message.user' ? e.payload.attachments : [])));
      return getSession(session.id);
    },

    /** 只删 idle / error 的会话：运行中的让用户先中断或等结束，Hub 不处理关 Provider 的时序 */
    deleteSession(sessionId: string) {
      const session = getSession(sessionId);
      if (session.status === 'running' || session.status === 'waiting_user') throw new HubError(409, 'Session is running; stop it or wait for it to finish before deleting');
      // 空闲会话的 Provider 进程可能还活着（等下一条消息），先关掉
      live.get(sessionId)?.close();
      live.delete(sessionId);
      watchers.delete(sessionId);
      autoWakes.delete(sessionId);
      spawnGrants.delete(sessionId);
      titleJobs.get(sessionId)?.abort();
      store.deleteSession(sessionId);
      // 表已一致，目录删失败也不回滚；残留会在下次删除同 id 时被 force 覆盖
      attachments.removeAll(sessionId);
      for (const fn of deletedListeners.get(sessionId) ?? []) fn();
      listeners.delete(sessionId);
      deletedListeners.delete(sessionId);
    },

    sendMessage,

    /** 子会话这一轮（连同插入的追加指令）结束时，以一条消息回报给父会话；一次性 */
    notifyWhenDone(childId: string, parentId: string) {
      let parents = watchers.get(childId);
      if (!parents) watchers.set(childId, (parents = new Map()));
      parents.set(parentId, store.lastSeq(childId));
    },

    grantSpawn(sessionId: string) {
      spawnGrants.add(sessionId);
    },

    canSpawn(sessionId: string) {
      return spawnGrants.has(sessionId);
    },

    async interrupt(sessionId: string) {
      const session = getSession(sessionId);
      const provider = live.get(sessionId);
      if (!provider || (session.status !== 'running' && session.status !== 'waiting_user')) throw new HubError(409, 'No turn is running');
      // 用户要的是"停下来"：Provider 连同还没被读到的插入消息一起丢弃
      await provider.interrupt();
    },

    resolvePending(requestId: string, resolution: Resolution): number {
      const request = store.getPending(requestId);
      if (!request) throw new HubError(404, 'Request not found');
      if (resolution.kind !== request.kind) throw new HubError(400, `Request kind is ${request.kind}, got ${resolution.kind}`);
      if (!settle(requestId, resolution)) throw new HubError(409, 'Already handled elsewhere');
      if (request.kind === 'question' && request.delivery === 'async' && resolution.kind === 'question') {
        const session = getSession(request.sessionId);
        const provider = ensureProvider(session);
        const text = request.questions.map((q) => `${q.question}：${resolution.answers[q.question]?.join('、') || resolution.response || ''}`).join('\n');
        emit(session.id, { type: 'message.user', payload: { text, attachments: [] } });
        if (session.archivedAt) store.setSessionArchivedAt(session.id, null);
        // 运行中插入当前轮，空闲时新开一轮
        if (session.status === 'running' || session.status === 'waiting_user') provider.send({ text, images: [] });
        else dispatch(session.id, provider, { text, files: [] });
      }
      return store.lastSeq(request.sessionId);
    },

    pendingRequests: store.pendingBySession,
    /** 不经 Provider、由 Hub 自己在该会话上弹的审批（MCP 派生会话） */
    createPending,

    subscribe(sessionId: string, listener: (m: LiveMessage) => void, onDeleted: () => void): () => void {
      let set = listeners.get(sessionId);
      if (!set) listeners.set(sessionId, (set = new Set()));
      set.add(listener);
      let deleted = deletedListeners.get(sessionId);
      if (!deleted) deletedListeners.set(sessionId, (deleted = new Set()));
      deleted.add(onDeleted);
      return () => {
        set.delete(listener);
        deleted.delete(onDeleted);
      };
    },

    eventsAfter: store.eventsAfter,
    lastSeq: store.lastSeq,

    close() {
      closing = true;
      for (const job of titleJobs.values()) job.abort();
      for (const p of live.values()) p.close();
      live.clear();
      shutdownCodex();
    },
  };
}
