// debrid-remote menu-bar status : shows the launchd state of the server agent, with start / stop / log.
// Holds no logic of its own : every state and action goes through agent.sh. No secret read, no network call.
// Built and started by `agent.sh install` (swiftc -parse-as-library) : DebridRemoteBar <agent.sh> <log>

import AppKit

func agentStatus(_ script: String) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = [script, "status"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return "error \(error.localizedDescription)" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

@MainActor
final class Bar: NSObject, NSMenuDelegate {
    let script: String
    let logPath: String
    let item: NSStatusItem
    let stateLine: NSMenuItem
    let startItem: NSMenuItem
    let stopItem: NSMenuItem
    var pending: Process?

    init(script: String, logPath: String) {
        self.script = script
        self.logPath = logPath
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        stateLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        startItem = NSMenuItem(title: "Démarrer", action: #selector(start), keyEquivalent: "")
        stopItem = NSMenuItem(title: "Arrêter", action: #selector(stop), keyEquivalent: "")
        super.init()
        let note = NSMenuItem(title: "État du processus seulement : relay et ICE non vérifiés", action: nil, keyEquivalent: "")
        let logItem = NSMenuItem(title: "Ouvrir le journal", action: #selector(openLog), keyEquivalent: "")
        let quitItem = NSMenuItem(title: "Quitter l'icône", action: #selector(quit), keyEquivalent: "")
        stateLine.isEnabled = false
        note.isEnabled = false
        let menu = NSMenu()
        menu.autoenablesItems = false
        for i in [startItem, stopItem, logItem, quitItem] { i.target = self }
        for i in [stateLine, note, NSMenuItem.separator(), startItem, stopItem, logItem, NSMenuItem.separator(), quitItem] {
            menu.addItem(i)
        }
        menu.delegate = self
        item.menu = menu
        refresh()
        Timer.scheduledTimer(timeInterval: 3, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
    }

    @objc func tick() { refresh() }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    // agent.sh status : the first word is the state, the rest is detail. Skipped while start / stop runs.
    func refresh() {
        if let p = pending, p.isRunning { return }
        pending = nil
        let line = agentStatus(script)
        let words = line.split(separator: " ")
        let state = words.first.map(String.init) ?? ""
        let symbol: String
        let text: String
        switch state {
        case "running":
            symbol = "bolt.horizontal.circle.fill"
            text = "debrid-remote : en marche (" + words.dropFirst().joined(separator: " ") + ")"
        case "crashing":
            symbol = "exclamationmark.triangle"
            text = "debrid-remote : redémarre en boucle — voir le journal"
        case "stopped":
            symbol = "bolt.horizontal.circle"
            text = "debrid-remote : arrêté"
        case "absent":
            symbol = "questionmark.circle"
            text = "debrid-remote : non installé"
        default:
            symbol = "questionmark.circle"
            text = "debrid-remote : état inconnu — " + line
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: text)
        image?.isTemplate = true
        if let button = item.button {
            button.image = image
            button.toolTip = text
        }
        stateLine.title = text
        startItem.isEnabled = state == "stopped" || state == "crashing"
        stopItem.isEnabled = state == "running" || state == "crashing"
    }

    // start / stop can wait up to 5 s on launchd : run them detached, the timer picks up the result.
    func run(_ action: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [script, action]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return }
        pending = p
        startItem.isEnabled = false
        stopItem.isEnabled = false
        stateLine.title = action == "start" ? "debrid-remote : démarrage…" : "debrid-remote : arrêt…"
    }

    @objc func start() { run("start") }
    @objc func stop() { run("stop") }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }
    @objc func quit() { NSApp.terminate(nil) }
}

@main
enum Main {
    @MainActor static var bar: Bar?

    @MainActor static func main() {
        let argv = CommandLine.arguments
        guard argv.count == 3 else {
            FileHandle.standardError.write(Data("usage: DebridRemoteBar <agent.sh> <log>\n".utf8))
            exit(64)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        bar = Bar(script: argv[1], logPath: argv[2])
        app.run()
    }
}
