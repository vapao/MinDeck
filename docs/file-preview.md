# 会话文件预览与 Finder

助手消息中的本地 Markdown 链接与图片支持绝对路径、相对会话 cwd 的路径、`~/`、`file://`、`sandbox:`；文件行号支持 `:42` / `:42:3` / `#L42`。普通网站链接保持新标签打开。历史消息使用同一渲染逻辑，无需迁移。

输出文件按开发者明确授权不限定目录，受 Hub 进程的 macOS 权限约束。此授权仅针对文件预览和下载，不改变 workspace cwd allowlist、上传附件路径与 Provider 审批模式。读取的是当前磁盘文件，不保存快照。

图片原地预览，文本最多读取 512 KiB，Markdown 可切源码，PDF 使用浏览器查看器，音视频使用原生播放器。其他文件展示操作弹窗。HTML 作为文本，SVG 以 img 展示；文件内容响应带 sandbox CSP 和 nosniff，未知类型强制下载，不作为 Hub 同源页面执行。下载使用流。

## MacBook 一次性安装

在 **MacBook** 上取得本仓库的 `scripts/install-finder-helper.sh` 与 `scripts/finder-helper/main.swift`，保持相对目录不变，执行：

```sh
bash scripts/install-finder-helper.sh
```

安装需要 Xcode Command Line Tools（`xcrun swiftc`）。安装到 `~/Applications/AgentDeck Finder.app`，注册 `agentdeck-finder:` 协议，无常驻进程或监听端口。移除此应用即可卸载。

在 AgentDeck Settings → Finder on this Mac 设置：

- Mac Mini folder：例如 `/Users/aka`
- Mounted folder on this Mac：例如 `/Volumes/aka`

设置只保存在当前浏览器。同一浏览器更换 Hub 地址会有独立设置。映射按完整目录前缀匹配，不将 `/Users/aka-other` 当成 `/Users/aka` 的子目录。

点击 Show in Finder 后，浏览器可能首次要求允许启动辅助应用。文件在 Finder 中选中；目录直接打开。辅助应用只接收路径并调用系统 Finder API，不将参数传给 shell。路径不存在时提示检查挂载和映射。网页无法可靠判断辅助应用是否安装或操作是否成功。

下载始终可用；目录仅支持 Finder。没有映射的路径提示到 Settings 配置。手机上保持映射为空，使用预览和下载。

桌面输入框底部的 Open in Finder 文件夹图标位于终端入口左侧，点击直接打开当前会话的项目目录（cwd），沿用上述映射和辅助应用。没有匹配的映射时提示前往 Settings 配置。

## 项目 SSH 终端

桌面输入框底部的 Open in iTerm2 图标位于 Start fresh 左侧。Settings → iTerm2 on this Mac 中填写 MacBook `~/.ssh/config` 的主机别名（如 `mac-mini`），也可填写 `user@hostname`；端口、密钥等放在 SSH config 中。该设置只保存在当前浏览器，未配置时按钮提示设置。

重新运行安装脚本更新辅助应用。首次调用可能要求允许 AgentDeck Finder 控制 iTerm2；可在 macOS「系统设置 → 隐私与安全性 → 自动化」管理。辅助应用会在已有 iTerm2 窗口新建标签页，没有窗口则新建窗口，执行 SSH 并进入会话原始 cwd，随后启动远端登录 Shell。新建 session 先启动 `/bin/zsh -l`，再输入 SSH 命令；SSH 失败或结束后保留本地提示符，便于查看错误和重试。不会使用 Finder 映射，不会向已有 session 写命令。SSH 密码和主机确认在终端中处理。

只接受主机别名与绝对目录，不接受任意命令。路径经过本地 Shell、SSH 远端 Shell 与 AppleScript 各层转义；若远端目录不存在，连接命令退出，不在错误目录启动 Shell。Finder 动作仍不使用 Shell。

辅助应用编译及参数转义检查：

```sh
xcrun swiftc -D HELPER_TEST scripts/finder-helper/main.swift -framework AppKit -o /tmp/agentdeck-helper-test
/tmp/agentdeck-helper-test
```
