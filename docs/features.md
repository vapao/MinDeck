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

输入框草稿（localStorage 按会话）；用户消息 hover 出现 Copy（触屏常显）；每轮落款（Completed / Stopped）右侧有 Copy，复制这轮最后一段回复的原文 Markdown，便于转贴给其他会话（中间过程段落不单独提供复制）；「新开一轮」（同 cwd / provider 新建会话，等价 `/clear`，弹窗可选删除旧会话）；会话通知；头部显示当前模型。

- 发送收到成功回执后才清空输入框和附件；请求期间锁定编辑及重复发送，发送按钮显示 loading 转圈（减少动态效果偏好下不旋转）。发送失败保留原文、文字草稿和当前页面的已上传附件，错误在输入框上方完整显示，用户手动重试。文字草稿刷新后仍在；附件仍沿用当前页面内存保存，不跨刷新恢复。不自动重发、不新增服务端去重协议；回执丢失时可先核对聊天记录再重试。

- 通知沿用会话列表每 5 秒轮询比对状态，后台仍轮询；首次加载只记录基线。running / waiting_user 变为等待处理、完成或失败时提醒，同状态不重复。
- 页面可见且窗口有焦点才算前台：当前会话不提醒，其他会话在右下角显示站内提醒，不依赖系统通知权限；提醒持续停留，不自动消失，点击进入对应会话或手动关闭后移除，同会话只保留最新一条，进入该会话时也移除提醒。
- 窗口失焦或页面隐藏时，通过浏览器 `Notification` 发系统通知（需已授权），包括当前打开的会话；点击唤起窗口并进入对应会话。页面关闭后不通知；浏览器后台节流或冻结可能延迟提醒，未接 Web Push。

## 切片 8：项目与设置

`workspaces` 表 + 目录浏览（限家目录内，弹窗内选）添加、别名、移除，首次启动种入本仓库。添加成功直接弹出新建会话并选中该项目；项目行可新建会话，桌面另有 Finder / iTerm2。新建会话是全局弹窗（不占路由）：项目页、侧栏分组头 hover 的 `+`、侧栏 New session（带上当前会话的项目）都可打开并预选项目，没带时用上次新建所选；项目选择框可按别名 / 路径搜索。设置页：各 Provider 默认模型与 effort，创建会话时传给 Provider，靠 init 回包校验。

## 切片 9：删除会话

只允许 idle / error（否则 409）。级联删 events / pending_requests / attachments 及 `data/uploads/<id>/`；Provider 原生记录（`~/.claude/projects`、Codex thread）不动。

有子会话（按 `parent_id` 递归，含孙会话、子会话的分叉，不分 Active / Inactive）时，确认框选「Delete with N sub-sessions」（主按钮，`DELETE ?descendants=true`）或「Delete this only」（子会话留作独立会话）；× / Esc 取消。整棵树先整体检查，任一会话 running / waiting_user 即 409 并列出标题，一个都不删。

删除当前会话后，手机布局（< 1024px）返回会话列表；桌面优先进入同项目最近活跃的 Active 会话，其次任意 Active 会话，没有其他会话才回首页。在别处删除当前会话时也遵循此规则。

## 切片 10：改动侧栏（桌面）

cwd 内查看 Git 改动和文件；`turn.completed` 与写类工具完成后节流刷新。diff 由服务端返回 HEAD 与工作区两份全文（HEAD 中没有时原文为空，已删除时现文为空；二进制或任一侧超过 512 KiB 时只提示），点击列表中的文件打开预览弹窗，默认显示 diff，标题栏可切到 File（即普通预览，可编辑）；diff 用 `@codemirror/merge` 的单栏合并视图渲染，带语法高亮、行内改动标记，未改动区域折叠。重命名文件按新路径显示为整份新增。cwd 不是仓库时向下找两级子仓库合并展示，没有仓库时显示提示；cwd 是仓库子目录时只列该目录内的改动。

diff 弹窗底部提供 `Discard changes`；列表不显示回退按钮，必须通过确认弹窗。基准为当前分支最近一次提交（HEAD），同时还原工作区和暂存区：修改恢复原内容，删除恢复文件，新增（含未跟踪、已暂存及尚无首次提交的仓库）删除文件并移出暂存区。这会丢弃该文件所有未提交改动，包括本会话开始前的修改；不提供撤销，也不是回退某一轮 Agent。成功后关闭弹窗，刷新改动列表、目录树和文件预览。弹窗打开期间列表可能刷新，丢弃时按路径取最新 Git 状态；不可丢弃或有活跃任务时提示原因。

只支持单文件；重命名 / 复制、合并冲突、子模块禁用。接口重新读取 Git 状态，HEAD 或恢复 / 删除动作与确认时不同则拒绝；路径限 cwd 内，不沿父目录符号链接、不接受目录或 `.git` 路径，文件名按字面匹配。叶子符号链接只操作链接本身。同仓库或覆盖该仓库的工作区有 running / waiting_user 会话或 Agent 后台任务时禁用；回退期间阻止相关会话新一轮和并发回退。外部编辑器、终端进程不受 Hub 锁保护。

## 切片 11：`@` 文件引用

`GET /api/sessions/:id/entries?q=`：相对 cwd，`~` 展开为家目录；直接子项在前、深层匹配在后，目录以 `/` 结尾可继续敲；cwd 内递归限 4 层 / 3000 项 / 1.5s，`~` 下只列直接子项。弹层支持上下键 / Enter / Tab / Escape。路径含空格时插入 `@"a b/c.md"`（选目录时引号不闭合，可继续往里补全），着色与补全都识别引号形式。

**未做**：会话中切模型（Codex 按轮传 model / effort 简单；Claude 只有 `setModel()`，effort 需 resume 重开）。

## `#` 会话引用

- 输入框在行首或空白后输入 `#` 补全其他会话，支持按标题、项目、Provider 或 ID 搜索；当前项目优先，组内沿用最近更新排序，包含 Inactive 会话。候选显示标题、项目、Provider 和短 ID。
- 上下键选择，Enter / Tab 插入，Escape 关闭；`@` 仍只补全文件，`$` 仍只补全 skill。
- 插入 `#[标题](session:ID)` 纯文本引用，草稿与消息保留完整 ID；消息气泡显示可点击的 `#标题`。仅传引用，不自动注入历史，Agent 按需调用 `get_session` 读取；标题变化不影响 ID 定位。

## 切片 12：Active / Inactive

`sessions.archived_at`、`PATCH /api/sessions/:id { archived }`（running / waiting_user 409；给归档会话发消息自动取消归档）。侧栏两个页签共用分组列表：分组按组内最近活动排、可折叠（localStorage），折叠后仍露出 running / waiting_user 会话。Active 行 hover 可移到 Inactive / 永久删除（仅桌面、idle / error）；Inactive 行 hover 可移回 / 永久删除。会话页头部固定为「删除」；「新开一轮」在发送按钮左侧。图标 `EyeOff` / `Eye`。

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
- 每 2 秒读取本机 `/api/sessions`（端口沿用 `AGENTDECK_PORT`，默认 8004），只有所有会话均为 idle / error 且没有后台任务才构建；running / waiting_user 和后台任务都阻止更新。构建后再次等空闲，再调用现有 `restart`。
- 空闲检查共用从进程启动起的 10 分钟期限；连接拒绝、连接重置、套接字断开或请求超时会在阶段期限内限时重试（最多 60 秒）；HTTP / 数据错误、重连超时或构建失败会记录具体阶段、接口和原因并退出，不重启。构建命令自身不受该期限强制终止。同一时间只允许一个后台更新任务，重复调用不会再次安排；不是常驻任务，机器重启后不恢复。
- 后台任务原子写入 `data/update-status.json`，`GET /api/update-status` 返回最近一次更新及本次 Hub 的实例 ID；重启后最多等待 60 秒，确认新实例可访问才记成功。失败、取消或后台进程意外停止都会显示失败。
- 顶部独立更新通知每 5 秒查询更新状态，显示等待 / 构建 / 重启 / 成功 / 失败和时间；不会自动消失，关闭只针对本次更新的当前阶段，后续结果仍会出现。关闭浏览器后重开仍可查看未关闭的最近结果；成功提供 Refresh 按钮，不主动刷新页面。状态文件与 SQLite 位于同目录，日志仍在项目 `data/logs/`。
- 保留 `update` 的立即构建并重启行为（不生成上述通知）。空闲轮询不锁住新消息，最终检查与重启之间仍有短暂竞争窗口，不提供严格的无中断升级保证。

## 切片 15：会话编排 MCP

`POST /mcp` 无状态 Streamable HTTP（`src/mcp.ts`）：`list_workspaces` / `list_sessions` / `create_session(provider, prompt, workspace?)` / `get_session(id, afterSeq?, waitSec?)`（最多 40 条；`waitSec` ≤ 600）/ `send_message` / `interrupt` / `move_session(id, parent?)`。

- **读取范围**：`get_session` 的记录只含用户消息、助手回复、错误和中断，不含工具调用；筛选后取最近 40 条，超过时标记 `truncated`。另外返回当前状态和待处理的审批 / 问题；`nextSeq` 用于后续增量读取。
- **只给 Hub 拉起的会话用**：按会话注入（Claude `mcpServers`、Codex thread `config.mcp_servers`），请求头 `x-agentdeck-session` 标识调用方，缺失或未知 403。请求头不是安全边界（REST 无鉴权）。
- **派生必须审批**：`create_session` 由 Hub 在调用方会话弹审批卡（与权限模式无关），批准后按设置默认值建会话并发首条消息。派生授权（该会话之后派生免审批，供用户离开时让监督会话自主派活）有两个入口：会话顶栏的开关（事先打开需二次确认，可随时关掉），或卡上的"本会话允许"。授权落库、只给该会话、子会话和分叉不继承，Hub 重启后仍有效，关掉开关或删除会话即失效；子会话仍按设置默认权限模式跑，无人值守需先把默认改成 bypass。`send_message` / `interrupt` / `move_session` 按调用方权限模式走 Provider 审批（Codex 为 elicitation，见方案 §16.3）；只读工具与 `create_session` 在 Provider 侧免审。不能对自己的会话 send / interrupt / 等待。
- **定位**：把对话里已定的需求整理成交接单派给新会话，用户之后接管；prompt 取材于对话，不为写 prompt 查仓库、不转述项目规则、不加活。
- **结果回调**：`notify` 默认 false，仅父会话需要结果才能继续时开启；不等待 / 轮询。子会话本轮处理完（idle / error）时 Hub 发 `[AgentDeck] Session … finished`（含最后回复）给父会话；回调只在内存，Hub 重启即丢。同一父会话在用户未发消息时最多被自动唤醒 5 次（有派生授权时 30 次），超出改记 error，用户发消息后清零。
- **预约压缩**：`compact_after_turn(instructions)` 只作用于调用方自己的会话（Claude / DeepSeek；Codex 400），Provider 侧免审。Hub 在内存记下，本轮正常结束（idle）时以 `agent` 身份发 `/compact <instructions>`；本轮中断 / 失败则作废，发送失败（如工作区有文件操作）记一条 error 不重试，Hub 重启即丢。压缩期间到达的 `notify` 回调照常插入，SDK 排在压缩之后、在新上下文里处理，整段只报一次 `turn.completed`（已用 SDK 0.3.284 验证）。用户中断压缩那一轮时排队中的回调随 `cancelQueued` 丢弃，父会话可用 `get_session` 补读。
- **自适应压缩提示**：Agent 看不到自己的上下文用量，由 Hub 判断阈值。Hub 在内存记各会话最近一次 `context.updated`；Claude / DeepSeek 会话一轮正常结束（idle）时若 ≥ 150K、本轮没预约压缩、没有后台任务，Hub 以 `agent` 身份单独发一条提示，要求它调 `compact_after_turn` 写明要保留什么后结束本轮，不让它判断要不要压（压缩约等于多跑一个请求，之后的请求都少带大量上下文）。提示那一轮结束时不再提示，Agent 没预约就等下一轮。代价：会话多跑提示和压缩两轮，Finished 通知要等压缩完才到；提示与回复在聊天界面可见。发出 `/compact`（预约或手动）时清掉记录，等压缩后的新值。Hub 重启后要等下一次上下文上报。
- **压缩后续跑**：`compact_after_turn` 可选 `continueWith`。Hub 发出 `/compact` 后紧接着以 `agent` 身份插入这条消息，与压缩期间到达的回调同一路径，排在压缩之后处理；用户中断压缩时一并丢弃。等子会话回调或用户回话时不需要传。
- **隶属关系**：`create_session` 建的会话记 `sessions.parent_id`（调用方会话），用户手动新建为 null，fork 沿用源会话的；之后只能经 `move_session` 改（省略 `parent` 即移到顶层），用于把一条工作线拆成平级会话：先建新会话、移到顶层，再把相关子会话挂过去。不能挂到自己或自己的后代下（400，防成环）。汇报对象跟着父级走：原父会话登记、还没触发的 `notify` 回调转给新父会话，移到顶层则丢弃；其他会话登记的回调不动。新父会话要靠交接单知道自己接手了哪些子会话。侧栏里子会话挂在父会话下缩进一级（孙会话挂直接父会话、缩进不再加深），整棵树按其中最近活动排；折叠分组时子会话需要关注，父会话一并露出。父会话不在同一页签或同一项目（跨项目派生、只有一方归档）时照常排，行内注 `↳ 父标题`；父会话已删除则不显示任何关系。会话页顶栏有回到父会话的按钮。加列前的派生会话无法回填。
- **不暴露**：resolve 审批、设置与 Key、删除、项目增删。

## 切片 16：项目服务 MCP

`list_services(workspace?)` / `create_service(name, command, subdir?, url?, workspace?)` / `update_service(id, …)` / `start_service` / `stop_service` / `restart_service` / `get_service_log(id, cursor?, lines?)`，复用切片 14。`workspace` 省略取调用方项目。创建只存配置，更新只改传入字段，运行中更新需重启生效；启动立即返回；日志首次取末尾 100 行（最大 1000），超出标 `truncated`。不暴露删除。写操作按调用方权限模式由 Provider 审批，Hub 不另弹卡。

## 切片 17：分叉 / 原地回退（CLI `/rewind`）

悬停在开启一轮的用户消息上出现「Rewind」：**Fork** 保留原会话；**Rewind in place** = 分叉后删原会话（不改写原事件流，会话 id 变化）。每轮落款上的「Fork」用于分头讨论不同方向：不确认、输入框留空，直接跳到新会话；后面还有轮次时等同于从下一条消息之前分叉，最后一轮则从末尾分叉。

- `POST /api/sessions/:id/fork { beforeSeq?, rewind }`，省略 `beforeSeq` 即从末尾分叉；idle / error 才行。
- 分叉来源记在 `sessions.forked_from_id` / `forked_at_seq`（分叉点 = 保留到的最后一条 seq，源会话与新会话里同号）；原地回退、第一轮前分叉不记。分叉点挂在它之前最后一个落款 / 报错下面：源会话显示「Forked here」+ 各分支链接，分叉会话显示「Forked from」+ 源会话链接；源会话已删除则不显示。侧栏不变，分叉与源会话平级（沿用源会话的 `parent_id`）。加列前的分叉无法回填。
- 与派生回调（切片 15 `notify`）：分叉是新 id，不继承任何回调，父会话只收原会话的结果。分叉一个还在等子会话回调的监督会话时，回调仍只回原会话，分叉会话收不到，需用户让它用 `get_session` 自取（有意不复制回调，避免两个监督会话同时驱动一个子会话）。
- 各分支共用同一工作目录，适合讨论；分头改代码会互相覆盖。
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

Files 支持在项目根目录或指定子目录新建空文件 / 文件夹，重名不覆盖；文件行、目录行和搜索结果提供确认后永久删除，删除文件夹包含全部子项。写入限定 cwd 内，保护根目录、Git 元数据和符号链接边界；活跃任务期间禁用。只修改工作区，不改暂存区；暂不提供文本编辑。具体交互与限制见 `docs/file-preview.md`。

## `$` 调用 skill

- 输入框底部指令按钮（手机免切符号键盘）弹出小菜单，各项只往输入框填内容，不直接发送：`$` 插到消息开头并弹出 skill 补全，已有 skill 会被替换、原文保留在后面；`#` 插在光标处（前面不是空白就补一个空格）并弹出会话补全；`/compact` 见下。
- 三个 Provider 统一用 `$` 触发，**只在消息开头生效**（Claude 的 slash 命令只认开头的一个）。输入框光标前整段是 `$xxx` 时弹出候选，按 name 子串过滤，交互同 `@`，选中插入 `$name `。
- `GET /api/sessions/:id/skills` 只列 skill、不含内置命令（`/clear`、`/model` 等会和 Hub 状态冲突）：Claude / DeepSeek 起空 Streaming Input 调 `reloadSkills()`，再合并 `supportedCommands()` 中非内置的用户命令，按名称去重，让 `disable-model-invocation: true` 的手动 skill 也能补全和通过 `$name` 调用（约 2 秒，不调模型、不存会话）；发送时使用相同规则识别，保留禁止模型自动调用的设置。服务端按 cwd 缓存：命中直接返回，超过 60 秒后台刷新（新增的 skill 晚一次请求出现）；Codex 调共享 app-server 的 `skills/list`，只取 enabled，同名只留第一条；补全列表再去掉 Codex 内置（`scope: system`）和插件带的（有 `pluginId`）——只是不显示，发送时解析不过滤，Agent 照样能用。前端打开会话即预取，按会话 + Provider 缓存 60 秒。
- 发送时服务端再解析一次，开头 `$name` 不是已知 skill 就原样发：Claude / DeepSeek 改写成 `/name 其余文本` 推入 Streaming Input；Codex 保留文本并追加 `{ type: 'skill', name, path }`（path 由服务端查，不信任客户端）。实测 Codex steer 只带 skill 项、文本不含 `$name` 时模型会忽略该 skill。
- 开头 `$name` 在当前会话的 skill 列表里时着琥珀色，`@` 引用（前面是开头或空白）着蓝色：输入框由 textarea 背后同排版的背景层代为显示文字，消息气泡渲染为标签；列表与补全共用缓存。
- 事件流存用户原文 `$name …`。一轮进行中插入：Claude 在当前轮结束后接着执行 skill，`idle` 等它执行完才到；Codex steer 进当前轮。

## Claude 后台任务

- 后台 Bash（`run_in_background`）不拦 `session_state_changed: idle`：Agent 先结束本轮（记 Completed、置 idle），任务结束后 SDK 自动唤醒它继续。唤醒时的 `session_state_changed: running` 映射为 `turn.started`，Hub 若仍是 idle 就落库并置 running；Hub 自己发起的轮次已是 running，丢弃这条。
- `background_tasks_changed`（全量列表、替换语义）去掉 `ambient` 后的数量只记在 Hub 内存，随 `/api/sessions` 以 `backgroundTasks` 返回；Provider 进程退出或 Hub 重启即清零。
- 后台任务未结束时：会话仍是 idle（照常 Finished 通知、可发消息 / 删除 / 归档），列表显示 Background，输入框上方提示会自动继续。只有 update-when-idle 会等它：重启会杀掉后台任务，Agent 不会再被唤醒。常驻后台进程（如 dev server）会让更新一直等到 10 分钟超时。
- 未覆盖：MCP 子会话回调（`notify`）和 `get_session` 的 `waitSec` 仍只看 status，子会话起后台任务时会提前回报。

## `/compact` 手动压缩

- 指令菜单里的 Compact context 把 `/compact` 填到消息开头（已有草稿保留在后面，Claude 会当作压缩说明；Codex 带说明会被拒），由用户自己发送；运行中、等待中、空会话时置灰。
- 消息开头是 `/compact` 时触发，是唯一放行的内置命令（不改会话身份、模型、权限）。事件流照常存用户原文，显示为一轮普通的"运行 → 完成"，不新增事件类型。
- Hub 前置校验：运行中 / 等待中 409（压缩独占一轮，不插入）；空会话 409；不能带附件；Codex 不接受附带指示（`/compact 其余文本` 400），Claude / DeepSeek 原样透传给 SDK 作为压缩指示。
- Claude / DeepSeek：原文推入 Streaming Input，SDK 依次发 `status: compacting` → `compact_boundary` → `result: success` → `idle`；`compact_boundary.compact_metadata.post_tokens` 映射为 `context.updated`（自动压缩同样生效）。
- Codex：改调 `thread/compact/start`（回包为空），随后 `turn/started` → `contextCompaction` item → `turn/completed`；turnId 从 `turn/started` 取，压缩中可中断。压缩那轮 `tokenUsage.last.inputTokens` 为 0，忽略，上下文数字等下一轮更新。

## 定时任务

- 侧栏 / 手机底部 tab 的 Automations 页（路由仍是 `/schedules`）：到点在指定项目新建一个会话并发出 prompt。周期三选一：一次性（本机时区的日期时间）、每天、工作日（周一到周五，**不处理法定假日和调休**）。每次执行都新建会话，标题为"任务名 · 日期"（先占住标题，AI 标题不覆盖）。
- 调度在 Hub 进程内：`schedules` 表 + 每 30 秒检查一次，启动时立即检查一次。先用条件更新推进 `next_run_at`（认领）再建会话，同一次到期最多执行一次；下一次从当前时间算，不逐次补跑。
- 错过（Hub 重启、宕机）：过期 1 小时内的启动后补跑一次；更久的只在 `last_error` 记一条 Missed，不执行。执行失败（项目被移除、Key 未配等）也记在 `last_error`，不重试。一次性任务执行或错过后自动关闭。
- model / effort 保存具体值（空 = Provider 默认）；权限模式存在任务上、不跟设置走，默认 approval，选 bypass 时前端二次确认。approval 模式下首个审批会停住等人，此时会话是 waiting_user，`update-when-idle` 会一直等它。
- Run now 立即执行一次，不影响下次执行时间。
- MCP（`src/mcp.ts`）：`list_schedules` / `create_schedule(name, provider, prompt, kind, time, workspace?, model?, effort?)` / `update_schedule(id, …)`（只改传入字段）/ `delete_schedule(id)`。写操作先校验再由 Hub 在调用方会话弹审批卡，**每次都弹，不提供"本会话允许"**（任务会无人值守执行）；Provider 侧免审。model / effort 省略取设置默认值并存成具体值；权限模式创建时取该 Provider 设置里的默认值，卡上展示，MCP 不能改（换 Provider 也保留原值），要改只能在页面上。不暴露 Run now。
- 未做：任意 cron 表达式、自选星期、完成推送。

## Inbox（2026-11-04）

方向：工作模式逐步转向 Agent 自主运行，用户只处理汇报和决策。Inbox 是首页（`/`），汇总所有需要用户处理的事。

- 三类事项：
  - **Blocking**：卡着一轮的审批和同步提问（会话 waiting_user），在 Inbox 详情里直接用原审批卡 / 提问卡处理。
  - **Decide**：异步提问——Agent 经 MCP `ask_user` 提交的待决定事项，以及 Codex 的非阻塞提问（规则 14）。答案作为一条用户消息发回原会话并唤醒它（运行中则插入当前轮）。可 Dismiss：不答就关掉，记为作废，不通知 Agent。
  - **Report**：Agent 经 MCP `report_to_user` 提交的汇报，只读，Mark as read 后进 Done。
- `ask_user(question, details?, options?, multiSelect?)`：存为 `pending_requests` 里 `kind: 'question'`、`delivery: 'async'`、`filed: true` 的一行，不挂起调用方、不改会话状态，提交即返回。`filed` 事项 **Hub 重启不作废**（其余待处理请求照旧作废）；用户中断提交它的那一轮时作废（之前几轮提交的不动）；会话删除时随会话删除。会话流里显示为非阻塞提问卡（说明按纯文本），Inbox 里问题作标题、说明按 Markdown 渲染。
- `report_to_user(title, summary, body)`：存 `reports` 表，随会话删除。两个工具 Provider 侧免审。
- REST：`GET /api/inbox`（待处理请求 + 未读汇报；`?done=true` 为已处理的异步提问（带答案）与已读汇报，各最近 50 条）、`POST /api/pending/:id/dismiss`（只限异步提问）、`POST /api/reports/:id/read`。前端 5s 轮询，侧栏角标与手机 tab 角标共用。
- Agent 是否使用这两个工具取决于它自己的判断和任务 prompt；定时任务的 prompt 里要写明"待决定事项用 ask_user 提交，结论用 report_to_user 汇报"。
- 新提问和汇报会推送到手机，见「推送到手机」。

## Automations 与唤醒（2026-11-04）

- 定时任务执行时新建的会话记 `scheduleId`（`sessions.schedule_id`）。它们**不进 Active 侧栏**，只在 Automations 页该任务的 Recent runs 里（最近 6 次，按创建时间倒序）；正在跑、等你（waiting_user）、Inbox 里有它的事项、或正在看时才出现在侧栏。分叉出来的会话不带 `scheduleId`，回到侧栏。归档后照常在 Inactive。
- Recent runs 芯片：日期 + 状态点（蓝 = 运行中、琥珀 = 等你或有未处理事项并注明条数、红 = 出错、绿 = 正常结束），点击进会话。错过 / 执行失败仍只显示在任务的 `lastError`。
- MCP `wake_later(note, inMinutes | at)`（二选一，`at` 为本机时区 `YYYY-MM-DDTHH:mm`，须晚于现在；Provider 侧免审）：存 `wakeups` 表，到点由调度器（30 秒一次的 tick）把 `[AgentDeck] Wake-up you scheduled at …: <note>` 作为消息发回同一会话（运行中则插入当前轮）。先删后发，同一个最多发一次；Hub 停机期间到点的启动后照发；发不出去（如项目正在做文件操作）在会话里记一条 error，不重试。用户中断某一轮时，这一轮预约的唤醒作废；会话删除时一起删。
- Automations 页的 Upcoming wake-ups 列出全部待触发唤醒（时间、note、会话），可取消（`GET /api/wakeups`、`DELETE /api/wakeups/:id`）。Agent 侧没有取消工具。
- 未做：自动唤醒的次数上限（bypass 会话可以无限续约，靠 Upcoming 列表人工发现）。

## 没收尾提醒与待办（2026-11-04）

解决"做到一半的事被忘掉"。用户习惯是验证没问题也不会回会话说一声，所以宁可多提醒，由用户在 Inbox 里删或忽略。

- **没收尾判断**：调度器每次 tick（30 秒）判断一个会话，用 AI 标题的 Provider / 模型（AI 标题关闭时不做）。对象是空闲（idle / error）满 24 小时、没归档、不是定时任务运行、不是子会话（父会话已删的算顶层）、有过 Agent 回复、这次活动还没判断过的会话，新近空闲的优先。输入是最近 12 条消息（单条超 1500 字留头尾，总长不超过 8000 字），输出 `done` / `open` + 会话概况（这个会话在做什么、现在停在哪，2–3 句，给已经忘了它的人看）+ 一句"下一步"。只有明确收尾（问题答完无后续、用户确认 / 关闭 / 放弃）才算 done；做到一半、stash 暂停、等用户验证或预览、等用户拍板、等外部都算 open。
- 结果存在会话上（`review_for` / `review_state` / `review_summary` / `review_next`），**只对判断时那次活动有效**：会话再有活动（`updated_at` 变了）结论即失效，再空闲满 24 小时重新判断。概况上线前判为 open 的（`review_summary` 为空）会被重新判断一次补上概况。请求失败（网络、额度、超时）整体暂停 30 分钟、不记结果；模型答非所问记为失败、这次活动不再重试。
- open 的进 Inbox（Unfinished work 段）：Continue（进会话）/ Later…（以会话标题和下一步预填，转成关联该会话、默认一周后提醒的待办）/ Done, delete session（走会话删除确认，可连子会话）/ Dismiss（保留会话，直到有新活动）。`POST /api/sessions/:id/review/dismiss`。
- **自动归档**：判为 done、之后再没活动、空闲满 7 天的会话移到 Inactive（随时可移回，发消息也会自动回到 Active）。这是"只有用户手动归档"之外唯一的自动归档。
- **待办**（`todos` 表，`/todos` 页，侧栏主导航与手机 tab）：标题、备注、项目（存路径，可空）、提醒日期（本机本地日期，可空）、关联会话（可空）；状态只有未完成 / 完成。到提醒日期当天起进 Inbox（Reminders 段），可 Done / 推到明天 / 推一周 / 编辑。删除关联会话时待办保留、关联置空。
  - 来源：Todos 页输入框回车即加，New todo 填全字段；会话页顶栏 Create todo 用 AI 标题模型从最近对话起草标题和备注（`POST /api/sessions/:id/todo-draft`，AI 标题关闭时 400，弹窗留空手填）；Inbox 的 Later…；Agent 经 MCP `add_todo(title, note?, remindOn?)`（关联调用方会话与项目，Provider 侧免审）。
  - 带关联会话新建待办时，该会话的 Unfinished 一并从 Inbox 移除。
  - REST：`GET /api/todos?done=`（未完成按提醒日期、没日期的在后；完成的按完成时间倒序最近 100 条）、`POST /api/todos`、`PATCH /api/todos/:id`（只改传入字段，`done` 切换完成）、`DELETE /api/todos/:id`。
- 未做：待办的排序 / 分组 / 优先级、重复提醒、到点推送。

## 密钥（2026-11-08）

解决"Agent 要密钥时只能贴进对话，或让用户自己建文件"。目标是让值不进对话和日志，Agent 下次能自己找到并使用；**不是隔离**。

- **存储**：`secrets` 表（`workspace_id` 为 `''` 是 Shared，否则只对该项目可见；`(workspace_id, name)` 唯一，同一作用域同名即覆盖）。值明文存在 `data/agentdeck.db`，拷库 / 备份会连同密钥一起带走。删除项目时其私有密钥一并删除。
- **请求**：MCP `request_secret(name, description, shared?)`，名字限环境变量风格，默认本项目私有（调用方 cwd 必须是项目）。走 `ask_user` 同一套 filed 异步提问（`kind: 'question'` 带 `secret` 字段），会话流与 Inbox 显示为密码输入卡；名字、说明、作用域只读，填错就 Dismiss 让 Agent 重提。保存后以一条只含名字的消息唤醒会话。
- **值只在 `secrets` 表里**（有测试）：卡片提交的值经 `resolution.response` 传到 Hub，Hub 存表后以 `answers: {}` 结算，`pending_requests`、`user_input.resolved` 事件、发回会话的消息都不带值。
- **查与用**：MCP `list_secrets` 只返回本项目私有和 Shared 的名字、说明、作用域（同名私有优先），不返回值，附带用法。Agent 在 shell 里用 `$(node <repo>/scripts/secret.mjs get NAME)` 取值，脚本按当前目录（解析软链接后取最长匹配的项目）判断作用域，读不到时非零退出。
- **管理**：Settings 页最下方 Secrets 分组，即时生效、不归 Save changes 管：列表（名字、作用域、说明）、点眼睛单独取值显示（`GET /api/secrets/:id/value`）、新增 / 覆盖、编辑说明与作用域（目标作用域已有同名时 409）、删除。REST：`GET/POST /api/secrets`、`PATCH/DELETE /api/secrets/:id`。
- 边界：Agent 有 shell，直接读库能拿到所有项目的密钥；命令输出若回显了值（如报错打印请求头）仍会进上下文；Agent 被注入的指令诱导外发也拦不住，token 尽量给最小权限。
- 未做：Keychain、加密、过期、按会话注入环境变量、命令占位符替换。

## 管家 Steward（2026-11-08）

解决"要一个个点开会话、Inbox 才知道现在什么情况"。管家汇总现状、判断哪些要用户处理，对话长期连续、记得用户偏好，用户不需要关心上下文用量。v1 只看和说，不替用户操作会话。

- **入口**：侧栏 Inbox 上方的 Steward（`/steward`），有没看过的新简报时显示圆点；手机端是底部第一个 tab（Brief / Memory / Chat 三个子 tab）。
- **简报**：工作日按 Settings → Steward 的时间（默认 08:00，主机本地时间）由调度器自动跑一次（Hub 停机错过的，1 小时内启动后补跑，更晚不跑；当天跑过就不再跑），页面上 Run brief 随时跑。Hub 把现状快照连同要求发给管家，管家调 MCP `publish_brief(body)` 发布 Markdown 简报（Needs you / Watch / Can clean up，会话写成 `[标题](session:ID)`，点了进会话页），存 `steward_briefs` 表。页面顶部显示最新一份，可翻看历史。自动跑失败记在页面上，不重试。
- **现状快照**由 Hub 组装，不让管家自己查：近 14 天未归档会话（状态、项目、没收尾判断的概况与下一步）、待处理的审批与提问、未读汇报、未完成待办、定时任务（下次执行、最近错误）、项目服务运行状态、各项目未提交文件数。聊天中管家可随时调 `work_snapshot` 取最新一份，用 `get_session` 看某个会话的细节。
- **长期记忆**：`steward_memories` 表，一条一句。管家在用户说出长期偏好、规则、目标或要求记住时调 `remember(text)`，过时了调 `forget(id)`；易变的状态不进记忆。页面右栏列出全部记忆，用户可增、改、删；用户改过后，管家下一条消息开头会收到最新记忆。
- **连续对话 = 底层轮换会话**：管家的每段对话是一个带 `steward` 标记的普通会话，cwd 固定为 `data/steward/`（服务端生成，不在项目列表里），权限模式固定 approval，标题 `Steward · 日期`。不进侧栏、会话列表、MCP `list_sessions`，也不做没收尾判断和压缩提示。用户发消息或跑简报时，沿用最近一个管家会话，除非它不是今天建的、上下文已到 150K、或者 Provider / 模型 / 思考等级和设置不一致——此时新建一个（运行中的不换）。新会话的第一条消息前，Hub 只对 Provider 附上管家说明、全部记忆、最新简报和上一个会话的最后 12 条消息（界面上仍只显示用户原文）。页面只显示最近一个会话的对话流，之前的按日期列在下方，点开进普通会话页。
- **模型**：Settings 页 Steward 分组选 Provider / 模型 / 思考等级，默认 Codex + Provider 默认模型。改了之后下一条消息起换到新会话。
- **v1 只读**：管家的 MCP 只有只读工具（`list_workspaces` / `list_sessions` / `get_session` / `list_services` / `get_service_log` / `list_schedules`）、`add_todo`（不关联项目）和上面四个管家工具；不能派生、发消息、中断、改服务和定时任务。
- REST：`GET /api/steward`（当前会话、历史会话、简报、记忆、下次与最近一次自动简报）、`POST /api/steward/messages`（`{ text }`，不支持图片）、`POST /api/steward/brief`、`POST /api/steward/memories`、`PATCH / DELETE /api/steward/memories/:id`。
- 未做：替用户操作会话、旧对话检索、推送、简报卡片上的快捷操作、自定义星期（目前只有工作日）。

## 推送到手机（2026-11-08）

开发者的主力手机是国行小米（HyperOS），连不上 FCM，Web Push 不可靠，所以走 Spug 推送 App（厂商通道，不依赖 Tailscale）。手机不在前台时也能知道哪个会话跑完了、要处理什么。

- **通道**：Hub 向 Shared 密钥 `SPUG_PUSH_URL` 的地址 POST `{"channel":"app","type":"markdown","title","content"}`，标题截到 32 字。没配这个密钥就不推；删掉即关闭。失败（响应体 `code` 不是 200 或网络错误）只打日志，不重试。
- **什么时候推**（`push.ts`，在 `hub.ts` 调）：
  - 会话一轮"在跑"之后落到 Finished / 等待处理 / Failed，与站内通知同一规则；用户中断的不推。标题 `✅ / ⏳ / ❌ 会话标题 · 项目`，正文分别是这轮最后一段回复全文、待处理的审批（命令一行摘要）或提问（问题和选项）、错误信息。
  - 落点之后同步处理完再判断：一轮结束紧接着发出压缩时，等压缩那轮结束才推（这时正文是压缩那轮的回复）。
  - 父会话经 `notify` 等着结果的子会话结束时不推，由父会话收尾时推；子会话等审批照推。管家会话不推。
  - 异步提问（MCP `ask_user` / `request_secret`、Codex 非阻塞提问）提交时推 `❓`，`report_to_user` 推 `📋 标题`，正文为摘要和全文。
- **有设备在前台就不推**：页面可见且窗口有焦点时每 10 秒 `POST /api/presence { clientId, visible }`，离开前台立刻报 `visible: false`（`keepalive`）；超过 25 秒没报算离开。任一设备在前台时都不推，只在内存里。
- **链接**：正文末尾带 `Open session` 链接，域名取最近一次经 Tailscale 上报前台时的 Host（存 settings 表 `publicOrigin`），本机直连的不记；还没记到时不带链接。点开需要手机连着 Tailscale。
- 正文直接带回复全文，不做脱敏（开发者明确不在意）。4K 字符正文实测可推。
- 未做：推送开关 UI、按事件类型过滤、合并节流、管家简报推送。
