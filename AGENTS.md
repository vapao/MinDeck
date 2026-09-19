# AgentDeck

Mac Mini 上自托管的 Claude / Codex 多端控制台：Agent 在 Mac Mini 上跑，MacBook / iPhone / 浏览器通过 Tailscale 发消息、传截图、看流式输出、处理审批。单用户，不做 SaaS。

本文是给任何 AI 编码助手（Claude Code、Codex 等）和人的统一入口。`CLAUDE.md` 只是对本文的引用。

## 必读文档

| 文档 | 内容 |
|---|---|
| `docs/remote_agent_hub_technical_plan.md` | 技术方案 v1.1。架构、Provider 设计、统一事件协议（§7）、持久化（§12）、技术栈（§13）、API（§14）、分期（§15）、P0 验证记录与设计影响（Claude §16.1、Codex §16.2） |
| `docs/ui-design-spec.md` | UI 设计规范：token、事件→组件映射、页面布局、实现约定。前端实现以它为准 |
| 设计稿 | https://claude.ai/artifact/Q4D8So6aNPffo4oiLezwze |

## 当前状态与下一步

- 已完成：方案、Claude / Codex 两侧 P0 验证、工程脚手架、UI 设计稿与规范、**切片 1–10**（切片 1–4 于 2026-09-19 浏览器验收通过；切片 5 于 2026-09-19 在真实 Hub 上用 REST + WS 脚本验收通过；切片 6 于 2026-09-19 在 launchd 托管的 Hub 上经 Tailscale 用桌面浏览器验收：PWA 注册、Hub 重启自动重连、离线期间事件按 seq 回放、390px 视口布局；切片 7、8 于 2026-09-19 桌面浏览器验收；切片 9 于 2026-09-19 用 REST + WS 脚本验收：删除广播、运行中 409、附件目录清理；切片 10 于 2026-09-19 桌面浏览器验收：文件列表、diff、整文件、越界路径拒绝）。
- **待办：真机 iPhone 走 Tailscale 完整跑一遍**（添加到主屏幕、相册选图、审批、切后台回来重连）——需要开发者手持设备，代码侧切片 6 已完成。
- 使用定位（2026-09-19 与开发者确认）：Mac Mini 常驻服务端；**MacBook 上的桌面浏览器是主控制端**，手机只是辅助，不追求全功能。易用性切片（7–11）按此排优先级。
- 实施按垂直切片推进，每片端到端可用：

| 切片 | 内容 | 验收 |
|---|---|---|
| 1 | shared 契约（只定本片用到的）；server：ClaudeProvider（Streaming Input + normalizer）、`node:sqlite` sessions/events 表、`POST /sessions`、`POST /sessions/:id/messages`、WS subscribe + seq 重放；web：单会话页（消息流 + 流式 + 输入） | 浏览器发消息收流式输出；刷新后从 seq 重放 |
| 2 | `pending_requests` 表；canUseTool → approval / user_input 事件；`POST /pending/:id/resolve` 原子 resolve + 广播；审批卡、提问卡、"已在别处处理"态 | iPhone 批准，MacBook 卡片同步失效 |
| 3 | 附件上传、`attachments` 表、image block；粘贴 / 拖拽 / 相册 | 手机传图，Claude 看到 |
| 4 | workspace allowlist、会话列表页、interrupt、追加指令排队、Hub 重启后 resume、额度条 | Hub 重启后继续下一轮 |
| 5 | Codex Provider：app-server stdio adapter 映射到同一套事件；审批 / requestUserInput / localImage | Codex 走完 1–4 的验收 |
| 6 | Tailscale Serve、launchd、PWA manifest、移动端打磨、断线重连 | 真机 iPhone 走 Tailscale 完整跑一遍 |
| 7 | 输入框草稿（localStorage 按会话）、"新开一轮"（同 cwd / provider 新建会话，等价 `/clear`）、浏览器 `Notification` 通知（靠会话列表轮询比对状态，不改服务端）、头部显示当前模型 | 切走再切回草稿还在；非当前会话完成时弹通知 |
| 8 | 项目管理：`workspaces` 表 + 目录浏览（限家目录内）添加、别名、移除，替代 `AGENTDECK_WORKSPACES`；设置页：Claude / Codex 默认模型与 effort，创建会话时传给 Provider，靠 init 回包校验 | 手机 / 桌面都能加项目；设置的模型出现在会话头部 |
| 9 | 删除会话：只允许 idle / error 状态（running / waiting_user 返回 409 让用户先中断），级联删 events / pending_requests / attachments 及 `data/uploads/<id>/`；Provider 原生记录（`~/.claude/projects`、Codex thread）不动 | 删后 `data/` 无残留 |
| 10 | 改动侧栏（桌面端）：cwd 内只读 `git status` / `git diff -- <file>` / 读文件，`turn.completed` 与写类工具完成后节流刷新，非 git 目录隐藏；自解析 unified diff，不引 diff 库、不做语法高亮 | 一轮结束能看到改了哪些文件及 diff |
| 11 | `@` 文件引用（服务端列目录，`~` 展开为家目录，子一级优先，支持目录；前端补全弹层）；会话中切模型（Codex `turn/start` 按轮传 model / effort；Claude 仅 `setModel()`，effort 无 setter 需 resume 重开，先不做） | 低频，待观察 |

## 技术栈与命令

- Node ≥ 24（`.nvmrc`），pnpm 11 workspace：`apps/server`（Fastify 5 + `@fastify/websocket` + `@fastify/multipart` + `@anthropic-ai/claude-agent-sdk`，tsx 运行）、`apps/web`（Vite 8 + React 19 + TanStack Query + vite-plugin-pwa）、`packages/shared`（domain 类型 + REST/WS 契约）。
- 存储：`node:sqlite` 内置模块 + 原生 SQL。**不引 ORM。**
- 前端状态：TanStack Query 管 REST；实时 session 状态用 `useReducer` / `useSyncExternalStore` 对事件流 reduce。**不引 Zustand。**
- 样式：CSS Modules + `tokens.css` 变量，字体 `@fontsource/*` 自托管，图标 `lucide-react`。**不引 Tailwind / 组件库。**
- TypeScript 三个工作区统一 `~6.0.2`。

```
pnpm dev:server      # tsx watch apps/server/src/main.ts
pnpm dev:web         # vite
pnpm build           # 前端构建到 apps/web/dist，Hub 启动时若该目录存在就直接托管（SPA 回退 + PWA）
pnpm start           # tsx apps/server/src/main.ts（生产，不 watch）
scripts/launchd.sh install | uninstall | restart | status | logs   # 常驻：先 pnpm build，再写 ~/Library/LaunchAgents/com.agentdeck.hub.plist 并加载；日志 data/logs/hub.log
pnpm typecheck       # 三个工作区
pnpm --filter @agentdeck/server test   # tsx --test：事件 seq 单调、PendingRequest 原子 resolve、附件路径/会话边界
pnpm codex:schema    # codex app-server generate-ts → apps/server/src/providers/codex/schema（已 gitignore，按本机 codex 版本生成）
cd apps/server && node scripts/p0-claude-harness.mjs   # Claude SDK 回归 harness，真实消耗额度
cd apps/server && node scripts/p0-codex-harness.mjs    # Codex app-server 回归 harness，真实消耗额度
```

## 本项目已定的规则（来自 P0 验证，不要回退）

1. **`tsconfig.base.json` 用 `moduleResolution: "bundler"` + `noEmit`**，不是 NodeNext：Codex `generate-ts` 输出无扩展名相对导入。server 由 tsx 运行，不产出 tsc 编译物，launchd 也按 `tsx` 跑。
2. **Claude Provider 的 `settingSources` 只取 `project`**，并在 init 消息里校验实际 `permissionMode`，与 Hub 期望不符时拒绝启动 session。原因：开发者本机 `~/.claude/settings.json` 是 `bypassPermissions`，加载 `user` 会让审批全部静默通过。
3. **interrupt 后的 turn 返回 `result.subtype = "error_during_execution"`**（`errors` 含 `[ede_diagnostic] … stop_reason=null`），normalizer 必须映射为"用户中断"而非错误；在该 result 之后立刻关闭输入流 SDK 会抛 `Claude Code returned an error result`，关 session 前先处理。
4. **认证**：不设 `ANTHROPIC_API_KEY`，SDK 复用本机 `claude` 的 claude.ai 登录（init `apiKeySource: "none"`），并推送 `rate_limit_event`（含 `five_hour` / `seven_day` 利用率）——额度条直接用它。此方式仅限自用，不可对外提供。
5. **SDK 消息类型有 40 余种**，normalizer 只显式映射 §7.2 需要的子集，其余归入 `provider.raw` 保留不映射。
6. Hub 只保存标准化 UI 事件流；Agent 对话上下文由 Provider 原生 session / thread 负责（§4.1）。不要试图在 Hub 里重建 Provider 内部状态。
7. 安全边界（§11.3）：workspace cwd 走 allowlist；附件路径由服务端生成，客户端只引用 attachmentId；不默认启用 bypassPermissions。
8. **`rate_limit_event` 的各窗口利用率在 `rate_limit_info.unifiedWindows`**（`five_hour` / `seven_day`，SDK 类型未声明），顶层 `utilization` 实际不存在；normalizer 按 unifiedWindows 解析。
9. **追加指令排队在 Hub 内存里**（不用 SDK 自己的消息队列，避免依赖其 result 语义）：一轮进行中收到的消息先落 `message.user` 事件，本轮 `turn.completed` / `turn.failed` 后按序发出；interrupt 会连同排队一起丢弃；Hub 重启后未发出的排队丢失。Hub 启动时把上次仍在 running / waiting_user 的会话记一条 `turn.completed(interrupted)` 并置 idle，下一轮用 `resume` 恢复。
10. **Codex Provider 在 `thread/start` / `thread/resume` 里显式传 `approvalPolicy: "on-request"` + `sandbox: "workspace-write"` + `approvalsReviewer: "user"`**，并校验回包，不符则拒绝启动。原因：开发者本机 `~/.codex/config.toml` 是 `approval_policy = "never"` + `danger-full-access`，不覆盖审批会全部静默通过。
11. **app-server 以 `--enable default_mode_request_user_input` 启动**：`request_user_input` 默认只在 Plan 模式可用，Hub 不支持 Plan 模式。
12. **一个 Hub 进程只维持一个 app-server**（`providers/codex/index.ts` 里的模块级单例），thread 按 `threadId` 路由；账号级通知（额度）广播给所有 Codex 会话，各自去重。
13. **Codex 审批的"本会话允许"只在回包 `availableDecisions` 含 `acceptForSession` 时提供**；不用 `acceptWithExecpolicyAmendment`（会写持久化 execpolicy 规则）。

## 工程习惯

- YAGNI：只解决当前切片的需求，抽象等重复出现再提。Provider 在 `apps/server/src/providers/` 里是目录，不拆包。
- 只在规则被明确固定、且破坏会静默失败时写测试（事件 seq 单调、PendingRequest 原子 resolve、附件路径边界这类）。UI、时序、样式不写测试。
- 错误只在真正的边界处理（用户输入、Provider 进程、外部 API），内部代码让异常抛出。
- 端口按 `~/Workspace/mac-mini-tailscale-web-ports.md` 分配：Hub 8004（只监听 127.0.0.1）、vite 5180、Tailscale HTTPS 8450。**生产映射到 Hub**：`tailscale serve --bg --https=8450 8004`（Hub 托管 `apps/web/dist`，方案 §11.2）；要在手机上看 HMR 时临时 `tailscale serve --bg --https=8450 5180`，用完切回。开发时 `pnpm dev:server` + `pnpm dev:web`，vite 代理 `/api` 与 `/ws` 到 8004（先 `scripts/launchd.sh uninstall` 或改 `AGENTDECK_PORT`，否则 8004 被常驻 Hub 占着）。
- launchd 不读 `~/.zshrc`：`scripts/launchd.sh install` 会把当前 shell 的 `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` 写进 plist（本机访问 Anthropic 走代理，缺了 Claude 报 `403 Request not allowed`），并把 `~/.local/bin`（claude / codex）加进 PATH。改了代理配置要重新 install。
- WS 握手校验 Origin 与 Host 一致（§11.3），Node 脚本不带 Origin 可直连；Tailscale Serve 会透传原始 Host。工作区 allowlist 是 `workspaces` 表，由 UI「项目」页从家目录内浏览添加（`/api/fs/dirs` 只列家目录内的目录），首次启动自动种入本仓库；应用级默认模型 / effort 在 `settings` 表，UI「设置」页改。SQLite 在 `data/`、上传图片在 `data/uploads/<sessionId>/`（`AGENTDECK_UPLOADS` 可改；已 gitignore）。
- 提交前 `pnpm typecheck`。commit 用 conventional 格式，不加 Co-Authored-By。
- 回复与文档使用简体中文；代码标识符、路径、命令保持原文。
