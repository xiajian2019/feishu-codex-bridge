import Foundation

enum BridgeAppIntentHandoff {
    static let routeQueuedNotification = Notification.Name("BridgeAppIntentRouteQueued")

    private static let appGroup = "group.dev.feishu.codex.bridge"
    private static let pendingRouteKey = "bridge.app-intent.pending-route.v1"
    private static let allowedRoutes: Set<String> = ["/tmux-dashboard", "/mobile-inbox"]

    static var hasPendingRoute: Bool {
        pendingDefaults?.string(forKey: pendingRouteKey) != nil
    }

    @discardableResult
    static func enqueue(route: String) -> Bool {
        guard allowedRoutes.contains(route), let defaults = pendingDefaults else { return false }
        defaults.set(route, forKey: pendingRouteKey)
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: routeQueuedNotification, object: nil)
        }
        return true
    }

    static func consumePendingRoute() -> String? {
        guard let defaults = pendingDefaults,
              let route = defaults.string(forKey: pendingRouteKey),
              allowedRoutes.contains(route) else {
            pendingDefaults?.removeObject(forKey: pendingRouteKey)
            return nil
        }
        defaults.removeObject(forKey: pendingRouteKey)
        return route
    }

    private static var pendingDefaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }
}
