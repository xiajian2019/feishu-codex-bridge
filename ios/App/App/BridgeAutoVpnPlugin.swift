import Capacitor
import Foundation
import UniformTypeIdentifiers
import UIKit

@MainActor
@objc(BridgeAutoVpnPlugin)
public final class BridgeAutoVpnPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "BridgeAutoVpnPlugin"
    public let jsName = "BridgeAutoVpn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importProfile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickProfile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkAndConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestRecovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentWifi", returnType: CAPPluginReturnPromise),
    ]

    private let coordinator: BridgeAutoVpnCoordinator
    private var pendingPicker: PendingPicker?
    private var pendingSelections: [String: PendingSelection] = [:]

    private struct PendingPicker {
        let call: CAPPluginCall
        let username: String?
        let password: String?
        let title: String?
    }

    private struct PendingSelection {
        let url: URL
        let fileName: String
        let username: String?
        let password: String?
        let title: String?
    }

    public override init() {
        self.coordinator = .shared
        super.init()
    }

    init(coordinator: BridgeAutoVpnCoordinator) {
        self.coordinator = coordinator
        super.init()
    }

    func startAutomaticCheck() {
        coordinator.startAutomaticCheck()
    }

    @objc func configure(_ call: CAPPluginCall) {
        let values = call.getArray("bypassWifiSsids", String.self) ?? []
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                var result = try await coordinator.configure(bypassWifiSsids: values)
                result["accepted"] = true
                call.resolve(result)
            } catch {
                reject(error, call: call)
            }
        }
    }

    @objc func importProfile(_ call: CAPPluginCall) {
        let selectionID = call.getString("selectionId")
        let selected = selectionID.flatMap { pendingSelections.removeValue(forKey: $0) }
        guard let selected else {
            call.reject("请先通过原生文件选择器选择 .ovpn 文件。", "INVALID_PROFILE_SELECTION")
            return
        }
        let url = selected.url
        let username = call.getString("username") ?? selected.username
        let password = call.getString("password") ?? selected.password
        let title = call.getString("title") ?? selected.title
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                var resolvedUsername = username
                var resolvedPassword = password
                if resolvedUsername == nil || resolvedPassword == nil,
                   try coordinator.profileRequiresCredentials(at: url) {
                    guard let credentials = await requestCredentials(defaultUsername: resolvedUsername) else {
                        call.reject("已取消输入 OpenVPN 凭据。", "CREDENTIALS_CANCELLED")
                        return
                    }
                    resolvedUsername = credentials.username
                    resolvedPassword = credentials.password
                }
                let result = try await coordinator.importProfile(
                    at: url,
                    username: resolvedUsername,
                    password: resolvedPassword,
                    title: title
                )
                var response = result
                response["accepted"] = true
                call.resolve(response)
            } catch {
                reject(error, call: call)
            }
        }
    }

    @objc func pickProfile(_ call: CAPPluginCall) {
        guard pendingPicker == nil else {
            call.reject("已有一个 OpenVPN 文件选择器正在打开。", "PICKER_BUSY")
            return
        }
        guard let presenter = bridge?.viewController else {
            call.reject("无法打开 OpenVPN 文件选择器。", "PICKER_UNAVAILABLE")
            return
        }

        pendingPicker = PendingPicker(
            call: call,
            username: call.getString("username"),
            password: call.getString("password"),
            title: call.getString("title")
        )
        let type = UTType(filenameExtension: "ovpn") ?? .data
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [type], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        presenter.present(picker, animated: true)
    }

    @objc func checkAndConnect(_ call: CAPPluginCall) {
        runStatusCall(call) { coordinator in
            try await coordinator.checkAndConnect(
                manualWifiSsid: Self.manualWifiSsid(from: call),
                reason: "manualCheck"
            )
        }
    }

    @objc func requestRecovery(_ call: CAPPluginCall) {
        runStatusCall(call) { coordinator in
            try await coordinator.requestRecovery(manualWifiSsid: Self.manualWifiSsid(from: call))
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                call.resolve(try await coordinator.status())
            } catch {
                reject(error, call: call)
            }
        }
    }

    @objc func getCurrentWifi(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                call.resolve(try await coordinator.currentWifi())
            } catch {
                reject(error, call: call)
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let pendingPicker else { return }
        self.pendingPicker = nil
        pendingPicker.call.reject("已取消选择 OpenVPN 配置。", "PICKER_CANCELLED")
    }

    public func documentPicker(
        _ controller: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        guard let pendingPicker, let url = urls.first else {
            documentPickerWasCancelled(controller)
            return
        }
        self.pendingPicker = nil
        // The picker uses asCopy=true, so the selected URL is a native copy;
        // no security-scoped bookmark or WebView-visible file path is kept.
        let selectionID = UUID().uuidString
        pendingSelections[selectionID] = PendingSelection(
            url: url,
            fileName: url.lastPathComponent,
            username: pendingPicker.username,
            password: pendingPicker.password,
            title: pendingPicker.title
        )
        pendingPicker.call.resolve([
            "selectionId": selectionID,
            "fileName": url.lastPathComponent,
        ])
    }

    private func runStatusCall(
        _ call: CAPPluginCall,
        operation: @escaping (BridgeAutoVpnCoordinator) async throws -> [String: Any]
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                call.resolve(compatibilityStatus(try await operation(coordinator)))
            } catch {
                reject(error, call: call)
            }
        }
    }

    private static func manualWifiSsid(from call: CAPPluginCall) -> String? {
        call.getString("wifiSsid") ?? call.getString("currentWifiSsid") ?? call.getString("ssid")
    }

    private func reject(_ error: Error, call: CAPPluginCall) {
        if let error = error as? BridgeAutoVpnError {
            call.reject(error.localizedDescription, error.code)
            return
        }
        if let error = error as? BridgeVpnProfileStoreError {
            let code: String
            switch error {
            case .appGroupUnavailable:
                code = "APP_GROUP_UNAVAILABLE"
            case .profileUnavailable:
                code = "VPN_PROFILE_NOT_CONFIGURED"
            case .invalidTitle, .credentialsMustBeProvidedTogether, .invalidCredential:
                code = "INVALID_VPN_ARGUMENTS"
            case .keychainFailure:
                code = "VPN_KEYCHAIN_FAILED"
            case .invalidStoredProfile:
                code = "INVALID_VPN_PROFILE"
            case .tunnelKitUnavailable:
                code = "TUNNELKIT_UNAVAILABLE"
            }
            call.reject(error.localizedDescription, code)
            return
        }
        call.reject("OpenVPN 操作失败，请稍后重试。", "VPN_OPERATION_FAILED")
    }

    private func requestCredentials(defaultUsername: String?) async -> (username: String, password: String)? {
        guard let presenter = bridge?.viewController else { return nil }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(
                title: "OpenVPN 登录",
                message: "此配置需要用户名和密码；凭据只保存到设备 Keychain。",
                preferredStyle: .alert
            )
            alert.addTextField { field in
                field.placeholder = "用户名"
                field.text = defaultUsername
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

    private func compatibilityStatus(_ result: [String: Any]) -> [String: Any] {
        var response = result
        let decision = result["decision"] as? String
        let accepted = decision != "notConfigured" && decision != "manualWifiConfirmationRequired"
        response["accepted"] = accepted
        switch decision {
        case "connectRequested":
            response["message"] = "VPN 连接已请求。"
        case "alreadyActive":
            response["message"] = "VPN 已连接或正在连接。"
        case "bypassed":
            response["message"] = "当前 Wi‑Fi 在免 VPN 列表中，未启动或断开现有 VPN。"
        case "manualWifiConfirmationRequired":
            response["message"] = "无法确认当前 Wi‑Fi，请手动输入 SSID 后重试。"
        case "notConfigured":
            response["message"] = "尚未导入 OpenVPN 配置。"
        default:
            response["message"] = "VPN 检查已完成。"
        }
        return response
    }
}
