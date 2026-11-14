import Capacitor
import Foundation
import Network
@preconcurrency import NetworkExtension
import UIKit
import WebKit

class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BridgeCrashDiagnosticsPlugin())
        bridge?.registerPluginInstance(BridgeCredentialsPlugin())
        bridge?.registerPluginInstance(BridgeIOSOtaPlugin())
        bridge?.registerPluginInstance(BridgeShareInboxPlugin())
        bridge?.registerPluginInstance(BridgeNativeThemePlugin())
        bridge?.registerPluginInstance(BridgeConnectBotSSHPlugin())
        bridge?.registerPluginInstance(BridgeOpenVPNConnectPlugin())

#if BRIDGE_APP_ONLY_VPN_POC
        // Experimental App-only VPN POC. It never creates a Network Extension
        // profile and is intentionally manual-start only.
        BridgeAppOnlyVpnDiagnostics.installExceptionHandler()
        bridge?.registerPluginInstance(BridgeAppOnlyVpnPlugin())
#endif

#if BRIDGE_TUNNELKIT
        let autoVpnPlugin = BridgeAutoVpnPlugin()
        bridge?.registerPluginInstance(autoVpnPlugin)
        // Startup checks are deliberately conservative: if iOS cannot provide
        // a current SSID, the coordinator returns a manual-confirmation state
        // and does not start or stop any VPN.
        autoVpnPlugin.startAutomaticCheck()
#endif
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardFrameChanged(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func keyboardFrameChanged(_ notification: Notification) {
        guard let window = view.window,
              let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let keyboard = window.convert(frame, from: nil)
        let overlap = window.bounds.intersection(keyboard)
        let docked = !overlap.isNull && overlap.height > 1
            && overlap.width >= window.bounds.width * 0.5
            && overlap.maxY >= window.bounds.maxY - 1
        setWebKeyboardDocked(docked)
    }

    @objc private func keyboardWillHide() {
        setWebKeyboardDocked(false)
    }

    private func setWebKeyboardDocked(_ docked: Bool) {
        webView?.evaluateJavaScript("document.documentElement.classList.toggle('bridge-ios-keyboard-visible', \(docked ? "true" : "false"));", completionHandler: nil)
    }

#if BRIDGE_APP_ONLY_VPN_POC
    private weak var appOnlyWebViewController: BridgeAppOnlyWebViewController?

    @discardableResult
    func presentAppOnlyWebView(url: URL, target: String) -> Bool {
        guard presentedViewController == nil,
              viewIfLoaded?.window != nil,
              appOnlyWebViewController == nil else { return false }
        let controller = BridgeAppOnlyWebViewController(url: url, target: target)
        controller.onClose = { [weak self, weak controller] in
            guard let self, self.appOnlyWebViewController === controller else { return }
            self.appOnlyWebViewController = nil
            BridgeAppOnlyVpnCore.shared.stopWebProxy(completion: {})
        }
        appOnlyWebViewController = controller
        controller.modalPresentationStyle = .fullScreen
        present(controller, animated: true)
        return true
    }
#endif
}

#if BRIDGE_APP_ONLY_VPN_POC
private final class BridgeAppOnlyWebViewController: UIViewController, WKNavigationDelegate {
    private let targetURL: URL
    private let target: String
    private let webView: WKWebView
    private var didClose = false
    var onClose: (() -> Void)?

    init(url: URL, target: String) {
        targetURL = url
        self.target = target
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false

        let toolbar = UIView()
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        toolbar.backgroundColor = .secondarySystemBackground

        let close = UIButton(type: .system)
        close.translatesAutoresizingMaskIntoConstraints = false
        close.setTitle("关闭实验页面", for: .normal)
        close.addTarget(self, action: #selector(closePage), for: .touchUpInside)

        let reload = UIButton(type: .system)
        reload.translatesAutoresizingMaskIntoConstraints = false
        reload.setTitle("重新加载", for: .normal)
        reload.addTarget(self, action: #selector(reloadPage), for: .touchUpInside)

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = target
        label.font = .preferredFont(forTextStyle: .caption1)
        label.textColor = .secondaryLabel
        label.numberOfLines = 1
        label.lineBreakMode = .byTruncatingMiddle

        toolbar.addSubview(close)
        toolbar.addSubview(reload)
        toolbar.addSubview(label)
        view.addSubview(toolbar)
        view.addSubview(webView)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: guide.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 48),
            close.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 12),
            close.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            reload.leadingAnchor.constraint(equalTo: close.trailingAnchor, constant: 12),
            reload.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: reload.trailingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -12),
            label.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            webView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        webView.load(URLRequest(url: targetURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc private func closePage() {
        guard !didClose else { return }
        didClose = true
        webView.stopLoading()
        dismiss(animated: true) { [weak self] in self?.onClose?() }
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard presentingViewController == nil, !didClose else { return }
        didClose = true
        onClose?()
    }
}
#endif

@objc(BridgeIOSOtaPlugin)
public class BridgeIOSOtaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeIOSOtaPlugin"
    public let jsName = "BridgeIOSOta"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]

    @objc func open(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https", components.host != nil,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.path.range(of: "/[A-Za-z0-9_-]{43}/$", options: .regularExpression) != nil,
              let url = components.url else {
            call.reject("Invalid iOS OTA URL.", "INVALID_URL")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("无法打开 Safari 安装页。", "OPEN_FAILED") }
            }
        }
    }
}

@MainActor
@objc(BridgeOpenVPNConnectPlugin)
public final class BridgeOpenVPNConnectPlugin: CAPPlugin, @preconcurrency CAPBridgedPlugin, @unchecked Sendable {
    public let identifier = "BridgeOpenVPNConnectPlugin"
    public let jsName = "BridgeOpenVPNConnect"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecoveryMonitor", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecoveryMonitor", returnType: CAPPluginReturnPromise),
    ]

    private static let candidateURLs = [
        URL(string: "openvpn://")!,
        URL(string: "openvpn-connect://")!,
    ]
    private static let recoveryInterval: TimeInterval = 1
    private static let recoveryProbeTimeout: UInt64 = 800_000_000
    private let recoveryQueue = DispatchQueue(label: "dev.feishu.codex.bridge.openvpn-recovery", qos: .utility)
    private var recoveryTarget: URL?
    private var recoveryPageOpen = false
    private var recoveryTimer: Timer?
    private var recoveryConnection: NWConnection?
    private var recoveryProbeTimeoutTask: Task<Void, Never>?
    private var recoveryOpenedForOutage = false
    private var recoveryBypassWifiSsids = Set<String>()
    private var recoveryWifiBypassed = false
    private var recoveryWifiCheckInFlight = false
    private var recoveryPathMonitor: NWPathMonitor?

    public override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(recoveryDidBecomeActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(recoveryWillResignActive),
                                               name: UIApplication.willResignActiveNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        recoveryTimer?.invalidate()
        recoveryConnection?.cancel()
        recoveryProbeTimeoutTask?.cancel()
        recoveryPathMonitor?.cancel()
    }

    @objc func status(_ call: CAPPluginCall) {
        let url = Self.candidateURLs.first(where: UIApplication.shared.canOpenURL)
        call.resolve([
            "installed": url != nil,
            "scheme": url?.scheme ?? NSNull(),
        ])
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let url = Self.candidateURLs.first(where: UIApplication.shared.canOpenURL) else {
            call.reject("未安装 OpenVPN Connect，请先从 App Store 安装。", "OPENVPN_CONNECT_NOT_INSTALLED")
            return
        }
        UIApplication.shared.open(url, options: [:]) { opened in
            if opened {
                call.resolve(["installed": true, "launched": true, "scheme": url.scheme ?? "openvpn"])
            } else {
                call.reject("无法打开 OpenVPN Connect。", "OPENVPN_CONNECT_OPEN_FAILED")
            }
        }
    }

    @objc func startRecoveryMonitor(_ call: CAPPluginCall) {
        guard let value = call.getString("server"), let server = Self.recoveryServerURL(value) else {
            call.reject("Bridge 地址无效，无法启动原生网络检查。", "INVALID_RECOVERY_TARGET")
            return
        }
        recoveryBypassWifiSsids = Set(Self.normalizedWifiSsids(call.getArray("bypassWifiSsids", String.self) ?? []))
        recoveryWifiBypassed = false
        if recoveryTarget != server {
            recoveryOpenedForOutage = false
        }
        recoveryTarget = server
        recoveryPageOpen = true
        ensureRecoveryPathMonitor()
        updateRecoveryTimer()
        checkRecoveryWifi()
        call.resolve(["accepted": true, "running": recoveryTimer != nil])
    }

    @objc func stopRecoveryMonitor(_ call: CAPPluginCall) {
        recoveryPageOpen = false
        recoveryTarget = nil
        recoveryOpenedForOutage = false
        recoveryBypassWifiSsids = []
        recoveryWifiBypassed = false
        recoveryWifiCheckInFlight = false
        stopRecoveryTimer()
        recoveryPathMonitor?.cancel()
        recoveryPathMonitor = nil
        call.resolve(["accepted": true])
    }

    @objc private func recoveryDidBecomeActive() {
        ensureRecoveryPathMonitor()
        updateRecoveryTimer()
        checkRecoveryWifi()
    }

    @objc private func recoveryWillResignActive() {
        // The Bridge page is no longer visible. Cancel both the timer and an
        // in-flight probe; do not run recovery work in the background.
        stopRecoveryTimer()
        recoveryPathMonitor?.cancel()
        recoveryPathMonitor = nil
    }

    private func updateRecoveryTimer() {
        guard recoveryPageOpen, !recoveryWifiBypassed, recoveryTarget != nil,
              UIApplication.shared.applicationState == .active else {
            stopRecoveryTimer()
            return
        }
        guard recoveryTimer == nil else { return }
        let timer = Timer(timeInterval: Self.recoveryInterval, target: self,
                          selector: #selector(runRecoveryProbe), userInfo: nil, repeats: true)
        recoveryTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopRecoveryTimer() {
        recoveryTimer?.invalidate()
        recoveryTimer = nil
        recoveryConnection?.cancel()
        recoveryConnection = nil
        recoveryProbeTimeoutTask?.cancel()
        recoveryProbeTimeoutTask = nil
    }

    @objc private func runRecoveryProbe() {
        guard recoveryPageOpen, !recoveryWifiBypassed, UIApplication.shared.applicationState == .active,
              recoveryConnection == nil, let target = recoveryTarget,
              let host = target.host else { return }
        let port = target.port ?? (target.scheme?.lowercased() == "https" ? 443 : 80)
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        recoveryConnection = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let connection else { return }
            switch state {
            case .ready:
                Task { @MainActor [weak self, weak connection] in
                    guard let self, let connection else { return }
                    self.finishRecoveryProbe(connection, reachable: true)
                }
            case .failed, .cancelled:
                Task { @MainActor [weak self, weak connection] in
                    guard let self, let connection else { return }
                    self.finishRecoveryProbe(connection, reachable: false)
                }
            default:
                break
            }
        }
        connection.start(queue: recoveryQueue)
        recoveryProbeTimeoutTask = Task { @MainActor [weak self, weak connection] in
            try? await Task.sleep(nanoseconds: Self.recoveryProbeTimeout)
            guard !Task.isCancelled, let self, let connection else { return }
            self.finishRecoveryProbe(connection, reachable: false)
        }
    }

    private func finishRecoveryProbe(_ connection: NWConnection, reachable: Bool) {
        guard recoveryConnection === connection else { return }
        recoveryConnection = nil
        recoveryProbeTimeoutTask?.cancel()
        recoveryProbeTimeoutTask = nil
        connection.cancel()
        guard recoveryPageOpen, UIApplication.shared.applicationState == .active else { return }
        if reachable {
            recoveryOpenedForOutage = false
            return
        }
        guard !recoveryOpenedForOutage else { return }
        recoveryOpenedForOutage = true
        guard let url = Self.candidateURLs.first(where: UIApplication.shared.canOpenURL) else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    private func ensureRecoveryPathMonitor() {
        guard recoveryPathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.checkRecoveryWifi()
            }
        }
        monitor.start(queue: recoveryQueue)
        recoveryPathMonitor = monitor
    }

    private func checkRecoveryWifi() {
        guard recoveryPageOpen, UIApplication.shared.applicationState == .active else { return }
        guard !recoveryBypassWifiSsids.isEmpty else {
            recoveryWifiBypassed = false
            updateRecoveryTimer()
            runRecoveryProbe()
            return
        }
        guard !recoveryWifiCheckInFlight else { return }
        recoveryWifiCheckInFlight = true
        NEHotspotNetwork.fetchCurrent { [weak self] network in
            let ssid = network?.ssid
            Task { @MainActor [weak self] in
                self?.finishRecoveryWifiCheck(ssid)
            }
        }
    }

    private func finishRecoveryWifiCheck(_ ssid: String?) {
        recoveryWifiCheckInFlight = false
        let normalized = Self.normalizedWifiSSID(ssid)
        let bypassed = normalized.map { recoveryBypassWifiSsids.contains($0) } ?? false
        recoveryWifiBypassed = bypassed
        updateRecoveryTimer()
        if !bypassed { runRecoveryProbe() }
    }

    private static func recoveryServerURL(_ value: String) -> URL? {
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let url = components.url else { return nil }
        let port = components.port ?? (scheme == "https" ? 443 : 80)
        guard (1...65535).contains(port) else { return nil }
        return url
    }

    private static func normalizedWifiSsids(_ values: [String]) -> [String] {
        var result: [String] = []
        for value in values {
            guard let normalized = normalizedWifiSSID(value), !result.contains(normalized) else { continue }
            result.append(normalized)
            if result.count == 64 { break }
        }
        return result
    }

    private static func normalizedWifiSSID(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty, normalized.count <= 255 else { return nil }
        return normalized
    }
}
