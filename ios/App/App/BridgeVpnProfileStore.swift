import Foundation
import Security

#if canImport(TunnelKitOpenVPN)
import TunnelKitOpenVPN
#endif

enum BridgeVpnProfileStoreError: LocalizedError {
    case appGroupUnavailable
    case profileUnavailable
    case invalidTitle
    case credentialsMustBeProvidedTogether
    case invalidCredential
    case keychainFailure(OSStatus, operation: String)
    case invalidStoredProfile
    case tunnelKitUnavailable

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "iOS VPN 缺少有效的 App Group 配置。"
        case .profileUnavailable:
            return "尚未导入 OpenVPN 配置。"
        case .invalidTitle:
            return "VPN 配置名称无效。"
        case .credentialsMustBeProvidedTogether:
            return "OpenVPN 用户名和密码必须同时提供。"
        case .invalidCredential:
            return "OpenVPN 用户名或密码无效。"
        case .keychainFailure(_, let operation):
            return "无法\(operation) OpenVPN 凭据。"
        case .invalidStoredProfile:
            return "已保存的 OpenVPN 配置已损坏，请重新导入。"
        case .tunnelKitUnavailable:
            return "当前 iOS 构建未包含 TunnelKit OpenVPN 模块。"
        }
    }
}

struct BridgeVpnProfileMetadata: Codable {
    let schemaVersion: Int
    let id: String
    let title: String
    let importedAt: Date
    let requiresUsernamePassword: Bool
    let credentialsStored: Bool
}

struct BridgeVpnCredentials {
    let username: String
    let passwordReference: Data
}

protocol BridgeVpnCredentialKeychain {
    func save(username: String, password: String) throws -> Data
    func username() throws -> String?
    func passwordReference() throws -> Data?
    func saveProfile(_ data: Data) throws
    func profileData() throws -> Data?
    func remove() throws
    func removeProfile() throws
}

/// Stores OpenVPN credentials in Keychain. The password is never part of the
/// profile metadata and is passed to the Packet Tunnel only as a persistent
/// Keychain reference.
final class BridgeVpnSecurityKeychain: BridgeVpnCredentialKeychain {
    static let usernameService = "dev.feishu.codex.bridge.openvpn.username.v1"
    static let passwordService = "dev.feishu.codex.bridge.openvpn.password.v1"
    static let profileService = "dev.feishu.codex.bridge.openvpn.profile.v1"
    static let account = "default"

    private let accessGroup: String?

    init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    func save(username: String, password: String) throws -> Data {
        guard !username.isEmpty, username.count <= 512,
              !password.isEmpty, password.count <= 16_384 else {
            throw BridgeVpnProfileStoreError.invalidCredential
        }

        do {
            let passwordReference = try upsert(
                data: Data(password.utf8),
                service: Self.passwordService,
                returnsPersistentReference: true
            )
            _ = try upsert(
                data: Data(username.utf8),
                service: Self.usernameService,
                returnsPersistentReference: false
            )
            return passwordReference
        } catch {
            try? delete(service: Self.passwordService)
            try? delete(service: Self.usernameService)
            throw error
        }
    }

    func username() throws -> String? {
        guard let data = try read(service: Self.usernameService) else { return nil }
        guard let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            throw BridgeVpnProfileStoreError.invalidCredential
        }
        return value
    }

    func passwordReference() throws -> Data? {
        try persistentReference(service: Self.passwordService)
    }

    func saveProfile(_ data: Data) throws {
        guard !data.isEmpty, data.count <= 512 * 1024 else {
            throw BridgeVpnProfileStoreError.invalidStoredProfile
        }
        _ = try upsert(data: data, service: Self.profileService, returnsPersistentReference: false)
    }

    func profileData() throws -> Data? {
        try read(service: Self.profileService)
    }

    func remove() throws {
        try delete(service: Self.usernameService)
        try delete(service: Self.passwordService)
    }

    func removeProfile() throws {
        try delete(service: Self.profileService)
    }

    private func baseQuery(service: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    private func read(service: String) throws -> Data? {
        var query = baseQuery(service: service)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else {
            throw BridgeVpnProfileStoreError.keychainFailure(status, operation: "读取")
        }
        return data
    }

    private func persistentReference(service: String) throws -> Data? {
        var query = baseQuery(service: service)
        query[kSecReturnPersistentRef as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else {
            throw BridgeVpnProfileStoreError.keychainFailure(status, operation: "读取")
        }
        return data
    }

    private func upsert(
        data: Data,
        service: String,
        returnsPersistentReference: Bool
    ) throws -> Data {
        let query = baseQuery(service: service)
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            values.forEach { item[$0.key] = $0.value }
            if returnsPersistentReference {
                item[kSecReturnPersistentRef as String] = true
            }
            var value: CFTypeRef?
            status = SecItemAdd(item as CFDictionary, &value)
            if status == errSecSuccess, returnsPersistentReference,
               let reference = value as? Data {
                return reference
            }
        }
        guard status == errSecSuccess else {
            throw BridgeVpnProfileStoreError.keychainFailure(status, operation: "写入")
        }
        if returnsPersistentReference, let reference = try persistentReference(service: service) {
            return reference
        }
        return Data()
    }

    private func delete(service: String) throws {
        let status = SecItemDelete(baseQuery(service: service) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw BridgeVpnProfileStoreError.keychainFailure(status, operation: "删除")
        }
    }
}

final class BridgeVpnProfileStore {
    static let appGroupInfoKey = "BridgeShareAppGroup"
    static let keychainAccessGroupInfoKey = "BridgeVpnKeychainAccessGroup"
    static let profileMetadataKey = "BridgeAutoVpn.profile.metadata.v1"
    static let bypassWifiSsidsKey = "BridgeAutoVpn.settings.bypassWifiSsids.v1"
    static let defaultProfileID = "default"

    private let defaults: UserDefaults?
    private let appGroupIdentifier: String?
    private let keychain: BridgeVpnCredentialKeychain
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        appGroupIdentifier: String? = BridgeVpnProfileStore.appGroupIdentifier(),
        defaults: UserDefaults? = nil,
        keychain: BridgeVpnCredentialKeychain? = nil
    ) {
        self.appGroupIdentifier = appGroupIdentifier
        self.defaults = defaults ?? appGroupIdentifier.flatMap(UserDefaults.init(suiteName:))
        // TunnelKit's host and Packet Tunnel targets must share the matching
        // keychain access group. The parallel Xcode/entitlement task owns that
        // signing change; keeping the group here prevents credentials from
        // silently falling back to the host app's private keychain namespace.
        self.keychain = keychain ?? BridgeVpnSecurityKeychain(accessGroup: Self.keychainAccessGroup())
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    static func appGroupIdentifier(bundle: Bundle = .main) -> String? {
        guard let value = bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
              value.hasPrefix("group."), !value.contains("$(") else {
            return nil
        }
        return value
    }

    static func keychainAccessGroup(bundle: Bundle = .main) -> String? {
        guard let value = bundle.object(forInfoDictionaryKey: Self.keychainAccessGroupInfoKey) as? String,
              !value.isEmpty, !value.contains("$(") else {
            return nil
        }
        return value
    }

    var groupIdentifier: String? {
        appGroupIdentifier
    }

    var hasProfile: Bool {
        guard defaults?.data(forKey: Self.profileMetadataKey) != nil else { return false }
        return (try? keychain.profileData()) != nil
    }

    func bypassWifiSsids() -> [String] {
        (defaults?.array(forKey: Self.bypassWifiSsidsKey) as? [String]) ?? []
    }

    @discardableResult
    func saveBypassWifiSsids(_ values: [String]) throws -> [String] {
        guard let defaults else { throw BridgeVpnProfileStoreError.appGroupUnavailable }
        let normalized = try Self.normalizeWifiSsids(values)
        defaults.set(normalized, forKey: Self.bypassWifiSsidsKey)
        return normalized
    }

    static func normalizeWifiSsids(_ values: [String]) throws -> [String] {
        var result: [String] = []
        for rawValue in values {
            let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value.count <= 255 else {
                throw BridgeVpnProfileStoreError.invalidTitle
            }
            if !result.contains(value) { result.append(value) }
        }
        guard result.count <= 64 else { throw BridgeVpnProfileStoreError.invalidTitle }
        return result
    }

#if canImport(TunnelKitOpenVPN)
    func save(
        configuration: OpenVPN.Configuration,
        title: String,
        username: String?,
        password: String?
    ) throws -> BridgeVpnProfileMetadata {
        guard let defaults else { throw BridgeVpnProfileStoreError.appGroupUnavailable }
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty, normalizedTitle.count <= 128 else {
            throw BridgeVpnProfileStoreError.invalidTitle
        }
        guard (username == nil) == (password == nil) else {
            throw BridgeVpnProfileStoreError.credentialsMustBeProvidedTogether
        }

        let configurationData: Data
        do {
            configurationData = try encoder.encode(configuration)
        } catch {
            throw BridgeVpnProfileStoreError.invalidStoredProfile
        }

        let credentialsStored: Bool
        if let username, let password {
            _ = try keychain.save(username: username, password: password)
            credentialsStored = true
        } else {
            try keychain.remove()
            credentialsStored = false
        }

        let metadata = BridgeVpnProfileMetadata(
            schemaVersion: 1,
            id: Self.defaultProfileID,
            title: normalizedTitle,
            importedAt: Date(),
            requiresUsernamePassword: configuration.authUserPass == true,
            credentialsStored: credentialsStored
        )
        do {
            try keychain.saveProfile(configurationData)
        } catch {
            try? keychain.remove()
            throw error
        }
        do {
            defaults.set(try encoder.encode(metadata), forKey: Self.profileMetadataKey)
        } catch {
            try? keychain.remove()
            try? keychain.removeProfile()
            throw BridgeVpnProfileStoreError.invalidStoredProfile
        }
        return metadata
    }

    func metadata() throws -> BridgeVpnProfileMetadata {
        guard let data = defaults?.data(forKey: Self.profileMetadataKey),
              let metadata = try? decoder.decode(BridgeVpnProfileMetadata.self, from: data),
              metadata.id == Self.defaultProfileID else {
            throw BridgeVpnProfileStoreError.profileUnavailable
        }
        return metadata
    }

    func loadConfiguration() throws -> OpenVPN.Configuration {
        guard let data = try keychain.profileData() else {
            throw BridgeVpnProfileStoreError.profileUnavailable
        }
        do {
            return try decoder.decode(OpenVPN.Configuration.self, from: data)
        } catch {
            throw BridgeVpnProfileStoreError.invalidStoredProfile
        }
    }

    func credentials() throws -> BridgeVpnCredentials? {
        guard let username = try keychain.username() else { return nil }
        guard let passwordReference = try keychain.passwordReference() else {
            throw BridgeVpnProfileStoreError.credentialsMustBeProvidedTogether
        }
        return BridgeVpnCredentials(username: username, passwordReference: passwordReference)
    }
#else
    func metadata() throws -> BridgeVpnProfileMetadata {
        throw BridgeVpnProfileStoreError.tunnelKitUnavailable
    }
#endif
}
