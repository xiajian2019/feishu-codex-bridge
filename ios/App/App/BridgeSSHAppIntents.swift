import AppIntents
import Foundation

enum BridgeSSHAppIntentHandoff {
    struct Request: Codable, Equatable {
        let profileID: String?
    }

    private static let appGroup = "group.dev.feishu.codex.bridge"
    private static let requestKey = "bridge.app-intent.pending-ssh.v1"

    @discardableResult
    static func enqueue(profileID: String?) -> Bool {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let data = try? JSONEncoder().encode(Request(profileID: profileID)) else { return false }
        defaults.set(data, forKey: requestKey)
        return true
    }

    static func pending() -> Request? {
        guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: requestKey),
              let request = try? JSONDecoder().decode(Request.self, from: data) else { return nil }
        return request
    }

    static func clear() {
        UserDefaults(suiteName: appGroup)?.removeObject(forKey: requestKey)
    }
}

@available(iOS 16.0, *)
struct BridgeSSHProfileEntity: AppEntity, Identifiable {
    let id: String
    let label: String

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "SSH 主机")
    static let defaultQuery = BridgeSSHProfileQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(label)")
    }
}

@available(iOS 16.0, *)
struct BridgeSSHProfileQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [BridgeSSHProfileEntity] {
        let profiles = BridgeIOSSHProfileStore.shared.list()
            .filter { !$0.keyId.isEmpty }
        let byID = Dictionary(uniqueKeysWithValues: profiles.map { ($0.id, $0) })
        return identifiers.compactMap { id in
            guard let profile = byID[id] else { return nil }
            return BridgeSSHProfileEntity(id: profile.id, label: profile.label)
        }
    }

    func entities(matching string: String) async throws -> [BridgeSSHProfileEntity] {
        let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
        let profiles = BridgeIOSSHProfileStore.shared.list()
            .filter { !$0.keyId.isEmpty }
        guard !query.isEmpty else {
            return profiles.map { BridgeSSHProfileEntity(id: $0.id, label: $0.label) }
        }
        return profiles.filter { profile in
            [profile.label, profile.host, "\(profile.username)@\(profile.host)",
             "\(profile.username)@\(profile.host):\(profile.port)"]
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }.map { BridgeSSHProfileEntity(id: $0.id, label: $0.label) }
    }

    func suggestedEntities() async throws -> [BridgeSSHProfileEntity] {
        BridgeIOSSHProfileStore.shared.list()
            .filter { !$0.keyId.isEmpty }
            .map { BridgeSSHProfileEntity(id: $0.id, label: $0.label) }
    }
}

@available(iOS 16.0, *)
struct OpenDefaultSSHIntent: AppIntent {
    static let title: LocalizedStringResource = "打开远程终端"
    static let description = IntentDescription("打开默认 SSH 主机的全屏远程终端。")

    @available(iOS, deprecated: 26.0, message: "Use supportedModes instead")
    static var openAppWhenRun: Bool { true }

    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await BridgeConnectBotSSHPlugin.requestAppIntent(profileID: nil)
        return .result(dialog: "正在打开默认 SSH 远程终端。")
    }
}

@available(iOS 16.0, *)
struct ConnectSSHIntent: AppIntent {
    static let title: LocalizedStringResource = "连接 SSH"
    static let description = IntentDescription("连接到 Bridge 中已保存的 SSH 主机。")

    @Parameter(title: "SSH 主机")
    var profile: BridgeSSHProfileEntity?

    // iOS 16–25: request that the app open before running the intent.
    @available(iOS, deprecated: 26.0, message: "Use supportedModes instead")
    static var openAppWhenRun: Bool { true }

    // iOS 26+: connecting opens the native SSH workspace, so run in the foreground.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await BridgeConnectBotSSHPlugin.requestAppIntent(profileID: profile?.id)
        return .result(dialog: "正在打开全屏 SSH 终端。")
    }
}

