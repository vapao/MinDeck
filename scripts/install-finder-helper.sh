#!/bin/bash
set -euo pipefail
# 在浏览器所在的 Mac 上安装，不在 Hub 中执行 Finder 操作。
source_dir="$(cd "$(dirname "$0")" && pwd)/finder-helper"
app_dir="${2:-$HOME/Applications/MinDeck Finder.app}"
mkdir -p "$app_dir/Contents/MacOS"
xcrun swiftc "$source_dir/main.swift" -o "$app_dir/Contents/MacOS/MinDeckFinder" -framework AppKit
cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.mindeck.finder</string>
<key>CFBundleName</key><string>MinDeck Finder</string>
<key>CFBundleExecutable</key><string>MinDeckFinder</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Open an SSH terminal for your project in iTerm2.</string>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>MinDeck Finder</string>
<key>CFBundleURLSchemes</key><array><string>mindeck-finder</string></array>
</dict></array>
</dict></plist>
PLIST
codesign --force --sign - "$app_dir"
if [[ "${1:-}" == --build ]]; then exit 0; fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app_dir"
printf 'Installed: %s\nConfigure Finder mapping and SSH host in MinDeck Settings.\n' "$app_dir"
