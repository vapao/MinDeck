# 会话文件预览与 Finder

助手消息中的本地 Markdown 链接与图片支持绝对路径、相对会话 cwd 的路径、`~/`、`file://`、`sandbox:`；文件行号支持 `:42` / `:42:3` / `#L42`。普通网站链接保持新标签打开。Claude 会话通过 `systemPrompt.append` 要求本地图片用 `![](路径)`、其他输出文件用 Markdown 链接给出，不写成行内代码（行内代码不会渲染为文件）；Codex 默认已这样输出，未注入。历史消息使用同一渲染逻辑，无需迁移。

输出文件按开发者明确授权不限定目录，受 Hub 进程的 macOS 权限约束。此授权仅针对文件预览和下载，不改变 workspace cwd allowlist、上传附件路径与 Provider 审批模式。读取的是当前磁盘文件，不保存快照。

图片原地预览，文本最多读取 512 KiB，Markdown 可切源码，PDF 使用浏览器查看器，音视频使用原生播放器。其他文件展示操作弹窗。SVG 以 img 展示；普通文件内容响应带 sandbox CSP 和 nosniff，未知类型强制下载。下载使用流。

图片弹窗使用固定视口（高度随浏览器可用空间适配），缩放只改变图片尺寸，不移动工具栏。支持加减号、Fit、双击切换原尺寸与适应视口，以及 Mac 触控板双指缩放；图片弹窗内的缩放手势由预览接管，普通双指滚动仍用于平移。图片超出视口时可按住鼠标拖动，使用指针捕获和原生滚动，松手 / 取消后结束；拖动结束不触发点击空白关闭。此行为共用于聊天图片、文件图片和 HTML 图片弹窗。

HTML（`.html` / `.htm`）默认在 iframe 中显示页面，标题栏提供 Preview / Source，带行号的链接默认打开源码；底部提供 Open in new tab。预览读取完整文件，源码仍限 512 KiB，截断时不可编辑。源码保存后再切回 Preview 会加载磁盘最新内容。

HTML 内嵌预览中，点击图片或指向图片文件的“查看原图”链接，会在报告上方打开图片弹窗；点击遮罩、图片周围空白、关闭按钮或按 Escape 只关闭图片，保留报告滚动位置。复用图片缩放，按页面图片顺序提供 Previous / Next 和左右方向键切换，显示当前序号 / 总数，首尾不循环；同一原图的重复引用只算一张。非图片链接、按钮内图片和带修饰键的点击保持原行为。通过 Open in new tab 独立打开的 HTML 仍按原页交互。

`GET /api/sessions/:id/preview/*` 在 URL 中保留磁盘绝对路径的目录层级，按文件类型返回内容，不缓存；图片、CSS、JS（含模块导入）、fetch 和链接中的相对路径由浏览器正常解析，页内锚点照常工作。按单用户自用场景允许脚本运行，不加 sandbox；iframe 用于隔离样式和布局，页面与 Hub 同源。读取范围沿用输出文件授权，不限制在 cwd 内。普通下载接口保持原有行为。

该预览直接服务磁盘文件，不启动开发服务、不编译源码；以 `/` 开头的 URL 仍指向 Hub 的网站根路径，不自动映射到报告目录。依赖构建或后端的应用使用自己的开发服务。

预览弹窗标题栏显示文件名，标题栏下方直接显示 Mac Mini 上的完整文件路径，可选中复制，长路径自动换行；加载中或读取失败时显示消息中的原始路径。聊天上传图片与待发送图片不展示路径。Markdown 的 Preview / Source 和图片缩放放在标题栏。主体只显示文件内容及必要的错误 / 截断提示；Copy text、Show in Finder、下载统一放到底部，不展示文件大小和 MacBook 映射路径。

代码预览、编辑与 Changes 面板统一使用按需加载的 CodeMirror 6，按文件名经 `@codemirror/language-data` 识别语言；不认识的扩展名显示纯文本。预览为只读实例（可聚焦，⌘F 搜索），点 Edit 切为可编辑，保留滚动位置；带 `:42` 行号打开时定位并居中该行。Markdown 渲染视图中的 fenced code 不挂编辑器，用同一套 lezer 解析器做静态高亮，单段超过 100 KiB 时显示纯文本；复制始终使用原文。语法配色为 classHighlighter 的 `tok-*` 类，只在 `FilePreview.module.css` 维护一份，预览、编辑、diff 与 Markdown 代码块共用；不作用于聊天消息。

## 右侧项目文件浏览（2026-09-22）

桌面右侧使用 Changes / Files 两个页签。Changes 只显示改动列表，点击文件在预览弹窗中看 diff；Files 以当前会话 cwd 为根，展开目录时才加载直接子项，目录在前，不依赖 Git，也不按 `.gitignore` 排除文件。点击文件复用预览弹窗，切换页签和清空搜索保留目录展开状态与滚动位置。

Files 支持新建空文件 / 文件夹、删除文件 / 文件夹，以及在预览弹窗中编辑文本文件。顶部提供项目根目录的新建入口，仅鼠标悬停时，目录行显示在该目录内新建文件、新建文件夹和删除按钮，文件行及搜索结果显示删除按钮；点击或焦点停留不使操作按钮常驻。新建使用统一输入弹窗，只接受单个名称，重名报错且不覆盖已有内容；创建后展开父目录并刷新列表。

删除使用统一危险确认弹窗，显示完整相对路径。删除为永久删除，不进入废纸篓；删除文件夹包括全部子项及隐藏、忽略、未跟踪内容，Git 不保证能找回未提交内容。只修改工作区，不改暂存区。Changes 支持确认后丢弃单文件未提交改动，具体语义和边界见 `features.md` 切片 10。

写入限定在当前会话 cwd 内；拒绝工作区根目录、路径越界、`.git` 路径和父目录符号链接，删除符号链接只删链接本身，不沿目录内符号链接递归。删除目录前检查整个子树，含 `.git` 目录或文件时拒绝，避免删除嵌套仓库及 worktree 元数据。删除接口校验文件 / 文件夹类型与确认时相符。同工作区或与其路径重叠的会话有 running / waiting_user 或 Agent 后台任务时禁用写入，操作期间与新一轮、Git 回退互斥；外部编辑器和终端不受 Hub 锁保护。操作后刷新 Files、Changes 和预览缓存。

Show hidden files 默认关闭，在当前浏览器 localStorage 记住；控制以 `.` 开头的文件和目录，目录树与搜索遵循同一个开关。搜索按文件名 / 相对路径不区分大小写匹配，输入后显示带相对路径的文件列表，不搜索文件内容。

`GET /api/sessions/:id/files?path=&q=&hidden=false`：无 q 时列直接子项，有 q 时从项目根搜索；搜索最多返回 200 项，扫描预算 1.5 秒，达到上限返回 `truncated` 并在界面明确提示结果不完整、需要缩小关键词。目录路径解析后必须仍在 cwd 内；符号链接作为可预览条目，不递归跟随，避免循环或扫描项目之外。

`POST /api/sessions/:id/files` / `DELETE /api/sessions/:id/files`：请求体 `{ path, dir }`，path 相对 cwd，dir 标明文件夹。新建只创建目标这一层，父目录必须已存在。空文件夹会出现在 Files，但 Git 不记录空文件夹。

已通过桌面浏览器验收：未改动文件预览、展开状态保留、文件路径搜索、隐藏文件过滤及 Markdown 视图切换；新增目录边界测试覆盖相对 / 绝对越界与目录符号链接。

## 文本编辑（2026-10-14）

预览弹窗对 cwd 内、完整读取（未截断）的 UTF-8 文本 / Markdown 显示 Edit，在同一 CodeMirror 实例中编辑（Markdown 切到源码），支持自动缩进、Tab 缩进、括号补全与撤销；缩进单位按文件已有缩进识别（Tab 或最小空格缩进，无缩进时 2 空格）。Save 或 ⌘S 保存，Cancel 回到预览；有未保存改动时关闭或取消需确认。cwd 外的文件、`.git` 内文件、超过 512 KiB 的文件只读。原文件为 CRLF 时按 CRLF 写回。

`PUT /api/sessions/:id/files/content`：请求体 `{ path, content }`，path 为预览返回的绝对路径，服务端换算回 cwd 相对路径后走与新建 / 删除相同的写入校验与工作区写锁（Agent 运行中拒绝保存），只覆盖已存在的普通文件，符号链接不可保存。不做并发冲突检测，保存直接覆盖磁盘当前内容；仅桌面端使用，不针对手机适配。

## MacBook 一次性安装

在 **MacBook** 上取得本仓库的 `scripts/install-finder-helper.sh` 与 `scripts/finder-helper/main.swift`，保持相对目录不变，执行：

```sh
bash scripts/install-finder-helper.sh
```

安装需要 Xcode Command Line Tools（`xcrun swiftc`）。安装到 `~/Applications/AgentDeck Finder.app`，注册 `agentdeck-finder:` 协议，无常驻进程或监听端口。移除此应用即可卸载。

在 AgentDeck Settings → Finder on this Mac 设置：

- Mac Mini folder：例如 `/Users/aka`
- Mounted folder on this Mac：例如 `/Volumes/aka`

点击设置页底部的 Save changes 后，映射只保存在当前浏览器。同一浏览器更换 Hub 地址会有独立设置。映射按完整目录前缀匹配，不将 `/Users/aka-other` 当成 `/Users/aka` 的子目录。

点击 Show in Finder 后，浏览器可能首次要求允许启动辅助应用。文件在 Finder 中选中；目录直接打开。辅助应用只接收路径并调用系统 Finder API，不将参数传给 shell。路径不存在时提示检查挂载和映射。网页无法可靠判断辅助应用是否安装或操作是否成功。

下载始终可用；目录仅支持 Finder。没有映射的路径提示到 Settings 配置。手机上保持映射为空，使用预览和下载。

桌面输入框底部的 Open in Finder 文件夹图标位于终端入口左侧，点击直接打开当前会话的项目目录（cwd），沿用上述映射和辅助应用。没有匹配的映射时提示前往 Settings 配置。

## 项目 SSH 终端

桌面输入框底部的 Open in iTerm2 图标位于 Start fresh 左侧。Settings → iTerm2 on this Mac 中填写 MacBook `~/.ssh/config` 的主机别名（如 `mac-mini`），也可填写 `user@hostname`；端口、密钥等放在 SSH config 中。点击页尾 Save changes 后，该设置只保存在当前浏览器；未配置时按钮提示设置。

重新运行安装脚本更新辅助应用。首次调用可能要求允许 AgentDeck Finder 控制 iTerm2；可在 macOS「系统设置 → 隐私与安全性 → 自动化」管理。辅助应用会在已有 iTerm2 窗口新建标签页，没有窗口则新建窗口，执行 SSH 并进入会话原始 cwd，随后启动远端登录 Shell。新建 session 先启动 `/bin/zsh -l`，再输入 SSH 命令；SSH 失败或结束后保留本地提示符，便于查看错误和重试。不会使用 Finder 映射，不会向已有 session 写命令。SSH 密码和主机确认在终端中处理。

只接受主机别名与绝对目录，不接受任意命令。路径经过本地 Shell、SSH 远端 Shell 与 AppleScript 各层转义；若远端目录不存在，连接命令退出，不在错误目录启动 Shell。Finder 动作仍不使用 Shell。

辅助应用编译及参数转义检查：

```sh
xcrun swiftc -D HELPER_TEST scripts/finder-helper/main.swift -framework AppKit -o /tmp/agentdeck-helper-test
/tmp/agentdeck-helper-test
```
