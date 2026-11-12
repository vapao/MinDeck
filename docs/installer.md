# macOS 安装版

安装版面向已经登录 Claude Code 的单机用户。无需预装 Node、git、pnpm 或 Xcode，无需构建；Codex 仍为可选的本机安装。使用 Release 中 `install.sh` 的下载链接执行 `curl -fsSL "$installer_url" | sh`，重复执行同一条 latest Release 链接就是升级。脚本完成后打开 `http://127.0.0.1:8004`，首次在 Projects 添加自己的目录。

仓库地址尚未确定：唯一默认值在 `scripts/release-config.json` 的 `repository`。GitHub Actions 使用 `github.repository` 注入实际地址；生成的安装脚本固定引用所属 tag 的包与校验文件，避免 latest 在下载过程中变化。发布后将该仓库的 latest Release 的 `install.sh` 链接放进 README。此变更没有修改两个 README。

## 目录与生命周期

- `~/.mindeck/app/`：Node、服务端单文件 bundle、前端 dist、SDK 平台可执行文件、脚本和助手副本，升级整体替换。
- `~/.mindeck/data/`：SQLite、uploads、logs、steward；升级及卸载均保留。
- `~/.mindeck/MinDeck Finder.app`：稳定路径的已编译助手，注册 `mindeck-finder:`；没有常驻进程。
- `~/.mindeck/install.json`：安装版本、端口和 launchd label；升级沿用端口及 label。
- `~/Library/LaunchAgents/com.mindeck.hub.plist`：当前用户登录后启动、异常退出重启。安装时复制当前 shell 的代理变量；改代理后重跑安装命令。

源码运行默认仍用仓库 `data/`、端口 8004，并添加仓库为默认项目。安装版设置现有 `MINDECK_DB` / `MINDECK_UPLOADS` / `MINDECK_WEB_DIST`，另设 `MINDECK_SEED_WORKSPACE=0` 跳过默认项目。服务日志跟随数据库目录的 `logs/services`，默认源码路径保持不变。

升级先校验 SHA-256 和架构、检查服务空闲与端口冲突、复制新程序，随后停止旧 Hub、替换程序并启动。running / waiting_user 或后台任务存在时拒绝升级或卸载，提示结束任务后重跑；空闲检查不锁新请求，和源码更新一样不保证严格无中断升级。不会自动回滚数据库；新 Hub 启动失败会报出日志位置并保留上一版程序。未知错误直接退出。

已有同名 launchd 服务但没有本安装器的安装记录时拒绝覆盖，因此不会替换源码部署。端口占用也会在替换前报错。源码部署用户需自行选择迁移或用不同端口与 label 并存，不自动迁移数据。

卸载（停止服务、删除程序和助手，保留数据）：

```sh
sh ~/.mindeck/app/scripts/uninstall.sh
```

Claude 的原生会话仍由 Claude 自己管理；正常安装复用当前用户的 Claude Code 登录和配置。安装器会检查登录状态，未登录时提示运行 `claude auth login`。不会替用户登录或安装 Codex。

## 打包与发布

采用独立 Node 二进制 + 一个服务端 JS，保留 SQLite、动态包解析与 SDK 子进程的常规运行方式，无需 SEA 注入。SDK 原生二进制保留包路径，SDK 按其现有 resolver 查找；没有改 Provider 的会话或权限行为。

```sh
pnpm install --frozen-lockfile
pnpm codex:schema  # 开发者/CI typecheck 需要，本机需 Codex
pnpm typecheck
pnpm build:release v0.1.0
```

在对应芯片的 Mac 上打包；Node 版本固定于 `scripts/release-config.json`，下载 [Node 官方发行包](https://nodejs.org/download/release/v24.20.0/)并验证其 SHA-256。Swift 助手在构建机编译、临时签名；用户机器不编译。输出在 gitignore 的 `dist/`：

- `mindeck-darwin-arm64.tar.gz` 或 `mindeck-darwin-x64.tar.gz`
- 相应 `.sha256`
- 已填入仓库和 tag 的 `install.sh`

`.github/workflows/release.yml` 在推送 `v*` tag 时，分别用 `macos-15` 与 `macos-15-intel` 构建（架构标签见 [GitHub 官方 runner 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)），再把两套包及安装脚本上传到 Release。不需要预先创建 Release。Node、SDK 平台包及 SDK 的许可说明随包提供。SDK 是按其许可使用的组件，发布前仍需维护者确认分发条款。

构建机与运行系统的支持范围受所选 Node、SDK 与 Swift 系统框架限制；本次实测仅覆盖当前 Apple Silicon Mac，不能把 CI 的双架构配置视为 Intel 真机验收。

## 隔离验收

本地包入口只用于开发验收，不影响正式下载行为：

```sh
# 先建立临时目录并保存路径，不能指向生产 HOME。
test_home=$(mktemp -d /tmp/mindeck-test.XXXXXX)
env HOME="$test_home" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  MINDECK_PORT=18004 MINDECK_LABEL=com.mindeck.installer-test \
  MINDECK_ARCHIVE="$PWD/dist/mindeck-darwin-arm64.tar.gz" \
  sh dist/install.sh
```

可用 `MINDECK_INSTALL_ROOT` 覆盖安装根，`MINDECK_OPEN_BROWSER=0` 关闭自动开页；它们主要用于隔离测试。不要用生产 label 或数据目录测试。

自动集成检查只验证已固定的数据边界，不调用模型：

```sh
node scripts/test-installer.mjs dist/mindeck-darwin-arm64.tar.gz
```

它使用带空格的临时 HOME、随机空闲端口与独立 label，验证无 Node/pnpm 的安装、空项目初始状态、升级后项目/会话/附件保留，以及卸载后数据库/附件/服务日志保留，以及同名非本安装器 launchd 配置不会被覆盖。finally 清理测试服务、助手注册和临时目录。原生 Finder / Terminal 和真实 Claude 对话另外手动验收。

2026-11-12 实测记录：

- Apple Silicon，发布包约 132 MiB；服务端 bundle 约 4.4 MiB。
- 首装本地包 4.36 秒，升级第二版本 5.82 秒，卸载 0.60 秒；不含 GitHub 网络下载。另一次不关闭自动开页的升级成功在默认浏览器打开测试地址，验收后关闭该标签。
- PATH 不含 Node / pnpm，用包内 Node 启动 launchd 服务；独立端口 18004、临时 HOME、label `com.mindeck.installer-test`。
- 浏览器从零添加项目、创建 Claude 会话，真实回复「MinDeck 安装版验证成功。」。临时 HOME 中旧凭证第一次失败，换为当前有效凭证副本后成功；未修改生产认证。
- 升级前上传图片，升级后核对完整会话元信息和图片原始字节一致；浏览器刷新可查看已有消息。
- Finder 原生窗口显示测试项目；Terminal 新 shell 的 cwd 为测试项目；原生界面工具拒绝访问 Terminal，因此使用进程 cwd 验证而未读取其窗口。Auto 与 Remote Mac 切换、保存、刷新均正确。
- 本机测试地址已有旧 Service Worker，首次导航仍显示旧壳，刷新后使用新版本。升级时现有标签可能也需刷新。
- GitHub 上传/下载链路、Intel 真机、无 Command Line Tools 的全新 macOS、远程 SSH 主机实连未覆盖。

测试清理：卸载测试 label 与 plist、注销临时助手，验证保留的 SQLite（18 条事件）和图片后删除整个临时 HOME（含凭证副本），关闭测试浏览器与 Finder 窗口，停止测试终端 shell。生产 Hub 的 PID `39269` 与实例 ID 均未变化，main 的两个 README 校验值未变化。
