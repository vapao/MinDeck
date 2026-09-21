import { randomUUID } from 'node:crypto';
import { effortOptions, modelOptions, permissionModeOptions, type AgentEvent, type Attachment, type MessageDelta, type PendingRequest, type PendingRequestBody, type PermissionMode, type ProviderEvent, type ProviderOutput, type Resolution, type Session, type SessionStatus, type Settings, type UsageInfo } from '@agentdeck/shared';
import type { Store } from './store/db';
import type { AttachmentStore } from './store/attachments';
import type { ProviderSession, StartOptions } from './providers/types';
import { startClaudeSession } from './providers/claude';
import { shutdownCodex, startCodexSession } from './providers/codex';

const providers: Record<Session['provider'], (o: StartOptions) => ProviderSession> = { claude: startClaudeSession, codex: startCodexSession };

export class HubError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// Hub：Session 元数据 + append-only 事件流 + 多端 fan-out。Provider 会话在首条消息时才拉起。
export function createHub(store: Store, attachments: AttachmentStore) {
  const live = new Map<string, ProviderSession>();
  /** 订阅者收到的是落库后的事件（带 seq）或不落库的流式片段 */
  type LiveMessage = { type: 'event'; event: AgentEvent } | MessageDelta;
  const listeners = new Map<string, Set<(m: LiveMessage) => void>>();
  // 会话被删除时通知仍订阅着它的客户端（没有事件可落库，单独一路回调）
  const deletedListeners = new Map<string, Set<() => void>>();
  // 正在等用户处理的 Provider 回调；Hub 重启后这些 Promise 不复存在，对应的行在启动时作废
  const waiting = new Map<string, (r: Resolution | null) => void>();
  // 一轮进行中收到的追加指令（方案 §8.3）：本轮结束后按序发出。只在内存里，Hub 重启即丢
  const queues = new Map<string, { text: string; files: Attachment[] }[]>();
  // 账号级额度，按 rateLimitType 保留最新值，GET /api/usage 直接返回
  const usage: Record<string, UsageInfo> = {};
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
  function broadcast(sessionId: string, output: ProviderOutput) {
    if (output.type !== 'message.delta') return emit(sessionId, output);
    for (const fn of listeners.get(sessionId) ?? []) fn(output);
  }

  function setStatus(sessionId: string, status: SessionStatus) {
    store.setSessionStatus(sessionId, status);
    emit(sessionId, { type: 'session.status', payload: { status } });
  }

  const emptyDefaults: Settings = { claude: { model: '', effort: '', permissionMode: 'approval' }, codex: { model: '', effort: '', permissionMode: 'approval' } };
  function settings(): Settings {
    const stored = store.getSettings();
    // 补 permissionMode 这种后加的字段：旧库存的 JSON 里没有，兜底成安全默认值，不然老装置升级后直接 undefined
    if (!stored) return emptyDefaults;
    return { claude: { ...emptyDefaults.claude, ...stored.claude }, codex: { ...emptyDefaults.codex, ...stored.codex } };
  }

  function getSession(id: string): Session {
    const session = store.getSession(id);
    if (!session) throw new HubError(404, 'Session not found');
    return session;
  }

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
    const provider = providers[session.provider]({
      cwd: session.cwd,
      resume: session.providerSessionId ?? undefined,
      model: session.model ?? undefined,
      effort: session.effort ?? undefined,
      permissionMode: session.permissionMode,
      onPending: (body, signal) => createPending(session.id, body, signal),
      onEvent(event) {
        // 会话已被删除：Provider 收尾时可能还有零星消息，直接丢弃，不能再往已删的 session 写
        if (!store.getSession(session.id)) return;
        if (event.type === 'session.started') store.setProviderSessionId(session.id, event.payload.providerSessionId);
        if (event.type === 'usage.updated') usage[event.payload.rateLimitType] = event.payload;
        broadcast(session.id, event);
        // 一轮结束：有排队的追加指令就接着发，否则回到 idle / error
        if (event.type === 'turn.completed' || event.type === 'turn.failed') {
          const next = queues.get(session.id)?.shift();
          if (next) dispatch(session.id, provider, next);
          else setStatus(session.id, event.type === 'turn.completed' ? 'idle' : 'error');
        }
        if (event.type === 'error') setStatus(session.id, 'error');
      },
      onExit(error) {
        live.delete(session.id);
        queues.delete(session.id);
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

  return {
    /** model / effort 省略时取设置里的默认值；空字符串 = 交给 Provider 默认，落库为 null。permissionMode 省略时也取默认值，没有"交给 Provider 默认"这一说 */
    createSession(provider: Session['provider'], cwd: string, override: { model?: string; effort?: string; permissionMode?: PermissionMode } = {}): Session {
      if (!(provider in providers)) throw new HubError(400, `Unknown provider ${provider}`);
      // cwd 只能是 UI 里添加过的工作区（方案 §11.3 allowlist）
      if (!store.getWorkspaceByPath(cwd)) throw new HubError(400, `cwd is not a registered workspace`);
      const defaults = settings()[provider];
      const model = (override.model ?? defaults.model).trim() || null;
      const effort = (override.effort ?? defaults.effort).trim() || null;
      const permissionMode = override.permissionMode ?? defaults.permissionMode;
      if (model && !modelOptions[provider].some((o) => o.value === model)) throw new HubError(400, `${provider} does not support model ${model}`);
      if (effort && !effortOptions[provider].some((o) => o.value === effort)) throw new HubError(400, `${provider} does not support effort ${effort}`);
      if (!permissionModeOptions.some((o) => o.value === permissionMode)) throw new HubError(400, `Unsupported permission mode ${permissionMode}`);
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), provider, cwd, providerSessionId: null, status: 'idle', title: null, model, effort, permissionMode, archivedAt: null, createdAt: now, updatedAt: now };
      store.createSession(session);
      return session;
    },

    settings,
    updateSettings(next: Settings) {
      for (const provider of ['claude', 'codex'] as const) {
        const model = next[provider].model.trim();
        const effort = next[provider].effort.trim();
        const permissionMode = next[provider].permissionMode;
        if (model && !modelOptions[provider].some((o) => o.value === model)) throw new HubError(400, `${provider} does not support model ${model}`);
        if (effort && !effortOptions[provider].some((o) => o.value === effort)) throw new HubError(400, `${provider} does not support effort ${effort}`);
        if (!permissionModeOptions.some((o) => o.value === permissionMode)) throw new HubError(400, `Unsupported permission mode ${permissionMode}`);
      }
      store.setSettings(next);
    },

    getSession,
    listSessions: store.listSessions,
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
      if (session.providerSessionId || live.has(sessionId) || store.lastSeq(sessionId) > 0) throw new HubError(409, 'Session already has messages; start a new session to use another agent');
      // model / effort 两个 Provider 不通用，按新 Provider 的设置默认值重来；permissionMode 与 Provider 无关，保留
      const defaults = settings()[provider];
      store.setSessionProvider(sessionId, provider, defaults.model.trim() || null, defaults.effort.trim() || null);
      return getSession(sessionId);
    },

    /** 只删 idle / error 的会话：运行中的让用户先中断或等结束，Hub 不处理关 Provider 的时序 */
    deleteSession(sessionId: string) {
      const session = getSession(sessionId);
      if (session.status === 'running' || session.status === 'waiting_user') throw new HubError(409, 'Session is running; stop it or wait for it to finish before deleting');
      // 空闲会话的 Provider 进程可能还活着（等下一条消息），先关掉
      live.get(sessionId)?.close();
      live.delete(sessionId);
      queues.delete(sessionId);
      store.deleteSession(sessionId);
      // 表已一致，目录删失败也不回滚；残留会在下次删除同 id 时被 force 覆盖
      attachments.removeAll(sessionId);
      for (const fn of deletedListeners.get(sessionId) ?? []) fn();
      listeners.delete(sessionId);
      deletedListeners.delete(sessionId);
    },

    sendMessage(sessionId: string, text: string, attachmentIds: string[]): { seq: number; queued: boolean } {
      const session = getSession(sessionId);
      let files;
      try {
        files = attachments.forMessage(sessionId, attachmentIds);
      } catch (err) {
        throw new HubError(400, (err as Error).message);
      }
      const provider = ensureProvider(session);
      // 从归档里点进来继续聊：一旦又活起来就得回到侧栏，否则会在看不见的地方跑
      if (session.archivedAt) store.setSessionArchivedAt(sessionId, null);
      const { seq } = emit(sessionId, { type: 'message.user', payload: { text, attachments: files } });
      // 一个 Session 同时只允许一个 active turn（方案 §8.3）：进行中就排队，本轮结束后由 onEvent 接着发
      const queued = session.status === 'running' || session.status === 'waiting_user';
      if (queued) {
        let q = queues.get(sessionId);
        if (!q) queues.set(sessionId, (q = []));
        q.push({ text, files });
      } else {
        dispatch(sessionId, provider, { text, files });
      }
      return { seq, queued };
    },

    async interrupt(sessionId: string) {
      const session = getSession(sessionId);
      const provider = live.get(sessionId);
      if (!provider || (session.status !== 'running' && session.status !== 'waiting_user')) throw new HubError(409, 'No turn is running');
      // 用户要的是"停下来"：连同排队的追加指令一起丢弃
      queues.delete(sessionId);
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
        // Codex turn/start 在有 active turn 时直接注入答案，不经过普通追加指令的轮后队列。
        if (session.status === 'running' || session.status === 'waiting_user') provider.send({ text, images: [] });
        else dispatch(session.id, provider, { text, files: [] });
      }
      return store.lastSeq(request.sessionId);
    },

    pendingRequests: store.pendingBySession,

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
      for (const p of live.values()) p.close();
      live.clear();
      shutdownCodex();
    },
  };
}
