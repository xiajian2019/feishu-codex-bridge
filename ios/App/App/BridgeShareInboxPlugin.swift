import Foundation
import Capacitor

@objc(BridgeShareInboxPlugin)
public class BridgeShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeShareInboxPlugin"
    public let jsName = "BridgeShareInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listShares", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getFile", returnType: CAPPluginReturnPromise)
    ]

    private func root() throws -> URL {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "BridgeShareAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw NSError(domain: "BridgeShare", code: 1, userInfo: [NSLocalizedDescriptionKey: "iOS 分享收件箱需要有效的 App Group 签名配置；其他功能仍可使用。"])
        }
        let root = container.appendingPathComponent("mobile-share-inbox", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.resolvingSymlinksInPath()
    }

    @objc func listShares(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let root = try self.root()
                let directories = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
                let shares: [[String: Any]] = directories.compactMap { directory in
                    guard UUID(uuidString: directory.lastPathComponent) != nil,
                          let data = try? Data(contentsOf: directory.appendingPathComponent("record.json")),
                          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
                    return value
                }
                call.resolve(["shares": shares])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func getFile(_ call: CAPPluginCall) {
        do {
            guard let shareId = call.getString("shareId"), UUID(uuidString: shareId) != nil,
                  let fileId = call.getString("fileId"), UUID(uuidString: fileId) != nil else { throw invalidFile() }
            let root = try root()
            let directory = root.appendingPathComponent(shareId).resolvingSymlinksInPath()
            let file = directory.appendingPathComponent(fileId).resolvingSymlinksInPath()
            let data = try Data(contentsOf: directory.appendingPathComponent("record.json"))
            let record = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let files = record?["files"] as? [[String: Any]] ?? []
            guard directory.path.hasPrefix(root.path + "/"), file.path.hasPrefix(directory.path + "/"),
                  files.contains(where: { $0["id"] as? String == fileId }),
                  try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw invalidFile() }
            call.resolve(["uri": file.absoluteString])
        } catch { call.reject("分享文件不可用，请保留原文件并重新分享。") }
    }

    private func invalidFile() -> NSError { NSError(domain: "BridgeShare", code: 2) }
}
