# AgentDeck UI 设计规范

设计稿：https://claude.ai/artifact/Q4D8So6aNPffo4oiLezwze（5 块画板：桌面会话视图、iPhone 会话列表、iPhone 会话与审批、iPhone 重连回放 + 提问、事件卡片组件表）。本文是设计稿的文字版约束，实现时以本文为准；两者冲突以本文为准并回头改稿。

## 1. 基调

- 单一深色主题。不做浅色版，不做主题切换。
- 这是一个"盯着 Agent 干活"的控制台，视觉重心在**它在等你**的时刻。整个界面只有一个强调色（琥珀 `#E0A25F`），用于主按钮和审批、提问、等待状态；其余全部灰阶 + 语义色。
- 密度偏高、字号偏小（UI 13px、消息正文 14px 桌面 / 15px 移动），信息优先于留白。
- 不用渐变、不用 emoji、不用品牌色区分 Provider、不做 toast 承载审批（审批是消息流里的卡片）。

## 2. Token

实现为 `apps/web/src/styles/tokens.css` 里的 CSS 变量，组件样式只引用变量，不写裸色值。视觉基线于 2026-09-20 对齐 Turnwork（`~/Workspace/fizee/Turnwork`）：系统字体、13px 基准、半透明白描边、两档圆角、琥珀单强调色、克制的悬停态（120ms 过渡）。

### 颜色

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#0F1012` | 页面底 |
| `--panel` | `#141518` | 侧栏、顶栏、改动侧栏 |
| `--surface` | `#1B1D21` | 卡片、输入框、控件、菜单 |
| `--surface-2` | `#202328` | 带描边控件的悬停底 |
| `--surface-3` | `#23262B` | 用户气泡、行内代码、命令块、附件芯片 |
| `--hover` | `rgba(255,255,255,0.05)` | 无描边按钮 / 列表项的悬停底 |
| `--selected` | `rgba(255,255,255,0.075)` | 当前会话、键盘选中项（选中项再加 `inset 0 0 0 1px --border`） |
| `--border` | `rgba(255,255,255,0.07)` | 分隔线、控件描边 |
| `--border-2` | `rgba(255,255,255,0.09)` | 卡片描边 |
| `--border-3` | `rgba(255,255,255,0.13)` | 悬停描边、菜单描边 |
| `--text` | `#E6E8EC` | 正文 |
| `--text-strong` | `#F2F4F6` | 标题、品牌名、悬停后的按钮文字 |
| `--text-2` | `#9AA0A9` | 次级文字、工具名 |
| `--text-3` | `#777D86` | 说明、时间、图标按钮 |
| `--text-4` | `#5E646D` | 占位符、禁用、分组标题 |
| `--accent` | `#E0A25F` | 唯一强调色：主按钮（发送、新建、保存、弹窗确定）、审批 / 提问卡图标与芯片、选中勾 |
| `--accent-hover` | `#EFB87A` | 主按钮悬停 |
| `--on-accent` | `#1B1510` | 琥珀实心按钮上的文字 |
| `--accent-bg` / `--accent-bg-2` | 琥珀 7.5% / 12% | 琥珀卡片底、聚焦光晕 / 芯片底、选中选项底 |
| `--accent-border` / `--accent-ring` | 琥珀 28% / 42% | 琥珀卡片与次级按钮描边 / 聚焦描边 |
| `--running` / `--running-border` | `#7FA8D9` / 蓝 28% | 运行中（状态点、工具转圈） |
| `--ok` / `--ok-bg` | `#8DBB9D` / 绿 10% | 完成、成功、diff 新增 |
| `--danger` / `--danger-bg` / `--danger-border` | `#D98D84` / 红 12% / 红 25% | 出错、失败、diff 删除、中断与危险按钮 |

运行中与成功分色：运行中是蓝，完成才是绿。对比度：`--text-3` 是允许的最浅正文色；`--text-4` 只用于占位符、禁用态和分组标题。

### 字体

- 正文：`-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', system-ui, sans-serif`，字重 400 / 500 / 600，不再自托管 UI 字体。
- 等宽：`'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace`（`@fontsource/jetbrains-mono` 自托管），用于：文件路径、命令、session/seq/ID、模型名、额度数字、diff、附件文件名、Provider 芯片。
- 字号只用整数：10（分组标题，大写 + 600）· 11（辅助信息）· 12（次级文字、紧凑控件）· 13（UI 基准，桌面 body）· 14（消息正文、输入框）· 15 / 17 / 19（Markdown h3 / h2 / h1）· 16（页面标题）。移动端 body 15。行高：UI 1.5，消息与输入 1.65。
- 不做字距微调；标题不用 `letter-spacing`。

### 圆角、尺寸、间距

| 项 | 值 |
|---|---|
| `--radius-control` 6px | 按钮、输入框、下拉、菜单项、芯片、附件、选项 |
| `--radius-card` 8px | 卡片、工具卡、审批卡、输入区、弹窗、菜单 |
| 其它 | 徽标 4px；发送 / 中断按钮 50%（28px 圆） |
| 触控目标 | 移动端 ≥ 44px；桌面按钮高 29–30px、下拉 / 输入框 32px、图标按钮 28px |
| 桌面 | 侧栏 280，顶栏 52，消息列最大宽 820，助手消息最大宽 720，用户气泡最大宽 600 |
| 移动 | 顶部安全区 54，底部安全区 30，底栏输入区最小高 44 |
| 间距阶梯 | 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 28 |

### 交互态

- 带描边的按钮 / 下拉：悬停 `--border-3` + `--surface-2` + `--text-strong`；聚焦 `--accent-ring` 描边 + `0 0 0 2px --accent-bg` 光晕。
- 无描边的图标按钮 / 列表项：悬停 `--hover`；当前项 `--selected` + 1px 内描边。
- 主按钮悬停 `--accent-hover`；危险按钮是红色描边 + 红色 12% 底，不用实心红。
- 禁用态 `opacity: 0.42`。菜单弹出 110ms 淡入，`prefers-reduced-motion` 下关闭。
- 全局 `:focus-visible` 为 1px `--accent-ring` 描边，滚动条 9px 半透明白。

### 图标

- 用 `lucide-react`，线宽 2，尺寸 12 / 14 / 16 / 18 / 20。设计稿里的 SVG 就是 lucide 风格。
- 图标本身不承载语义色以外的颜色；图标按钮必须有 `aria-label`。

## 3. 事件 → 组件

统一协议 §7.2 的每个事件在 UI 里只有一种呈现。组件名即实现时的文件名。

| 事件 | 组件 | 规则 |
|---|---|---|
| `session.status` | `StatusPill` | 五态：运行中（ok）、等待审批 / 等待回答（accent）、空闲（text-3）、出错（danger）。带 6px 圆点。列表项和顶栏共用。 |
| `message.*`（user） | `UserMessage` | 靠右，气泡 `--surface-3`，圆角 `12 12 4 12`。上方小字"你 · 设备 · 时间"。附件以缩略图 + 文件名 + 来源列在气泡内。 |
| `message.delta / completed`（assistant） | `AssistantMessage` | 不做气泡，也不带发送者 / 时间头部（时间由 `TurnRow` 落款承担）。流式时末尾 8×15 实心光标。行内代码用 `--surface-3` 底。 |
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
| `GET /api/usage`（5s 轮询，不走事件流） | `RateMeter` | 桌面侧栏底部、"项目 / 设置"之上，按 Provider 分组；每条：标签 `5h` / `week` + 4px 进度条（填充 `--text-2`，不用琥珀）+ 等宽 `42%` + 等宽重置倒计时 `2h14m`。 |
| 连接状态 | `ConnectionBanner` | `--surface-2` 底单行：刷新图标 + "已重新连接 · 回放 n 条事件（seq a → b）"。离线时同样式换文案。 |
| 附件上传 | `AttachmentChip` | `--surface-3` 底、`--border-2` 边、6px 圆角：22px 缩略图 + 等宽文件名 + 大小/进度 + 移除按钮。 |
| Provider | `ProviderChip` | 等宽、`--border-2` 描边、`--text-2`，内容 `claude · opus-5`。不上色。 |

## 4. 页面布局

### 桌面（≥ 1024）

三栏：侧栏 280（`--panel`，右边线）· 主区（顶栏 56 + 消息流 + 输入区）。消息流居中 820 列，上内边距 28。输入区：附件芯片行 + 提示文字，下方输入框（`--surface`、`--border-2`、12px 圆角），右侧附件按钮与发送按钮各 36px。有一轮在运行时提示"当前有一轮在运行，发送将作为追加指令排队"，顶栏显示"中断"按钮（danger 描边）。

侧栏结构：品牌行（Logo + 名称 + 连接状态）→ 按工作区分组的会话列表（组头：名称 + 等宽计数；项：圆点 + 标题 + 时间 / Provider 芯片 + 状态文字）→ 底部"新建会话" → 额度区（`RateMeter`）→ "项目 / 设置"。选中项底 `--surface-3`。

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
