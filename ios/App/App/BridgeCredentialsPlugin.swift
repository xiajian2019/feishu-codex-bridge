import Foundation
import Capacitor
import Security

enum BridgeIOSecureCredentialStore {
    static let service = "dev.feishu.codex.bridge.credentials"

    static func readToken(server: String) throws -> String? {
        guard let url = URL(string: server), let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              server.count <= 2_048 else {
            throw NSError(domain: "BridgeCredentials", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid Bridge server address."])
        }
        var request: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: server,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        request.removeAll(keepingCapacity: false)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data,
              let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            throw NSError(domain: "BridgeCredentials", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to read secure Bridge credentials."])
        }
        return token
    }
}

@objc(BridgeCredentialsPlugin)
public class BridgeCredentialsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeCredentialsPlugin"
    public let jsName = "BridgeCredentials"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private func query(_ call: CAPPluginCall) -> [String: Any]? {
        guard let server = call.getString("server"), server.count <= 2048,
              let url = URLComponents(string: server),
              ["https", "http"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            call.reject("Invalid Bridge server address.", "INVALID_SERVER")
            return nil
        }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: BridgeIOSecureCredentialStore.service,
            kSecAttrAccount as String: server,
            kSecAttrSynchronizable as String: false
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard var request = query(call) else { return }
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound {
            call.resolve(["token": NSNull()])
        } else if status == errSecSuccess, let data = value as? Data,
                  let token = String(data: data, encoding: .utf8) {
            call.resolve(["token": token])
        } else {
            call.reject("Unable to read secure Bridge credentials. Unlock this device and try again.", "CREDENTIAL_READ_FAILED")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let request = query(call) else { return }
        guard let token = call.getString("token"), !token.isEmpty, token.count <= 16384,
              let data = token.data(using: .utf8) else {
            call.reject("Invalid Bridge device token.", "INVALID_TOKEN")
            return
        }
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var status = SecItemUpdate(request as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = request
            values.forEach { item[$0.key] = $0.value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Unable to save secure Bridge credentials.", "CREDENTIAL_WRITE_FAILED")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let request = query(call) else { return }
        let status = SecItemDelete(request as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Unable to remove secure Bridge credentials.", "CREDENTIAL_REMOVE_FAILED")
        }
    }
}
