import Foundation
import NIOCore
import NIOSFTP

enum BridgeIOSSHSFTPError: Error, LocalizedError {
    case invalidPath
    case outsideRoot
    case symbolicLink
    case unsupportedFile

    var errorDescription: String? {
        switch self {
        case .invalidPath: return "远端文件路径无效。"
        case .outsideRoot: return "远端文件路径超出当前 Session 根目录。"
        case .symbolicLink: return "为避免越界，暂不允许通过符号链接访问文件。"
        case .unsupportedFile: return "远端对象不是普通文件或目录。"
        }
    }
}

struct BridgeIOSSHSFTPEntry: Equatable {
    let name: String
    let isDirectory: Bool
    let isSymbolicLink: Bool
    let size: UInt64?
}

/// Small, transport-only SFTP adapter. UI, API-first routing, and fallback
/// decisions stay outside this type so a file operation cannot silently escape
/// the selected Session root.
final class BridgeIOSSHSFTPClient {
    private let client: SFTPClient
    private let root: String

    init(client: SFTPClient, canonicalRoot: String) throws {
        guard canonicalRoot.hasPrefix("/"), !canonicalRoot.contains("\0") else {
            throw BridgeIOSSHSFTPError.invalidPath
        }
        var normalized = canonicalRoot
        while normalized.contains("//") { normalized = normalized.replacingOccurrences(of: "//", with: "/") }
        if normalized.count > 1 { normalized = "/" + normalized.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        self.client = client
        self.root = normalized
    }

    func list(relativePath: String) throws -> EventLoopFuture<[BridgeIOSSHSFTPEntry]> {
        let candidate = try checkedRelativePath(relativePath)
        return client.openDirectory(path: candidate).flatMap { handle in
            self.readDirectory(handle, entries: [])
        }
    }

    func read(relativePath: String, offset: UInt64 = 0, length: UInt32 = 64 * 1024) throws -> EventLoopFuture<ByteBuffer?> {
        let candidate = try checkedRelativePath(relativePath)
        return client.openFile(path: candidate, flags: [.read]).flatMap { handle in
            self.client.read(file: handle, offset: offset, length: min(length, 64 * 1024)).flatMap { data in
                self.client.closeFile(handle).map { data }
            }
        }
    }

    func write(relativePath: String, offset: UInt64 = 0, data: ByteBuffer, createExclusive: Bool = false) throws -> EventLoopFuture<Void> {
        let candidate = try checkedRelativePath(relativePath)
        var flags: SFTPOpenFlags = [.write]
        if createExclusive { flags.insert([.create, .exclusive]) }
        return client.openFile(path: candidate, flags: flags).flatMap { handle in
            self.client.write(file: handle, offset: offset, data: data).flatMap {
                self.client.closeFile(handle)
            }
        }
    }

    private func readDirectory(_ handle: SFTPDirectoryHandle, entries: [BridgeIOSSHSFTPEntry]) -> EventLoopFuture<[BridgeIOSSHSFTPEntry]> {
        client.readDirectoryBatch(handle).flatMap { batch in
            guard let batch else {
                return self.client.closeDirectory(handle).map { entries }
            }
            let next = entries + batch.map { item in
                let mode = item.attributes.permissions ?? 0
                let type = mode & 0o170000
                return BridgeIOSSHSFTPEntry(
                    name: item.filename,
                    isDirectory: type == 0o040000,
                    isSymbolicLink: type == 0o120000,
                    size: item.attributes.size,
                )
            }
            return self.readDirectory(handle, entries: next)
        }
    }

    private func checkedRelativePath(_ value: String) throws -> String {
        guard value.count <= 4_096, !value.contains("\0"), !value.hasPrefix("/") else {
            throw BridgeIOSSHSFTPError.invalidPath
        }
        let parts = value.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !parts.contains(".."), !parts.contains(where: { $0 == "." || $0.isEmpty || $0.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) }) else {
            throw BridgeIOSSHSFTPError.invalidPath
        }
        let suffix = parts.joined(separator: "/")
        return root == "/" ? "/\(suffix)" : "\(root)/\(suffix)"
    }
}
