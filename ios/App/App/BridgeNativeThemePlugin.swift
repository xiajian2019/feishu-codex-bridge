import Capacitor
import SwiftUI
import UIKit

@objc(BridgeNativeThemePlugin)
public final class BridgeNativeThemePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeNativeThemePlugin"
    public let jsName = "BridgeNativeTheme"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTheme", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTheme", returnType: CAPPluginReturnPromise),
    ]

    private static let themeKey = "bridge.native.theme"

    @objc func setTheme(_ call: CAPPluginCall) {
        guard let theme = call.getString("theme")?.lowercased(), theme == "light" || theme == "dark" else {
            call.reject("Invalid native theme.", "INVALID_ARGUMENTS")
            return
        }
        UserDefaults.standard.set(theme, forKey: Self.themeKey)
        call.resolve()
    }

    @objc func getTheme(_ call: CAPPluginCall) {
        let stored = UserDefaults.standard.string(forKey: Self.themeKey)
        let style = bridge?.viewController?.traitCollection.userInterfaceStyle ?? .unspecified
        let theme = stored == "dark" || stored == "light"
            ? stored!
            : (style == .dark ? "dark" : "light")
        call.resolve(["theme": theme])
    }

    static var preferredColorScheme: ColorScheme? {
        switch UserDefaults.standard.string(forKey: themeKey) {
        case "dark": return .dark
        case "light": return .light
        default: return nil
        }
    }
}
