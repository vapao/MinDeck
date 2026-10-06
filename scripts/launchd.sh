#!/bin/zsh
# Hub 常驻（方案 §11.3：launchd 自动拉起）。用法：scripts/launchd.sh install | uninstall | update | update-when-idle | restart | status | logs
# install 会先构建前端，再写 ~/Library/LaunchAgents/com.agentdeck.hub.plist 并加载（改了代理配置要重新 install）。
# 改了代码后 update：重新构建前端并重启 Hub，不动 plist；只改了 server 端用 restart 即可（tsx 直接跑源码）。
set -euo pipefail

label=com.agentdeck.hub
root=${0:A:h:h}
plist=$HOME/Library/LaunchAgents/$label.plist
log=$root/data/logs/hub.log
node=$(command -v node)
tsx=$root/apps/server/node_modules/tsx/dist/cli.mjs
# 子进程要能找到 claude / codex（~/.local/bin）与 git 等工具；launchd 默认 PATH 只有系统目录
path_env="$HOME/.local/bin:$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# launchd 不读 ~/.zshrc：本机访问 Anthropic / OpenAI 依赖 shell 里的代理变量，安装时原样带进去，否则 Claude 报 403 Request not allowed
proxy_env=""
for k in http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY; do
  [[ -n ${(P)k:-} ]] && proxy_env+="    <key>$k</key><string>${(P)k}</string>"$'\n'
done

case ${1:-} in
  install)
    (cd "$root" && pnpm build)
    mkdir -p "$(dirname "$log")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$tsx</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$root/apps/server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path_env</string>
    <key>HOME</key><string>$HOME</string>
$proxy_env  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    # bootout 是异步的，旧实例没退干净就 bootstrap 会报 Bad request
    while launchctl print "gui/$UID/$label" &>/dev/null; do sleep 0.5; done
    launchctl bootstrap "gui/$UID" "$plist"
    echo "已加载 $label，日志 $log"
    ;;
  uninstall)
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "已卸载 $label"
    ;;
  update)
    (cd "$root" && pnpm build)
    launchctl kickstart -k "gui/$UID/$label"
    echo "已重新构建并重启 $label"
    ;;
  update-when-idle)
    launchctl print "gui/$UID/$label" >/dev/null
    "$node" "$root/scripts/update-when-idle.mjs"
    ;;
  restart)
    launchctl kickstart -k "gui/$UID/$label"
    ;;
  status)
    launchctl print "gui/$UID/$label" | grep -E 'state|pid|last exit' || echo "$label 未加载"
    ;;
  logs)
    tail -f "$log"
    ;;
  *)
    echo "用法: $0 install | uninstall | update | update-when-idle | restart | status | logs" >&2
    exit 1
    ;;
esac
