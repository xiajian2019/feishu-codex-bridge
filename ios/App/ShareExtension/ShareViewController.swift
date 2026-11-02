import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let status = UILabel()
    private let save = UIButton(type: .system)
    private var saving = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel(); title.text = "分享到 Bridge"; title.font = .preferredFont(forTextStyle: .title2)
        status.numberOfLines = 0
        status.text = "内容仅保存到本机收件箱，不自动上传或执行。保存后请打开 Bridge，选择项目或会话并确认加入草稿。"
        save.setTitle("保存在 Bridge 收件箱", for: .normal)
        save.addTarget(self, action: #selector(saveShare), for: .touchUpInside)
        let cancel = UIButton(type: .system); cancel.setTitle("取消", for: .normal)
        cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, status, save, cancel])
        stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 30)])
    }

    @objc private func cancelShare() { if !saving { extensionContext?.completeRequest(returningItems: nil) } }

    @objc private func saveShare() {
        guard !saving else { return }
        saving = true; save.isEnabled = false; status.text = "正在复制到本机，请保持分享窗口打开…"
        guard let group = Bundle.main.object(forInfoDictionaryKey: "BridgeShareAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            finishError("分享扩展缺少有效的 App Group 签名配置，请先在 Xcode 配置主 App 与扩展为同一 App Group。")
            return
        }
        let id = UUID().uuidString.lowercased()
        let directory = container.appendingPathComponent("mobile-share-inbox").appendingPathComponent(id)
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        catch { finishError("本机空间不可用，请保留原文件后重试。"); return }
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let groupWait = DispatchGroup()
        let lock = NSLock()
        var texts: [String] = []
        var files: [[String: Any]] = []
        var failed = false
        func copyFile(_ url: URL?, type: String) {
            guard let url = url, url.isFileURL else { lock.lock(); failed = true; lock.unlock(); return }
            let fileId = UUID().uuidString.lowercased()
            do {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let destination = directory.appendingPathComponent(fileId)
                try FileManager.default.copyItem(at: url, to: destination)
                let size = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? UTType(type)?.preferredMIMEType ?? "application/octet-stream"
                lock.lock(); files.append(["id": fileId, "name": url.lastPathComponent, "type": mime, "size": size]); lock.unlock()
            } catch { lock.lock(); failed = true; lock.unlock() }
        }
        for provider in providers {
            let fileType = provider.registeredTypeIdentifiers.first { type in
                guard let value = UTType(type) else { return false }
                return value.conforms(to: .image) || (value.conforms(to: .data) && !value.conforms(to: .text) && !value.conforms(to: .url))
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                groupWait.enter()
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                    defer { groupWait.leave() }
                    copyFile(item as? URL, type: UTType.data.identifier)
                }
            } else if let type = fileType {
                groupWait.enter()
                provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                    defer { groupWait.leave() }
                    copyFile(url, type: type)
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) || provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                groupWait.enter()
                let type = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) ? UTType.url.identifier : UTType.plainText.identifier
                provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                    defer { groupWait.leave() }
                    lock.lock(); defer { lock.unlock() }
                    if let url = item as? URL, !url.isFileURL { texts.append(url.absoluteString) }
                    else if let text = item as? String { texts.append(text) }
                    else { failed = true }
                }
            } else { lock.lock(); failed = true; lock.unlock() }
        }
        groupWait.notify(queue: .main) {
            var record: [String: Any] = ["id": id, "text": texts.joined(separator: "\n\n"), "title": "手机分享", "createdAt": Int(Date().timeIntervalSince1970 * 1000), "files": files]
            if failed { record["error"] = "部分内容未能复制，请保留原文件并重新分享。" }
            do {
                let data = try JSONSerialization.data(withJSONObject: record)
                try data.write(to: directory.appendingPathComponent("record.json"), options: [.atomic, .completeFileProtectionUnlessOpen])
                self.extensionContext?.completeRequest(returningItems: nil)
            } catch { self.finishError("分享未能持久保存，请保留原文件并检查本机空间。") }
        }
    }

    private func finishError(_ message: String) { status.text = message; saving = false; save.isEnabled = true }
}
