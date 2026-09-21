# Remote Agent Hub

> Mac Mini 本地执行的 Claude / Codex 多端控制台

> **方案结论**
>
> 采用“纯结构化接口”路线：Codex 通过官方 app-server（JSON-RPC/stdio）接入；Claude 通过官方 Claude Agent SDK 的 Streaming Input 接入。控制端只呈现结构化 Agent UI，不实现 PTY、终端界面或 ANSI 解析。Mac Mini 是唯一执行端和本地状态源，MacBook / iPhone / Web 仅作为多端控制客户端。


**版本：**v1.1 **研究日期：**2026-09-19 **状态：**Claude 侧 P0 已验证通过（见 16.1）；Codex app-server 链路已人工确认；可进入 P1

**面向场景：**Mac Mini 常驻开机；MacBook / iPhone / 浏览器多端交互；代码、CLI、Git、凭据与实际执行均留在 Mac Mini。

# 目录

1. 执行摘要
2. 已确认的官方能力
3. 目标与非目标
4. 总体架构
5. Codex Provider 设计
6. Claude Provider 设计
7. 统一 Agent 协议
8. 会话与多端同步
9. 图片与附件
10. 审批与用户输入
11. 网络、自托管与安全
12. 持久化与故障恢复
13. 技术栈与工程结构
14. API 与 WebSocket 协议
15. MVP 分期
16. 风险与 P0 验证清单
17. 决策记录
18. 参考资料


# 1. 执行摘要

本方案要解决的不是“远程桌面”或“网页版终端”，而是建立一个自托管的 Coding Agent 控制层：Claude 与 Codex 都在 Mac Mini 上运行，MacBook、iPhone 和浏览器只负责发送消息、上传截图、查看流式输出、处理审批与切换会话。

> **推荐技术路线**
>
> 后端使用 TypeScript + Fastify；Codex 通过 `codex app-server` 默认 stdio 传输接入；Claude 通过 `@anthropic-ai/claude-agent-sdk` 的 Streaming Input 接入；前端采用 React + Vite PWA；客户端与 Mac Mini 之间通过 Tailscale + HTTPS/WSS 通信。


- 不实现 PTY，不解析 ANSI，不依赖 tmux，不提供“Terminal View”。

- 不把 Omnara/第三方云作为控制平面；控制数据只在自己的设备与模型厂商 API 之间流动。

- 图片在控制端直接粘贴/选择/拖入，由 Hub 自动上传到 Mac Mini，并由 Provider 转换为对应的原生图片输入。

- Hub 不重新实现 Agent 的上下文：Claude session ID 与 Codex thread ID 仍由各自官方运行时负责。

- 统一层只抽象双方真正共有的语义；Provider 特有能力通过 capability flags 暴露，不强行“抹平”。

## 最重要的产品化约束

Codex app-server 官方提供 ChatGPT 登录与设备码登录；Claude Agent SDK 则明确写明：未经 Anthropic 事先批准，第三方开发者不能在自己的产品中提供 claude.ai 登录或其 rate limits，应使用 API Key 等支持的认证方式。因此，如果目标是“自研 UI 仍直接消耗现有 Claude Max/Pro 订阅额度”，这不是一个可以默认成立的前提，必须在 P0 阶段单独验证。 [OAI-1] [ANTH-1]

# 2. 已确认的官方能力

| **能力**     | **Codex**                                      | **Claude**                                       |
|--------------|------------------------------------------------|--------------------------------------------------|
| 结构化接入   | 官方 app-server；双向 JSON-RPC 2.0             | 官方 Claude Agent SDK；结构化消息流              |
| 推荐本地传输 | stdio JSONL                                    | SDK 内部通过 stdio 管理 claude 子进程            |
| 流式响应     | 是：turn/item/delta 通知                       | 是：Streaming Input + partial/stream events      |
| 会话恢复     | thread/start、thread/read、thread/resume、fork | session_id + resume / continue / fork            |
| 图片输入     | text / image URL / localImage 路径             | Streaming Input 原生 image/base64                |
| 审批         | server-initiated JSON-RPC approval requests    | canUseTool 回调                                  |
| 向用户提问   | tool/requestUserInput                          | AskUserQuestion 经 canUseTool                    |
| 中断/跟进    | turn/interrupt、turn/steer                     | Streaming Input 支持排队消息与 interrupt         |
| 本地配置复用 | 基于本机 Codex 配置/工作目录                   | 可加载 .claude、skills、hooks、MCP、plugins      |
| 账户登录     | 官方支持 API Key / ChatGPT / device code       | 第三方产品推荐 API Key；claude.ai 登录需事先批准 |

## 2.1 Codex app-server

OpenAI 将 `codex app-server` 定义为面向富客户端集成的双向 JSON-RPC 2.0 服务。默认传输是 stdio 上的 JSONL；WebSocket 传输仍标注为 experimental/unsupported，因此本方案不直接把 app-server 暴露到网络，而是由本地 Hub 进程通过 stdio 启动和管理。 [OAI-1]

```
Remote Hub ──stdio/JSONL──> codex app-server
<──JSON-RPC events──
```


官方还允许从当前安装的 Codex 版本直接生成匹配的 TypeScript 类型和 JSON Schema，这非常适合在升级 Codex 后做协议兼容测试。 [OAI-1]

```
codex app-server generate-ts --out apps/server/src/providers/codex/schema
codex app-server generate-json-schema --out apps/server/src/providers/codex/schema-json
```


## 2.2 Claude Agent SDK

Anthropic 当前推荐 Streaming Input 用于持久、交互式场景：它支持图片上传、排队消息、中断、实时反馈、工具/MCP 与上下文持续。Agent SDK 自己会启动并监管 `claude` CLI 子进程，通过 stdio 与其通信；这是官方 SDK 内部实现，不是 PTY/TUI，也无需我们解析终端输出。 [ANTH-2] [ANTH-3]

```
Remote Hub ──Claude Agent SDK──> claude subprocess
structured stdio messages
└──HTTPS──> api.anthropic.com
```


# 3. 目标与非目标

## 3.1 目标

- Mac Mini 是唯一执行端：代码、Git 工作区、Agent 进程、工具与本地凭据均在 Mac Mini。

- MacBook、iPhone、PWA 可以同时连接到同一个 Agent session，看到同一份实时状态。

- 使用聊天式结构化 UI 展示 assistant 文本、tool call、diff/文件变更、审批、问题与错误。

- 截图/图片可直接粘贴、拖拽或从手机相册选择，发送体验接近 ChatGPT/Claude App。

- 断开客户端不会结束已运行的 Agent；重新打开后能重放历史并继续会话。

- 网络控制面完全自托管；Mac Mini 可只通过 Tailscale 暴露服务。

- Provider 层允许未来继续增加 Gemini CLI、OpenCode 等结构化 Agent。

## 3.2 非目标

- 不做 Web SSH、远程桌面、网页 Terminal、tmux 管理器。

- 不实现 PTY 或 ANSI/TUI 解析兜底。

- MVP 不做 Web IDE、完整文件管理器、完整 Git 客户端。

- MVP 不做团队/多租户/公开 SaaS；先按单用户、多个设备设计。

- 不实现第三方云 relay 或云端执行；设备间连接由 Tailscale 提供。

- 不自己实现模型 Agent loop，不绕过 Claude/Codex 的原生工具、上下文与权限模型。

# 4. 总体架构

```
MacBook / iPhone / PWA
│
│ HTTPS + WebSocket over Tailscale
▼
┌─────────────────────────────────────────┐
│ Remote Agent Hub · Mac Mini │
│ │
│ API/Auth Workspace Service │
│ Session Hub Event Store / Replay │
│ Attachment Multi-client Fan-out │
│ │
│ ┌────────────────┐ ┌─────────────────┐ │
│ │ Codex Provider │ │ Claude Provider │ │
│ └───────┬────────┘ └────────┬────────┘ │
└─────────┼───────────────────┼───────────┘
│ stdio/JSON-RPC │ Agent SDK
▼ ▼
codex app-server claude subprocess
│ │
└──── model APIs ───┘
```


## 4.1 关键架构原则

**1.** Hub 是“控制与同步层”，不是模型上下文的唯一真相来源。Provider 原生 session/thread 才负责 Agent 对话上下文。

**2.** Hub 使用自己的 append-only event stream 解决多端 UI 重放、断线恢复和通知，但不试图重建 Provider 内部全部状态。

**3.** 客户端只认识统一 Domain Model，不直接接触 Codex JSON-RPC 或 Claude SDK 消息。

**4.** Provider 的连接只存在于 Mac Mini 内部。Codex app-server 不直接暴露远程端口；Claude 子进程也不监听网络。

**5.** 所有工作区路径由服务端配置/白名单决定，客户端不能任意指定 Mac Mini 的绝对路径。

# 5. Codex Provider 设计

## 5.1 生命周期

```
Hub 启动
└─ spawn: codex app-server
└─ initialize / initialized
├─ account/read
├─ thread/list / thread/read
└─ 等待 Hub 指令
```


建议一个 Hub 进程只维持一个 app-server 实例，由它承载多个 thread。若未来发现某些配置必须进程级隔离，再升级为每 Workspace 一个 app-server。

## 5.2 新建、恢复、历史

- `thread/start`：创建新会话，并指定 cwd、model、approvalPolicy、sandbox 等。

- `thread/read`：读取已保存 thread 的历史，不必先恢复运行。

- `thread/resume`：恢复指定 thread；Hub 保存 `thread.id` 作为 `providerSessionId`。

- `thread/fork`：未来可作为“从此处新开分支”的高级功能。

## 5.3 输入与图片

`turn/start.input` 原生支持 `text`、`image` URL 和 `localImage` 本地路径。由于上传文件已经落在同一台 Mac Mini，Codex Provider 对图片优先使用 `localImage`，无需再做 base64 转换。 [OAI-1]

```json
{
"method": "turn/start",
"params": {
"threadId": "thr_...",
"input": [
{"type":"text","text":"按这张截图修一下布局"},
{"type":"localImage","path":"/Users/.../uploads/abc.png"}
]
}
}
```


## 5.4 审批与用户输入

命令执行、文件变更、权限提升等审批由 app-server 主动向客户端发 JSON-RPC request。Provider 将它映射为 Hub 的 `approval.requested`；收到用户决定后再原样/转换后回复 app-server。`tool/requestUserInput` 同理映射成结构化问题卡片。 [OAI-1]

## 5.5 认证

app-server 官方提供 `account/read`、`account/login/start`、`account/logout` 与 rate-limit API，登录类型包含 API key、ChatGPT 浏览器登录、ChatGPT device code 等。因此 Codex 可以在自研前端中实现正式的登录/设备码流程，而不是读取或复制私有 token。 [OAI-1]

# 6. Claude Provider 设计

## 6.1 运行模式

使用 TypeScript Claude Agent SDK，优先采用官方推荐的 Streaming Input 模式，不使用单条字符串 prompt 模式作为主交互路径。Streaming Input 可把一个 session 保持为长驻交互，支持图片、消息排队、中断和权限请求。 [ANTH-2]

## 6.2 Session 管理

- 首次 session：启动 Streaming Input，捕获 init/result 中的 `session_id`。

- 运行中：长驻 session 接收后续消息；Hub 将结构化 SDK 消息转换成统一事件。

- Hub/进程重启后：使用保存的 `session_id` + `resume` 恢复对话上下文。

- 历史浏览：SDK 已提供 `listSessions()`、`getSessionMessages()`、`getSessionInfo()` 等能力。

- 同一 Mac Mini 上不需要 SessionStore 才能恢复；session 文件本身保存在 `~/.claude/projects/...`。

官方说明 session 持久化的是“对话历史”，不是文件系统快照；本方案正好固定在同一台 Mac Mini 和同一工作目录，因此文件状态天然继续存在。 [ANTH-4]

## 6.3 图片

Claude Streaming Input 原生接受 image content block，示例使用 base64 + media_type。Provider 从 Attachment Service 读取图片字节后构造 SDKUserMessage，无需把文件路径暴露给用户。 [ANTH-2]

```ts
message.content = [
{ type: "text", text: "看一下这个截图" },
{ type: "image", source: {
type: "base64",
media_type: "image/png",
data: "..."
}}
]
```


## 6.4 审批 / AskUserQuestion

通过 `canUseTool` callback 接管动态审批。Claude 请求一个需要确认的工具，或者调用 `AskUserQuestion` 时，callback 会被触发。Hub 创建 PendingRequest，通过 WebSocket 推给所有在线控制端，并让 callback 对应的 Promise 等待用户响应；用户批准/拒绝/回答后 resolve。 [ANTH-5]

## 6.5 认证边界（P0 必查）

> **高优先级风险**
>
> Anthropic 官方文档明确：未经事先批准，第三方开发者不得在其产品中提供 claude.ai 登录或 rate limits；Agent SDK 应使用 API Key 等文档化认证方式。因此，这个项目若仅自己内部使用，可以先做技术验证，但若未来提供给其他用户，不能把“复用 Claude Max/Pro 消费订阅登录”作为既定设计。

**2026-09-19 验证结论：**未设置 `ANTHROPIC_API_KEY` 时，SDK 直接复用本机 `claude` 的 claude.ai OAuth 登录态（init 消息 `apiKeySource: "none"`），并持续推送订阅额度 `rate_limit_event`。单用户自托管场景技术上无障碍；上述条款约束仅在对外提供时生效。详见 16.1。


## 6.6 DeepSeek 复用 Claude SDK（2026-09-21）

DeepSeek 在 UI / Session 中作为独立 `provider: 'deepseek'`，路由到现有 Claude Provider。设置中保存独立的默认模型、权限和 API 地址，密钥单独存于 settings 表，不进入普通设置响应、事件流或前端持久存储。仅点击显示密钥时读取原文，响应 `Cache-Control: no-store`。

启动时按会话构造环境，并在 flag 层 `settings.env` 覆盖 user/project 设置：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、主模型与 Opus/Sonnet/Haiku 别名、子 Agent 模型、effort 和压缩窗口。SDK 模型附加 `[1m]`，实际 API 请求使用 `deepseek-flash` 或 `deepseek-v4-pro`。Claude 官方会话继续使用原本的本机登录，不修改全局环境。

模型和权限在会话创建时固定；API 地址和 Key 是连接配置，在会话进程下次启动时读取最新值。现有上下文恢复、工具与审批沿用 Claude 实现，Pro 图片输入在 UI 与服务端拒绝，DeepSeek 不转发 Claude 订阅额度事件。

新增 `POST /api/settings/deepseek/reveal-key` 和 `POST /api/settings/deepseek/test`。后者使用同一环境构造函数，经真实 SDK 发最短文本请求，无工具、不持久化会话、60 秒超时。

验证范围限于配置生效：已用真实 SDK + 本地 Anthropic 兼容端点确认 Flash/Pro 模型和认证请求，并确认会话配置覆盖 project settings 中的冲突配置。真实 DeepSeek 连通需设置有效 Key 后验证，不宣称工具全功能回归通过。配置依据：[DeepSeek Claude Code 接入](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)、[模型说明](https://api-docs.deepseek.com/quick_start/pricing)。

# 7. 统一 Agent 协议

统一层的目的不是制造“最低共同能力”，而是让 UI 有稳定的数据模型。Provider 差异通过 capabilities 表达。

## 7.1 Provider 接口草案

```ts
interface AgentProvider {
readonly id: "codex" | "claude";
capabilities(): ProviderCapabilities;
startSession(input: StartSessionInput): Promise<ProviderSession>;
resumeSession(providerSessionId: string): Promise<ProviderSession>;
listSessions(workspace: Workspace): Promise<ProviderSessionSummary[]>;
loadHistory(providerSessionId: string): Promise<NormalizedEvent[]>;
sendTurn(session: ProviderSession, message: AgentMessage): Promise<void>;
interrupt(session: ProviderSession): Promise<void>;
steer?(session: ProviderSession, message: AgentMessage): Promise<void>;
resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
resolveUserInput(requestId: string, answers: UserAnswers): Promise<void>;
subscribe(session: ProviderSession, emit: (event: AgentEvent) => void): Unsubscribe;
}
```


## 7.2 核心事件

| **事件**                                      | **用途**                              |
|-----------------------------------------------|---------------------------------------|
| session.started / session.resumed             | 建立/恢复 Provider 会话               |
| turn.started / turn.completed / turn.failed   | 一轮工作的生命周期                    |
| message.delta / message.completed             | Assistant 文本流（delta 只广播不落库） |
| tool.started / tool.completed                 | 工具卡：只记 name + 一行 summary 与成败，不存输出 |
| file.changed                                  | 结构化文件变更/diff 摘要              |
| approval.requested / approval.resolved        | 命令/文件/权限审批                    |
| user_input.requested / user_input.resolved    | Agent 向用户发起的问题                |
| usage.updated                                 | Token/费用/额度（Provider 支持时）    |
| session.status                                | idle / running / waiting_user / error |
| error                                         | Provider / 传输 / 运行错误            |

## 7.3 Capability flags

```ts
type ProviderCapabilities = {
images: boolean;
sessionResume: boolean;
sessionFork: boolean;
midTurnSteer: boolean;
userQuestions: boolean;
commandApproval: boolean;
fileApproval: boolean;
accountLogin: "none" | "api-key" | "managed";
rateLimitInfo: boolean;
};
```


例如 Codex 的 `turn/steer` 与 Claude 的 queued streaming messages 并不完全同语义，UI 可以统一显示“追加指令”，但 Provider 依据 capabilities 选择具体行为。

# 8. 会话与多端同步

## 8.1 双层会话模型

| **层级**         | **职责**                                    | **示例**                           |
|------------------|---------------------------------------------|------------------------------------|
| Hub Session      | 产品级 ID、工作区、Provider、状态、设备同步 | sess_01J...                        |
| Provider Session | 模型/Agent 原生上下文                       | Codex threadId / Claude session_id |

## 8.2 Event Store 与断线恢复

Hub 为每个 Session 保存一条递增序号的标准化事件流。它服务的是 UI 重放和多端同步，不取代 Provider 原始 transcript。

```json
event = {
sessionId: "sess_...",
seq: 1042,
type: "message.completed",
provider: "claude",
providerEventId: "...",
payload: {...},
createdAt: "..."
}
```


- WebSocket 首次订阅：返回当前 snapshot + 从 `afterSeq` 开始的事件。

- 网络重连：客户端携带 `lastSeq`，Hub 先从 SQLite replay，再进入 live stream。

- 同一会话可被 MacBook 与 iPhone 同时订阅；任一端发送的新消息或审批都会同步到另一端。

- 写操作带 `idempotencyKey`，避免移动网络重试造成重复发送。

## 8.3 并发规则

- MVP：一个 Session 同时只允许一个 active turn。

- 正在运行时始终允许“Stop/Interrupt”。

- “追加指令”根据 Provider 能力决定：Codex 可映射到 steer；Claude 可进入 Streaming Input 队列。

- 两个设备同时发消息时，由 Hub 统一排序并产生 serverSeq，避免客户端各自决定顺序。

# 9. 图片与附件

## 9.1 用户体验

用户永远不需要先把截图手工传到 Mac Mini。MacBook 端可以拖拽/粘贴，iPhone 可以从照片库或文件选择；客户端上传后只引用 attachmentId。

```
iPhone / MacBook
└─ screenshot.png
└─ HTTPS multipart upload
└─ Mac Mini Attachment Service
├─ metadata -> SQLite
└─ bytes -> private local store
├─ Codex: localImage(path)
└─ Claude: base64 image block
```


## 9.2 存储建议

```
~/Library/Application Support/RemoteAgentHub/
uploads/
<session-id>/
<attachment-id>.png
agent-hub.sqlite
```


- 目录权限 0700，文件权限 0600。

- 客户端不能传本机绝对路径，只能引用服务端返回的 attachmentId。

- 建议 V1 支持 PNG/JPEG/WebP；HEIC 在服务端统一转 JPEG/PNG。

- 建议默认单张 ≤ 10 MB、单条消息 ≤ 5 张，可配置。

- 可选择去 EXIF，避免照片地理位置等元数据被带入模型请求。

- Session 删除或超过保留期后自动清理。

## 9.3 通用文件附件

图片是 V1 的一等公民。普通文件（日志、PDF、配置等）建议作为 V1.1：文件先保存到受控附件目录，再由 Provider 通过允许的文件读取工具处理。不要把“任意文件附件”伪装成双方都原生支持的统一输入类型。

# 10. 审批与用户输入

## 10.1 PendingRequest 模型

```ts
PendingRequest {
id, sessionId, provider, providerRequestId,
kind: "command" | "file-change" | "permission" | "question",
title, details, choices,
createdAt, expiresAt?, status
}
```


审批属于“必须跨设备正确恢复”的状态，不能只保存在某个 WebSocket 连接内。Hub 先落库，再广播。

- MacBook 正在前台：显示原地 approval card。

- MacBook 合盖、iPhone 在线：iPhone 能处理同一个 request。

- 全部离线：request 保持 pending；后续可接 Web Push / APNs 通知。

- 某个设备处理后，Hub 原子更新状态并广播 `approval.resolved`，其他设备按钮立即失效。

## 10.2 UI 呈现原则

- 命令审批必须展示完整 command、cwd、reason；不要只写“允许执行命令”。

- 文件变更审批尽可能展示文件列表与 diff 摘要。

- 高风险权限使用明确状态，不做“一键永远允许”作为默认按钮。

- AskUserQuestion / tool/requestUserInput 统一成单选、多选、文本输入等结构化控件。

# 11. 网络、自托管与安全

## 11.1 网络拓扑

```
Internet
│
├─ OpenAI API <──── Codex on Mac Mini
└─ Anthropic API <─ Claude on Mac Mini
Tailscale private network
MacBook ─┐
iPhone ──┼── HTTPS/WSS ──> Mac Mini Remote Agent Hub
Browser ─┘
```


模型 API 仍然正常访问 OpenAI/Anthropic；但 Remote Hub 的控制面不经过 Omnara 等第三方服务。

## 11.2 暴露方式

- 首选：Hub 仅监听 `127.0.0.1`，由 Tailscale Serve 提供 HTTPS。

- 备选：Hub 绑定 Tailscale IP，并在应用层验证访问 token / Tailscale identity。

- 禁止把 Codex app-server 的 WebSocket 直接暴露到公网；官方当前仍将该 WebSocket transport 标记为 experimental/unsupported。 [OAI-1]

## 11.3 应用安全控制

- Workspace 根目录 allowlist；所有 cwd 必须落在允许根目录下。

- Attachment path 只由服务端生成，不接受客户端提供任意文件系统 path。

- WebSocket 握手鉴权 + Origin 检查；REST 写接口使用 CSRF-safe token/cookie 策略。

- 默认保留 Provider 原生审批机制；不默认启用 bypassPermissions / approvalPolicy=never。

- 日志/事件库不保存环境变量与 token；对工具输出中的敏感字段做可配置脱敏。

- Hub 通过 macOS launchd 常驻并自动重启；使用独立数据目录。

- 远程访问只在 Tailnet 内开放；不设计公网账号注册入口。

# 12. 持久化与故障恢复

## 12.1 各层持久化职责

| **数据**           | **归属**        | **存储**                                 |
|--------------------|-----------------|------------------------------------------|
| Agent 对话上下文   | Provider        | Codex thread / Claude session transcript |
| 项目文件与 Git     | Mac Mini 工作区 | 本地磁盘                                 |
| Hub Session 元数据 | Hub             | SQLite                                   |
| 标准化 UI 事件     | Hub             | SQLite append-only                       |
| 待处理审批/问题    | Hub             | SQLite                                   |
| 上传附件           | Hub             | 本地私有目录                             |

## 12.2 故障场景

| **场景**               | **预期行为**                                                                            |
|------------------------|-----------------------------------------------------------------------------------------|
| MacBook/iPhone 断线    | Agent 不受影响；重连后按 seq 重放 UI 事件。                                             |
| Hub Web 服务重启       | 已落盘历史可恢复；重新连接 Provider。进行中的 turn 可能受 Provider 子进程生命周期影响。 |
| Codex app-server 重启  | 通过保存的 threadId 重新 thread/read/resume。                                           |
| Claude 子进程/Hub 重启 | 通过 session_id resume 恢复上下文；进行中的未完成工作不保证继续执行。                   |
| Mac Mini 重启          | 运行中的任务停止；机器恢复后可从持久 session 继续下一轮。                               |

> **重要边界**
>
> “会话可恢复”不等于“进程在 Hub 重启后继续原地跑”。在纯结构化 SDK 路线中，MVP 的目标是恢复上下文并继续下一轮，而不是实现进程级热迁移。若后续确实需要 Hub 无损升级，可把每个 Agent session 放到独立 worker/supervisor 进程中，Hub 只作为控制层。


# 13. 技术栈与工程结构

## 13.1 推荐技术栈

| **层** | **选择**                          | **原因**                                                         |
|--------|-----------------------------------|------------------------------------------------------------------|
| 语言   | TypeScript                        | Codex 可生成 TS schema；Claude 有官方 TS SDK；前后端可共享类型。 |
| 运行时 | Node.js ≥ 24（锁定 `.nvmrc`）     | `node:sqlite` 免 flag；SDK 会 spawn 本机 `claude`，与本机保持一致。 |
| 后端   | Fastify                           | 适合常驻进程、child_process、WS；与现有经验一致。                |
| 实时   | @fastify/websocket                | Hub 对客户端提供稳定 WSS，不依赖 Provider 的网络 transport。     |
| 存储   | `node:sqlite`（内置），原生 SQL   | 四张表（sessions / events / pending_requests / attachments），append-only 事件流写原生 SQL 最直接；无原生编译依赖；不引 ORM。 |
| 前端   | React + Vite PWA                  | 无需 SSR；MacBook/手机同一套界面；安装成本低。                   |
| 状态   | TanStack Query（REST）；实时 session 状态用 `useReducer` / `useSyncExternalStore` 对事件流做 reduce | session 快照本质是事件 reduce 结果，不需要独立状态库；出现跨页面共享状态再评估。 |
| 样式   | 待 UI 设计阶段决定                | 初始化时不预装 Tailwind / 组件库。                               |
| 网络   | Tailscale + HTTPS/WSS             | 无需公网 relay，符合现有网络环境。                               |
| 常驻   | launchd                           | Mac Mini 原生服务管理与自动拉起。                                |

## 13.2 工程结构

pnpm workspace，三个工作区。Provider 是 server 内的目录，不是独立包；等出现第二个消费方（例如独立 worker 进程）再拆。

```
AgentDeck/
├─ apps/
│ ├─ server/                    # Fastify + WS + launchd entry
│ │ └─ src/
│ │    ├─ providers/
│ │    │  ├─ claude/            # Claude Agent SDK adapter
│ │    │  └─ codex/             # app-server adapter
│ │    │     └─ schema/         # codex app-server generate-ts 输出（gitignore，按本机版本生成）
│ │    ├─ store/                # node:sqlite：sessions / events / pending / attachments
│ │    └─ main.ts
│ └─ web/                       # React/Vite PWA
├─ packages/
│ └─ shared/                    # Domain 类型 + REST/WS 协议契约（原 domain + protocol）
├─ pnpm-workspace.yaml
└─ package.json                 # 根脚本：dev:server / dev:web / typecheck / codex:schema
```

`AgentProvider` 接口（§7.1）与统一事件类型放在 `packages/shared`，供 server 与 web 共用；两个 Provider 的实现只在 server 内引用。

# 14. API 与 WebSocket 协议

## 14.1 REST（建议）

| **方法** | **路径**                    | **用途**                        |
|----------|-----------------------------|---------------------------------|
| GET      | /api/workspaces             | 工作区列表                      |
| GET      | /api/sessions               | 会话列表/过滤                   |
| POST     | /api/sessions               | 创建 Claude/Codex session       |
| GET      | /api/sessions/:id           | Session snapshot                |
| POST     | /api/sessions/:id/messages  | 发送一条用户消息                |
| POST     | /api/sessions/:id/interrupt | 中断当前 turn                   |
| POST     | /api/attachments            | multipart 上传图片/文件         |
| POST     | /api/pending/:id/resolve    | 审批或回答问题                  |
| GET      | /api/providers              | Provider 状态/capabilities/auth |

## 14.2 WebSocket

```
client -> server
subscribe { sessionId, afterSeq }
unsubscribe { sessionId }
ping
server -> client
snapshot { session, pendingRequests, lastSeq }
event { seq, type, payload }
replay.completed { lastSeq }
error { code, message }
```


消息发送可以继续走 REST，让幂等、超时与重试更简单；WebSocket 专注服务器推送。也可以后续统一成双向 WS，但 MVP 没必要。

# 15. MVP 分期

> **实施顺序以 `AGENTS.md` 的垂直切片为准**（2026-09-19 决定）：P1/P2 不按层推进，而是每次打通一条端到端路径。本节保留为范围清单。

## P0：可行性验证（必须先完成）

- Codex：app-server stdio 初始化、ChatGPT device code 登录、thread/start/resume、图片 localImage、命令审批、requestUserInput、中断。

- Claude：Agent SDK Streaming Input、API Key 认证、图片、canUseTool、AskUserQuestion、interrupt/排队消息、session_id + resume。

- Claude：验证实际需要的本地配置是否按预期加载（CLAUDE.md、skills、hooks、MCP、plugins）。

- Claude：若希望继续使用现有 claude.ai/Max/Pro 订阅，先确认官方允许且 SDK 支持的集成方式；未确认前不进入产品设计假设。

- 为双方各保存一套真实事件 fixture，作为 Provider parser/normalizer 的回归测试输入。

## P1：后端核心

- Workspace、Session、Provider registry。

- CodexProvider + ClaudeProvider。

- 统一事件、SQLite Event Store、seq replay。

- Attachment Service 与图片转换。

- PendingRequest（审批/问题）。

- REST + WebSocket + Tailscale 内网访问。

## P2：可用 UI

- Workspace / Session 列表与状态。

- 聊天消息 + 流式文本。

- Tool call 折叠卡片。

- 审批卡片与 AskUserQuestion。

- 截图粘贴、拖拽、手机选图。

- Stop / 追加指令。

- PWA 安装与移动端布局。

- 断线重连和历史重放。

## P3：体验增强

- Web Push 通知：Agent 完成、等待审批、发生错误。

- 更完整的 diff / 文件变更视图。

- 会话重命名、标签、搜索、fork。

- Provider usage / rate-limit 面板（能正式获取时）。

- 独立 session worker 进程，减少 Hub 热更新对 active turn 的影响。

- Native iOS/macOS 客户端仅在 PWA 明确遇到体验瓶颈后再考虑。

# 16. 风险与 P0 验证清单

| **优先级** | **风险/问题**                                   | **处理建议**                                                         |
|------------|-------------------------------------------------|----------------------------------------------------------------------|
| P0         | Claude 现有订阅认证能否用于自研控制端           | 不要假设可用；以 API Key 为官方基线，单独确认消费订阅复用边界。      |
| P0         | Claude Streaming Input 在长时间 idle 后的稳定性 | 做真实长会话测试；断开后应能用 session_id resume。                   |
| P0         | Codex app-server 协议随版本变化                 | 固定 Codex 版本；升级时重新 generate-ts + fixture 回归。             |
| P0         | 双端同时操作审批/发送消息的竞争                 | PendingRequest 原子 resolve；消息 idempotencyKey + server sequence。 |
| P1         | Hub 重启导致进行中任务中断                      | 接受 MVP 边界；后续拆独立 worker。                                   |
| P1         | 图片上传包含隐私元数据                          | 可配置 EXIF 清理；附件私有权限与保留策略。                           |
| P1         | Provider 事件语义不完全一致                     | capability flags；统一 UI 语义但不伪造不存在的能力。                 |
| P2         | PWA 后台/通知限制                               | 后续加 Web Push；仍不足再做原生 App。                                |

## P0 验收标准

**1.** 从 MacBook Web UI 创建 Codex session，发送文本并收到流式回答。

**2.** 从 iPhone 上传截图，Codex 能看到同一张图并继续同一个 thread。

**3.** 触发 Codex command approval，在 iPhone 批准后继续执行。

**4.** 创建 Claude session，发送文本 + 图片，收到结构化流式输出。

**5.** 触发 Claude AskUserQuestion / permission request，从另一台设备处理。

**6.** 关闭浏览器后 Agent 仍继续；重新打开能重放到最新 seq。

**7.** 重启 Hub 后，已完成的 Codex thread / Claude session 都可以继续下一轮。

**8.** 确认 Claude 认证方案符合实际使用方式和官方条款。

以上 8 条中 Claude 相关项（4、5、7 的 Claude 部分、8）已于 2026-09-19 通过，见 16.1；1–3、6、7 的 Codex 部分于切片 5 在真实 Hub 上通过（浏览器 / iPhone 真机部分待切片 6），见 16.2。

## 16.1 P0 验证记录（2026-09-19）

**范围：**Claude 侧全部 P0 项。Codex app-server 链路由人工另行确认通过，本节不含。

**环境：**Claude Code 2.1.278、`@anthropic-ai/claude-agent-sdk` 0.3.278、Node 24.20、macOS 24.6。验证脚本为一次性 harness：一个 Streaming Input 长驻 session 连续跑 4 轮（图片 → Bash 审批 → interrupt → 打断后继续），再用新进程 `resume` 同一 session。

| **P0 项**                       | **结果** | **证据**                                                                                   |
|---------------------------------|----------|--------------------------------------------------------------------------------------------|
| Streaming Input 长驻会话        | 通过     | 同一 session 内连续 4 轮，`session_id` 不变                                                |
| 流式输出                        | 通过     | `includePartialMessages: true` 下收到 `stream_event` 的 `text_delta`                       |
| 图片输入                        | 通过     | base64 PNG image block，模型正确识别颜色                                                   |
| `canUseTool` 审批               | 通过     | Bash 写文件触发回调；延迟 2s 后 resolve `allow`，工具继续执行（模拟异地设备批准）          |
| interrupt                       | 通过     | 长输出被即时打断；被打断的 turn 以 `result.subtype = "error_during_execution"` 结束        |
| 打断后继续                      | 通过     | 同一 session 下一轮正常回答                                                                |
| `session_id` + `resume`（新进程）| 通过     | 新 `query({ resume })` 返回同一 `session_id`，且带有前几轮上下文                           |
| 本地配置加载                    | 通过     | `settingSources: ['user','project']` 下 init 报告 41 skills、2 plugins、1 MCP，SessionStart hook 触发 |
| 认证                            | 通过     | 未设 API Key，`apiKeySource: "none"`，复用本机 claude.ai 登录；收到 `rate_limit_event`     |

**未验证：**长时间 idle 后 Streaming Input 的稳定性（本表上方风险表第二条），需要小时级跑测，另行安排。

### 对设计有影响的发现

**1. 认证风险解除（自用范围内）。**SDK 复用本机登录态消耗订阅额度，不需要 API Key。§6.5 的条款约束只在对外提供时生效；MVP 按单用户自托管设计即可。

**2. 本机 settings 会吞掉审批。**首次运行 `canUseTool` 未触发：用户级 `~/.claude/settings.json` 含 `permissions.defaultMode: "bypassPermissions"`，且 `echo` 类只读命令本就在 Claude Code 安全白名单内。Hub 若用 `settingSources` 加载 `user`，会继承这台机器的 permission 规则。P1 须明确规则：`settingSources` 建议只取 `project`；并在 init 消息里校验实际生效的 `permissionMode`，与 Hub 期望不符时拒绝启动 session。

**3. interrupt 的结果语义。**被打断的 turn 返回 `error_during_execution`，`errors` 含 `[ede_diagnostic] ... stop_reason=null`，而非 `success`。Provider normalizer 须把这种情况映射为 `turn.interrupted`（或带 `reason: "interrupted"` 的 `turn.completed`），不能当作错误。另外，若在该 result 之后立即关闭输入流，SDK 会抛 `Claude Code returned an error result`；Hub 关闭 session 前应确认最后一轮不处于此状态，或直接 catch 该异常。

**4. `rateLimitInfo` 对 Claude 可立即实现。**`rate_limit_event.rate_limit_info` 含 `status`、`rateLimitType`（`five_hour` / `seven_day` / `seven_day_opus` 等）、`utilization`、`resetsAt`。§7.3 中 Claude 的 `rateLimitInfo` 取 `true`，P3 的额度面板不必等待。

**5. SDK 消息类型远多于 §7.2 的核心事件。**一次 session 内观察到 `system/hook_started`、`system/hook_response`、`system/status`、`rate_limit_event` 等；`SDKMessage` 联合类型共 40 余种。normalizer 应显式处理需要的子集，其余直接丢弃（最初设计为归入 `provider.raw` 保留，2026-09-20 取消：没有消费者，只是撑大库和回放），避免每次 SDK 升级都要补类型。

## 16.2 Codex P0 验证记录（2026-09-19，切片 5）

**环境：**codex-cli 0.155.0（app-server 协议 v2，`experimentalApi: true`）、Node 24.20、macOS 24.6。验证脚本 `apps/server/scripts/p0-codex-harness.mjs`：一个 app-server 进程内单 thread 连续跑 6 轮，再用新进程 `thread/resume`；随后在真实 Hub 上走 REST + WS 端到端。

| **P0 项**                        | **结果** | **证据**                                                                                          |
|----------------------------------|----------|---------------------------------------------------------------------------------------------------|
| stdio JSONL 双向 JSON-RPC        | 通过     | `initialize` → `thread/start` → `turn/start`，通知按 `threadId` 路由                               |
| 流式输出                         | 通过     | `item/started(agentMessage)` → `item/agentMessage/delta` → `item/completed`                       |
| `localImage` 图片输入            | 通过     | 上传目录里的 PNG 直接按路径送入，模型正确识别颜色                                                 |
| 命令审批                         | 通过     | 沙箱外写文件触发 `item/commandExecution/requestApproval`；延迟 2s 回 `accept` 后命令执行          |
| 审批拒绝                         | 通过     | 回 `decline` 后 item 以 `status: "declined"` 结束，turn 正常 `completed`                           |
| `request_user_input`             | 通过     | 需 `--enable default_mode_request_user_input`（见下）；`item/tool/requestUserInput` 按问题 id 回答 |
| `turn/interrupt`                 | 通过     | `turn/completed` 的 `turn.status = "interrupted"`，无 error                                        |
| 打断后继续                       | 通过     | 同 thread 下一轮正常                                                                              |
| `thread/resume`（新进程）        | 通过     | 新进程 resume 后带前几轮上下文（记得图片颜色）；`thread.turns` 含历史                             |
| 额度                             | 通过     | 每次 API 调用后推 `account/rateLimits/updated`，`primary.usedPercent` / `windowDurationMins` / `resetsAt` |
| Hub 端到端（切片 1–4 验收项）    | 通过     | 对话、审批、追加指令排队、interrupt、Hub 重启后 resume、提问卡、上传图片，均经 REST + WS 走通      |

### 对设计有影响的发现

**1. 本机 Codex 配置会吞掉审批。**`~/.codex/config.toml` 是 `approval_policy = "never"` + `sandbox_mode = "danger-full-access"`。Provider 必须在 `thread/start` / `thread/resume` 里显式传 `approvalPolicy: "on-request"`、`sandbox: "workspace-write"`、`approvalsReviewer: "user"`，并校验回包中的 `approvalPolicy` / `sandbox.type`，不符则拒绝启动（与 Claude 侧规则 2 同类）。`workspace-write` 默认允许写 `/tmp`，审批只在写工作区外其他路径或访问网络时触发。

**2. `request_user_input` 默认只在 Plan 协作模式可用。**默认模式下模型调用会得到 `request_user_input is unavailable in Default mode`。Plan 模式下 Codex 不改文件，不适合作为 Hub 默认；app-server 提供 feature flag `default_mode_request_user_input`，开启后默认模式也能收到 `item/tool/requestUserInput`。Provider 以 `--enable default_mode_request_user_input` 启动 app-server；不支持 Plan 模式本身。

**3. 被打断的 agentMessage 不会收到 `item/completed`。**normalizer 在 `turn/completed` 时用已累积的 delta 文本补发 `message.completed`。

**4. 审批回包的 `availableDecisions` 字段 schema 未声明。**沙箱逃逸类审批实际只给 `accept` / `acceptWithExecpolicyAmendment` / `cancel`，没有 `acceptForSession`；"本会话允许"按钮只在 `availableDecisions` 含 `acceptForSession` 时提供。`acceptWithExecpolicyAmendment` 会写持久化的 execpolicy 规则，超出"本会话"语义，不使用。

**5. 一个 Hub 进程一个 app-server（§5.1）可行。**`account/rateLimits/updated` 等账号级通知没有 `threadId`，广播给所有会话，各自 normalizer 按内容去重后落库。app-server 每个 thread 启动时会拉起本机配置的 MCP server（`mcpServer/startupStatus/updated`）与 hooks，约 3s。

**6. 高频通知不落库。**`item/reasoning/*Delta`、`item/commandExecution/outputDelta` 直接丢弃；`thread/tokenUsage/updated` 映射为 `context.updated`，其余未映射通知也直接丢弃。

# 17. 决策记录

| **决策**    | **结论**                  | **理由**                                             |
|-------------|---------------------------|------------------------------------------------------|
| 控制 UI     | 结构化 Chat UI            | 手机/图片/审批体验优于终端。                         |
| 终端兜底    | 不做                      | 避免维护两套交互模型与 ANSI/TUI 兼容。               |
| Codex 接入  | app-server stdio          | 官方结构化协议；网络 WebSocket 当前仍 experimental。 |
| Claude 接入 | Agent SDK Streaming Input | 官方推荐长驻交互；支持图片、权限、interrupt。        |
| 执行端      | 固定 Mac Mini             | 项目文件、Agent、凭据和环境一致。                    |
| 远程网络    | Tailscale                 | 私网直达，不引入第三方 Agent control plane。         |
| 前端        | React + Vite PWA          | 覆盖 MacBook/iPhone/Web，先不做原生 App。            |
| 状态库      | SQLite                    | 单机产品足够，部署与备份简单。                       |
| 附件        | 自动上传到 Mac Mini       | 用户无需手工传文件；Provider 用原生图片输入。        |

# 18. 参考资料

以下资料均在 2026-09-19 核对。设计实现时应以安装版本对应的官方文档与生成 schema 为准。

**[OAI-1] Codex App Server —** JSON-RPC、stdio/WebSocket transport、schema generation、thread/turn、图片、审批、登录与 rate limits。  
[<u>https://developers.openai.com/codex/app-server/</u>](https://developers.openai.com/codex/app-server/)

**[ANTH-1] Claude Agent SDK Overview —** SDK 能力、sessions、plugins，以及第三方 claude.ai 登录限制。  
[<u>https://code.claude.com/docs/en/agent-sdk/overview</u>](https://code.claude.com/docs/en/agent-sdk/overview)

**[ANTH-2] Claude Agent SDK - Streaming Input —** 长驻交互、图片、排队消息、interrupt、实时反馈。  
[<u>https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode</u>](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

**[ANTH-3] Claude Agent SDK - Hosting —** 子进程/stdio 架构、长运行 session、自托管、网络与认证。  
[<u>https://code.claude.com/docs/en/agent-sdk/hosting</u>](https://code.claude.com/docs/en/agent-sdk/hosting)

**[ANTH-4] Claude Agent SDK - Sessions —** session_id、resume、fork、磁盘 transcript、跨进程恢复。  
[<u>https://code.claude.com/docs/en/agent-sdk/sessions</u>](https://code.claude.com/docs/en/agent-sdk/sessions)

**[ANTH-5] Claude Agent SDK - Permissions —** canUseTool、AskUserQuestion、permission modes。  
[<u>https://code.claude.com/docs/en/agent-sdk/permissions</u>](https://code.claude.com/docs/en/agent-sdk/permissions)

# 最终建议

> **Go / No-Go 建议**
>
> 整体技术路线可以进入开发验证，且不需要 PTY 兜底。先做 P0 harness，不先做完整 UI。若 Codex 的结构化链路全部通过、Claude Agent SDK 的交互能力也通过，并且 Claude 认证方式满足你的真实使用成本/账号需求，再进入 P1。当前最大的未知数不是“结构化接口够不够”，而是 Claude 的认证/计费形态是否符合你希望复用现有订阅的预期。

