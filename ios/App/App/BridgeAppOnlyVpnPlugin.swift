#if BRIDGE_APP_ONLY_VPN_POC
import Capacitor
import Foundation
import TunnelKitOpenVPNCore
import TunnelKitOpenVPNProtocol
import UIKit
import UniformTypeIdentifiers

@MainActor
@objc(BridgeAppOnlyVpnPlugin)
public final class BridgeAppOnlyVpnPlugin: CAPPlugin, @preconcurrency CAPBridgedPlugin, UIDocumentPickerDelegate, @unchecked Sendable {
    public let identifier = "BridgeAppOnlyVpnPlugin"
    public let jsName = "BridgeAppOnlyVpn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickProfile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importProfile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probeHttp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openTmuxWebView", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearProfile", returnType: CAPPluginReturnPromise),
    ]

    private let store = BridgeAppOnlyVpnProfileStore.shared
    private let core = BridgeAppOnlyVpnCore.shared
    private var pendingPicker: CAPPluginCall?
    private var pendingSelections: [String: URL] = [:]

    @objc func getStatus(_ call: CAPPluginCall) {
        var result = core.status()
        result["configured"] = store.hasProfile
        result["appVersion"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        result["appBuild"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        if let summary = store.summary() {
            result["profileTitle"] = summary.title
            result["profileImportedAt"] = ISO8601DateFormatter().string(from: summary.importedAt)
            result["requiresCredentials"] = summary.requiresCredentials
            result["credentialsStored"] = summary.credentialsStored
        }
        call.resolve(result)
    }

    @objc func pickProfile(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            self?.presentPicker(call)
        }
    }

    private func presentPicker(_ call: CAPPluginCall) {
        guard pendingPicker == nil else {
            call.reject("已有一个 App-only OpenVPN 文件选择器正在打开。", "PICKER_BUSY")
            return
        }
        guard let root = bridge?.viewController else {
            call.reject("无法打开 App-only OpenVPN 文件选择器。", "PICKER_UNAVAILABLE")
            return
        }
        let presenter = Self.topViewController(from: root)
        guard presenter.viewIfLoaded?.window != nil, !presenter.isBeingDismissed else {
            call.reject("当前页面尚未准备好打开 App-only OpenVPN 文件选择器。", "PICKER_UNAVAILABLE")
            return
        }
        pendingPicker = call
        // Use the stable public data type here instead of a dynamic UTI for
        // the custom .ovpn extension. The file provider can still return the
        // selected URL; we validate the extension in the delegate below.
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        // Let the current WebView event finish before UIKit presents a second
        // controller. This also avoids presenting during a stale modal
        // transition after returning from the App-only page.
        DispatchQueue.main.async { [weak self, weak root, weak presenter] in
            guard let self else { return }
            guard let root, let presenter,
                  self.pendingPicker != nil,
                  presenter.viewIfLoaded?.window != nil,
                  !presenter.isBeingDismissed else {
                self.pendingPicker?.reject("当前页面尚未准备好打开 App-only OpenVPN 文件选择器。", "PICKER_UNAVAILABLE")
                self.pendingPicker = nil
                return
            }
            let activePresenter = Self.topViewController(from: root)
            guard activePresenter.viewIfLoaded?.window != nil,
                  !activePresenter.isBeingDismissed,
                  !(activePresenter is UIDocumentPickerViewController),
                  !(activePresenter is UIAlertController),
                  activePresenter.presentedViewController == nil else {
                self.pendingPicker?.reject("当前页面尚未准备好打开 App-only OpenVPN 文件选择器。", "PICKER_UNAVAILABLE")
                self.pendingPicker = nil
                return
            }
            activePresenter.present(picker, animated: true)
        }
    }

    @objc func importProfile(_ call: CAPPluginCall) {
        guard let selectionID = call.getString("selectionId"),
              let url = pendingSelections.removeValue(forKey: selectionID) else {
            call.reject("请先通过原生文件选择器选择 .ovpn 文件。", "INVALID_PROFILE_SELECTION")
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let parsed = try OpenVPN.ConfigurationParser.parsed(fromURL: url)
                var username = call.getString("username")
                var password = call.getString("password")
                if parsed.configuration.authUserPass == true && (username == nil || password == nil) {
                    guard let credentials = await requestCredentials() else {
                        call.reject("已取消输入 OpenVPN 凭据。", "CREDENTIALS_CANCELLED")
                        return
                    }
                    username = credentials.username
                    password = credentials.password
                }
                let suppliedTitle = call.getString("title")?.trimmingCharacters(in: .whitespacesAndNewlines)
                let title = suppliedTitle?.isEmpty == false
                    ? suppliedTitle!
                    : url.deletingPathExtension().lastPathComponent
                let summary = try store.save(
                    configuration: parsed.configuration,
                    title: title,
                    username: username,
                    password: password
                )
                call.resolve([
                    "accepted": true,
                    "title": summary.title,
                    "requiresCredentials": summary.requiresCredentials,
                    "credentialsStored": summary.credentialsStored,
                    "experimental": true,
                ])
            } catch {
                call.reject(error.localizedDescription, "APP_ONLY_PROFILE_IMPORT_FAILED")
            }
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        BridgeAppOnlyVpnDiagnostics.shared.record(stage: "plugin_connect_requested", message: "WebView 已请求连接 App-only VPN。")
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let configuration = try store.loadConfiguration()
                BridgeAppOnlyVpnDiagnostics.shared.record(stage: "configuration_loaded", message: "已从 Keychain 加载 OpenVPN 配置。")
                let credentials = try store.loadCredentials()
                BridgeAppOnlyVpnDiagnostics.shared.record(stage: "credentials_loaded", message: "已从 Keychain 加载 OpenVPN 凭据。")
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    self.core.start(configuration: configuration, credentials: credentials) { result in
                        continuation.resume(with: result)
                    }
                }
                call.resolve(core.status())
            } catch {
                BridgeAppOnlyVpnDiagnostics.shared.record(stage: "plugin_connect_failed", message: BridgeAppOnlyVpnCore.safeDiagnosticError(error), active: false)
                call.reject(error.localizedDescription, "APP_ONLY_CONNECT_FAILED")
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        core.stop()
        call.resolve(core.status())
    }

    @objc func probeHttp(_ call: CAPPluginCall) {
        guard let address = call.getString("address")?.trimmingCharacters(in: .whitespacesAndNewlines),
              Self.isIPv4Literal(address),
              let portValue = call.getInt("port"),
              (1...65535).contains(portValue),
              let path = call.getString("path"),
              path.hasPrefix("/"), path.count <= 512 else {
            call.reject("请输入 IPv4 地址、有效端口和以 / 开头的路径。", "INVALID_APP_ONLY_PROBE")
            return
        }
        core.probeHTTP(address: address, port: UInt16(portValue), path: path, timeoutMs: 8_000) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let response):
                    call.resolve([
                        "ok": true,
                        "bytes": response.count,
                        "bodyUtf8": String(data: response, encoding: .utf8) ?? "",
                    ])
                case .failure(let error):
                    call.reject(error.localizedDescription, "APP_ONLY_PROBE_FAILED")
                }
            }
        }
    }

    @objc func openTmuxWebView(_ call: CAPPluginCall) {
        guard let address = call.getString("address")?.trimmingCharacters(in: .whitespacesAndNewlines),
              Self.isIPv4Literal(address),
              let portValue = call.getInt("port"),
              (1...65535).contains(portValue),
              let path = call.getString("path")?.trimmingCharacters(in: .whitespacesAndNewlines),
              path.hasPrefix("/tmux-dashboard"), path.count <= 2_048,
              !path.contains("#"),
              let credentialServer = call.getString("credentialServer")?.trimmingCharacters(in: .whitespacesAndNewlines),
              let credentialURL = URL(string: credentialServer),
              ["http", "https"].contains(credentialURL.scheme?.lowercased() ?? ""),
              credentialURL.host == address else {
            call.reject("请输入与已配对 Bridge 同一 IPv4 主机的 tmux 页面地址。", "INVALID_APP_ONLY_WEBVIEW")
            return
        }
        do {
            guard let token = try BridgeIOSecureCredentialStore.readToken(server: credentialServer) else {
                call.reject("当前 Bridge 没有可用的 App 配对 token，请先重新配对。", "APP_ONLY_TOKEN_MISSING")
                return
            }
            core.startWebProxy(address: address, port: UInt16(portValue), token: token) { [weak self] result in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    switch result {
                    case .success(let proxy):
                        guard let root = self.bridge?.viewController as? BridgeViewController,
                              let url = URL(string: proxy + path),
                              root.presentAppOnlyWebView(url: url, target: "http://\(address):\(portValue)\(path)") else {
                            self.core.stopWebProxy(completion: {})
                            call.reject("当前页面无法打开实验 WebView。", "APP_ONLY_WEBVIEW_UNAVAILABLE")
                            return
                        }
                        call.resolve(["opened": true, "target": "http://\(address):\(portValue)\(path)"])
                    case .failure(let error):
                        call.reject(error.localizedDescription, "APP_ONLY_WEBVIEW_FAILED")
                    }
                }
            }
        } catch {
            call.reject("无法读取 App 配对 token。", "APP_ONLY_TOKEN_READ_FAILED")
        }
    }

    @objc func clearProfile(_ call: CAPPluginCall) {
        do {
            core.stop()
            try store.remove()
            call.resolve(["accepted": true])
        } catch {
            call.reject(error.localizedDescription, "APP_ONLY_PROFILE_CLEAR_FAILED")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let call = pendingPicker
        pendingPicker = nil
        finishPickerDismissal(controller) {
            call?.reject("已取消选择 App-only OpenVPN 配置。", "PICKER_CANCELLED")
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPicker, let url = urls.first else {
            documentPickerWasCancelled(controller)
            return
        }
        guard url.pathExtension.caseInsensitiveCompare("ovpn") == .orderedSame else {
            pendingPicker = nil
            finishPickerDismissal(controller) {
                call.reject("请选择 .ovpn 格式的 OpenVPN 配置文件。", "INVALID_PROFILE_FILE")
            }
            return
        }
        pendingPicker = nil
        let selectionID = UUID().uuidString
        pendingSelections[selectionID] = url
        finishPickerDismissal(controller) {
            call.resolve(["selectionId": selectionID, "fileName": url.lastPathComponent])
        }
    }

    private func requestCredentials() async -> (username: String, password: String)? {
        guard let presenter = await credentialPresenter() else { return nil }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(
                title: "App-only OpenVPN 登录",
                message: "凭据只保存到本机 Keychain，不会进入网页。",
                preferredStyle: .alert
            )
            alert.addTextField { field in
                field.placeholder = "用户名"
                field.autocorrectionType = .no
                field.autocapitalizationType = .none
            }
            alert.addTextField { field in
                field.placeholder = "密码"
                field.isSecureTextEntry = true
                field.autocorrectionType = .no
                field.autocapitalizationType = .none
            }
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in
                continuation.resume(returning: nil)
            })
            alert.addAction(UIAlertAction(title: "保存并导入", style: .default) { _ in
                let username = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let password = alert.textFields?.dropFirst().first?.text ?? ""
                guard !username.isEmpty, !password.isEmpty else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: (username, password))
            })
            presenter.present(alert, animated: true)
        }
    }

    private func credentialPresenter() async -> UIViewController? {
        // The WebView starts import immediately after pickProfile resolves. Wait
        // until UIDocumentPicker has left the hierarchy before presenting the
        // credentials alert; presenting while the picker is dismissing can take
        // down the app on iOS instead of returning a rejected plugin call.
        for _ in 0..<20 {
            if let root = bridge?.viewController {
                let presenter = Self.topViewController(from: root)
                if !(presenter is UIDocumentPickerViewController), !presenter.isBeingDismissed,
                   presenter.viewIfLoaded?.window != nil {
                    return presenter
                }
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return nil
    }

    private func finishPickerDismissal(_ controller: UIDocumentPickerViewController, completion: @escaping () -> Void) {
        if controller.presentingViewController != nil || controller.isBeingDismissed {
            controller.dismiss(animated: true, completion: completion)
        } else {
            DispatchQueue.main.async(execute: completion)
        }
    }

    private static func topViewController(from root: UIViewController) -> UIViewController {
        if let presented = root.presentedViewController, !presented.isBeingDismissed {
            return topViewController(from: presented)
        }
        if let navigation = root as? UINavigationController, let visible = navigation.visibleViewController {
            return topViewController(from: visible)
        }
        if let tab = root as? UITabBarController, let selected = tab.selectedViewController {
            return topViewController(from: selected)
        }
        return root
    }

    private static func isIPv4Literal(_ value: String) -> Bool {
        let parts = value.split(separator: ".")
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            guard let number = Int(part) else { return false }
            return (0...255).contains(number)
        }
    }
}
#endif
