import { randomUUID } from 'node:crypto';
import { effortOptions, modelOptions, permissionModeOptions, type AgentEvent, type Attachment, type PendingRequest, type PendingRequestBody, type PermissionMode, type ProviderEvent, type Resolution, type Session, type SessionStatus, type Settings, type UsageInfo } from '@agentdeck/shared';
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
  const listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  // 会话被删除时通知仍订阅着它的客户端（没有事件可落库，单独一路回调）
  const deletedListeners = new Map<string, Set<() => void>>();
  // 正在等用户处理的 Provider 回调；Hub 重启后这些 Promise 不复存在，对应的行在启动时作废
  const waiting = new Map<string, (r: Resolution | null) => void>();
  // 一轮进行中收到的追加指令（方案 §8.3）：本轮结束后按序发出。只在内存里，Hub 重启即丢
  const queues = new Map<string, { text: string; files: Attachment[] }[]>();
  // 账号级额度，按 rateLimitType 保留最新值，随 snapshot 下发
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
    for (const fn of listeners.get(sessionId) ?? []) fn(stored);
    return stored;
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
    if (!session) throw new HubError(404, 'session 不存在');
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
    setStatus(sessionId, 'waiting_user');
    return new Promise((resolve) => {
      waiting.set(request.id, resolve);
      // turn 被中断等情况下 Provider 会放弃这次请求：作废并通知各端
      signal.addEventListener('abort', () => settle(request.id, null), { once: true });
    });
  }

  /** 原子 resolve：只有第一个到达的处理生效，其余返回 false（"已在别处处理"） */
  function settle(requestId: string, resolution: Resolution | null): boolean {
    const request = store.getPending(requestId);
    if (!request) throw new HubError(404, '请求不存在');
    if (!store.resolvePending(requestId, resolution, resolution ? 'resolved' : 'expired')) return false;
    emit(request.sessionId, resolvedEvent(request, resolution));
    if (store.pendingBySession(request.sessionId).length === 0) setStatus(request.sessionId, 'running');
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
        emit(session.id, event);
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
          emit(session.id, { type: 'error', payload: { message: `${session.provider} 进程退出：${error instanceof Error ? error.message : String(error)}` } });
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
      if (!(provider in providers)) throw new HubError(400, `未知 Provider ${provider}`);
      // cwd 只能是 UI 里添加过的工作区（方案 §11.3 allowlist）
      if (!store.getWorkspaceByPath(cwd)) throw new HubError(400, `cwd 不是已添加的工作区`);
      const defaults = settings()[provider];
      const model = (override.model ?? defaults.model).trim() || null;
      const effort = (override.effort ?? defaults.effort).trim() || null;
      const permissionMode = override.permissionMode ?? defaults.permissionMode;
      if (model && !modelOptions[provider].some((o) => o.value === model)) throw new HubError(400, `${provider} 不支持模型 ${model}`);
      if (effort && !effortOptions[provider].some((o) => o.value === effort)) throw new HubError(400, `${provider} 不支持思考等级 ${effort}`);
      if (!permissionModeOptions.some((o) => o.value === permissionMode)) throw new HubError(400, `不支持的权限模式 ${permissionMode}`);
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), provider, cwd, providerSessionId: null, status: 'idle', title: null, model, effort, permissionMode, createdAt: now, updatedAt: now };
      store.createSession(session);
      return session;
    },

    settings,
    updateSettings(next: Settings) {
      for (const provider of ['claude', 'codex'] as const) {
        const model = next[provider].model.trim();
        const effort = next[provider].effort.trim();
        const permissionMode = next[provider].permissionMode;
        if (model && !modelOptions[provider].some((o) => o.value === model)) throw new HubError(400, `${provider} 不支持模型 ${model}`);
        if (effort && !effortOptions[provider].some((o) => o.value === effort)) throw new HubError(400, `${provider} 不支持思考等级 ${effort}`);
        if (!permissionModeOptions.some((o) => o.value === permissionMode)) throw new HubError(400, `不支持的权限模式 ${permissionMode}`);
      }
      store.setSettings(next);
    },

    getSession,
    listSessions: store.listSessions,
    usage,

    /** 只删 idle / error 的会话：运行中的让用户先中断或等结束，Hub 不处理关 Provider 的时序 */
    deleteSession(sessionId: string) {
      const session = getSession(sessionId);
      if (session.status === 'running' || session.status === 'waiting_user') throw new HubError(409, '会话正在运行，先中断或等它结束后再删除');
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
      if (!provider || (session.status !== 'running' && session.status !== 'waiting_user')) throw new HubError(409, '当前没有在运行的 turn');
      // 用户要的是"停下来"：连同排队的追加指令一起丢弃
      queues.delete(sessionId);
      await provider.interrupt();
    },

    resolvePending(requestId: string, resolution: Resolution): number {
      const request = store.getPending(requestId);
      if (!request) throw new HubError(404, '请求不存在');
      if (resolution.kind !== request.kind) throw new HubError(400, `请求类型是 ${request.kind}，收到的是 ${resolution.kind}`);
      if (!settle(requestId, resolution)) throw new HubError(409, '已在别处处理');
      return store.lastSeq(request.sessionId);
    },

    pendingRequests: store.pendingBySession,

    subscribe(sessionId: string, listener: (e: AgentEvent) => void, onDeleted: () => void): () => void {
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
