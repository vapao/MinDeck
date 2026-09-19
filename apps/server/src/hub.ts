import { randomUUID } from 'node:crypto';
import type { AgentEvent, ProviderEvent, Session, SessionStatus } from '@agentdeck/shared';
import type { Store } from './store/db';
import { startClaudeSession, type ClaudeSession } from './providers/claude';

export class HubError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// Hub：Session 元数据 + append-only 事件流 + 多端 fan-out。Provider 会话在首条消息时才拉起。
export function createHub(store: Store, workspaces: string[]) {
  const live = new Map<string, ClaudeSession>();
  const listeners = new Map<string, Set<(e: AgentEvent) => void>>();

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

  function ensureProvider(session: Session): ClaudeSession {
    const existing = live.get(session.id);
    if (existing) return existing;
    const provider = startClaudeSession({
      cwd: session.cwd,
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

    sendMessage(sessionId: string, text: string): number {
      const session = getSession(sessionId);
      // MVP：一个 Session 同时只允许一个 active turn（方案 §8.3）；追加指令排队留给切片 4
      if (session.status === 'running') throw new HubError(409, '当前有一轮在运行');
      const provider = ensureProvider(session);
      const { seq } = emit(sessionId, { type: 'message.user', payload: { text } });
      emit(sessionId, { type: 'turn.started', payload: {} });
      setStatus(sessionId, 'running');
      provider.send(text);
      return seq;
    },

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
