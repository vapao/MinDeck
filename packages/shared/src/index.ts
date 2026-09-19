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
  /** 首条用户消息的开头，用于列表展示；还没发过消息时为 null */
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

/** claude.ai 订阅额度（P0 验证记录 §16.1 第 4 条），按 rateLimitType 各存一份最新值 */
export type UsageInfo = {
  rateLimitType: string;
  /** 0–1 */
  utilization: number;
  /** Unix 秒；未知时为 null */
  resetsAt: number | null;
};

// ---- 附件（方案 §9）----

/** 图片附件元数据。字节由服务端私有目录保存，客户端只拿 id，通过 GET /api/attachments/:id 取回 */
export type Attachment = {
  id: string;
  sessionId: string;
  /** 上传时的原始文件名，仅用于展示 */
  name: string;
  mimeType: ImageMimeType;
  size: number;
  createdAt: string;
};

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

// ---- 待处理请求（方案 §10.1）----

export type QuestionSpec = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

/** 请求内容本身，由 Provider 产出；Hub 落库时补上 id / 状态 / 时间 */
export type PendingRequestBody =
  | {
      kind: 'approval';
      toolName: string;
      toolUseId: string;
      input: unknown;
      /** Provider 给的完整提示句 / 说明 / 触发原因，有就展示 */
      title?: string;
      description?: string;
      decisionReason?: string;
      /** "本会话允许 <pattern>" 按钮展示用；为空则不提供该按钮 */
      sessionAllowPatterns: string[];
      /** Provider 建议的规则原文，resolve 时原样交还 Provider，UI 不解释 */
      suggestions: unknown[];
    }
  | { kind: 'question'; toolUseId: string; questions: QuestionSpec[] };

export type PendingRequest = PendingRequestBody & {
  id: string;
  sessionId: string;
  status: 'pending' | 'resolved' | 'expired';
  createdAt: string;
  resolvedAt: string | null;
};

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

/** 每个问题 → 选中的选项 label（单选也是长度 1 的数组） */
export type QuestionAnswers = Record<string, string[]>;

export type Resolution =
  | { kind: 'approval'; decision: ApprovalDecision }
  | { kind: 'question'; answers: QuestionAnswers; response?: string };

// ---- 统一事件 ----

export type TurnEndReason = 'completed' | 'interrupted';

export type EventPayloads = {
  'session.started': { providerSessionId: string; model: string };
  /** Hub 重启后用保存的 providerSessionId 恢复了 Provider 会话 */
  'session.resumed': { providerSessionId: string; model: string };
  'session.status': { status: SessionStatus };
  'turn.started': Record<never, never>;
  'turn.completed': { reason: TurnEndReason; durationMs: number; costUsd: number };
  'turn.failed': { message: string };
  'usage.updated': UsageInfo;
  'message.user': { text: string; attachments: Attachment[] };
  'message.delta': { messageId: string; text: string };
  'message.completed': { messageId: string; text: string };
  'tool.started': { toolUseId: string; name: string; input: unknown };
  'tool.completed': { toolUseId: string; output: string; isError: boolean };
  'approval.requested': { request: Extract<PendingRequest, { kind: 'approval' }> };
  'approval.resolved': { requestId: string; decision: ApprovalDecision | 'expired' };
  'user_input.requested': { request: Extract<PendingRequest, { kind: 'question' }> };
  'user_input.resolved': { requestId: string; answers: QuestionAnswers | null; response?: string };
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

/** 按 updatedAt 倒序 */
export type ListSessionsResponse = Session[];

/** text 与 attachmentIds 至少有一个非空；附件必须属于同一 session */
export type SendMessageBody = { text: string; attachmentIds?: string[] };
/** queued：当前有一轮在跑，消息已排队，本轮结束后自动发出 */
export type SendMessageResponse = { seq: number; queued: boolean };

/** POST /api/sessions/:id/interrupt，无 body；未在运行时 409 */
export type InterruptResponse = { ok: true };

export type ListWorkspacesResponse = { cwd: string }[];

/** POST /api/sessions/:id/attachments，multipart 单文件字段 file */
export type UploadAttachmentResponse = Attachment;

export type ResolvePendingBody = Resolution;
export type ResolvePendingResponse = { seq: number };

// ---- WebSocket ----

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string; afterSeq: number }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'snapshot'; session: Session; pendingRequests: PendingRequest[]; lastSeq: number; usage: Record<string, UsageInfo> }
  | { type: 'event'; event: AgentEvent }
  | { type: 'replay.completed'; lastSeq: number }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
