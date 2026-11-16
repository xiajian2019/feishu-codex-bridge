import BridgeCrashDiagnostics
import Capacitor
import Foundation
import UIKit

@objc(BridgeCrashDiagnosticsPlugin)
public final class BridgeCrashDiagnosticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeCrashDiagnosticsPlugin"
    public let jsName = "BridgeCrashDiagnostics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readReport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareReport", returnType: CAPPluginReturnPromise),
    ]

    @objc func getStatus(_ call: CAPPluginCall) {
        do { call.resolve(try BridgeCrashDiagnostics.shared.status()) }
        catch { call.reject(error.localizedDescription, "CRASH_DIAGNOSTICS_STATUS_FAILED") }
    }

    @objc func readReport(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("缺少报告标识。", "INVALID_REPORT"); return }
        do { call.resolve(["text": try BridgeCrashDiagnostics.shared.reportText(id: id)]) }
        catch { call.reject(error.localizedDescription, "CRASH_DIAGNOSTICS_READ_FAILED") }
    }

    @objc func captureSnapshot(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .utility).async {
            do { call.resolve(["id": try BridgeCrashDiagnostics.shared.captureSnapshot()]) }
            catch { call.reject(error.localizedDescription, "CRASH_DIAGNOSTICS_SNAPSHOT_FAILED") }
        }
    }

    @objc func shareReport(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("缺少报告标识。", "INVALID_REPORT"); return }
        do {
            let url = try BridgeCrashDiagnostics.shared.reportURL(id: id)
            DispatchQueue.main.async { [weak self] in
                guard let presenter = self?.bridge?.viewController, presenter.viewIfLoaded?.window != nil else {
                    call.reject("当前页面无法打开分享面板。", "SHARE_UNAVAILABLE")
                    return
                }
                let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                if let popover = sheet.popoverPresentationController {
                    popover.sourceView = presenter.view
                    popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                }
                presenter.present(sheet, animated: true) { call.resolve(["opened": true]) }
            }
        } catch { call.reject(error.localizedDescription, "CRASH_DIAGNOSTICS_SHARE_FAILED") }
    }
}
