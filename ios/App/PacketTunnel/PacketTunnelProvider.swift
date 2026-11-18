import Foundation
import NetworkExtension
import Security
import TunnelKitOpenVPN
import TunnelKitOpenVPNAppExtension

final class PacketTunnelProvider: OpenVPNTunnelProvider {
    override func loadProviderConfiguration(from tunnelProtocol: NETunnelProviderProtocol) throws -> OpenVPN.ProviderConfiguration {
        guard let values = tunnelProtocol.providerConfiguration,
              (values["bridgeKeychainProfileVersion"] as? Int) == 1 else {
            // Continue to support profiles created by older AppVpn builds.
            return try super.loadProviderConfiguration(from: tunnelProtocol)
        }
        guard let title = values["title"] as? String, !title.isEmpty,
              let appGroup = Bundle.main.object(forInfoDictionaryKey: "BridgeShareAppGroup") as? String,
              appGroup.hasPrefix("group."),
              let keychainGroup = Bundle.main.object(forInfoDictionaryKey: "BridgeVpnKeychainAccessGroup") as? String,
              !keychainGroup.isEmpty, !keychainGroup.contains("$(") else {
            throw profileError()
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.feishu.codex.bridge.openvpn.profile.v1",
            kSecAttrAccount as String: "default",
            kSecAttrAccessGroup as String: keychainGroup,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let configuration = try? JSONDecoder().decode(OpenVPN.Configuration.self, from: data) else {
            throw profileError()
        }
        var result = OpenVPN.ProviderConfiguration(title, appGroup: appGroup, configuration: configuration)
        result.username = tunnelProtocol.username
        return result
    }

    private func profileError() -> NSError {
        NSError(domain: "BridgePacketTunnel", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "无法读取 VPN 配置，请在 Bridge 中重新导入。",
        ])
    }
}
