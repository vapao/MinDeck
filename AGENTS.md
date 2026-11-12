# MinDeck

Mac Mini 上自托管的 Claude / Codex / DeepSeek 多端控制台：Agent 在 Mac Mini 上跑，MacBook / iPhone / 浏览器通过 Tailscale 发消息、传截图、看流式输出、处理审批。单用户，不做 SaaS。**MacBook 桌面浏览器是主控制端**，手机只是辅助，不追求全功能。

本文是 AI 编码助手和人的统一入口，`CLAUDE.md` 只引用本文。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/features.md` | 已实现功能（切片 1–17、DeepSeek、AI 标题）的行为、边界、未做项。改某功能前先读对应段 |
| `docs/remote_agent_hub_technical_plan.md` | 技术方案：架构、事件协议（§7）、持久化（§12）、API（§14）、P0 验证记录（§16） |
| `docs/ui-design-spec.md` | UI 规范，前端实现以它为准 |
| `docs/file-preview.md` | 文件预览、文件树、高亮的限制与边界 |

## 待办

- 浏览器验收：切片 12、13、14、15（审批卡）、17、`$` 调用 skill、`/compact`、密钥（输入卡、Settings Secrets）。
- Inbox 与 Automations：真实 Agent 在定时任务里调用 `ask_user` / `report_to_user` / `wake_later` 跑一遍（定时任务 prompt 需写明使用这三个工具）。
- 真机 iPhone 走 Tailscale 完整跑一遍（添加到主屏幕、相册选图、审批、切后台重连），需开发者手持设备。
- DeepSeek 真实服务验证（需填 Key）。

## 技术栈与命令

- Node ≥ 24，pnpm 11 workspace：`apps/server`（Fastify 5 + `@anthropic-ai/claude-agent-sdk`，tsx 运行）、`apps/web`（Vite 8 + React 19 + TanStack Query + vite-plugin-pwa）、`packages/shared`（类型 + REST/WS 契约）。TypeScript 统一 `~6.0.2`。
- Claude SDK 与 `@openai/codex` 在 `apps/server/package.json` 中锁定精确版本，`pnpm-lock.yaml` 锁定平台包。源码和安装版均使用依赖内程序，不查找 PATH 中的 Claude / Codex；升级版本后重新生成 schema 并验证。安装版从 npm 下载平台包并校验 lockfile 的 SHA-512，MinDeck Release 不包含这些二进制（见 `docs/installer.md`）。
- 存储：`node:sqlite` + 原生 SQL，**不引 ORM**。
- 前端：TanStack Query 管 REST，实时状态用 `useReducer` / `useSyncExternalStore`，**不引 Zustand**。CSS Modules + `tokens.css`，图标 `lucide-react`，弹窗统一 `components/Dialog.tsx`（不用浏览器原生弹窗），**不引 Tailwind / 组件库**。

```
pnpm dev:server | dev:web | build | start | typecheck
pnpm --filter @mindeck/server test
pnpm codex:schema    # 使用 apps/server 依赖锁定的 Codex 生成 schema（已 gitignore）
scripts/launchd.sh install | uninstall | update | update-when-idle | restart | status | logs
cd apps/server && node scripts/p0-{claude,codex}-harness.mjs              # 以下均真实消耗额度
cd apps/server && node scripts/p0-{mcp,fork}-harness.mjs claude|codex
```

## 已定规则（来自 P0 验证，不要回退）

1. `tsconfig.base.json` 用 `moduleResolution: "bundler"` + `noEmit`：Codex `generate-ts` 输出无扩展名导入。server 由 tsx 运行，不产出编译物。
2. Claude Provider 加载 `settingSources: ['user', 'project']`（拿 `~/.claude/CLAUDE.md`、skills、plugins），但用 flag 层 `settings: { permissions: { defaultMode } }` 按会话强制权限（'approval' → `default`，'bypass' → `bypassPermissions`），并在 init 校验实际 `permissionMode`，不符拒绝启动——本机 user 设置是 bypass，否则审批会静默通过。系统提示词用 `{ type: 'preset', preset: 'claude_code' }`。
3. interrupt 后的 result 为 `error_during_execution`（含 `[ede_diagnostic] … stop_reason=null`），必须映射为"用户中断"；在其后立刻关输入流 SDK 会抛错，先处理再关。
4. 认证不设 `ANTHROPIC_API_KEY`，复用本机 `claude` 登录，仅限自用。
5. normalizer 只映射 §7.2 需要的子集，其余丢弃。事件流只记"做了什么"不记工具输出：`tool.started` 只带一行 `summary`（`providers/summary.ts`），`tool.completed` 只带 `isError`；`message.delta` 不落库、不占 seq，仅 WS 广播。
6. Hub 只存标准化 UI 事件流；对话上下文由 Provider 原生 session / thread 负责。
7. 安全边界：cwd 走 `workspaces` allowlist；附件路径由服务端生成，客户端只引用 attachmentId；权限模式默认 'approval'，bypass 只能显式选且前端二次确认。
8. `rate_limit_event` 利用率在 `rate_limit_info.unifiedWindows`（`five_hour` / `seven_day`），不是顶层 `utilization`。
9. 追加指令插入当前轮：Codex `turn/steer`（带 `expectedTurnId`，不可插入时退回 `turn/start`）；Claude 直接 push 进 Streaming Input，以 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 下的 `session_state_changed: idle` 为准。**Provider 只在全部处理完时发一次 `turn.completed` / `turn.failed`**。interrupt 连同未读到的插入消息一起丢弃（Claude `interrupt({ cancelQueued: true })`）。Hub 启动时把残留 running / waiting_user 会话记 `turn.completed(interrupted)` 置 idle，下一轮 resume。
10. Codex `thread/start` / `thread/resume` 显式传 `approvalPolicy` + `sandbox` + `approvalsReviewer: "user"`：'approval' → `on-request` + `workspace-write`；'bypass' → `never` + `danger-full-access`。校验回包一致，不符拒绝启动。
11. app-server 以 `--enable default_mode_request_user_input` 启动（否则只在 Plan 模式可用）。
12. 一个 Hub 进程只维持一个 app-server（模块级单例），thread 按 `threadId` 路由；额度通知广播给所有 Codex 会话，各自去重。
13. Codex "本会话允许"只在 `availableDecisions` 含 `acceptForSession` 时提供；不用 `acceptWithExecpolicyAmendment`（会写持久化规则）。
14. Codex 异步提问来自 `agentMessage.delivery = "async"` + `questions`：转非阻塞问答卡，答案走普通追加指令路径；中断 / 关闭时作废。

## 工程习惯

- YAGNI；Provider 在 `apps/server/src/providers/` 里是目录，不拆包。
- 只在规则被明确固定、破坏会静默失败时写测试。UI、时序、样式不写测试。错误只在真正边界处理。
- 端口：Hub 8004（只监听 127.0.0.1）、vite 5180、Tailscale HTTPS 8450。生产 `tailscale serve --bg --https=8450 8004`；手机看 HMR 时临时改映 5180，用完切回。本地开发前先 `scripts/launchd.sh uninstall` 或改 `MINDECK_PORT`。
- launchd 不读 `~/.zshrc`：`install` 把当前 shell 的代理变量写进 plist（缺了 Claude 报 `403 Request not allowed`），并把 `~/.local/bin` 加进 PATH 供项目工具使用（Claude / Codex 使用锁定依赖，不靠此 PATH）。改代理要重新 install。
- 改完代码：在 MinDeck 会话内用 `scripts/launchd.sh update-when-idle`，启动一次性后台进程，所有会话空闲后构建并重启；不要自行编写延迟重启脚本。日志在 `data/logs/update-when-idle.log`，命令返回 PID 可用 `kill` 取消。外部终端确认可立即重启时仍用 `update`。
- WS 握手校验 Origin 与 Host 一致，Node 脚本不带 Origin 可直连。数据在 `data/`（SQLite、`uploads/<sessionId>/`、日志），已 gitignore。
- 提交前 `pnpm typecheck`；conventional commit，不加 Co-Authored-By。
- 回复与文档用简体中文；界面文案默认英文。
