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

/// Uploads Composer attachments to the host of this SSH connection, independently
/// of any Bridge Session binding. Each upload is streamed and exclusively created.
final class BridgeIOSSHComposerSFTP {
    private let client: SFTPClient
    private let chunkSize = 64 * 1024

    init(client: SFTPClient) { self.client = client }

    func upload(fileURL: URL, name: String, contentType: String) async throws -> BridgeIOSSHComposerRemoteAttachment {
        let home = try await client.realpath(".").get()
        guard home.hasPrefix("/"), !home.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !home.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            throw BridgeIOSSHSFTPError.invalidPath
        }
        let base = home.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parent = "/" + (base.isEmpty ? "" : base + "/") + ".feishu-codex-bridge"
        let directory = parent + "/ssh-attachments"
        try await ensureDirectory(parent, privateOnly: false)
        try await ensureDirectory(directory, privateOnly: true)

        let ext = (name as NSString).pathExtension
        let safeExtension = !ext.isEmpty && ext.count <= 12 && ext.unicodeScalars.allSatisfy {
            (48...57).contains($0.value) || (65...90).contains($0.value) || (97...122).contains($0.value)
        } ? "." + ext : ""
        let remotePath = directory + "/" + UUID().uuidString + safeExtension
        let input = try FileHandle(forReadingFrom: fileURL)
        defer { try? input.close() }
        let remote = try await client.openFile(path: remotePath, flags: [.write, .create, .exclusive],
                                               attributes: SFTPAttributes(permissions: 0o600)).get()
        do {
            var offset: UInt64 = 0
            while let chunk = try input.read(upToCount: chunkSize), !chunk.isEmpty {
                var buffer = client.channel.allocator.buffer(capacity: chunk.count)
                buffer.writeBytes(chunk)
                try await client.write(file: remote, offset: offset, data: buffer).get()
                offset += UInt64(chunk.count)
            }
            try await client.closeFile(remote).get()
            return BridgeIOSSHComposerRemoteAttachment(name: name, contentType: contentType, path: remotePath)
        } catch {
            try? await client.closeFile(remote).get()
            try? await client.remove(path: remotePath).get()
            throw error
        }
    }

    func remove(_ attachments: [BridgeIOSSHComposerRemoteAttachment]) async {
        for attachment in attachments { try? await client.remove(path: attachment.path).get() }
    }

    private func ensureDirectory(_ path: String, privateOnly: Bool) async throws {
        let attributes: SFTPAttributes
        do {
            attributes = try await client.lstat(path: path).get()
        } catch SFTPError.status(let status) where status.code == .noSuchFile {
            do {
                try await client.mkdir(path: path, attributes: SFTPAttributes(permissions: 0o700)).get()
            } catch {
                // A concurrent transfer may have created it; verify below.
                guard (try? await client.lstat(path: path).get()) != nil else { throw error }
            }
            attributes = try await client.lstat(path: path).get()
        }
        guard let mode = attributes.permissions, mode & 0o170000 == 0o040000,
              mode & (privateOnly ? 0o077 : 0o022) == 0 else {
            throw BridgeIOSSHSFTPError.unsupportedFile
        }
        guard try await client.realpath(path).get() == path else { throw BridgeIOSSHSFTPError.symbolicLink }
    }
}
