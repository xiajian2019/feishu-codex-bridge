import Foundation
import Security

struct BridgeIOSSHKeyMetadata: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var label: String
    let format: BridgeIOSSHPrivateKeyFormat
    let algorithm: BridgeIOSSHPrivateKeyAlgorithm
    let fingerprintSHA256: String
    let comment: String?
    let createdAt: Date
    var updatedAt: Date
}

struct BridgeIOSSHKeychainRecord {
    let metadata: BridgeIOSSHKeyMetadata
    let material: Data
}

enum BridgeIOSSHKeychainError: Error, LocalizedError {
    case invalidKeyID
    case invalidLabel
    case materialTooLarge
    case metadataMismatch
    case missingKey(String)
    case invalidMetadata
    case securityStatus(OSStatus, operation: String)

    var errorDescription: String? {
        switch self {
        case .invalidKeyID:
            return "SSH 私钥标识无效。"
        case .invalidLabel:
            return "SSH 私钥名称无效。"
        case .materialTooLarge:
            return "SSH 私钥文件过大。"
        case .metadataMismatch:
            return "SSH 私钥元数据与实际材料不一致。"
        case .missingKey(let id):
            return "找不到 SSH 私钥：\(id)。"
        case .invalidMetadata:
            return "SSH 私钥元数据损坏。"
        case .securityStatus(_, let operation):
            return "Keychain 操作失败：\(operation)。"
        }
    }
}

/// Small abstraction around Security.framework so metadata/material handling
/// can be tested without touching a user's real Keychain.
protocol BridgeIOSSHKeychainBackend {
    func read(service: String, account: String) throws -> Data?
    func write(service: String, account: String, data: Data) throws
    func delete(service: String, account: String) throws
    func accounts(service: String) throws -> [String]
}

final class BridgeIOSSHKeychainStore {
    static let defaultService = "dev.feishu.codex.bridge.ssh-private-keys.v1"

    private static let metadataPrefix = "metadata:"
    private static let materialPrefix = "material:"
    private static let maxMaterialSize = 4 * 1024 * 1024

    private let service: String
    private let backend: any BridgeIOSSHKeychainBackend
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        service: String = BridgeIOSSHKeychainStore.defaultService,
        backend: any BridgeIOSSHKeychainBackend = BridgeIOSSHSecurityKeychainBackend()
    ) {
        self.service = service
        self.backend = backend
    }

    func importKey(
        material: Data,
        label: String? = nil,
        id: String = UUID().uuidString,
        passphrase: String? = nil
    ) throws -> BridgeIOSSHKeyMetadata {
        try validate(id: id)
        try validate(label: label)
        guard material.count <= Self.maxMaterialSize else {
            throw BridgeIOSSHKeychainError.materialTooLarge
        }

        let parsed = try BridgeIOSSHPrivateKeyParser.parse(data: material, passphrase: passphrase)
        let now = Date()
        let oldMetadata = try metadata(for: id)
        let metadata = BridgeIOSSHKeyMetadata(
            id: id,
            label: normalizedLabel(label, parsed: parsed),
            format: parsed.format,
            algorithm: parsed.algorithm,
            fingerprintSHA256: parsed.fingerprintSHA256,
            comment: parsed.comment,
            createdAt: oldMetadata?.createdAt ?? now,
            updatedAt: now
        )
        try save(metadata: metadata, material: material)
        return metadata
    }

    func save(metadata: BridgeIOSSHKeyMetadata, material: Data) throws {
        try validate(id: metadata.id)
        try validate(label: metadata.label)
        guard material.count <= Self.maxMaterialSize else {
            throw BridgeIOSSHKeychainError.materialTooLarge
        }

        let metadataData: Data
        do {
            metadataData = try encoder.encode(metadata)
        } catch {
            throw BridgeIOSSHKeychainError.invalidMetadata
        }

        // Keep the two records separate so listing metadata never needs to
        // load private bytes. A future transactional store can replace this
        // backend without changing the parser or calling code.
        try backend.write(service: service, account: Self.materialAccount(metadata.id), data: material)
        do {
            try backend.write(service: service, account: Self.metadataAccount(metadata.id), data: metadataData)
        } catch {
            try? backend.delete(service: service, account: Self.materialAccount(metadata.id))
            throw error
        }
    }

    func metadata(for id: String) throws -> BridgeIOSSHKeyMetadata? {
        try validate(id: id)
        guard let data = try backend.read(service: service, account: Self.metadataAccount(id)) else {
            return nil
        }
        do {
            let value = try decoder.decode(BridgeIOSSHKeyMetadata.self, from: data)
            guard value.id == id else { throw BridgeIOSSHKeychainError.invalidMetadata }
            return value
        } catch let error as BridgeIOSSHKeychainError {
            throw error
        } catch {
            throw BridgeIOSSHKeychainError.invalidMetadata
        }
    }

    func listMetadata() throws -> [BridgeIOSSHKeyMetadata] {
        try backend.accounts(service: service)
            .filter { $0.hasPrefix(Self.metadataPrefix) }
            .compactMap { account in
                let id = String(account.dropFirst(Self.metadataPrefix.count))
                guard !id.isEmpty else { throw BridgeIOSSHKeychainError.invalidMetadata }
                return try metadata(for: id)
            }
            .sorted {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
                return $0.id < $1.id
            }
    }

    func record(for id: String) throws -> BridgeIOSSHKeychainRecord {
        guard let metadata = try metadata(for: id) else {
            throw BridgeIOSSHKeychainError.missingKey(id)
        }
        guard let material = try backend.read(service: service, account: Self.materialAccount(id)) else {
            throw BridgeIOSSHKeychainError.missingKey(id)
        }
        return BridgeIOSSHKeychainRecord(metadata: metadata, material: material)
    }

    func parsedKey(for id: String, passphrase: String? = nil) throws -> BridgeIOSSHParsedPrivateKey {
        let record = try record(for: id)
        let parsed = try BridgeIOSSHPrivateKeyParser.parse(data: record.material, passphrase: passphrase)
        guard parsed.format == record.metadata.format,
              parsed.algorithm == record.metadata.algorithm,
              parsed.fingerprintSHA256 == record.metadata.fingerprintSHA256 else {
            throw BridgeIOSSHKeychainError.metadataMismatch
        }
        return parsed
    }

    func delete(id: String) throws {
        try validate(id: id)
        try backend.delete(service: service, account: Self.metadataAccount(id))
        try backend.delete(service: service, account: Self.materialAccount(id))
    }

    private func normalizedLabel(
        _ label: String?,
        parsed: BridgeIOSSHParsedPrivateKey
    ) -> String {
        let explicit = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !explicit.isEmpty { return explicit }
        if let comment = parsed.comment?.trimmingCharacters(in: .whitespacesAndNewlines), !comment.isEmpty {
            return comment
        }
        return parsed.algorithm.displayName
    }

    private func validate(id: String) throws {
        let scalars = id.unicodeScalars
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard !id.isEmpty, id.count <= 128, scalars.allSatisfy({ allowed.contains($0) }) else {
            throw BridgeIOSSHKeychainError.invalidKeyID
        }
    }

    private func validate(label: String?) throws {
        guard let label else { return }
        let value = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count <= 128 else { throw BridgeIOSSHKeychainError.invalidLabel }
    }

    private static func metadataAccount(_ id: String) -> String { metadataPrefix + id }
    private static func materialAccount(_ id: String) -> String { materialPrefix + id }
}

private final class BridgeIOSSHSecurityKeychainBackend: BridgeIOSSHKeychainBackend {
    func read(service: String, account: String) throws -> Data? {
        var query = baseQuery(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else {
            throw BridgeIOSSHKeychainError.securityStatus(status, operation: "读取")
        }
        return data
    }

    func write(service: String, account: String, data: Data) throws {
        let query = baseQuery(service: service, account: account)
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            values.forEach { item[$0.key] = $0.value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw BridgeIOSSHKeychainError.securityStatus(status, operation: "写入")
        }
    }

    func delete(service: String, account: String) throws {
        let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw BridgeIOSSHKeychainError.securityStatus(status, operation: "删除")
        }
    }

    func accounts(service: String) throws -> [String] {
        var query = baseQuery(service: service, account: nil)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else {
            throw BridgeIOSSHKeychainError.securityStatus(status, operation: "列出")
        }
        guard let rows = value as? [[String: Any]] else { return [] }
        return rows.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    private func baseQuery(service: String, account: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: false,
        ]
        if let account { query[kSecAttrAccount as String] = account }
        return query
    }
}
