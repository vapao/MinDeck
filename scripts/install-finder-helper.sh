#!/bin/bash
set -euo pipefail
# 在浏览器所在的 Mac 上安装，不在 Hub 中执行 Finder 操作。
source_dir="$(cd "$(dirname "$0")" && pwd)/finder-helper"
app_dir="$HOME/Applications/AgentDeck Finder.app"
mkdir -p "$app_dir/Contents/MacOS"
xcrun swiftc "$source_dir/main.swift" -o "$app_dir/Contents/MacOS/AgentDeckFinder" -framework AppKit
cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.agentdeck.finder</string>
<key>CFBundleName</key><string>AgentDeck Finder</string>
<key>CFBundleExecutable</key><string>AgentDeckFinder</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Open an SSH terminal for your project in iTerm2.</string>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>AgentDeck Finder</string>
<key>CFBundleURLSchemes</key><array><string>agentdeck-finder</string></array>
</dict></array>
</dict></plist>
PLIST
codesign --force --sign - "$app_dir"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app_dir"
printf 'Installed: %s\nConfigure Finder mapping and SSH host in AgentDeck Settings.\n' "$app_dir"
