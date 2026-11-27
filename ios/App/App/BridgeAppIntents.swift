import AppIntents
import Foundation

@available(iOS 16.0, *)
struct OpenBridgeSessionIntent: AppIntent {
    static var title: LocalizedStringResource { "打开 Bridge Session" }
    static var description = IntentDescription("打开 Bridge 的 Session 页面。")

    @available(iOS, deprecated: 26.0, message: "Use supportedModes on iOS 26 and later.")
    static var openAppWhenRun: Bool { true }

    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    func perform() async throws -> some IntentResult {
        _ = BridgeAppIntentHandoff.enqueue(route: "/tmux-dashboard")
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenBridgeInboxIntent: AppIntent {
    static var title: LocalizedStringResource { "查看 Bridge 待处理" }
    static var description = IntentDescription("打开 Bridge 的待处理中心。")

    @available(iOS, deprecated: 26.0, message: "Use supportedModes on iOS 26 and later.")
    static var openAppWhenRun: Bool { true }

    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    func perform() async throws -> some IntentResult {
        _ = BridgeAppIntentHandoff.enqueue(route: "/mobile-inbox")
        return .result()
    }
}

@available(iOS 16.0, *)
struct BridgeAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenBridgeSessionIntent(),
            phrases: [
                "打开我的 \(.applicationName) Session",
                "打开 \(.applicationName) Session",
            ],
            shortTitle: "打开 Session",
            systemImageName: "terminal",
        )
        AppShortcut(
            intent: OpenBridgeInboxIntent(),
            phrases: [
                "查看我的 \(.applicationName) 待处理",
                "查看 \(.applicationName) 待处理",
            ],
            shortTitle: "查看待处理",
            systemImageName: "checklist",
        )
        AppShortcut(
            intent: OpenDefaultSSHIntent(),
            phrases: [
                "打开我的 \(.applicationName)远程终端",
                "打开我的 \(.applicationName) 远程终端",
                "进入 \(.applicationName) 的远程终端",
            ],
            shortTitle: "打开远程终端",
            systemImageName: "network",
        )
        AppShortcut(
            intent: ConnectSSHIntent(),
            phrases: [
                "在 \(.applicationName) 中连接到 \(\.$profile)",
                "Connect to \(\.$profile) in \(.applicationName)",
            ],
            shortTitle: "连接指定 SSH 主机",
            systemImageName: "network",
        )
    }
}
