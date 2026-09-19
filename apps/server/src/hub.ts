import { randomUUID } from 'node:crypto';
import type { AgentEvent, PendingRequest, PendingRequestBody, ProviderEvent, Resolution, Session, SessionStatus } from '@agentdeck/shared';
import type { Store } from './store/db';
import type { AttachmentStore } from './store/attachments';
import { startClaudeSession, type ClaudeSession } from './providers/claude';

export class HubError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// Hub：Session 元数据 + append-only 事件流 + 多端 fan-out。Provider 会话在首条消息时才拉起。
export function createHub(store: Store, attachments: AttachmentStore, workspaces: string[]) {
  const live = new Map<string, ClaudeSession>();
  const listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  // 正在等用户处理的 Provider 回调；Hub 重启后这些 Promise 不复存在，对应的行在启动时作废
  const waiting = new Map<string, (r: Resolution | null) => void>();
  store.expireAllPending();

  function emit(sessionId: string, event: ProviderEvent): AgentEvent {
    const stored = store.appendEvent(sessionId, event);
    for (const fn of listeners.get(sessionId) ?? []) fn(stored);
    return stored;
  }

  function setStatus(sessionId: string, status: SessionStatus) {
    store.setSessionStatus(sessionId, status);
    emit(sessionId, { type: 'session.status', payload: { status } });
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

  function ensureProvider(session: Session): ClaudeSession {
    const existing = live.get(session.id);
    if (existing) return existing;
    const provider = startClaudeSession({
      cwd: session.cwd,
      onPending: (body, signal) => createPending(session.id, body, signal),
      onEvent(event) {
        if (event.type === 'session.started') store.setProviderSessionId(session.id, event.payload.providerSessionId);
        emit(session.id, event);
        if (event.type === 'turn.completed') setStatus(session.id, 'idle');
        if (event.type === 'turn.failed' || event.type === 'error') setStatus(session.id, 'error');
      },
      onExit(error) {
        live.delete(session.id);
        if (error) {
          emit(session.id, { type: 'error', payload: { message: `Claude 子进程退出：${error instanceof Error ? error.message : String(error)}` } });
          setStatus(session.id, 'error');
        }
      },
    });
    live.set(session.id, provider);
    return provider;
  }

  return {
    workspaces,

    createSession(provider: Session['provider'], cwd: string): Session {
      if (provider !== 'claude') throw new HubError(400, `Provider ${provider} 尚未实现`);
      if (!workspaces.includes(cwd)) throw new HubError(400, `cwd 不在 workspace allowlist 内`);
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), provider, cwd, providerSessionId: null, status: 'idle', createdAt: now, updatedAt: now };
      store.createSession(session);
      return session;
    },

    getSession,

    sendMessage(sessionId: string, text: string, attachmentIds: string[]): number {
      const session = getSession(sessionId);
      // MVP：一个 Session 同时只允许一个 active turn（方案 §8.3）；追加指令排队留给切片 4
      if (session.status === 'running') throw new HubError(409, '当前有一轮在运行');
      let files;
      try {
        files = attachments.forMessage(sessionId, attachmentIds);
      } catch (err) {
        throw new HubError(400, (err as Error).message);
      }
      const provider = ensureProvider(session);
      const { seq } = emit(sessionId, { type: 'message.user', payload: { text, attachments: files } });
      emit(sessionId, { type: 'turn.started', payload: {} });
      setStatus(sessionId, 'running');
      // Claude 走原生 image block（方案 §9.1）；图片放在文字前面是 Anthropic 视觉文档的建议顺序
      provider.send([
        ...files.map((a) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mimeType, data: attachments.read(a).toString('base64') } })),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ]);
      return seq;
    },

    resolvePending(requestId: string, resolution: Resolution): number {
      const request = store.getPending(requestId);
      if (!request) throw new HubError(404, '请求不存在');
      if (resolution.kind !== request.kind) throw new HubError(400, `请求类型是 ${request.kind}，收到的是 ${resolution.kind}`);
      if (!settle(requestId, resolution)) throw new HubError(409, '已在别处处理');
      return store.lastSeq(request.sessionId);
    },

    pendingRequests: store.pendingBySession,

    subscribe(sessionId: string, listener: (e: AgentEvent) => void): () => void {
      let set = listeners.get(sessionId);
      if (!set) listeners.set(sessionId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },

    eventsAfter: store.eventsAfter,
    lastSeq: store.lastSeq,

    close() {
      for (const p of live.values()) p.close();
      live.clear();
    },
  };
}
