# 功能规格

按垂直切片实现，每片端到端可用。本文只记已定的行为、边界与未做项；验收过程见 git 历史。

## 切片 1–6：核心

1. shared 契约；ClaudeProvider（Streaming Input + normalizer）、`node:sqlite` sessions / events、`POST /sessions`、`POST /sessions/:id/messages`、WS subscribe + seq 重放；单会话页。
2. `pending_requests` 表；canUseTool → approval / user_input 事件；`POST /pending/:id/resolve` 原子 resolve + 广播；审批卡、提问卡、"已在别处处理"态。
3. 附件上传、`attachments` 表、image block；粘贴 / 拖拽 / 相册。
4. workspace allowlist、会话列表、interrupt、Hub 重启后 resume、额度条。（追加指令已改为插入当前轮，见 AGENTS.md 规则 9。）
5. Codex Provider：app-server stdio adapter 映射到同一套事件；审批 / requestUserInput / localImage。
6. Tailscale Serve、launchd、PWA manifest、移动端、断线重连。

桌面安装的 PWA 支持 Window Controls Overlay：会话栏并入系统标题栏，避开窗口控件与 Chrome 菜单，空白处可拖动，按钮可点击。非会话页保留拖动区域；窄窗口预留系统标题栏。普通浏览器、手机与关闭覆盖模式时保持原布局。

## 切片 7：易用性

输入框草稿（localStorage 按会话）；「新开一轮」（同 cwd / provider 新建会话，等价 `/clear`，弹窗可选删除旧会话）；会话通知；头部显示当前模型。

- 通知沿用会话列表每 5 秒轮询比对状态，后台仍轮询；首次加载只记录基线。running / waiting_user 变为等待处理、完成或失败时提醒，同状态不重复。
- 页面可见且窗口有焦点才算前台：当前会话不提醒，其他会话在右下角显示站内提醒，不依赖系统通知权限；提醒持续停留，不自动消失，点击进入对应会话或手动关闭后移除，同会话只保留最新一条，进入该会话时也移除提醒。
- 窗口失焦或页面隐藏时，通过浏览器 `Notification` 发系统通知（需已授权），包括当前打开的会话；点击唤起窗口并进入对应会话。页面关闭后不通知；浏览器后台节流或冻结可能延迟提醒，未接 Web Push。

## 切片 8：项目与设置

`workspaces` 表 + 目录浏览（限家目录内）添加、别名、移除，首次启动种入本仓库。设置页：各 Provider 默认模型与 effort，创建会话时传给 Provider，靠 init 回包校验。

## 切片 9：删除会话

只允许 idle / error（否则 409）。级联删 events / pending_requests / attachments 及 `data/uploads/<id>/`；Provider 原生记录（`~/.claude/projects`、Codex thread）不动。

## 切片 10：改动侧栏（桌面）

cwd 内只读 `git status` / `git diff -- <file>` / 读文件；`turn.completed` 与写类工具完成后节流刷新；非 git 目录隐藏。自解析 unified diff，不引 diff 库。

## 切片 11：`@` 文件引用

`GET /api/sessions/:id/entries?q=`：相对 cwd，`~` 展开为家目录；直接子项在前、深层匹配在后，目录以 `/` 结尾可继续敲；cwd 内递归限 4 层 / 3000 项 / 1.5s，`~` 下只列直接子项。弹层支持上下键 / Enter / Tab / Escape。

**未做**：会话中切模型（Codex 按轮传 model / effort 简单；Claude 只有 `setModel()`，effort 需 resume 重开）。

## `#` 会话引用

- 输入框在行首或空白后输入 `#` 补全其他会话，支持按标题、项目、Provider 或 ID 搜索；当前项目优先，组内沿用最近更新排序，包含 Inactive 会话。候选显示标题、项目、Provider 和短 ID。
- 上下键选择，Enter / Tab 插入，Escape 关闭；`@` 仍只补全文件，`$` 仍只补全 skill。
- 插入 `#[标题](session:ID)` 纯文本引用，草稿与消息保留完整 ID；消息气泡显示可点击的 `#标题`。仅传引用，不自动注入历史，Agent 按需调用 `get_session` 读取；标题变化不影响 ID 定位。

## 切片 12：Active / Inactive

`sessions.archived_at`、`PATCH /api/sessions/:id { archived }`（running / waiting_user 409；给归档会话发消息自动取消归档）。侧栏两个页签共用分组列表：分组按组内最近活动排、可折叠（localStorage），折叠后仍露出 running / waiting_user 会话。Active 行 hover 可移到 Inactive；Inactive 行 hover 可移回 / 永久删除。会话页头部固定为「删除」；「新开一轮」在发送按钮左侧。图标 `EyeOff` / `Eye`。

**未做**：侧栏过滤框。

## 切片 13：空会话换 Provider / 模型

`PATCH /api/sessions/:id { provider | model | effort }`，只允许无事件、Provider 未启动的会话（否则 409，不做中途切换）。换 provider 时 model / effort 重置为新 Provider 默认、permissionMode 保留；effort 不被新模型支持时重置为默认。新建会话页沿用上次的 Provider（`localStorage newSession:provider`）。

## 切片 14：项目服务

`workspace_services` 表（名称、命令、相对项目根的子目录、展示用链接）；桌面右侧 Services 页签增删改、起停、看日志，侧栏分组头与页签有运行点。

- 进程 `/bin/zsh -lc <cmd>` detached 自成进程组，输出写 `data/logs/services/<id>.log`，**与 Hub 解耦**：Hub 重启后按库里 pid + `ps lstart` 接管（组长退出但组内仍有进程也算运行）。
- 停止向整个进程组 SIGTERM，5s 后 SIGKILL。只区分运行 / 停止。
- 日志用不透明 cursor（inode:偏移）增量读，重启后 reset。
- 运行中的服务不能删、所在项目不能移除（409）；移除项目连同服务配置一起删。
- **风险**：能连 Hub 的设备都能执行任意命令，等同 bypass。
- **未做**：自动 `tailscale serve` 映射、健康检查 / 自动重启、环境变量编辑、启动顺序。

## 空闲后更新 Hub

- `scripts/launchd.sh update-when-idle`：先确认 launchd 服务已加载，再启动独立的一次性后台进程，立即返回 PID 和日志路径，不占用 Agent 会话等待。日志追加到 `data/logs/update-when-idle.log`，等待期间可用 `kill <PID>` 取消。
- 每 2 秒读取本机 `/api/sessions`（端口沿用 `AGENTDECK_PORT`，默认 8004），只有所有会话均为 idle / error 才构建；running / waiting_user 都阻止更新。构建后再次等空闲，再调用现有 `restart`。
- 空闲检查共用从进程启动起的 10 分钟期限；连接拒绝、连接重置、套接字断开或请求超时会在阶段期限内限时重试（最多 60 秒）；HTTP / 数据错误、重连超时或构建失败会记录具体阶段、接口和原因并退出，不重启。构建命令自身不受该期限强制终止。同一时间只允许一个后台更新任务，重复调用不会再次安排；不是常驻任务，机器重启后不恢复。
- 后台任务原子写入 `data/update-status.json`，`GET /api/update-status` 返回最近一次更新及本次 Hub 的实例 ID；重启后最多等待 60 秒，确认新实例可访问才记成功。失败、取消或后台进程意外停止都会显示失败。
- 顶部独立更新通知每 5 秒查询更新状态，显示等待 / 构建 / 重启 / 成功 / 失败和时间；不会自动消失，关闭只针对本次更新的当前阶段，后续结果仍会出现。关闭浏览器后重开仍可查看未关闭的最近结果；成功提供 Refresh 按钮，不主动刷新页面。状态文件与 SQLite 位于同目录，日志仍在项目 `data/logs/`。
- 保留 `update` 的立即构建并重启行为（不生成上述通知）。空闲轮询不锁住新消息，最终检查与重启之间仍有短暂竞争窗口，不提供严格的无中断升级保证。

## 切片 15：会话编排 MCP

`POST /mcp` 无状态 Streamable HTTP（`src/mcp.ts`）：`list_workspaces` / `list_sessions` / `create_session(provider, prompt, workspace?)` / `get_session(id, afterSeq?, waitSec?)`（最多 40 条；`waitSec` ≤ 600）/ `send_message` / `interrupt`。

- **读取范围**：`get_session` 的记录只含用户消息、助手回复、错误和中断，不含工具调用；筛选后取最近 40 条，超过时标记 `truncated`。另外返回当前状态和待处理的审批 / 问题；`nextSeq` 用于后续增量读取。
- **只给 Hub 拉起的会话用**：按会话注入（Claude `mcpServers`、Codex thread `config.mcp_servers`），请求头 `x-agentdeck-session` 标识调用方，缺失或未知 403。请求头不是安全边界（REST 无鉴权）。
- **派生必须审批**：`create_session` 由 Hub 在调用方会话弹审批卡（与权限模式无关），批准后按设置默认值建会话并发首条消息。卡上可选"本会话允许"：该会话之后派生免审批（供用户离开时让监督会话自主派活），授权只在内存、只给该会话、子会话不继承，Hub 重启或会话删除即失效；子会话仍按设置默认权限模式跑，无人值守需先把默认改成 bypass。`send_message` / `interrupt` 按调用方权限模式走 Provider 审批（Codex 为 elicitation，见方案 §16.3）；只读工具与 `create_session` 在 Provider 侧免审。不能对自己的会话 send / interrupt / 等待。
- **定位**：把对话里已定的需求整理成交接单派给新会话，用户之后接管；prompt 取材于对话，不为写 prompt 查仓库、不转述项目规则、不加活。
- **结果回调**：`notify` 默认 false，仅父会话需要结果才能继续时开启；不等待 / 轮询。子会话本轮处理完（idle / error）时 Hub 发 `[AgentDeck] Session … finished`（含最后回复）给父会话；回调只在内存，Hub 重启即丢。同一父会话在用户未发消息时最多被自动唤醒 5 次（有派生授权时 30 次），超出改记 error，用户发消息后清零。
- **不暴露**：resolve 审批、设置与 Key、删除、项目增删。

## 切片 16：项目服务 MCP

`list_services(workspace?)` / `create_service(name, command, subdir?, url?, workspace?)` / `update_service(id, …)` / `start_service` / `stop_service` / `restart_service` / `get_service_log(id, cursor?, lines?)`，复用切片 14。`workspace` 省略取调用方项目。创建只存配置，更新只改传入字段，运行中更新需重启生效；启动立即返回；日志首次取末尾 100 行（最大 1000），超出标 `truncated`。不暴露删除。写操作按调用方权限模式由 Provider 审批，Hub 不另弹卡。

## 切片 17：分叉 / 原地回退（CLI `/rewind`）

悬停在开启一轮的用户消息上出现「Rewind」：**Fork** 保留原会话；**Rewind in place** = 分叉后删原会话（不改写原事件流，会话 id 变化）。

- `POST /api/sessions/:id/fork { beforeSeq, rewind }`，idle / error 才行。
- Provider 侧按上一轮 `turn.completed` / `turn.failed` 上的 `anchor` 复制：Claude / DeepSeek `forkSession(upToMessageId)`（该轮最后一条主链消息 uuid，含中断标记）；Codex `thread/fork(lastTurnId)` 后必须 `thread/unsubscribe`，否则同进程 resume 忽略权限覆盖、规则 10 校验失败。
- Hub 复制此前事件（seq 重排、保留原时间）与附件（新 id、文件复制）；截断处仍在等的请求记为过期；第一轮前分叉 = 同配置空会话。
- 插入的追加指令处不能分叉；上一轮无锚点 409，前端不显示按钮。
- Fork 标题加 ` (fork)`；原消息文字预填输入框（图片不带）；删原会话由前端跳转后调 DELETE，失败只提示。
- **不做**文件回滚。

## DeepSeek 接入

- `provider` 为 `claude | codex | deepseek`，平级；DeepSeek 复用 Claude Provider / SDK。
- 设置页独立配置 API 地址、Key、Flash / Pro 默认模型和权限。API ID `deepseek-flash` / `deepseek-v4-pro`；Pro 不支持图片，前后端都拒绝。effort 与压缩参数按 DeepSeek 官方 Claude Code 配置注入。
- Key 存 `settings.deepseek_api_key`，普通设置接口只返回 `apiKeyConfigured`；点眼睛才经不缓存的独立接口取原文。保存时省略 Key 保留原值，空字符串清除。
- 仅 DeepSeek 会话注入端点、认证、模型别名 / 子 Agent 模型，经 SDK flag 层 `settings.env` 覆盖 user/project 配置；不改 Hub 全局环境或本机 Claude 配置。
- 默认模型和权限只作用于新会话；地址和 Key 在 Provider 进程下次启动（含 resume）时读取。不展示 Claude 订阅额度。
- 「验证连接」经真实 SDK 发简短请求，需先保存配置，有少量费用。**真实 DeepSeek 服务尚未验证。**

## AI 会话标题

- 设置页开关（默认关）、独立 Provider / 模型，复用既有认证。
- 首条带文字的普通消息入库后后台请求一次（输入最多 8000 字符）；纯中文最多 15 字、含英文最多 30 字符（仅 Prompt 约束，服务端不截断）。已有文字的会话不补生成，失败不重试。
- `sessions.title` 单独持久化；无标题时显示首条消息首行前 80 字符。更新不改 `updated_at`。
- 独立请求，不进聊天上下文或事件流。Claude 走 SDK（临时目录、不加载 settings、禁工具与 hooks、不保存会话）；DeepSeek 直接 `fetch` `/v1/messages`（`max_tokens: 64`、`thinking: disabled`，不走 Hub 代理环境变量）；Codex 复用 app-server 临时只读 thread，关闭执行 / 外部工具与 MCP，结束后 unsubscribe。

## 会话输出文件与项目文件树

开发者明确授权：消息链接的文件预览 / 下载不限工作区目录，受 macOS 进程权限约束；不改变 cwd allowlist 和上传附件边界。桌面右侧 Changes / Files 页签，Files 按需展开项目目录。细节见 `docs/file-preview.md`。

## `$` 调用 skill

- 三个 Provider 统一用 `$` 触发，**只在消息开头生效**（Claude 的 slash 命令只认开头的一个）。输入框光标前整段是 `$xxx` 时弹出候选，按 name 子串过滤，交互同 `@`，选中插入 `$name `。
- `GET /api/sessions/:id/skills` 只列 skill、不含内置命令（`/clear`、`/model` 等会和 Hub 状态冲突）：Claude / DeepSeek 起空 Streaming Input 调 `reloadSkills()`（约 2 秒，不调模型、不存会话）；Codex 调共享 app-server 的 `skills/list`，只取 enabled。前端按会话 + Provider 缓存 60 秒。
- 发送时服务端再解析一次，开头 `$name` 不是已知 skill 就原样发：Claude / DeepSeek 改写成 `/name 其余文本` 推入 Streaming Input；Codex 保留文本并追加 `{ type: 'skill', name, path }`（path 由服务端查，不信任客户端）。实测 Codex steer 只带 skill 项、文本不含 `$name` 时模型会忽略该 skill。
- 开头 `$name` 在当前会话的 skill 列表里时着琥珀色，`@` 引用（前面是开头或空白）着蓝色：输入框由 textarea 背后同排版的背景层代为显示文字，消息气泡渲染为标签；列表与补全共用缓存，只有出现 `$` 开头的消息才拉取。
- 事件流存用户原文 `$name …`。一轮进行中插入：Claude 在当前轮结束后接着执行 skill，`idle` 等它执行完才到；Codex steer 进当前轮。

## `/compact` 手动压缩

- 消息开头是 `/compact` 时触发，是唯一放行的内置命令（不改会话身份、模型、权限）。事件流照常存用户原文，显示为一轮普通的"运行 → 完成"，不新增事件类型。
- Hub 前置校验：运行中 / 等待中 409（压缩独占一轮，不插入）；空会话 409；不能带附件；Codex 不接受附带指示（`/compact 其余文本` 400），Claude / DeepSeek 原样透传给 SDK 作为压缩指示。
- Claude / DeepSeek：原文推入 Streaming Input，SDK 依次发 `status: compacting` → `compact_boundary` → `result: success` → `idle`；`compact_boundary.compact_metadata.post_tokens` 映射为 `context.updated`（自动压缩同样生效）。
- Codex：改调 `thread/compact/start`（回包为空），随后 `turn/started` → `contextCompaction` item → `turn/completed`；turnId 从 `turn/started` 取，压缩中可中断。压缩那轮 `tokenUsage.last.inputTokens` 为 0，忽略，上下文数字等下一轮更新。
