import Cocoa
import WebKit

private let kAdminURL = "https://localhost:43098/admin/"
private let kRetryInterval: TimeInterval = 1.0
private let kMaxRetries = 30
private let kSections = [
    (label: "Dossiers", id: "history"),
    (label: "Configuration", id: "configuration"),
    (label: "Tampon et pièces", id: "pieces"),
    (label: "Skills et agents", id: "files"),
]

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var sectionControl: NSSegmentedControl!
    var statusLabel: NSTextField!
    var retryCount = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "piecemakerShell")
        config.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.nativeShell = 'macos';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self

        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let w: CGFloat = min(1280, screen.width * 0.85)
        let h: CGFloat = min(900, screen.height * 0.85)
        let x = screen.origin.x + (screen.width - w) / 2
        let y = screen.origin.y + (screen.height - h) / 2

        window = NSWindow(
            contentRect: NSRect(x: x, y: y, width: w, height: h),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "PieceMaker"
        window.contentView = webView
        installTitlebarControls()
        window.makeKeyAndOrderFront(nil)

        loadAdmin()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func installTitlebarControls() {
        sectionControl = NSSegmentedControl(
            labels: kSections.map { $0.label },
            trackingMode: .selectOne,
            target: self,
            action: #selector(selectSection(_:))
        )
        sectionControl.controlSize = .small
        sectionControl.segmentStyle = .texturedRounded
        sectionControl.selectedSegment = 0
        sectionControl.setAccessibilityLabel("Sections PieceMaker")
        sectionControl.sizeToFit()

        let navigationContainer = NSView(frame: NSRect(
            x: 0,
            y: 0,
            width: sectionControl.frame.width + 12,
            height: max(28, sectionControl.frame.height)
        ))
        sectionControl.frame.origin = NSPoint(
            x: 6,
            y: (navigationContainer.frame.height - sectionControl.frame.height) / 2
        )
        navigationContainer.addSubview(sectionControl)
        let navigationAccessory = NSTitlebarAccessoryViewController()
        navigationAccessory.layoutAttribute = .left
        navigationAccessory.view = navigationContainer
        window.addTitlebarAccessoryViewController(navigationAccessory)

        statusLabel = NSTextField(labelWithString: "Connexion…")
        statusLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .right
        statusLabel.sizeToFit()
        let statusContainer = NSView(frame: NSRect(x: 0, y: 0, width: 142, height: 28))
        statusLabel.frame = NSRect(x: 0, y: 5, width: 134, height: 18)
        statusContainer.addSubview(statusLabel)
        let statusAccessory = NSTitlebarAccessoryViewController()
        statusAccessory.layoutAttribute = .right
        statusAccessory.view = statusContainer
        window.addTitlebarAccessoryViewController(statusAccessory)
    }

    @objc private func selectSection(_ sender: NSSegmentedControl) {
        guard sender.selectedSegment >= 0, sender.selectedSegment < kSections.count else { return }
        let section = kSections[sender.selectedSegment].id
        webView.evaluateJavaScript("window.piecemakerNavigateTo?.('\(section)')")
    }

    private func startServer() {
        var node = "/usr/local/bin/node"
        var cli = NSString(string: "~/PieceMaker/installer/bin/piecemaker.mjs").expandingTildeInPath

        if let bundlePlist = Bundle.main.url(forResource: "environment", withExtension: "plist"),
           let dict = NSDictionary(contentsOf: bundlePlist) {
            if let n = dict["PIECEMAKER_NODE"] as? String { node = n }
            if let c = dict["PIECEMAKER_CLI"] as? String { cli = c }
        }
        if let n = ProcessInfo.processInfo.environment["PIECEMAKER_NODE"] { node = n }
        if let c = ProcessInfo.processInfo.environment["PIECEMAKER_CLI"] { cli = c }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [cli, "start"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }

    private func loadAdmin() {
        guard let url = URL(string: kAdminURL) else { return }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }
}

extension AppDelegate: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "piecemakerShell",
              let payload = message.body as? [String: Any],
              let kind = payload["kind"] as? String else { return }

        if kind == "section", let section = payload["value"] as? String,
           let index = kSections.firstIndex(where: { $0.id == section }) {
            sectionControl.selectedSegment = index
            return
        }

        if kind == "status", let label = payload["label"] as? String {
            statusLabel.stringValue = label
            statusLabel.textColor = payload["value"] as? String == "ok" ? .systemGreen : .systemRed
        }
    }
}

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryCount += 1
        guard retryCount <= kMaxRetries else {
            webView.loadHTMLString(
                "<html><body style='font-family:system-ui;padding:40px;color:#666'>"
                + "<h2>Serveur inaccessible</h2>"
                + "<p>Le serveur local PieceMaker n'a pas répondu après \(kMaxRetries) tentatives.</p>"
                + "<p>Lancez <code>piecemaker start</code> dans le terminal, puis réessayez.</p>"
                + "</body></html>",
                baseURL: nil
            )
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + kRetryInterval) { [weak self] in
            self?.loadAdmin()
        }
    }

    func webView(
        _ webView: WKWebView,
        respondTo challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == "localhost",
              let trust = challenge.protectionSpace.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
