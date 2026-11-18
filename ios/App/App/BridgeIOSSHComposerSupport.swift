import Foundation

struct BridgeIOSSHComposerRemoteAttachment: Equatable {
    let name: String
    let contentType: String
    let path: String
}

enum BridgeIOSSHComposerEncoding {
    static func prompt(text: String, attachments: [BridgeIOSSHComposerRemoteAttachment]) -> String {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let cleaned = String(normalized.unicodeScalars.filter { scalar in
            scalar.value == 10 || scalar.value == 9 || (scalar.value >= 32 && scalar.value != 127)
        })
        var parts: [String] = []
        if !cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append(cleaned) }
        let images = attachments.filter { $0.contentType.lowercased().hasPrefix("image/") }
        let files = attachments.filter { !$0.contentType.lowercased().hasPrefix("image/") }
        if !images.isEmpty {
            let items = images.enumerated().map { index, image in
                "<image name=[Image #\(index + 1)] path=\"\(escape(image.path))\">"
            }.joined(separator: "\n")
            parts.append("请打开并查看我附上的图片，再结合上面的文字处理：\n" + items)
        }
        if !files.isEmpty {
            let items = files.map { "<file name=\"\(escape($0.name))\" path=\"\(escape($0.path))\">" }.joined(separator: "\n")
            parts.append("请读取我附上的文件，再结合上面的文字处理：\n" + items)
        }
        return parts.joined(separator: "\n\n")
    }

    static func paste(_ prompt: String, bracketed: Bool) -> Data {
        // A trailing skill token can otherwise consume Enter in Codex's picker.
        let needsSpace = prompt.range(of: #"(?:^|\s)\$[^\s$]+$"#, options: .regularExpression) != nil
        let body = prompt + (needsSpace ? " " : "")
        return Data((bracketed ? "\u{1b}[200~" + body + "\u{1b}[201~" : body).utf8)
    }

    static func terminalKey(_ bytes: [UInt8], applicationCursor: Bool) -> Data {
        guard applicationCursor, bytes.count == 3, bytes[0] == 27, bytes[1] == 91,
              (65...68).contains(bytes[2]) else { return Data(bytes) }
        return Data([27, 79, bytes[2]])
    }

    private static func escape(_ value: String) -> String {
        var result = ""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0...31, 127: result.append(" ")
            case 38: result.append("&amp;")
            case 34: result.append("&quot;")
            case 60: result.append("&lt;")
            case 62: result.append("&gt;")
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result
    }
}

enum BridgeIOSSHInputResult: Equatable {
    case written
    case notSent
    case unknown
}

/// All methods and callbacks are serialized by the owning SSH channel's event loop.
final class BridgeIOSSHInputQueue {
    private enum Operation {
        case raw(Data)
        case composer(Data, (BridgeIOSSHInputResult) -> Void)
    }
    private let active: () -> Bool
    private let write: (Data, @escaping (Bool) -> Void) -> Void
    private let schedule: (@escaping () -> Void) -> Void
    private var pending: [Operation] = []
    private var busy = false

    init(active: @escaping () -> Bool,
         write: @escaping (Data, @escaping (Bool) -> Void) -> Void,
         schedule: @escaping (@escaping () -> Void) -> Void) {
        self.active = active
        self.write = write
        self.schedule = schedule
    }

    func enqueueRaw(_ data: Data) {
        pending.append(.raw(data))
        drain()
    }

    func enqueueComposer(_ data: Data, completion: @escaping (BridgeIOSSHInputResult) -> Void) {
        pending.append(.composer(data, completion))
        drain()
    }

    private func drain() {
        guard !busy, !pending.isEmpty else { return }
        busy = true
        let operation = pending.removeFirst()
        switch operation {
        case .raw(let data):
            guard active() else { finish(); return }
            write(data) { [self] _ in finish() }
        case .composer(let data, let completion):
            guard active() else { completion(.notSent); finish(); return }
            write(data) { [self] sent in
                guard sent else { completion(.unknown); finish(); return }
                schedule { [self] in
                    guard active() else { completion(.unknown); finish(); return }
                    write(Data([13])) { [self] sentEnter in
                        completion(sentEnter ? .written : .unknown)
                        finish()
                    }
                }
            }
        }
    }

    private func finish() {
        busy = false
        drain()
    }
}
