# AgentDeck UI 设计规范

设计稿：https://claude.ai/artifact/Q4D8So6aNPffo4oiLezwze（5 块画板：桌面会话视图、iPhone 会话列表、iPhone 会话与审批、iPhone 重连回放 + 提问、事件卡片组件表）。本文是设计稿的文字版约束，实现时以本文为准；两者冲突以本文为准并回头改稿。

## 1. 基调

- 单一深色主题。不做浅色版，不做主题切换。
- 这是一个"盯着 Agent 干活"的控制台，视觉重心在**它在等你**的时刻。整个界面只有一个强调色（琥珀 `#E0A25F`），用于主按钮和审批、提问、等待状态；其余全部灰阶 + 语义色。
- 密度偏高、字号偏小（UI 13px、消息正文 14px 桌面 / 15px 移动），信息优先于留白。
- 不用渐变、不用 emoji、不用品牌色区分 Provider、不做 toast 承载审批（审批是消息流里的卡片）。
- 前台其他会话的状态提醒使用右下角轻量通知，显示会话标题、状态和项目，可点击跳转或关闭；多条纵向堆叠，同会话只保留最新一条。使用现有 surface、border、圆角和阴影变量；审批与提问在会话消息流或 Inbox 中处理，通知本身不带操作。

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
| `--text` | `#D5D8DD` | 正文 |
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
| `--ref` / `--ref-bg` | `#7FA8D9` / 蓝 12% | 输入框与用户消息里的 `@` 文件引用与 `#` 会话引用（`$skill` 用 `--accent` / `--accent-bg-2`） |
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
| 桌面 | 侧栏 280，顶栏 60，消息列与输入框同宽 880；助手消息、工具组、审批 / 提问 / 报错卡撑满列宽，用户气泡最大宽 660 |
| 移动 | 顶部安全区 54，底部安全区 30，底栏输入区最小高 44 |
| 间距阶梯 | 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 28 |

### 交互态

- 带描边的按钮 / 下拉：悬停 `--border-3` + `--surface-2` + `--text-strong`；聚焦 `--accent-ring` 描边 + `0 0 0 2px --accent-bg` 光晕。
- 无描边的图标按钮 / 列表项：悬停 `--hover`；当前项 `--selected` + 1px 内描边。
- 主按钮悬停 `--accent-hover`；危险按钮是红色描边 + 红色 12% 底，不用实心红。
- 禁用态 `opacity: 0.42`。菜单弹出 110ms 淡入，`prefers-reduced-motion` 下关闭。
- 全局 `:focus-visible` 为 1px `--accent-ring` 描边，滚动条 9px 半透明白。会话列表（桌面侧栏 / 手机列表）与聊天消息区仅在滚动时显示滑块，停止 800ms 后隐藏；这些区域的滚动条宽度 4px（仅支持标准属性的浏览器用 thin），保留滚动条占位，避免内容宽度跳变。

### 图标

- 用 `lucide-react`，线宽 2，尺寸 12 / 14 / 16 / 18 / 20。设计稿里的 SVG 就是 lucide 风格。
- 图标本身不承载语义色以外的颜色；图标按钮必须有 `aria-label`。

## 3. 事件 → 组件

Changes 列表不显示回退按钮；点击文件打开预览弹窗（默认 diff，标题栏 `File` / `Diff` 切换），diff 视图底部为危险样式的 `Discard changes` 按钮。操作前使用统一危险确认弹窗，显示完整路径，并说明恢复 HEAD（含暂存区）或删除新增文件；成功后关闭弹窗并刷新。不可操作的 Git 状态或活跃任务时点击给出提示弹窗说明原因；执行失败用统一提示弹窗展示服务端错误。

Files 工具栏提供 `FilePlus` / `FolderPlus` 图标，在项目根新建文件 / 文件夹；仅鼠标悬停时，目录行显示这两个入口及 `Trash2`，文件行和搜索结果显示 `Trash2`；点击或焦点停留不使操作按钮常驻。新建走统一输入弹窗，删除走统一危险确认弹窗，显示路径和永久删除范围；操作按钮与行展开 / 预览按钮独立。活跃任务、操作进行中和 `.git` 路径禁用写入，tooltip 显示原因。

统一协议 §7.2 的每个事件在 UI 里只有一种呈现。组件名即实现时的文件名。

| 事件 | 组件 | 规则 |
|---|---|---|
| `session.status` | `StatusPill` | 五态：运行中（ok）、等待审批 / 等待回答（accent）、空闲（text-3）、出错（danger）。带 6px 圆点。列表项和顶栏共用。 |
| `message.*`（user） | `UserMessage` | 靠右，气泡 `--surface-3`，圆角 `12 12 4 12`。上方小字"你 · 设备 · 时间"。附件以缩略图 + 文件名 + 来源列在气泡内。 |
| `message.delta / completed`（assistant） | `AssistantMessage` | 不做气泡，也不带发送者 / 时间头部（时间由 `TurnRow` 落款承担）。流式时末尾 8×15 实心光标。行内代码用 `--surface-3` 底。 |
| 连续的 `tool.started / completed` | `ToolGroup` | 对齐 Turnwork 的命令组：一张卡默认折叠，头部两行——"Ran N tools"（运行中为 "Running N tools" + 旋转圆环）+ 最新一个工具的 `name summary`（等宽、单行省略）+ 右箭头；任一失败时边框 `--danger-border`、红叉。点开逐条列出（图标 + 工具名 + 摘要）。服务端不保存工具输出，没有可展开的正文；改动看侧栏 diff。 |
| `approval.requested` | `ApprovalCard` | 边框 `--accent`，底 `--accent-bg`。头部：警告图标 + "需要你的批准" + 工具名芯片 + 等待时长。正文**必须**完整展示 command（等宽块）、目录、原因；file-change 类型列出文件与 `+n −m`。按钮：主按钮"允许一次"（实心琥珀），次级"本会话允许 &lt;pattern&gt;"（琥珀描边），"拒绝"（灰描边）。桌面横排，移动端主按钮全宽 46px、次级两个并排 44px。不提供"永远允许"。 |
| `approval.resolved` | `ApprovalCard`（resolved） | 保留在流中，`opacity: 0.85`，边框改 `--border`，头部改为"命令审批 · 已允许/已拒绝"+ 处理设备与时间，正文只留一行等宽命令。按钮移除。 |
| `user_input.requested` | `QuestionCard` | 同琥珀卡片。头部：问号图标 + "&lt;Provider&gt; 想确认" + "单选/可多选"。选项是真实的 `<label><input type=radio|checkbox>`，选中项底 `--accent-bg-2` 边 `--accent`；末尾一个"其它"文本输入。主按钮"提交回答"。 |
| `user_input.resolved` | `QuestionCard`（resolved） | 同审批 resolved 态，正文显示所选答案。 |
| `turn.interrupted` | `InterruptedRow` | 虚线边框单行，`--surface-2` 底，方块图标 + "已中断 · 设备 · 时间"。 |
| `error` | `ErrorCard` | `--danger-bg` 底、`--danger-border` 边，标题 danger，说明 text-2（含可恢复提示）。 |
| `GET /api/usage`（5s 轮询，不走事件流） | `RateMeter` | 桌面侧栏底部、"项目 / 设置"之上，按 Provider 分组；每条：标签 `5h` / `week` + 4px 进度条（填充 `--text-2`，不用琥珀）+ 等宽 `42%` + 等宽重置倒计时 `2h14m`。周额度条上加一条比进度条高的竖线（`--text`），标出按时间均匀消耗此刻应用到的位置；用量超过竖线时填充和百分比改 `--danger`。 |
| 连接状态 | `ConnectionBanner` | `--surface-2` 底单行：刷新图标 + "已重新连接 · 回放 n 条事件（seq a → b）"。离线时同样式换文案。 |
| 附件上传 | `AttachmentChip` | `--surface-3` 底、`--border-2` 边、6px 圆角：22px 缩略图 + 等宽文件名 + 大小/进度 + 移除按钮。 |
| Provider | `ProviderChip` | 等宽、`--border-2` 描边、`--text-2`，内容 `claude · opus-5`。不上色。 |

## 4. 页面布局

### 桌面（≥ 1024）

安装的桌面 PWA 启用 Window Controls Overlay 时，品牌栏和会话顶栏合并进系统标题栏，高度取 44px 与系统标题栏高度的较大值。按浏览器提供的标题栏安全区域避开窗口控制按钮与 Chrome 菜单；标题和空白区域可拖动窗口，按钮保持可点击。品牌栏省略 logo、通知入口仅显示铃铛。非会话页保留同高拖动区域；窗口窄于 1024px 时单独预留系统标题栏。普通浏览器、手机与未启用覆盖模式的 PWA 保持原布局。

三栏：侧栏 280（`--panel`，右边线）· 主区（顶栏 60 + 消息流 + 输入区）。消息流居中 880 列（与输入框同宽），上内边距 28。输入区：附件芯片行 + 提示文字，下方输入框（`--surface`、`--border-2`、12px 圆角），右侧附件按钮与发送按钮各 36px。有一轮在运行时提示"当前有一轮在运行，发送将作为追加指令排队"，顶栏显示"中断"按钮（danger 描边）。

侧栏结构：品牌行（Logo + 名称 + 连接状态）→ 主导航（Inbox：未处理数量用琥珀实心角标；Todos：右侧等宽小字显示未完成数；Automations：右侧等宽小字显示下次运行时间，今天显示时刻、其他日子显示日期；当前项 `--selected` + 1px 内描边）→ 「Active / Inactive」分段页签（`--surface-2` 底，选中项 `--surface` + 1px 边）→ 按工作区分组的会话列表（两个页签同一结构；分组按组内最近活动排；组头：折叠箭头 + 名称（11px 600、保留原始大小写便于识别、`--text-2`，是侧栏的导航层级，不用 `--text-4`）+ 等宽计数，点击折叠，组间距 20，组内会话项左缩进 18 表示从属；折叠后仍露出 running / waiting_user / 未读完成 / 有草稿的项；项：标题 +`Draft` 标记（当前浏览器保存的非空白输入；清空或发送后消失，琥珀色描边芯片、600 字重）+ 时间 / Provider 名（等宽、`--text-4`、无底色，不与组头抢权重）+ 状态文字（Running 蓝 / Waiting for you 琥珀 / Error 红 / Done 绿 = 跑完后还没看过，按浏览器记在 localStorage，看过即消失；idle 已读不显示），hover 右上角出行操作：Active 是"移到 Inactive / 永久删除"，Inactive 是"移回 / 永久删除"；移动端无 hover，行操作常显）→ 底部"新建会话" → 额度区（`RateMeter`）→ "项目 / 设置"。

首页 `/` 是 Inbox：顶栏标题 + 右侧筛选芯片（All / Blocking / Decide / Reports / Follow-up / Done，选中项琥珀描边与底，数字等宽）；主区左列表 380px、右详情（内容列最大 760、居中）。列表按 Blocking → Decide → Reports → Reminders（到期待办）→ Unfinished work（没收尾的会话）分段（All / Follow-up 时显示段标题），行：26px 图标块（审批 / 提问 / 提醒琥珀，汇报 / 没收尾灰）+ 类型 · 来源会话标题 + 等宽相对时间，下一行标题（未处理前加 6px 琥珀圆点），再一行摘要。详情：来源会话标题 + Provider 芯片 + Open session，下接标题、Markdown 正文与原审批卡 / 提问卡（Decide 的提问卡不重复显示问题）；处理后自动选中下一条。没收尾的详情：会话标题作标题，琥珀描边框里是「Left off at」+ 下一步，下接项目与空闲起始时间、操作（Continue 主按钮 / Later… / Done, delete session / Dismiss）。到期待办的详情：标题、备注纯文本、项目与提醒日期、操作（Done 主按钮 / Tomorrow / Next week / Edit…）。

Todos（`/todos`）：版式同 Automations，内容列最大 760；顶栏标题 + Open / Done 芯片 + New todo。列表上方一个输入框（回车即加）。行：18px 圆形勾选框（完成后绿底白勾、标题划线变灰）+ 标题（14px 500）/ 备注首行（12px `--text-3`）/ 项目小标签 + 等宽提醒日期（到期琥珀）；桌面行尾是关联会话按钮。点行打开编辑弹窗（标题、备注、项目、提醒日期 + Tomorrow / In 3 days / Next week 快捷芯片）。会话页顶栏的 Create todo 打开同一弹窗，内容由模型起草。

Automations（`/schedules`）：顶栏标题 + New task（描边按钮）；内容列最大 960 居中。Scheduled tasks 段：每个任务一张 `--surface` 卡片——名称（14px 600）+ On/Off 小胶囊（On 用 `--ok-bg` / `--ok`）+ 右侧图标按钮（Run now / 开关 / 编辑 / 删除）；两行 12px `--text-3` 元信息（项目、等宽 Provider · 模型、周期、权限模式；等宽 Next / Last）；错误另起一行；底部分隔线下是 Recent runs 芯片（等宽 11px、`--surface-3` 底、6px 状态点）。Upcoming wake-ups 段：每行等宽琥珀时间 + note + 会话标题 + 取消。停用的任务名称与元信息 0.55 透明度。选中项底 `--surface-3`。

### 移动（< 1024，按 390 设计）

- 品牌栏和会话顶栏统一高 60px（另加安全区），品牌名 16px、会话标题 15px；桌面 logo 24px。列表首次请求尚未完成时显示 `Loading sessions…`，后台刷新不替换已有列表；加载组件与详情共用。首次进入详情、尚无消息且连接未就绪时，显示旋转图标和 `Loading conversation…`，减少动态效果偏好下不旋转。
- 输入框状态栏使用模型显示名（如 `Opus-5`、`GPT-6 Astra`）和首字母大写的思考等级，保留原始模型 ID 用于 Provider 请求；手机已有会话隐藏独立的 Provider 名称，空会话保留 Agent / 模型切换入口。手机底部操作栏依次为上传、快捷指令、可收缩的模型信息、新开会话、发送 / 中断：上传和快捷指令按钮为 32×32px，图标保持 16px，上传图标左边缘与输入文字对齐；上传图标到快捷指令图标、快捷指令图标到模型文字的视觉间距均为 16px（含空会话切换入口）；右侧图标按钮保留 40px 点击区域，按钮间不额外留间距；中间文字过长时截尾，切换箭头保持可见，右侧按钮始终留在输入框内。上传、排队等状态提示独占下一行并允许换行。
- 手机顶栏不显示底部分隔线。品牌名 `AgentDeck` 左侧使用琥珀底、黑色 `A` 的圆角方形 logo，桌面品牌栏与 favicon 共用同一 SVG。
- 列表页固定在视口内，仅会话列表区域滚动，滚动到边缘不带动整页；顶部品牌栏保持不动，logo 尺寸 28px，手机品牌名 18px。手机列表顶栏操作图标 24px、点击区域 44px；详情返回箭头 32px 并向左偏移 7px 抵消 SVG 内部留白，删除图标 22px，点击区域仍为 44px；按可见笔画做光学对齐，手机会话标题为 16px。
- 顶层四页（Inbox `/`、Todos `/todos`、Sessions `/sessions`、Automations `/schedules`）底部有 tab 栏（图标 22px，选中琥珀，Inbox 带琥珀数量角标）；会话、Inbox 详情、项目、设置等下一级页面不显示，返回键回到最近停留的 tab 页。
- Inbox 页：品牌行（logo + Inbox + 新建会话）→ 可横向滚动的筛选芯片 → 事项列表（每项最小高 64）。详情页：返回 + 类型 + Open session，正文同桌面。
- Sessions 页：顶部品牌行（新建 / 项目 / 设置）→ 分组会话列表（每项最小高 64，右箭头）→ 额度。
- 每次进入会话，在首次历史回放完成后定位到消息底部；后续流式输出和重连保留手动上翻时暂停跟随的行为。
- 会话页高度和顶部位置在首次布局及可见视口变化时按 `visualViewport` 同步，输入区不依赖消息加载或键盘弹出才能定位；手机输入框字号 16px，避免 iOS 聚焦自动缩放。
- 发送请求期间保留输入内容，发送按钮显示转圈并禁用重复点击，输入框暂时只读；成功回执后才清空。失败时恢复编辑，原文与当前页面的附件保留，输入框上方显示可换行的完整错误与重试提示。桌面同样处理。
- 会话页：顶栏返回（44px 触控区）+ 标题 + 状态行 + "中断"；消息流 16px 内边距；底栏：提示行 + [相机/相册 44px] [输入框 + 32px 发送]。
- 有未回答的提问时输入框禁用（`--text-4` 文案"回答上方问题，或输入新指令…"），底栏左侧提示"回答问题后 &lt;Provider&gt; 才会继续"，右侧等宽显示当前 seq。
- 重连时在顶栏下方插 `ConnectionBanner`。

## 5. 实现约定

- 样式：CSS Modules（`*.module.css`）+ `tokens.css` 变量。不引 Tailwind、不引组件库。
- 组件按 §3 的名字建文件，一事件一组件；状态用 props（`state="running" | "collapsed" | ...`），不为每个状态建新组件。
- 所有可点击元素是真实 `<button>` / `<a>` / `<input>`，不在 `div` 上绑 onClick。
- 界面文案默认英文；回复与项目文档仍使用简体中文。等宽字段（路径、命令、ID）不翻译、不截断中间——过长时 `text-overflow: ellipsis` 截尾，审批卡片里的命令块例外，必须完整换行显示（`word-break: break-all`）。
- 与设计稿有出入需要改稿时，先改本文再改稿。

## 6. DeepSeek 设置与会话选择（2026-09-21）

- Claude、Codex、DeepSeek 是同级选项；设置页以轻量分组展示，内容最大宽度 800px；不使用外层卡片描边，仅在分组标题下使用分隔线，字段行上下内边距 6px、分组间距 20px。分组标题 16px / 600 / `--text-strong`，字段标题 13px / 500 / `--text`；桌面端左侧标题、右侧控件，600px 以下改为上下排列。DeepSeek 包含 API 地址、API Key、Flash / Pro 模型列表与默认权限。
- 项目页与设置页同样不套外层卡片，内容最大宽度 960px：标题行右侧放 Add project；列表为平铺分隔线行，桌面每个项目单行（别名固定 200px 列 + 等宽路径截尾 + 行操作图标），600px 以下路径换到别名下方。
- DeepSeek 的「验证连接」放在分组标题右侧，「清除密钥」作为密钥说明行的轻量文字按钮；验证结果放在分组底部，不在连接配置与模型设置之间插入独立操作行。
- API Key 默认密码形式；已保存时显示黑点占位，眼睛按钮可读取并显示原文，再点隐藏。普通设置查询不传密钥；隐藏已保存原文时从组件状态移除。支持替换、清除，保存后恢复隐藏态。
- 验证连接使用已保存配置；修改未保存或尚未配置密钥时隐藏按钮。底部不显示验证费用及新会话默认值的常驻提示。
- 空会话的 Agent 切换改为三选一下拉，输入框底部菜单向上展开；已有图片草稿时先移除图片再切换。DeepSeek Pro 的图片按钮禁用并说明原因。
- 选择 Agent、模型或思考等级后，底部设置弹层保持打开，方便连续调整；保存期间仅禁用选择控件。点击弹层外、再次点击入口或按 Escape 关闭。

## 会话文件预览（2026-09-21）

- 界面新增文案使用英文。消息内本地文件链接打开原地预览弹层；图片链接显示限高缩略图。桌面宽弹层，手机适配视口；Escape / 关闭按钮 / 遮罩关闭。
- 图片支持 Fit image / Actual size；文本带行号；Markdown 与 HTML 支持 Source / Preview，HTML 默认在 iframe 中展示页面，带行号时默认源码，底部提供 Open in new tab；PDF 与音视频使用浏览器原生能力。文件预览标题栏下方显示 Mac Mini 上的完整路径，使用等宽字体，支持选中复制和长路径换行；聊天上传图片与待发送图片不展示路径。无法预览的文件展示名称、路径与操作。
- HTML 内嵌预览中的图片和图片文件链接打开上层图片弹窗；点遮罩、图片周围空白或按 Escape 返回报告并保留滚动位置。标题栏提供上一张 / 下一张、序号及原有缩放控件，左右方向键切换，首尾按钮禁用。
- 图片弹窗的视口高度和工具栏位置不随图片缩放变化，Fit / 百分比占用固定宽度。支持触控板双指缩放及放大后按住图片拖动，普通滚动平移图片，不带动底层报告。
- 操作为 Show in Finder / Download to this device，点击任一操作后立即关闭预览弹层，不等待外部应用或下载完成。Finder 按当前浏览器的目录映射交给 Mac 本地辅助应用，路径不存在时由辅助应用提示。Changes 面板点击文件即打开同一个预览弹窗。
- Settings 增加 Finder on this Mac，映射仍只存于当前浏览器，与 Provider 设置共用页尾 Save changes。详细使用说明见 `docs/file-preview.md`。
- 桌面 Composer 底部在 Start fresh 左侧紧邻放置 SquareTerminal 图标（符号自带外框），tooltip / aria-label 为 Open in iTerm2；手机不显示。点击使用当前会话 cwd 打开 SSH 终端，未配置主机时使用统一提示弹窗。Settings 的 iTerm2 on this Mac 也通过页尾 Save changes 保存 SSH host 到当前浏览器，不应用 Finder 路径映射。
- 终端图标左侧放置 FolderOpen 图标，aria-label 为 Open in Finder；同样仅桌面显示。点击将当前会话 cwd 按 Finder 映射交给辅助应用直接打开目录；无匹配映射时用统一弹窗提示配置 Settings → Finder on this Mac。

## AI 会话标题（2026-09-22）

设置页在 Provider 设置之后增加 `AI session titles`，沿用现有 section / 两列字段布局，提供 `Automatic titles`（Off / On）、`Provider`、`Model`。切换标题 Provider 时模型重置为该 Provider 的首个选项；初始为关闭、Claude / Haiku。复用页尾 Save changes。说明首条文字会额外发送到所选 Provider、消耗额度，标题最多 15 字符、只生成一次、失败保留原文预览。会话页和侧栏沿用原有标题位置，不增加加载状态。

## Codex 模型与思考等级（2026-09-23）

- 设置页与新建会话页按所选模型展示 Reasoning effort：GPT-6 Astra / Sol 为 Low、Medium、High、Xhigh（`xhigh`）、Max、Ultra；GPT-6 Luna 无 Ultra。模型为 Default 时只提供这些模型共有的等级。
- 切换模型保留仍受支持的等级，不兼容时重置为 Default；服务端按同一份模型配置校验。
- 沿用手工维护的模型配置，依据本机 Codex 模型目录核对；Codex 的 Ultra 与底层 API effort 枚举不同。旧数据中的 `light` / `extra-high` 在 Hub 下次启动时分别迁移为 `low` / `xhigh`，其他等级不变。

## `#` 会话补全

- 复用输入框上方补全弹层，`#` 只列会话，`@` 只列文件；会话项显示 MessageSquare 图标、标题、项目、Provider、短 ID，Inactive 会话另标注状态。
- 当前项目优先，支持上下键 / Enter / Tab / Escape；引用沿用蓝色 `--ref` 配色。输入框保留 `#[标题](session:ID)` 可编辑文本，消息气泡显示可点击的 `#标题`。

## 空闲更新通知

- 更新提示独立于右下角会话通知，固定在顶部栏下方居中，桌面最大宽 560px、手机两侧留 16px。使用 Application update 标签、36px 图标底座和加粗左边框；进行中为琥珀色、成功为绿色、失败为红色，复用现有语义颜色变量。包括 Update queued、Building update、Restarting AgentDeck、AgentDeck updated、AgentDeck update failed，显示阶段时间和失败原因，不自动消失。
- 成功状态附 Refresh 按钮，由用户主动加载新界面；不自动刷新。关闭提示仅隐藏该任务的当前阶段，完成或失败仍提示；关闭状态按浏览器记住，刷新和重开页面不重复显示已关闭的结果。
