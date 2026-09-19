# AgentDeck UI 设计规范

设计稿：https://claude.ai/artifact/Q4D8So6aNPffo4oiLezwze（5 块画板：桌面会话视图、iPhone 会话列表、iPhone 会话与审批、iPhone 重连回放 + 提问、事件卡片组件表）。本文是设计稿的文字版约束，实现时以本文为准；两者冲突以本文为准并回头改稿。

## 1. 基调

- 单一深色主题。不做浅色版，不做主题切换。
- 这是一个"盯着 Agent 干活"的控制台，视觉重心在**它在等你**的时刻。整个界面只有一个强调色（琥珀），只用于审批、提问、等待状态；其余全部灰阶 + 语义色。
- 密度偏高、字号偏小（正文 14px 桌面 / 15px 移动），信息优先于留白。
- 不用渐变、不用 emoji、不用品牌色区分 Provider、不做 toast 承载审批（审批是消息流里的卡片）。

## 2. Token

实现为 `apps/web/src/styles/tokens.css` 里的 CSS 变量，组件样式只引用变量，不写裸色值。

### 颜色

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#111214` | 页面底 |
| `--panel` | `#141518` | 侧栏、顶栏 |
| `--surface` | `#16171B` | 卡片、输入框 |
| `--surface-2` | `#1B1D22` | 次级按钮、横幅 |
| `--surface-3` | `#1F2126` | 用户消息气泡、选中项、代码片段 |
| `--surface-4` | `#2A2D33` | 头像、缩略图占位 |
| `--border` | `#25272D` | 卡片、分隔线 |
| `--border-2` | `#2E3138` | 输入框、按钮、芯片 |
| `--text` | `#ECEDEF` | 正文 |
| `--text-2` | `#A5A9B2` | 次级文字、工具名 |
| `--text-3` | `#8A8F99` | 说明、时间、标签 |
| `--text-4` | `#5B606B` | 占位符、禁用 |
| `--accent` | `#E4A94F` | 琥珀：需要你 |
| `--accent-text` | `#F2D08A` | 琥珀卡片内的标题文字 |
| `--accent-bg` | `#1A1710` | 琥珀卡片底 |
| `--accent-bg-2` | `#2A2113` | 琥珀芯片底、选中选项底 |
| `--accent-border-2` | `#4A3A1B` / `#3A2F16` | 琥珀次级按钮边 / 卡片内分隔线 |
| `--on-accent` | `#1A1204` | 琥珀实心按钮上的文字 |
| `--ok` | `#5FB97A` | 运行中、成功、diff 新增 |
| `--ok-bg` | `#142018` | diff 新增行底 |
| `--ok-border` | `#244A2F` | 运行中 pill 边 |
| `--danger` | `#E06C6C` | 出错、失败、diff 删除、中断按钮 |
| `--danger-bg` | `#241717` | 错误卡底、中断按钮底 |
| `--danger-border` | `#3A2626` | 错误卡边 |
| `--inverse` | `#ECEDEF` / 文字 `#111214` | 主按钮（发送、新建会话）、Logo |

对比度：`--text-3` 在 `--surface` 上约 5:1，是允许的最浅正文色；`--text-4` 只用于占位符和禁用态。

### 字体

- 正文：`'IBM Plex Sans', system-ui, sans-serif`，字重 400 / 500 / 600。
- 等宽：`'JetBrains Mono', monospace`，用于：文件路径、命令、session/seq/ID、模型名、额度数字、diff、附件文件名、Provider 芯片。
- 通过 `@fontsource/ibm-plex-sans` 与 `@fontsource/jetbrains-mono` 自托管，不依赖外网（Tailscale 内网可能无外网字体）。
- 字号阶梯（px）：11 · 11.5 · 12 · 12.5 · 13 · 13.5 · 14 · 15 · 17 · 22。桌面正文 14，移动正文 15，标题 15–17，页面标题 22。行高 1.45–1.5。
- 品牌名和标题 `letter-spacing: -0.01em`；小标签 `+0.02em`。

### 圆角、尺寸、间距

| 项 | 值 |
|---|---|
| 卡片 | 10px；工具卡片 8px |
| 输入框、移动端大按钮 | 12px |
| 桌面按钮 | 8px |
| 芯片 | 4px（等宽标签）/ 6px（附件）/ 999px（状态 pill） |
| 触控目标 | 移动端 ≥ 44px；桌面按钮高 34–36px |
| 桌面 | 侧栏 280，顶栏 56，消息列最大宽 820，助手消息最大宽 720，用户气泡最大宽 600 |
| 移动 | 顶部安全区 54，底部安全区 30，底栏输入区最小高 44 |
| 间距阶梯 | 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 28 |

### 图标

- 用 `lucide-react`，线宽 2，尺寸 12 / 14 / 16 / 18 / 20。设计稿里的 SVG 就是 lucide 风格。
- 图标本身不承载语义色以外的颜色；图标按钮必须有 `aria-label`。

## 3. 事件 → 组件

统一协议 §7.2 的每个事件在 UI 里只有一种呈现。组件名即实现时的文件名。

| 事件 | 组件 | 规则 |
|---|---|---|
| `session.status` | `StatusPill` | 五态：运行中（ok）、等待审批 / 等待回答（accent）、空闲（text-3）、出错（danger）。带 6px 圆点。列表项和顶栏共用。 |
| `message.*`（user） | `UserMessage` | 靠右，气泡 `--surface-3`，圆角 `12 12 4 12`。上方小字"你 · 设备 · 时间"。附件以缩略图 + 文件名 + 来源列在气泡内。 |
| `message.delta / completed`（assistant） | `AssistantMessage` | 不做气泡。头部 18px 方形单字母头像（C / X）+ "Provider · 时间"。流式时末尾 8×15 实心光标。行内代码用 `--surface-3` 底。 |
| `tool.started` | `ToolCard`（running） | 单行：旋转圆环 + 工具名（text-2, 500）+ 参数摘要（等宽）+ 已用时。 |
| `tool.completed` | `ToolCard`（collapsed） | 单行：绿勾 + 工具名 + 摘要 + 结果计数/耗时 + 右箭头。默认折叠。 |
| `tool.completed` + `file.changed` | `ToolCard`（expanded） | Edit/Write 默认展开，头部带 `+n −m`，正文是 diff：删除行 danger/danger-bg，新增行 ok/ok-bg，hunk 头 text-3。 |
| `tool.completed`（失败） | `ToolCard`（failed） | 边框 `--danger-border`，红叉，右侧 `exit N`，正文显示 stderr 前几行（等宽、danger）。 |
| `approval.requested` | `ApprovalCard` | 边框 `--accent`，底 `--accent-bg`。头部：警告图标 + "需要你的批准" + 工具名芯片 + 等待时长。正文**必须**完整展示 command（等宽块）、目录、原因；file-change 类型列出文件与 `+n −m`。按钮：主按钮"允许一次"（实心琥珀），次级"本会话允许 &lt;pattern&gt;"（琥珀描边），"拒绝"（灰描边）。桌面横排，移动端主按钮全宽 46px、次级两个并排 44px。不提供"永远允许"。 |
| `approval.resolved` | `ApprovalCard`（resolved） | 保留在流中，`opacity: 0.85`，边框改 `--border`，头部改为"命令审批 · 已允许/已拒绝"+ 处理设备与时间，正文只留一行等宽命令。按钮移除。 |
| `user_input.requested` | `QuestionCard` | 同琥珀卡片。头部：问号图标 + "&lt;Provider&gt; 想确认" + "单选/可多选"。选项是真实的 `<label><input type=radio|checkbox>`，选中项底 `--accent-bg-2` 边 `--accent`；末尾一个"其它"文本输入。主按钮"提交回答"。 |
| `user_input.resolved` | `QuestionCard`（resolved） | 同审批 resolved 态，正文显示所选答案。 |
| `turn.interrupted` | `InterruptedRow` | 虚线边框单行，`--surface-2` 底，方块图标 + "已中断 · 设备 · 时间"。 |
| `error` | `ErrorCard` | `--danger-bg` 底、`--danger-border` 边，标题 danger，说明 text-2（含可恢复提示）。 |
| `usage.updated` | `RateMeter` | 标签"5 小时额度" + 等宽"42% · 重置 2h14m"，4px 进度条，填充 `--text-2`（不用琥珀）。 |
| 连接状态 | `ConnectionBanner` | `--surface-2` 底单行：刷新图标 + "已重新连接 · 回放 n 条事件（seq a → b）"。离线时同样式换文案。 |
| 附件上传 | `AttachmentChip` | `--surface-3` 底、`--border-2` 边、6px 圆角：22px 缩略图 + 等宽文件名 + 大小/进度 + 移除按钮。 |
| Provider | `ProviderChip` | 等宽、`--border-2` 描边、`--text-2`，内容 `claude · opus-5`。不上色。 |

## 4. 页面布局

### 桌面（≥ 1024）

三栏：侧栏 280（`--panel`，右边线）· 主区（顶栏 56 + 消息流 + 输入区）。消息流居中 820 列，上内边距 28。输入区：附件芯片行 + 提示文字，下方输入框（`--surface`、`--border-2`、12px 圆角），右侧附件按钮与发送按钮各 36px。有一轮在运行时提示"当前有一轮在运行，发送将作为追加指令排队"，顶栏显示"中断"按钮（danger 描边）。

侧栏结构：品牌行（Logo + 名称 + 连接状态）→ 按工作区分组的会话列表（组头：名称 + 等宽计数；项：圆点 + 标题 + 时间 / Provider 芯片 + 状态文字）→ 底部"新建会话"。选中项底 `--surface-3`。

### 移动（< 1024，按 390 设计）

- 列表页：顶部品牌行（含设置按钮 44px）→ 琥珀"n 项等待你处理"横幅（有待处理时才出现，点击进入最早的那个）→ 分组会话列表（每项最小高 64，右箭头）→ 底部全宽"新建会话" 50px。
- 会话页：顶栏返回（44px 触控区）+ 标题 + 状态行 + "中断"；消息流 16px 内边距；底栏：提示行 + [相机/相册 44px] [输入框 + 32px 发送]。
- 有未回答的提问时输入框禁用（`--text-4` 文案"回答上方问题，或输入新指令…"），底栏左侧提示"回答问题后 &lt;Provider&gt; 才会继续"，右侧等宽显示当前 seq。
- 重连时在顶栏下方插 `ConnectionBanner`。

## 5. 实现约定

- 样式：CSS Modules（`*.module.css`）+ `tokens.css` 变量。不引 Tailwind、不引组件库。
- 组件按 §3 的名字建文件，一事件一组件；状态用 props（`state="running" | "collapsed" | ...`），不为每个状态建新组件。
- 所有可点击元素是真实 `<button>` / `<a>` / `<input>`，不在 `div` 上绑 onClick。
- 文案中文；等宽字段（路径、命令、ID）不翻译、不截断中间——过长时 `text-overflow: ellipsis` 截尾，审批卡片里的命令块例外，必须完整换行显示（`word-break: break-all`）。
- 与设计稿有出入需要改稿时，先改本文再改稿。
