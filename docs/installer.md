# macOS 安装版

安装版面向已经登录 Claude Code 的单机用户。无需预装 Node、git、pnpm 或 Xcode，无需构建；安装器同时准备 Claude 与 Codex，Codex 登录可选。使用 Release 中 `install.sh` 的下载链接执行 `curl -fsSL "$installer_url" | sh`，重复执行同一条 latest Release 链接就是升级。脚本完成后打开 `http://127.0.0.1:8004`，首次在 Projects 添加自己的目录。

仓库地址尚未确定：唯一默认值在 `scripts/release-config.json` 的 `repository`。GitHub Actions 使用 `github.repository` 注入实际地址；生成的安装脚本固定引用所属 tag 的包与校验文件，避免 latest 在下载过程中变化。发布后将该仓库的 latest Release 的 `install.sh` 链接放进 README。此变更没有修改两个 README。

## 目录与生命周期

- `~/.mindeck/app/`：Node、服务端单文件 bundle、前端 dist、从 npm 安装的 Claude / Codex 平台可执行文件、脚本和助手副本，升级整体替换。
- `~/.mindeck/data/`：SQLite、uploads、logs、steward；升级及卸载均保留。
- `~/.mindeck/MinDeck Finder.app`：稳定路径的已编译助手，注册 `mindeck-finder:`；没有常驻进程。
- `~/.mindeck/install.json`：安装版本、端口和 launchd label；升级沿用端口及 label。
- `~/Library/LaunchAgents/com.mindeck.hub.plist`：当前用户登录后启动、异常退出重启。安装时复制当前 shell 的代理变量；改代理后重跑安装命令。

源码运行默认仍用仓库 `data/`、端口 8004，并添加仓库为默认项目。安装版设置现有 `MINDECK_DB` / `MINDECK_UPLOADS` / `MINDECK_WEB_DIST`，另设 `MINDECK_SEED_WORKSPACE=0` 跳过默认项目。服务日志跟随数据库目录的 `logs/services`，默认源码路径保持不变。

升级先校验 SHA-256 和架构、检查服务空闲与端口冲突、复制新程序，随后停止旧 Hub、替换程序并启动。running / waiting_user 或后台任务存在时拒绝升级或卸载，提示结束任务后重跑；空闲检查不锁新请求，和源码更新一样不保证严格无中断升级。不会自动回滚数据库；新 Hub 启动失败会报出日志位置并保留上一版程序。只有连接被拒（`ECONNREFUSED`，例如 Hub 崩溃循环）视为空闲，允许修复升级或卸载；HTTP 错误、超时等仍直接退出。

已有同名 launchd 服务但没有本安装器的安装记录时拒绝覆盖，因此不会替换源码部署。端口占用也会在替换前报错。源码部署用户需自行选择迁移或用不同端口与 label 并存，不自动迁移数据。

卸载（停止服务、删除程序和助手，保留数据）：

```sh
sh ~/.mindeck/app/scripts/uninstall.sh
```

Claude 的原生会话仍由 Claude 自己管理；正常安装复用当前用户的 Claude Code 登录和配置。安装器分别检查 Claude 的 `auth status` 和 Codex 的 `login status`，未登录时输出包内程序的完整登录命令（包括 Codex 启动器需要的包内 Node 路径）。两者未登录均提示而不阻断安装；不要求用户有全局 CLI，也不替用户登录。

## 打包与发布

采用独立 Node 二进制 + 一个服务端 JS，保留 SQLite、动态包解析与 SDK 子进程的常规运行方式，无需 SEA 注入。Claude SDK 与 Codex 主包在 `apps/server/package.json` 使用精确版本，平台包版本与 integrity 由 `pnpm-lock.yaml` 锁定。源码与安装版都使用依赖版本：Claude 由 SDK resolver 查找平台包；Codex 由 Hub 的 Node 执行依赖里的 `bin/codex.js`，再由官方启动器解析平台二进制，不查找 PATH 中的 CLI。

Codex npm 主包只有 JS 启动器，平台包通过 npm alias 分发，例如 `@openai/codex-darwin-arm64` 指向 `@openai/codex@0.160.1-darwin-arm64`（[该版本 npm 元数据](https://registry.npmjs.org/@openai/codex/0.160.1)）。构建时将 launcher 放进包，另外从 lockfile 提取 Claude 与 Codex 当前架构平台包的精确版本和 SHA-512 写入 `release.json`。

Release tar 不包含 Claude / Codex 平台二进制。安装器直接从 `registry.npmjs.org` 下载到暂存目录，校验 SHA-512 后才解压到 `app/node_modules/<平台包名>`；下载或校验失败不会停止、替换旧 Hub。升级时若旧版记录中的包名、版本、integrity 都一致且包仍存在，则复制复用。首次安装需要能访问 npm；使用本地 MinDeck tar 也仍需下载平台包。

```sh
pnpm install --frozen-lockfile
pnpm codex:schema  # 使用依赖内 Codex；开发者/CI typecheck 需要
pnpm typecheck
pnpm build:release v0.1.0
```

在对应芯片的 Mac 上打包；Node 版本固定于 `scripts/release-config.json`，下载 [Node 官方发行包](https://nodejs.org/download/release/v24.20.0/)并验证其 SHA-256。Swift 助手在构建机编译、临时签名；用户机器不编译。输出在 gitignore 的 `dist/`：

- `mindeck-darwin-arm64.tar.gz` 或 `mindeck-darwin-x64.tar.gz`
- 相应 `.sha256`
- 已填入仓库和 tag 的 `install.sh`

`.github/workflows/release.yml` 在推送 `v*` tag 时，分别用 `macos-15` 与 `macos-15-intel` 构建（架构标签见 [GitHub 官方 runner 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)），再把两套包及安装脚本上传到 Release。不需要预先创建 Release。Node 与 SDK JS 的许可说明随包提供，平台程序由用户安装时直接从官方 npm 包下载。

构建机与运行系统的支持范围受所选 Node、SDK 与 Swift 系统框架限制；双架构发布需要分别验收，不能仅以 workflow 配置代替真机验证。

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

它使用带空格的临时 HOME、随机空闲端口与独立 label，验证无 Node/pnpm 的安装、空项目初始状态、升级后项目/会话/附件保留，以及卸载后数据库/附件/服务日志保留，以及同名非本安装器 launchd 配置不会被覆盖。还验证 Release 未夹带平台二进制、SHA-512 不匹配时旧 Hub 不受影响、同版本平台包复用，以及崩溃循环下可升级/卸载。finally 清理测试服务、助手注册和临时目录。

真实对话验收：在隔离 HOME 中登录两个包内 CLI，再在独立端口的 Hub 各创建一条 Claude / Codex 会话并发送不调用工具的短消息。源码验收也须指定独立 `MINDECK_PORT`、`MINDECK_DB`、`MINDECK_UPLOADS` 和临时 HOME；通过进程命令行核对 Codex 来自项目依赖，并用该路径的 `--version` 核对版本。测试完成后卸载临时服务并删除临时 HOME。Finder / Terminal 联动另外手动验收。
