import Capacitor
import Foundation

@objc(BridgeAppIntentPlugin)
public final class BridgeAppIntentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeAppIntentPlugin"
    public let jsName = "BridgeAppIntent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingRoute", returnType: CAPPluginReturnPromise),
    ]

    private var routeObserver: NSObjectProtocol?

    override public func load() {
        super.load()
        routeObserver = NotificationCenter.default.addObserver(
            forName: BridgeAppIntentHandoff.routeQueuedNotification,
            object: nil,
            queue: .main,
        ) { [weak self] _ in
            self?.emitPendingRoute()
        }
        DispatchQueue.main.async { [weak self] in
            self?.emitPendingRoute()
        }
    }

    deinit {
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    }

    @objc func getPendingRoute(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let route = BridgeAppIntentHandoff.consumePendingRoute() {
                call.resolve(["route": route])
            } else {
                call.resolve(["route": NSNull()])
            }
        }
    }

    private func emitPendingRoute() {
        guard BridgeAppIntentHandoff.hasPendingRoute else { return }
        notifyListeners("routeRequested", data: [:], retainUntilConsumed: true)
    }
}
