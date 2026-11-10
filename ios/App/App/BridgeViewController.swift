import Capacitor
import UIKit

class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BridgeCredentialsPlugin())
        bridge?.registerPluginInstance(BridgeIOSOtaPlugin())
        bridge?.registerPluginInstance(BridgeShareInboxPlugin())
        bridge?.registerPluginInstance(BridgeNativeThemePlugin())
        bridge?.registerPluginInstance(BridgeConnectBotSSHPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardFrameChanged(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func keyboardFrameChanged(_ notification: Notification) {
        guard let window = view.window,
              let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let keyboard = window.convert(frame, from: nil)
        let overlap = window.bounds.intersection(keyboard)
        let docked = !overlap.isNull && overlap.height > 1
            && overlap.width >= window.bounds.width * 0.5
            && overlap.maxY >= window.bounds.maxY - 1
        setWebKeyboardDocked(docked)
    }

    @objc private func keyboardWillHide() {
        setWebKeyboardDocked(false)
    }

    private func setWebKeyboardDocked(_ docked: Bool) {
        webView?.evaluateJavaScript("document.documentElement.classList.toggle('bridge-ios-keyboard-visible', \(docked ? "true" : "false"));", completionHandler: nil)
    }
}

@objc(BridgeIOSOtaPlugin)
public class BridgeIOSOtaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeIOSOtaPlugin"
    public let jsName = "BridgeIOSOta"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]

    @objc func open(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https", components.host != nil,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.path.range(of: "/[A-Za-z0-9_-]{43}/$", options: .regularExpression) != nil,
              let url = components.url else {
            call.reject("Invalid iOS OTA URL.", "INVALID_URL")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("无法打开 Safari 安装页。", "OPEN_FAILED") }
            }
        }
    }
}
