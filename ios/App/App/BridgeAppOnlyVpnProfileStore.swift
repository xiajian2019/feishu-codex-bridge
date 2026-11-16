#if BRIDGE_APP_ONLY_VPN_POC
import Foundation
import Security
import TunnelKitOpenVPNCore
import TunnelKitOpenVPNProtocol

enum BridgeAppOnlyVpnProfileStoreError: LocalizedError {
    case noProfile
    case invalidProfile
    case invalidCredentials
    case keychainFailure(OSStatus, operation: String)

    var errorDescription: String? {
        switch self {
        case .noProfile:
            return "尚未导入 App-only OpenVPN 配置。"
        case .invalidProfile:
            return "App-only OpenVPN 配置已损坏，请重新导入。"
        case .invalidCredentials:
            return "用户名或密码无效。"
        case .keychainFailure(_, let operation):
            return "无法\(operation) App-only OpenVPN 凭据。"
        }
    }
}

struct BridgeAppOnlyVpnProfileSummary {
    let title: String
    let importedAt: Date
    let requiresCredentials: Bool
    let credentialsStored: Bool
}

/// Experimental App-only storage. It deliberately uses different Keychain
/// services from BridgeAutoVpn so the removable POC cannot alter the system
/// Packet Tunnel profile.
final class BridgeAppOnlyVpnProfileStore {
    static let shared = BridgeAppOnlyVpnProfileStore()

    private static let profileService = "dev.feishu.codex.bridge.app-only-poc.profile.v1"
    private static let usernameService = "dev.feishu.codex.bridge.app-only-poc.username.v1"
    private static let passwordService = "dev.feishu.codex.bridge.app-only-poc.password.v1"
    private static let account = "default"
    private static let metadataKey = "BridgeAppOnlyVpnPOC.profile.metadata.v1"

    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasProfile: Bool {
        (try? read(service: Self.profileService)) != nil
    }

    func summary() -> BridgeAppOnlyVpnProfileSummary? {
        guard let data = defaults.data(forKey: Self.metadataKey),
              let value = try? decoder.decode(Metadata.self, from: data) else { return nil }
        return BridgeAppOnlyVpnProfileSummary(
            title: value.title,
            importedAt: value.importedAt,
            requiresCredentials: value.requiresCredentials,
            credentialsStored: value.credentialsStored
        )
    }

    func save(
        configuration: OpenVPN.Configuration,
        title: String,
        username: String?,
        password: String?
    ) throws -> BridgeAppOnlyVpnProfileSummary {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty, normalizedTitle.count <= 128 else {
            throw BridgeAppOnlyVpnProfileStoreError.invalidProfile
        }
        guard (username == nil) == (password == nil) else {
            throw BridgeAppOnlyVpnProfileStoreError.invalidCredentials
        }

        let configurationData: Data
        do {
            configurationData = try encoder.encode(configuration)
        } catch {
            throw BridgeAppOnlyVpnProfileStoreError.invalidProfile
        }
        guard configurationData.count <= 512 * 1024 else {
            throw BridgeAppOnlyVpnProfileStoreError.invalidProfile
        }

        try upsert(data: configurationData, service: Self.profileService)
        do {
            if let username, let password {
                guard !username.isEmpty, username.count <= 512,
                      !password.isEmpty, password.count <= 16_384 else {
                    throw BridgeAppOnlyVpnProfileStoreError.invalidCredentials
                }
                try upsert(data: Data(username.utf8), service: Self.usernameService)
                try upsert(data: Data(password.utf8), service: Self.passwordService)
            } else {
                try delete(service: Self.usernameService)
                try delete(service: Self.passwordService)
            }
        } catch {
            try? delete(service: Self.profileService)
            throw error
        }

        let value = Metadata(
            title: normalizedTitle,
            importedAt: Date(),
            requiresCredentials: configuration.authUserPass == true,
            credentialsStored: username != nil
        )
        defaults.set(try encoder.encode(value), forKey: Self.metadataKey)
        return BridgeAppOnlyVpnProfileSummary(
            title: value.title,
            importedAt: value.importedAt,
            requiresCredentials: value.requiresCredentials,
            credentialsStored: value.credentialsStored
        )
    }

    func loadConfiguration() throws -> OpenVPN.Configuration {
        guard let data = try read(service: Self.profileService) else {
            throw BridgeAppOnlyVpnProfileStoreError.noProfile
        }
        do {
            return try decoder.decode(OpenVPN.Configuration.self, from: data)
        } catch {
            throw BridgeAppOnlyVpnProfileStoreError.invalidProfile
        }
    }

    func loadCredentials() throws -> OpenVPN.Credentials? {
        guard let usernameData = try read(service: Self.usernameService),
              let passwordData = try read(service: Self.passwordService) else { return nil }
        guard let username = String(data: usernameData, encoding: .utf8),
              let password = String(data: passwordData, encoding: .utf8),
              !username.isEmpty, !password.isEmpty else {
            throw BridgeAppOnlyVpnProfileStoreError.invalidCredentials
        }
        return OpenVPN.Credentials(username, password)
    }

    func remove() throws {
        try delete(service: Self.profileService)
        try delete(service: Self.usernameService)
        try delete(service: Self.passwordService)
        defaults.removeObject(forKey: Self.metadataKey)
    }

    private struct Metadata: Codable {
        let title: String
        let importedAt: Date
        let requiresCredentials: Bool
        let credentialsStored: Bool
    }

    private func query(service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private func read(service: String) throws -> Data? {
        var request = query(service: service)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else {
            throw BridgeAppOnlyVpnProfileStoreError.keychainFailure(status, operation: "读取")
        }
        return data
    }

    private func upsert(data: Data, service: String) throws {
        let request = query(service: service)
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(request as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = request
            values.forEach { item[$0.key] = $0.value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw BridgeAppOnlyVpnProfileStoreError.keychainFailure(status, operation: "保存")
        }
    }

    private func delete(service: String) throws {
        let status = SecItemDelete(query(service: service) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw BridgeAppOnlyVpnProfileStoreError.keychainFailure(status, operation: "删除")
        }
    }
}
#endif
