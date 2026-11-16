import Capacitor
import Foundation
import UIKit

@objc(BridgeConnectBotSSHPlugin)
public final class BridgeConnectBotSSHPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeConnectBotSSHPlugin"
    public let jsName = "BridgeConnectBotSSH"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openTerminal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSessions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWorkspaceVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setUpdateBanner", returnType: CAPPluginReturnPromise),
    ]

    private weak var activeWorkspace: BridgeIOSSHWorkspaceViewController?

    @objc func listOptions(_ call: CAPPluginCall) {
        let profiles = BridgeIOSSHProfileStore.shared.list().map { profile in
            [
                "id": profile.id,
                "label": profile.label,
                "host": profile.host,
                "port": profile.port,
                "username": profile.username,
                "keyId": profile.keyId,
                "startupCommand": profile.startupCommand,
            ] as [String: Any]
        }
        let keys = (try? BridgeIOSSHKeychainStore().listMetadata())?.map { key in
            [
                "id": key.id,
                "nickname": key.label,
                "algorithm": key.algorithm.displayName,
            ] as [String: Any]
        } ?? []
        call.resolve(["profiles": profiles, "keys": keys])
    }

    @objc func listSessions(_ call: CAPPluginCall) {
        guard let bridgeOrigin = validatedBridgeOrigin(call.getString("bridgeServerOrigin"), call: call) else {
            if call.getString("bridgeServerOrigin")?.isEmpty == false { return }
            call.reject("需要提供当前 Bridge 地址。", "BRIDGE_ORIGIN_REQUIRED")
            return
        }
        guard let host = call.getString("sshHost")?.trimmingCharacters(in: .whitespacesAndNewlines),
              validHost(host), host.count <= 253 else {
            call.reject("Invalid SSH host.", "INVALID_ARGUMENTS")
            return
        }
        let port = call.getInt("sshPort") ?? 22
        guard (1...65_535).contains(port) else {
            call.reject("Invalid SSH port.", "INVALID_ARGUMENTS")
            return
        }
        let username = call.getString("sshUsername")?.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { @MainActor [weak self] in
            do {
                let sessions = try await BridgeIOSSHSessionAPI.listSessions(
                    bridgeOrigin: bridgeOrigin,
                    sshHost: host,
                    sshPort: port,
                    sshUsername: username?.isEmpty == true ? nil : username
                )
                call.resolve([
                    "bridgeOrigin": bridgeOrigin,
                    "sshHost": host.lowercased(),
                    "sshPort": port,
                    "sessions": sessions.map(Self.sessionDictionary),
                ])
            } catch {
                self?.rejectSessionAPI(error, call: call)
            }
        }
    }

    @objc func openWorkspace(_ call: CAPPluginCall) {
        let host = call.getString("defaultHost")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard host.isEmpty || validHost(host) else {
            call.reject("Invalid default SSH host.", "INVALID_ARGUMENTS")
            return
        }
        guard let bridgeOrigin = validatedBridgeOrigin(call.getString("bridgeServerOrigin"), call: call) else {
            if call.getString("bridgeServerOrigin")?.isEmpty == false { return }
            return presentWorkspace(
                launch: .manager(defaultHost: host, bridgeServerOrigin: nil,
                                 presentation: call.getString("presentation") == "sheet" ? .sheet : .full,
                                 mode: call.getString("mode") == "manage",
                                 sessionSelection: nil),
                call: call
            )
        }
        let selection: BridgeIOSSHSessionSelection?
        do {
            selection = try parseSessionSelection(call.getObject("sessionSelection"), expectedOrigin: bridgeOrigin)
        } catch {
            call.reject(error.localizedDescription, "BRIDGE_SSH_CONTEXT_MISMATCH")
            return
        }
        presentWorkspace(
            launch: .manager(defaultHost: host, bridgeServerOrigin: bridgeOrigin,
                             presentation: call.getString("presentation") == "sheet" ? .sheet : .full,
                             mode: call.getString("mode") == "manage",
                             sessionSelection: selection),
            call: call
        )
    }

    @objc func openTerminal(_ call: CAPPluginCall) {
        guard let host = call.getString("host")?.trimmingCharacters(in: .whitespacesAndNewlines), validHost(host), host.count <= 253 else {
            call.reject("Invalid SSH host.", "INVALID_ARGUMENTS")
            return
        }
        guard let username = call.getString("username")?.trimmingCharacters(in: .whitespacesAndNewlines), validUsername(username) else {
            call.reject("Invalid SSH username.", "INVALID_ARGUMENTS")
            return
        }
        let port = call.getInt("port") ?? 22
        guard (1...65_535).contains(port) else {
            call.reject("Invalid SSH port.", "INVALID_ARGUMENTS")
            return
        }
        let keyId = call.getString("keyId")?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let keyId, !keyId.isEmpty,
           keyId.count > 128 || keyId.unicodeScalars.contains(where: { !CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.")).contains($0) }) {
            call.reject("Invalid SSH key.", "INVALID_ARGUMENTS")
            return
        }
        let password = call.getString("password") ?? ""
        guard password.count <= 16_384, !password.unicodeScalars.contains(where: { $0.value == 0 }) else {
            call.reject("Invalid SSH password.", "INVALID_ARGUMENTS")
            return
        }
        let startupCommand = call.getString("startupCommand") ?? ""
        guard startupCommand.count <= 32_768, !startupCommand.unicodeScalars.contains(where: { $0.value == 0 }) else {
            call.reject("Invalid SSH startup command.", "INVALID_ARGUMENTS")
            return
        }
        let bridgeOrigin = validatedBridgeOrigin(call.getString("bridgeServerOrigin"), call: call)
        if call.getString("bridgeServerOrigin")?.isEmpty == false && bridgeOrigin == nil { return }
        presentWorkspace(
            launch: .terminal(host: host, port: port, username: username, password: password,
                              startupCommand: startupCommand, bridgeServerOrigin: bridgeOrigin, keyId: keyId?.isEmpty == true ? nil : keyId),
            call: call
        )
    }

    @objc func setWorkspaceVisible(_ call: CAPPluginCall) {
        let visible = call.getBool("visible") ?? true
        DispatchQueue.main.async { [weak self] in
            let open = self?.activeWorkspace?.setWorkspaceVisible(visible) ?? false
            call.resolve(["workspaceOpen": open])
        }
    }

    @objc func closeWorkspace(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.activeWorkspace?.requestClose(returnToWorkbench: false)
            call.resolve()
        }
    }

    @objc func setUpdateBanner(_ call: CAPPluginCall) {
        // APK update banners are intentionally Android-only. The iOS update path
        // is controlled by App Store/TestFlight and must not present an APK UI.
        call.resolve()
    }

    private func presentWorkspace(launch: BridgeIOSSHWorkspaceLaunch, call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else {
                call.reject("无法打开 iOS SSH 工作区。", "NATIVE_TERMINAL_UNAVAILABLE")
                return
            }
            if let active = self.activeWorkspace {
                guard active.canReuse(for: launch) else {
                    call.reject("当前 SSH 工作区绑定了其他 Bridge/Session 上下文，请先关闭后再切换。", "BRIDGE_SSH_CONTEXT_MISMATCH")
                    return
                }
                _ = active.setWorkspaceVisible(true)
                call.resolve()
                return
            }
            let workspace = BridgeIOSSHWorkspaceViewController(launch: launch) { [weak self] returnToWorkbench in
                self?.workspaceClosed(returnToWorkbench: returnToWorkbench)
            }
            self.activeWorkspace = workspace
            workspace.modalPresentationStyle = launch.presentation == .sheet ? .pageSheet : .fullScreen
            if let sheet = workspace.sheetPresentationController {
                sheet.detents = [.medium(), .large()]
                sheet.prefersGrabberVisible = true
                sheet.preferredCornerRadius = 18
            }
            presenter.present(workspace, animated: true) {
                workspace.presentationController?.delegate = workspace
                call.resolve()
            }
        }
    }

    private func workspaceClosed(returnToWorkbench: Bool) {
        activeWorkspace = nil
        notifyListeners("workspaceClosed", data: ["returnToWorkbench": returnToWorkbench])
        if returnToWorkbench {
            notifyListeners("returnToWorkbench", data: [:], retainUntilConsumed: true)
        }
    }

    private func validatedBridgeOrigin(_ value: String?, call: CAPPluginCall) -> String? {
        guard let value, !value.isEmpty else { return nil }
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              value.count <= 2_048 else {
            call.reject("当前 Bridge 地址无效，请重新连接后再打开 SSH。", "BRIDGE_ORIGIN_REQUIRED")
            return nil
        }
        return url.originString
    }

    private func parseSessionSelection(_ object: JSObject?, expectedOrigin: String) throws -> BridgeIOSSHSessionSelection? {
        guard let object else { return nil }
        guard let bridgeOrigin = object["bridgeOrigin"] as? String, bridgeOrigin == expectedOrigin,
              let sessionId = object["sessionId"] as? String, sessionId.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
              let createdAt = object["createdAt"] as? Int, createdAt >= 0 else {
            throw NSError(domain: "BridgeConnectBotSSH", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bridge、Session ID 或 createdAt 不一致，请刷新后重试。"])
        }
        let expectedHost = (object["expectedSshHost"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let expectedPort = object["expectedSshPort"] as? Int
        if let expectedHost, !validHost(expectedHost) { throw NSError(domain: "BridgeConnectBotSSH", code: 2, userInfo: [NSLocalizedDescriptionKey: "SSH 主机上下文无效。"]) }
        if let expectedPort, !(1...65_535).contains(expectedPort) { throw NSError(domain: "BridgeConnectBotSSH", code: 3, userInfo: [NSLocalizedDescriptionKey: "SSH 端口上下文无效。"]) }
        return BridgeIOSSHSessionSelection(bridgeOrigin: bridgeOrigin, sessionId: sessionId, createdAt: createdAt,
                                           expectedSshHost: expectedHost, expectedSshPort: expectedPort)
    }

    private func validHost(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 253 && !value.unicodeScalars.contains(where: {
            $0.value < 0x20 || $0.value == 0x7f || $0.value == 0x2f || $0.value == 0x3f
                || $0.value == 0x23 || $0.value == 0x40
        })
    }

    private func validUsername(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 255 && !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f || CharacterSet.whitespacesAndNewlines.contains($0) })
    }

    private func rejectSessionAPI(_ error: Error, call: CAPPluginCall) {
        let apiError = error as? BridgeIOSSHSessionAPIError
        let message = apiError?.localizedDescription ?? "Bridge Session API 暂时不可用。"
        let code: String
        switch apiError {
        case .some(.unauthorized): code = "BRIDGE_AUTH_REQUIRED"
        case .some(.invalidContext), .some(.invalidSelection(_)), .some(.identityMismatch): code = "BRIDGE_SSH_CONTEXT_MISMATCH"
        case .some(.invalidResponse): code = "BRIDGE_SESSION_API_INVALID_RESPONSE"
        case .some(.resultUnknown(_)): code = "BRIDGE_SESSION_API_RESULT_UNKNOWN"
        case .some(.unavailable(_)): code = "BRIDGE_SESSION_API_UNAVAILABLE"
        case .none: code = "BRIDGE_SESSION_API_UNAVAILABLE"
        }
        call.reject(message, code)
    }

    private static func sessionDictionary(_ session: BridgeIOSSHRemoteSession) -> [String: Any] {
        var value: [String: Any] = [
            "id": session.id,
            "name": session.name,
            "windows": session.windows,
            "attachedClients": session.attachedClients,
            "cwd": session.cwd,
            "createdAt": session.createdAt,
            "endedAt": session.endedAt as Any,
            "suspendedAt": session.suspendedAt as Any,
            "source": session.source as Any,
            "uncertain": session.uncertain as Any,
        ]
        if session.endedAt == nil { value["endedAt"] = NSNull() }
        if session.suspendedAt == nil { value["suspendedAt"] = NSNull() }
        if session.source == nil { value["source"] = NSNull() }
        if session.uncertain == nil { value["uncertain"] = NSNull() }
        return value
    }
}

private extension URL {
    var originString: String {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        return components.string ?? absoluteString
    }
}
