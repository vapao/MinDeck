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
  /** 创建时指定的模型 / 思考等级（来自设置或新建页覆盖）；null 交给 Provider 默认。实际生效的模型看 session.started */
  model: string | null;
  effort: string | null;
  /** 创建时定下，会话生命周期内不变（同 model / effort）：审批走 Hub 审批卡，还是完全跳过审批 */
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
};

// ---- 工作区与设置 ----

/** 可作为会话 cwd 的目录，由用户在 UI 里从家目录内浏览添加；alias 只用于展示 */
export type Workspace = { id: string; path: string; alias: string; createdAt: string };

/** 下拉选项：value 是实际传给 Provider 的值，label 是展示文案 */
export type SelectOption = { value: string; label: string };

/**
 * 权限模式：'approval' 走 Hub 的审批卡（默认，安全）；'bypass' 让 Provider 不经审批直接执行
 * （Claude：permissionMode 'bypassPermissions'；Codex：approvalPolicy 'never' + sandbox 'danger-full-access'）。
 * 风险自负：一旦某会话是 bypass，任何能连上这台 Hub 的设备发消息都能让它不经审批跑任意命令。
 */
export type PermissionMode = 'approval' | 'bypass';
export const permissionModeOptions: readonly SelectOption[] = [
  { value: 'approval', label: '审批' },
  { value: 'bypass', label: '完全跳过审批' },
];

/** 应用级默认值：新建会话时未覆盖就用它；model / effort 空字符串 = 交给 Provider 默认 */
export type ProviderDefaults = { model: string; effort: string; permissionMode: PermissionMode };
export type Settings = Record<ProviderId, ProviderDefaults>;

/** 各 Provider 支持的模型，手工维护的硬编码列表，不做动态拉取；出新模型时手动改这里 */
export const modelOptions: Record<ProviderId, readonly SelectOption[]> = {
  claude: [
    { value: 'fable', label: 'Fable' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  ],
};

/** 各 Provider 接受的思考等级（Claude：SDK EffortLevel；Codex：model_reasoning_effort），同样手工维护 */
export const effortOptions: Record<ProviderId, readonly SelectOption[]> = {
  claude: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Xhigh' },
    { value: 'max', label: 'Max' },
  ],
  codex: [
    { value: 'light', label: 'Light' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'extra-high', label: 'Extra High' },
    { value: 'ultra', label: 'Ultra' },
  ],
};

/** 账号级额度（Claude：§16.1 第 4 条；Codex：account/rateLimits/updated），按 rateLimitType 各存一份最新值 */
export type UsageInfo = {
  provider: ProviderId;
  /** Claude: five_hour / seven_day …；Codex: primary / secondary */
  rateLimitType: string;
  /** 0–1 */
  utilization: number;
  /** Unix 秒；未知时为 null */
  resetsAt: number | null;
  /** 窗口长度；Provider 没给时为 null，UI 按 rateLimitType 兜底标注 */
  windowMinutes: number | null;
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
  /** 最近一次模型调用的上下文大小（prompt 侧 token 数，含缓存），Composer 状态区展示 */
  'context.updated': { tokens: number };
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

/** model / effort 省略时取设置里的默认值；空字符串表示显式交给 Provider 默认 */
export type CreateSessionBody = { provider: ProviderId; cwd: string; model?: string; effort?: string; permissionMode?: PermissionMode };
export type CreateSessionResponse = Session;

/** 按 updatedAt 倒序 */
export type ListSessionsResponse = Session[];

/** text 与 attachmentIds 至少有一个非空；附件必须属于同一 session */
export type SendMessageBody = { text: string; attachmentIds?: string[] };
/** queued：当前有一轮在跑，消息已排队，本轮结束后自动发出 */
export type SendMessageResponse = { seq: number; queued: boolean };

/** POST /api/sessions/:id/interrupt，无 body；未在运行时 409 */
export type InterruptResponse = { ok: true };

/** DELETE /api/sessions/:id：连同事件、待处理请求、附件（含文件）一起删；running / waiting_user 时 409 */
export type DeleteSessionResponse = { ok: true };

export type ListWorkspacesResponse = Workspace[];
/** POST /api/workspaces；path 必须在家目录内且已存在，重复添加 409 */
export type CreateWorkspaceBody = { path: string; alias: string };
/** PATCH /api/workspaces/:id */
export type UpdateWorkspaceBody = { alias: string };

/** GET /api/fs/dirs?path=：列出 path 下的子目录（跳过隐藏目录），只允许家目录内；path 省略 = 家目录 */
export type ListDirsResponse = { path: string; parent: string | null; dirs: { name: string; path: string }[] };

// ---- 改动侧栏（切片 10）：cwd 内只读 ----

/** ?：未跟踪；A 新增；M 修改；D 删除；R 重命名（path 为新路径）。additions / deletions 来自 numstat，未跟踪与二进制文件为 null */
export type ChangedFile = { path: string; status: '?' | 'A' | 'M' | 'D' | 'R'; additions: number | null; deletions: number | null };
/** GET /api/sessions/:id/changes；cwd 不是 git 仓库时 git=false */
export type ListChangesResponse = { git: boolean; files: ChangedFile[] };
/** GET /api/sessions/:id/diff?path=：工作区 vs HEAD 的 unified diff；未跟踪文件与 /dev/null 比 */
export type DiffResponse = { path: string; diff: string; binary: boolean };
/** GET /api/sessions/:id/file?path=：超过 512KB 截断；二进制文件 content 为 null */
export type FileResponse = { path: string; content: string | null; truncated: boolean; binary: boolean };

/** GET /api/sessions/:id/entries?q=：@ 引用补全。q 相对 cwd，`~` 开头相对家目录；目录 path 以 / 结尾 */
export type EntriesResponse = { entries: { path: string; name: string; dir: boolean }[] };

/** GET / PUT /api/settings */
export type SettingsResponse = Settings;
export type UpdateSettingsBody = Settings;

/** GET /api/usage：账号级额度，按 rateLimitType 取最新值；Hub 内存缓存，重启后到首轮跑完前为空 */
export type UsageResponse = Record<string, UsageInfo>;

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
  | { type: 'snapshot'; session: Session; pendingRequests: PendingRequest[]; lastSeq: number }
  | { type: 'event'; event: AgentEvent }
  | { type: 'replay.completed'; lastSeq: number }
  /** 订阅中的会话被删除；客户端应离开该页且不再重连 */
  | { type: 'session.deleted' }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
