// Domain 类型与 REST / WS 契约。只定义当前切片用到的部分（方案 §7.2、§14）。

export type ProviderId = 'claude' | 'codex';

export type SessionStatus = 'idle' | 'running' | 'waiting_user' | 'error';

export type Session = {
  id: string;
  provider: ProviderId;
  cwd: string;
  /** Provider 原生会话 ID（Claude session_id / Codex threadId），首轮 init 后才有 */
  providerSessionId: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
};

// ---- 统一事件 ----

export type TurnEndReason = 'completed' | 'interrupted';

export type EventPayloads = {
  'session.started': { providerSessionId: string; model: string };
  'session.status': { status: SessionStatus };
  'turn.started': Record<never, never>;
  'turn.completed': { reason: TurnEndReason; durationMs: number; costUsd: number };
  'turn.failed': { message: string };
  'message.user': { text: string };
  'message.delta': { messageId: string; text: string };
  'message.completed': { messageId: string; text: string };
  'tool.started': { toolUseId: string; name: string; input: unknown };
  'tool.completed': { toolUseId: string; output: string; isError: boolean };
  error: { message: string };
  /** Provider 消息中未映射到核心事件的子集，原样保留（AGENTS.md 规则 5） */
  'provider.raw': { kind: string; data: unknown };
};

export type EventType = keyof EventPayloads;

export type AgentEvent<T extends EventType = EventType> = {
  [K in T]: {
    sessionId: string;
    seq: number;
    type: K;
    payload: EventPayloads[K];
    createdAt: string;
  };
}[T];

/** Provider 产出的事件：Hub 落库后才分配 seq / createdAt */
export type ProviderEvent<T extends EventType = EventType> = {
  [K in T]: { type: K; payload: EventPayloads[K] };
}[T];

// ---- REST ----

export type CreateSessionBody = { provider: ProviderId; cwd: string };
export type CreateSessionResponse = Session;

export type SendMessageBody = { text: string };
export type SendMessageResponse = { seq: number };

export type ListWorkspacesResponse = { cwd: string }[];

// ---- WebSocket ----

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string; afterSeq: number }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'snapshot'; session: Session; lastSeq: number }
  | { type: 'event'; event: AgentEvent }
  | { type: 'replay.completed'; lastSeq: number }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
