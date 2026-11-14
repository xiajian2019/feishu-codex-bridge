import Foundation
import NetworkExtension

#if canImport(TunnelKitOpenVPN)
import TunnelKitOpenVPN
import TunnelKit
#endif

enum BridgeAutoVpnError: LocalizedError {
    case currentWifiUnavailable
    case invalidManualWifi
    case invalidProfile
    case credentialsRequired
    case tunnelKitUnavailable
    case managerSaveFailed

    var code: String {
        switch self {
        case .currentWifiUnavailable:
            return "WIFI_SSID_UNAVAILABLE"
        case .invalidManualWifi:
            return "INVALID_WIFI_SSID"
        case .invalidProfile:
            return "INVALID_VPN_PROFILE"
        case .credentialsRequired:
            return "VPN_CREDENTIALS_REQUIRED"
        case .tunnelKitUnavailable:
            return "TUNNELKIT_UNAVAILABLE"
        case .managerSaveFailed:
            return "VPN_MANAGER_SAVE_FAILED"
        }
    }

    var errorDescription: String? {
        switch self {
        case .currentWifiUnavailable:
            return "iOS 当前无法可靠读取 Wi-Fi SSID。请在 checkAndConnect 或 requestRecovery 中传入已确认的 wifiSsid。"
        case .invalidManualWifi:
            return "手动提供的 Wi-Fi SSID 为空或无效。"
        case .invalidProfile:
            return "无法解析 OpenVPN 配置，请确认导入的是受支持的 .ovpn 文件。"
        case .credentialsRequired:
            return "此 OpenVPN 配置需要用户名和密码，请重新导入配置并同时提供凭据。"
        case .tunnelKitUnavailable:
            return "当前 iOS 构建未包含 TunnelKit OpenVPN 模块或 Packet Tunnel 目标。"
        case .managerSaveFailed:
            return "无法保存 Bridge 自己的 VPN 配置，请检查 Network Extension entitlement 和签名。"
        }
    }
}

protocol BridgeCurrentWifiProviding {
    func fetchSSID(completion: @escaping (Result<String, Error>) -> Void)
}

@available(iOS 14.0, *)
final class BridgeCurrentWifiProvider: BridgeCurrentWifiProviding {
    func fetchSSID(completion: @escaping (Result<String, Error>) -> Void) {
        NEHotspotNetwork.fetchCurrent { network in
            guard let ssid = network?.ssid.trimmingCharacters(in: .whitespacesAndNewlines),
                  !ssid.isEmpty else {
                completion(.failure(BridgeAutoVpnError.currentWifiUnavailable))
                return
            }
            completion(.success(ssid))
        }
    }
}

@MainActor
final class BridgeAutoVpnCoordinator {
    static let shared = BridgeAutoVpnCoordinator()

    static let defaultPacketTunnelBundleIdentifier = "dev.feishu.codex.bridge.packet-tunnel"
    static let packetTunnelBundleIdentifierInfoKey = "BridgePacketTunnelBundleIdentifier"

    private let profileStore: BridgeVpnProfileStore
    private let wifiProvider: BridgeCurrentWifiProviding

    init(
        profileStore: BridgeVpnProfileStore = BridgeVpnProfileStore(),
        wifiProvider: BridgeCurrentWifiProviding = BridgeCurrentWifiProvider()
    ) {
        self.profileStore = profileStore
        self.wifiProvider = wifiProvider
    }

    var packetTunnelBundleIdentifier: String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: Self.packetTunnelBundleIdentifierInfoKey) as? String,
              Self.isValidBundleIdentifier(value) else {
            return Self.defaultPacketTunnelBundleIdentifier
        }
        return value
    }

    func startAutomaticCheck() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard self.profileStore.hasProfile else { return }
#if canImport(TunnelKitOpenVPN)
            // Arm only Bridge's own On Demand configuration first. If iOS does
            // not disclose the current SSID, the system still applies the
            // ssidMatch Ignore rule without the host app reading Wi-Fi data.
            _ = try? await self.update(manager: try await self.matchingManager() ?? NETunnelProviderManager())
#endif
            _ = try? await self.checkAndConnect(manualWifiSsid: nil, reason: "startup")
        }
    }

    func configure(bypassWifiSsids: [String]) async throws -> [String: Any] {
        let normalized = try profileStore.saveBypassWifiSsids(bypassWifiSsids)

        // If a Bridge profile already exists, apply only the matching manager's
        // new rules. No unrelated VPN configuration is inspected for deletion.
#if canImport(TunnelKitOpenVPN)
        if profileStore.hasProfile {
            _ = try await update(manager: try await matchingManager() ?? NETunnelProviderManager())
        }
#endif
        return [
            "accepted": true,
            "configured": profileStore.hasProfile,
            "bypassWifiSsids": normalized,
            "packetTunnelBundleIdentifier": packetTunnelBundleIdentifier,
        ]
    }

#if canImport(TunnelKitOpenVPN)
    func profileRequiresCredentials(at url: URL) throws -> Bool {
        do {
            let parsed = try OpenVPN.ConfigurationParser.parsed(fromURL: url)
            return parsed.configuration.authUserPass == true
        } catch {
            throw BridgeAutoVpnError.invalidProfile
        }
    }

    func importProfile(
        at url: URL,
        username: String?,
        password: String?,
        title: String?
    ) async throws -> [String: Any] {
        guard url.isFileURL else {
            throw BridgeVpnProfileStoreError.invalidStoredProfile
        }

        let parsed: OpenVPN.ConfigurationParser.Result
        do {
            parsed = try OpenVPN.ConfigurationParser.parsed(fromURL: url)
        } catch {
            // Do not forward parser descriptions: they can contain profile
            // lines or endpoint details supplied by the user.
            throw BridgeAutoVpnError.invalidProfile
        }
        if parsed.configuration.authUserPass == true && (username == nil || password == nil) {
            throw BridgeAutoVpnError.credentialsRequired
        }
        let fallbackTitle = url.deletingPathExtension().lastPathComponent
        let profileTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? title!
            : fallbackTitle
        let metadata = try profileStore.save(
            configuration: parsed.configuration,
            title: profileTitle,
            username: username,
            password: password
        )

        // Updating an existing Bridge manager is safe. It changes only the
        // manager whose providerBundleIdentifier is ours and never stops a
        // currently connected tunnel explicitly.
        _ = try await update(manager: try await matchingManager() ?? NETunnelProviderManager())

        return [
            "accepted": true,
            "configured": true,
            "title": metadata.title,
            "importedAt": ISO8601DateFormatter().string(from: metadata.importedAt),
            "requiresUsernamePassword": metadata.requiresUsernamePassword,
            "credentialsStored": metadata.credentialsStored,
        ]
    }
#else
    func importProfile(
        at _: URL,
        username _: String?,
        password _: String?,
        title _: String?
    ) async throws -> [String: Any] {
        throw BridgeAutoVpnError.tunnelKitUnavailable
    }
#endif

    func checkAndConnect(manualWifiSsid: String?, reason: String) async throws -> [String: Any] {
        guard profileStore.hasProfile else {
            var result = try await status()
            result["accepted"] = false
            result["message"] = "尚未导入 OpenVPN 配置。"
            result["decision"] = "notConfigured"
            result["reason"] = reason
            return result
        }

        let ssid = try await resolvedSSID(manualWifiSsid)
        guard let ssid else {
            var result = try await status()
            result["accepted"] = true
            result["message"] = "已启用系统自动 VPN；当前 Wi‑Fi 无法读取，请手动确认 SSID 后再执行检查。"
            result["decision"] = "manualWifiConfirmationRequired"
            result["requiresManualWifiConfirmation"] = true
            result["reason"] = reason
            return result
        }

        let bypass = profileStore.bypassWifiSsids()
        if bypass.contains(ssid) {
            // NEOnDemandRuleIgnore prevents an automatic start. Deliberately do
            // not stop an already connected VPN here.
            var result = try await status()
            result["accepted"] = true
            result["message"] = "当前 Wi‑Fi 在免 VPN 列表中，已跳过自动连接。"
            result["decision"] = "bypassed"
            result["wifiSsidKnown"] = true
            result["wifiSsidIsBypassed"] = true
            result["reason"] = reason
            return result
        }

#if canImport(TunnelKitOpenVPN)
        guard let appGroup = profileStore.groupIdentifier, !appGroup.isEmpty else {
            throw BridgeVpnProfileStoreError.appGroupUnavailable
        }
        let manager = try await update(manager: try await matchingManager() ?? NETunnelProviderManager())
        let existingStatus = manager.connection.status
        var startRequested = false
        switch existingStatus {
        case .disconnected, .invalid:
            do {
                try manager.connection.startVPNTunnel()
                startRequested = true
            } catch {
                throw BridgeAutoVpnError.managerSaveFailed
            }
        case .connected, .connecting, .reasserting, .disconnecting:
            break
        @unknown default:
            break
        }

        var result = try await status()
        result["accepted"] = true
        result["message"] = startRequested ? "已发起 VPN 连接。" : "VPN 已连接或正在连接。"
        result["decision"] = startRequested ? "connectRequested" : "alreadyActive"
        result["wifiSsidKnown"] = true
        result["wifiSsidIsBypassed"] = false
        result["reason"] = reason
        return result
#else
        throw BridgeAutoVpnError.tunnelKitUnavailable
#endif
    }

    func requestRecovery(manualWifiSsid: String?) async throws -> [String: Any] {
        try await checkAndConnect(manualWifiSsid: manualWifiSsid, reason: "recovery")
    }

    func currentWifi() async throws -> [String: Any] {
        let ssid = try await fetchSSID()
        return ["ssid": ssid]
    }

    func status() async throws -> [String: Any] {
        var result: [String: Any] = [
            "configured": profileStore.hasProfile,
            "packetTunnelBundleIdentifier": packetTunnelBundleIdentifier,
            "onDemandBypassWifiSsids": profileStore.bypassWifiSsids(),
        ]

        guard let manager = try await matchingManager() else {
            result["status"] = profileStore.hasProfile ? "disconnected" : "notConfigured"
            result["managerFound"] = false
            result["enabled"] = false
            result["onDemandEnabled"] = false
            return result
        }

        result["status"] = Self.statusString(manager.connection.status)
        result["managerFound"] = true
        result["enabled"] = manager.isEnabled
        result["onDemandEnabled"] = manager.isOnDemandEnabled
        return result
    }

    private func resolvedSSID(_ manualWifiSsid: String?) async throws -> String? {
        if let manualWifiSsid {
            let value = manualWifiSsid.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value.count <= 255 else {
                throw BridgeAutoVpnError.invalidManualWifi
            }
            return value
        }

        do {
            return try await fetchSSID()
        } catch is BridgeAutoVpnError {
            return nil
        } catch {
            return nil
        }
    }

    private func fetchSSID() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            wifiProvider.fetchSSID { result in
                continuation.resume(with: result)
            }
        }
    }

#if canImport(TunnelKitOpenVPN)
    private func matchingManager() async throws -> NETunnelProviderManager? {
        let managers = try await NETunnelProviderManager.loadAllFromPreferences()
        return managers.first { manager in
            guard let configuration = manager.protocolConfiguration as? NETunnelProviderProtocol else {
                return false
            }
            return configuration.providerBundleIdentifier == packetTunnelBundleIdentifier
        }
    }

    private func update(manager: NETunnelProviderManager) async throws -> NETunnelProviderManager {
        let metadata = try profileStore.metadata()
        let configuration = try profileStore.loadConfiguration()
        let credentials = try profileStore.credentials()
        if metadata.requiresUsernamePassword && credentials == nil {
            throw BridgeAutoVpnError.credentialsRequired
        }

        var provider = OpenVPN.ProviderConfiguration(
            metadata.title,
            appGroup: profileStore.groupIdentifier ?? "",
            configuration: configuration
        )
        provider.username = credentials?.username

        var extra = NetworkExtensionExtra()
        extra.passwordReference = credentials?.passwordReference
        extra.onDemandRules = onDemandRules()
        extra.disconnectsOnSleep = false

        let protocolConfiguration = try provider.asTunnelProtocol(
            withBundleIdentifier: packetTunnelBundleIdentifier,
            extra: extra
        )
        manager.localizedDescription = metadata.title
        manager.protocolConfiguration = protocolConfiguration
        manager.onDemandRules = extra.onDemandRules
        manager.isOnDemandEnabled = true
        manager.isEnabled = true

        do {
            try await manager.saveToPreferences()
            try await manager.loadFromPreferences()
            return manager
        } catch {
            throw BridgeAutoVpnError.managerSaveFailed
        }
    }

    private func onDemandRules() -> [NEOnDemandRule] {
        var rules: [NEOnDemandRule] = []
        let bypass = profileStore.bypassWifiSsids()
        if !bypass.isEmpty {
            let ignore = NEOnDemandRuleIgnore()
            ignore.ssidMatch = bypass
            rules.append(ignore)
        }
        rules.append(NEOnDemandRuleConnect())
        return rules
    }
#else
    private func matchingManager() async throws -> NETunnelProviderManager? {
        nil
    }
#endif

    private static func statusString(_ status: NEVPNStatus) -> String {
        switch status {
        case .connected:
            return "connected"
        case .connecting, .reasserting:
            return "connecting"
        case .disconnecting:
            return "disconnecting"
        case .disconnected, .invalid:
            return "disconnected"
        @unknown default:
            return "disconnected"
        }
    }

    private static func isValidBundleIdentifier(_ value: String) -> Bool {
        let components = value.split(separator: ".")
        guard components.count >= 2 else { return false }
        return components.allSatisfy { component in
            !component.isEmpty && component.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        }
    }
}
