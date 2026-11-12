import AppKit

final class FinderDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(reveal(_:reply:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    @objc func reveal(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        defer { NSApp.terminate(nil) }
        guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URLComponents(string: raw), url.scheme == "mindeck-finder",
              let path = url.queryItems?.first(where: { $0.name == "path" })?.value,
              path.hasPrefix("/"), !path.contains("\0") else { return }
        if url.host == "terminal" {
            guard let host = url.queryItems?.first(where: { $0.name == "host" })?.value,
                  host.rangeOfCharacter(from: .controlCharacters) == nil,
                  host.range(of: "^[A-Za-z0-9][A-Za-z0-9._@-]*$", options: .regularExpression) != nil,
                  path.rangeOfCharacter(from: .controlCharacters) == nil else { return }
            openTerminal(host: host, path: path)
            return
        }
        guard url.host == "reveal" else { return }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &directory) else {
            let alert = NSAlert()
            alert.messageText = "File not found on this Mac"
            alert.informativeText = "Check that the shared folder is mounted and the Finder mapping is correct.\n\n" + path
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }
        let file = URL(fileURLWithPath: path)
        if directory.boolValue { NSWorkspace.shared.open(file) }
        else { NSWorkspace.shared.activateFileViewerSelecting([file]) }
    }

    func openTerminal(host: String, path: String) {
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil else {
            showError("iTerm2 is not installed", "Install iTerm2 on this Mac, then try again.")
            return
        }
        // 只向新建的 session 写入命令，保留本地 shell 以显示 SSH 失败原因。
        // 本地 shell、SSH 远端 shell、AppleScript 分别转义，路径不能变成命令。
        let remote = "cd -- " + shellQuote(path) + " && exec \"$SHELL\" -l"
        let ssh = "/usr/bin/ssh -t -- " + shellQuote(host) + " " + shellQuote(remote)
        let literal = ssh.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let script = NSAppleScript(source: """
        tell application id "com.googlecode.iterm2"
            activate
            if (count of windows) is 0 then
                set projectWindow to (create window with default profile command "/bin/zsh -l")
                set projectSession to current session of projectWindow
            else
                tell current window
                    set projectTab to (create tab with default profile command "/bin/zsh -l")
                    set projectSession to current session of projectTab
                end tell
            end if
            tell projectSession
                write text "\(literal)"
            end tell
        end tell
        """)!
        var error: NSDictionary?
        script.executeAndReturnError(&error)
        if let error = error {
            showError("Could not open iTerm2", "Allow MinDeck Finder to control iTerm2 in System Settings → Privacy & Security → Automation.\n\n" + error.description)
        }
    }

    func showError(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

}
func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

#if HELPER_TEST
// 回归固定边界：任何目录字符串经过 shell 后仍是一个原样参数。
for value in ["/tmp/a b", "/tmp/中文", "/tmp/a'b", "/tmp/$(printf injected);`printf injected`", "/tmp/a\\b\"c"] {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", "printf '%s' " + shellQuote(value)]
    process.standardOutput = pipe
    try process.run()
    let result = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    precondition(process.terminationStatus == 0 && String(data: result, encoding: .utf8) == value)
}
print("Shell quoting checks passed")
#else
let app = NSApplication.shared
let delegate = FinderDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

#endif
