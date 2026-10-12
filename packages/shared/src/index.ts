// Domain 类型与 REST / WS 契约。只定义当前切片用到的部分（方案 §7.2、§14）。

export type ProviderId = 'claude' | 'codex' | 'deepseek';

export type SessionStatus = 'idle' | 'running' | 'waiting_user' | 'error';

export type Session = {
  id: string;
  provider: ProviderId;
  cwd: string;
  /** Provider 原生会话 ID（Claude session_id / Codex threadId），首轮 init 后才有 */
  providerSessionId: string | null;
  status: SessionStatus;
  /** AI 生成的标题；未生成时取首条用户消息开头，空会话为 null */
  title: string | null;
  /** 创建时指定的模型 / 思考等级（来自设置或新建页覆盖）；null 交给 Provider 默认。实际生效的模型看 session.started */
  model: string | null;
  effort: string | null;
  /** 创建时定下，会话生命周期内不变（同 model / effort）：审批走 Hub 审批卡，还是完全跳过审批 */
  permissionMode: PermissionMode;
  /** 归档只是从侧栏隐藏，事件流与 Provider 原生记录都还在；再给它发消息会自动取消归档 */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Agent 自己起的后台任务（如后台 Bash）还剩几个，不含常驻监听；不落库，随 Provider 进程消失，只有 Hub 返回的会话带 */
  backgroundTasks?: number;
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
  { value: 'approval', label: 'Ask for approval' },
  { value: 'bypass', label: 'Bypass approval' },
];

/** 应用级默认值：新建会话时未覆盖就用它；model / effort 空字符串 = 交给 Provider 默认 */
export type ProviderDefaults = { model: string; effort: string; permissionMode: PermissionMode };
export type TitleSettings = { enabled: boolean; provider: ProviderId; model: string };
export type Settings = Record<'claude' | 'codex', ProviderDefaults> & {
  titles: TitleSettings;
  deepseek: ProviderDefaults & { baseUrl: string; apiKeyConfigured: boolean };
};

/** 各 Provider 支持的模型，手工维护的硬编码列表，不做动态拉取；出新模型时手动改这里 */
export const modelOptions: Record<ProviderId, readonly SelectOption[]> = {
  deepseek: [
    { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek Pro' },
  ],
  // 用具体 ID 而非 SDK 别名：别名指向随 SDK 升级静默变化，界面上分不清实际跑的是哪一代
  claude: [
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { value: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { value: 'gpt-6-luna', label: 'GPT-6 Luna' },
  ],
};

/** 各 Provider 接受的思考等级（Claude：SDK EffortLevel；Codex：model_reasoning_effort），同样手工维护 */
export const effortOptions: Record<ProviderId, readonly SelectOption[]> = {
  deepseek: [],
  claude: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Xhigh' },
    { value: 'max', label: 'Max' },
  ],
  codex: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Xhigh' },
    { value: 'max', label: 'Max' },
    { value: 'ultra', label: 'Ultra' },
  ],
};

// 按本机 Codex 模型目录维护；ultra 是 Codex 级能力，不能用底层 Responses API 枚举代替。
const codexModelEfforts: Record<string, readonly string[]> = {
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
};

export function getEffortOptions(provider: ProviderId, model: string | null): readonly SelectOption[] {
  if (provider !== 'codex') return effortOptions[provider];
  // 未指定模型时仅提供各模型共有的等级，避免继承到不支持 ultra 的默认模型。
  const supported = codexModelEfforts[model ?? ''];
  return effortOptions.codex.filter(({ value }) => supported
    ? supported.includes(value)
    : Object.values(codexModelEfforts).every((efforts) => efforts.includes(value)));
}

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
  | { kind: 'question'; toolUseId: string; questions: QuestionSpec[]; /** 异步提问的答案通过用户消息送回 Provider */ delivery?: 'async' };

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
  /** anchor：Provider 侧这一轮的分叉点（Claude 最后一条主链消息 uuid / Codex 最后一个 turn id），没有则从下一条消息起不能分叉 */
  'turn.completed': { reason: TurnEndReason; durationMs: number; costUsd: number; anchor?: string };
  'turn.failed': { message: string; anchor?: string };
  'usage.updated': UsageInfo;
  /** 最近一次模型调用的上下文大小（prompt 侧 token 数，含缓存），Composer 状态区展示 */
  'context.updated': { tokens: number };
  'message.user': { text: string; attachments: Attachment[] };
  'message.completed': { messageId: string; text: string };
  /** 工具调用只记"做了什么"：summary 是服务端算好的一行（命令 / 文件路径 / pattern…），完整 input 和输出都不保存 */
  'tool.started': { toolUseId: string; name: string; summary: string };
  'tool.completed': { toolUseId: string; isError: boolean };
  'approval.requested': { request: Extract<PendingRequest, { kind: 'approval' }> };
  'approval.resolved': { requestId: string; decision: ApprovalDecision | 'expired' };
  'user_input.requested': { request: Extract<PendingRequest, { kind: 'question' }> };
  'user_input.resolved': { requestId: string; answers: QuestionAnswers | null; response?: string };
  error: { message: string };
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

/** 流式文本片段：不落库、不占 seq，只实时广播；掉线期间丢的片段由 message.completed 的全文补齐 */
export type MessageDelta = { type: 'message.delta'; messageId: string; text: string };
/** 后台任务数变化：Hub 只记在内存里，随会话列表返回，不落库也不广播 */
export type BackgroundChanged = { type: 'background.changed'; count: number };
export type ProviderOutput = ProviderEvent | MessageDelta | BackgroundChanged;

// ---- REST ----

/** model / effort 省略时取设置里的默认值；空字符串表示显式交给 Provider 默认 */
export type CreateSessionBody = { provider: ProviderId; cwd: string; model?: string; effort?: string; permissionMode?: PermissionMode };
export type CreateSessionResponse = Session;

/** 按 updatedAt 倒序 */
export type ListSessionsResponse = Session[];

export type UpdateStatus = {
  id: string;
  pid: number;
  phase: 'waiting' | 'building' | 'restarting' | 'completed' | 'failed';
  requestedAt: string;
  updatedAt: string;
  error?: string;
};
export type UpdateStatusResponse = { instanceId: string; update: UpdateStatus | null };

/** text 与 attachmentIds 至少有一个非空；附件必须属于同一 session */
export type SendMessageBody = { text: string; attachmentIds?: string[] };
/** steered：当前有一轮在跑，消息已插入该轮，Agent 下一步就能看到 */
export type SendMessageResponse = { seq: number; steered: boolean };

/** POST /api/sessions/:id/interrupt，无 body；未在运行时 409 */
export type InterruptResponse = { ok: true };

/**
 * PATCH /api/sessions/:id：归档 / 取消归档（归档 running / waiting_user 的会话 409，跟删除一样让用户先中断），
 * 或给还没发过消息的空会话换 Provider / 模型与思考等级（已有消息 / Provider 已启动则 409：上下文在 Provider 那边，换了等于丢光，不如新建）。
 * model / effort 空字符串 = Provider 默认；effort 不被新模型支持时服务端重置为默认
 */
export type UpdateSessionBody = { archived: boolean } | { provider: ProviderId } | { model: string; effort: string };
export type UpdateSessionResponse = Session;

/**
 * POST /api/sessions/:id/fork：从 beforeSeq 那条开启一轮的用户消息之前分叉出新会话，原会话不动（idle / error 才行，否则 409）。
 * rewind：原地回退，新会话沿用原标题（不加 "(fork)"），删原会话由前端跳转后自己调 DELETE
 */
export type ForkSessionBody = { beforeSeq: number; rewind: boolean };
export type ForkSessionResponse = Session;

/** DELETE /api/sessions/:id：连同事件、待处理请求、附件（含文件）一起删；running / waiting_user 时 409 */
export type DeleteSessionResponse = { ok: true };

export type ListWorkspacesResponse = Workspace[];
/** POST /api/workspaces；path 必须在家目录内且已存在，重复添加 409 */
export type CreateWorkspaceBody = { path: string; alias: string };
/** PATCH /api/workspaces/:id */
export type UpdateWorkspaceBody = { alias: string };

// ---- 项目服务（切片 14）：Hub 代为启动 / 停止的开发服务，每个项目一组 ----

/** subdir 相对项目根，空字符串 = 项目根；url 只用于展示链接（Tailscale 映射由用户自己配） */
export type ServiceConfig = { name: string; command: string; subdir: string; url: string };
export type Service = ServiceConfig & { id: string; workspaceId: string; running: boolean; createdAt: string };
/** GET /api/services：全部项目的服务，按创建时间排 */
export type ListServicesResponse = Service[];
/** POST /api/services */
export type CreateServiceBody = ServiceConfig & { workspaceId: string };
/** PATCH /api/services/:id；运行中也可改，下次启动生效 */
export type UpdateServiceBody = ServiceConfig;
/**
 * GET /api/services/:id/log?cursor=：从上次的 cursor 起的增量日志。cursor 对客户端不透明；
 * 省略或服务已重新启动过时返回末尾 64KB 且 reset=true，客户端应先清空已显示的内容
 */
export type ServiceLogResponse = { text: string; cursor: string; reset: boolean };

/** GET /api/fs/dirs?path=：列出 path 下的子目录（跳过隐藏目录），只允许家目录内；path 省略 = 家目录 */
export type ListDirsResponse = { path: string; parent: string | null; dirs: { name: string; path: string }[] };

// ---- 改动侧栏（切片 10）----

/** ?：未跟踪；A 新增；M 修改；D 删除；R 重命名（path 为新路径）。additions / deletions 来自 numstat，未跟踪与二进制文件为 null */
export type ChangedFile = { path: string; status: '?' | 'A' | 'M' | 'D' | 'R'; additions: number | null; deletions: number | null; discard: 'restore' | 'delete'; discardDisabled?: string; base: string };
/** POST /api/sessions/:id/changes/discard；同时丢弃指定文件的暂存区和工作区改动 */
export type DiscardChangeBody = { path: string; base: string; discard: ChangedFile['discard'] };
/** GET /api/sessions/:id/changes；cwd 不是 git 仓库时 git=false */
export type ListChangesResponse = { git: boolean; files: ChangedFile[] };
/** GET /api/sessions/:id/diff?path=：工作区 vs HEAD 的 unified diff；未跟踪文件与 /dev/null 比 */
export type DiffResponse = { path: string; diff: string; binary: boolean };
/** GET /api/sessions/:id/file?path=：超过 512KB 截断；二进制文件 content 为 null */
export type FileResponse = { path: string; content: string | null; truncated: boolean; binary: boolean };

/** GET /api/sessions/:id/entries?q=：@ 引用补全。q 相对 cwd，`~` 开头相对家目录；目录 path 以 / 结尾 */
export type EntriesResponse = { entries: { path: string; name: string; dir: boolean }[] };

/** GET /api/sessions/:id/skills：$ 补全，只含 skill，不含内置命令 */
export type SkillsResponse = { skills: { name: string; description: string }[] };

/** 消息开头的 $name（界面统一的 skill 触发写法，只认开头）；是否真是 skill 由调用方对照列表判断 */
export const skillToken = (text: string): string | undefined => text.match(/^\$(\S+)/)?.[1];

/** 开头是 /compact 的消息：手动压缩上下文，唯一放行的内置命令；Claude / DeepSeek 允许后接压缩指示 */
export const isCompactCommand = (text: string): boolean => /^\/compact(\s|$)/.test(text);

// 项目目录浏览 / 文件路径搜索；truncated 表示搜索未列完。
export type ProjectFilesResponse = EntriesResponse & { truncated: boolean; writeDisabled?: string };
/** POST /api/sessions/:id/files；创建空文件或单层目录，不覆盖已有条目 */
export type CreateProjectEntryBody = { path: string; dir: boolean };
/** DELETE /api/sessions/:id/files；永久删除，dir 用于校验确认后条目类型未变化 */
export type DeleteProjectEntryBody = { path: string; dir: boolean };


/** GET / PUT /api/settings */
export type SettingsResponse = Settings;
export type UpdateSettingsBody = Omit<Settings, 'deepseek'> & {
  /** apiKey 省略保留原值；空字符串清除。普通设置响应不含密钥。 */
  deepseek: Omit<Settings['deepseek'], 'apiKeyConfigured'> & { apiKey?: string };
};

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
  | MessageDelta
  | { type: 'replay.completed'; lastSeq: number }
  /** 订阅中的会话被删除；客户端应离开该页且不再重连 */
  | { type: 'session.deleted' }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
