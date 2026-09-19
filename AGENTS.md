# AgentDeck

Mac Mini 上自托管的 Claude / Codex 多端控制台：Agent 在 Mac Mini 上跑，MacBook / iPhone / 浏览器通过 Tailscale 发消息、传截图、看流式输出、处理审批。单用户，不做 SaaS。

本文是给任何 AI 编码助手（Claude Code、Codex 等）和人的统一入口。`CLAUDE.md` 只是对本文的引用。

## 必读文档

| 文档 | 内容 |
|---|---|
| `docs/remote_agent_hub_technical_plan.md` | 技术方案 v1.1。架构、Provider 设计、统一事件协议（§7）、持久化（§12）、技术栈（§13）、API（§14）、分期（§15）、P0 验证记录与设计影响（§16.1） |
| `docs/ui-design-spec.md` | UI 设计规范：token、事件→组件映射、页面布局、实现约定。前端实现以它为准 |
| 设计稿 | https://claude.ai/artifact/Q4D8So6aNPffo4oiLezwze |

## 当前状态与下一步

- 已完成：方案、Claude 侧 P0 验证、工程脚手架、UI 设计稿与规范、**切片 1、切片 2**（2026-09-19 浏览器验收通过）。
- Codex app-server 链路已由开发者人工确认可行，未写 harness。
- **下一步：切片 3**。实施按垂直切片推进，每片端到端可用：

| 切片 | 内容 | 验收 |
|---|---|---|
| 1 | shared 契约（只定本片用到的）；server：ClaudeProvider（Streaming Input + normalizer）、`node:sqlite` sessions/events 表、`POST /sessions`、`POST /sessions/:id/messages`、WS subscribe + seq 重放；web：单会话页（消息流 + 流式 + 输入） | 浏览器发消息收流式输出；刷新后从 seq 重放 |
| 2 | `pending_requests` 表；canUseTool → approval / user_input 事件；`POST /pending/:id/resolve` 原子 resolve + 广播；审批卡、提问卡、"已在别处处理"态 | iPhone 批准，MacBook 卡片同步失效 |
| 3 | 附件上传、`attachments` 表、image block；粘贴 / 拖拽 / 相册 | 手机传图，Claude 看到 |
| 4 | workspace allowlist、会话列表页、interrupt、追加指令排队、Hub 重启后 resume、额度条 | Hub 重启后继续下一轮 |
| 5 | Codex Provider：app-server stdio adapter 映射到同一套事件；审批 / requestUserInput / localImage | Codex 走完 1–4 的验收 |
| 6 | Tailscale Serve、launchd、PWA manifest、移动端打磨、断线重连 | 真机 iPhone 走 Tailscale 完整跑一遍 |

## 技术栈与命令

- Node ≥ 24（`.nvmrc`），pnpm 11 workspace：`apps/server`（Fastify 5 + `@fastify/websocket` + `@fastify/multipart` + `@anthropic-ai/claude-agent-sdk`，tsx 运行）、`apps/web`（Vite 8 + React 19 + TanStack Query + vite-plugin-pwa）、`packages/shared`（domain 类型 + REST/WS 契约）。
- 存储：`node:sqlite` 内置模块 + 原生 SQL。**不引 ORM。**
- 前端状态：TanStack Query 管 REST；实时 session 状态用 `useReducer` / `useSyncExternalStore` 对事件流 reduce。**不引 Zustand。**
- 样式：CSS Modules + `tokens.css` 变量，字体 `@fontsource/*` 自托管，图标 `lucide-react`。**不引 Tailwind / 组件库。**
- TypeScript 三个工作区统一 `~6.0.2`。

```
pnpm dev:server      # tsx watch apps/server/src/main.ts
pnpm dev:web         # vite
pnpm typecheck       # 三个工作区
pnpm --filter @agentdeck/server test   # tsx --test：事件 seq 单调、PendingRequest 原子 resolve
pnpm codex:schema    # codex app-server generate-ts → apps/server/src/providers/codex/schema（已 gitignore，按本机 codex 版本生成）
cd apps/server && node scripts/p0-claude-harness.mjs   # Claude SDK 回归 harness，真实消耗额度
```

## 本项目已定的规则（来自 P0 验证，不要回退）

1. **`tsconfig.base.json` 用 `moduleResolution: "bundler"` + `noEmit`**，不是 NodeNext：Codex `generate-ts` 输出无扩展名相对导入。server 由 tsx 运行，不产出 tsc 编译物，launchd 也按 `tsx` 跑。
2. **Claude Provider 的 `settingSources` 只取 `project`**，并在 init 消息里校验实际 `permissionMode`，与 Hub 期望不符时拒绝启动 session。原因：开发者本机 `~/.claude/settings.json` 是 `bypassPermissions`，加载 `user` 会让审批全部静默通过。
3. **interrupt 后的 turn 返回 `result.subtype = "error_during_execution"`**（`errors` 含 `[ede_diagnostic] … stop_reason=null`），normalizer 必须映射为"用户中断"而非错误；在该 result 之后立刻关闭输入流 SDK 会抛 `Claude Code returned an error result`，关 session 前先处理。
4. **认证**：不设 `ANTHROPIC_API_KEY`，SDK 复用本机 `claude` 的 claude.ai 登录（init `apiKeySource: "none"`），并推送 `rate_limit_event`（含 `five_hour` / `seven_day` 利用率）——额度条直接用它。此方式仅限自用，不可对外提供。
5. **SDK 消息类型有 40 余种**，normalizer 只显式映射 §7.2 需要的子集，其余归入 `provider.raw` 保留不映射。
6. Hub 只保存标准化 UI 事件流；Agent 对话上下文由 Provider 原生 session / thread 负责（§4.1）。不要试图在 Hub 里重建 Provider 内部状态。
7. 安全边界（§11.3）：workspace cwd 走 allowlist；附件路径由服务端生成，客户端只引用 attachmentId；不默认启用 bypassPermissions。

## 工程习惯

- YAGNI：只解决当前切片的需求，抽象等重复出现再提。Provider 在 `apps/server/src/providers/` 里是目录，不拆包。
- 只在规则被明确固定、且破坏会静默失败时写测试（事件 seq 单调、PendingRequest 原子 resolve、附件路径边界这类）。UI、时序、样式不写测试。
- 错误只在真正的边界处理（用户输入、Provider 进程、外部 API），内部代码让异常抛出。
- 开发时 `pnpm dev:server`（8787）+ `pnpm dev:web`（5173，vite 代理 `/api` 与 `/ws` 到 8787）。工作区 allowlist 用 `AGENTDECK_WORKSPACES`（逗号分隔绝对路径）配置，默认只允许本仓库；SQLite 在 `data/`（已 gitignore）。
- 提交前 `pnpm typecheck`。commit 用 conventional 格式，不加 Co-Authored-By。
- 回复与文档使用简体中文；代码标识符、路径、命令保持原文。
