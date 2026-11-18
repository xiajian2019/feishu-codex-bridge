import CryptoKit
import Foundation
import NIOCore
import NIOPosix
import NIOSSH
import NIOSFTP
import OSLog
import SwiftTerm
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private let bridgeIOSSHOSLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.feishu.codex.bridge",
    category: "SSH"
)

private final class BridgeIOSSHDiagnosticStore {
    static let shared = BridgeIOSSHDiagnosticStore()

    private let lock = NSLock()
    private var entries: [String] = []
    private var totalBytes = 0
    private let maxEntries = 400
    private let maxBytes = 128 * 1024

    func append(level: String, message: String) {
        let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
        let line = "\(timestamp) [\(level)] \(message)"
        lock.lock()
        entries.append(line)
        totalBytes += line.utf8.count
        while entries.count > maxEntries || totalBytes > maxBytes {
            guard !entries.isEmpty else { break }
            totalBytes -= entries.removeFirst().utf8.count
        }
        lock.unlock()
    }

    func snapshot() -> String {
        lock.lock()
        let lines = entries
        lock.unlock()
        let body = lines.isEmpty ? "（暂无 SSH 调试日志）" : lines.joined(separator: "\n")
        return "Bridge iOS SSH diagnostics\n\(body)"
    }
}

private enum BridgeIOSSHLog {
    private static func record(level: String, message: String) {
        BridgeIOSSHDiagnosticStore.shared.append(level: level, message: message)
    }

    static func debug(_ message: String) {
        record(level: "DEBUG", message: message)
        bridgeIOSSHOSLogger.debug("\(message, privacy: .public)")
    }

    static func info(_ message: String) {
        record(level: "INFO", message: message)
        bridgeIOSSHOSLogger.info("\(message, privacy: .public)")
    }

    static func error(_ message: String) {
        record(level: "ERROR", message: message)
        bridgeIOSSHOSLogger.error("\(message, privacy: .public)")
    }

    static func snapshot() -> String {
        BridgeIOSSHDiagnosticStore.shared.snapshot()
    }
}

private func bridgeIOSSHLogHash(_ value: String) -> String {
    let digest = SHA256.hash(data: Data(value.utf8))
    return String(Data(digest).base64EncodedString().prefix(12))
}

private func bridgeIOSSHErrorDetails(_ error: Error) -> String {
    let nsError = error as NSError
    let description = String(describing: error)
    let shortened = description.count > 240 ? String(description.prefix(240)) + "…" : description
    return "type=\(String(reflecting: type(of: error))) domain=\(nsError.domain) code=\(nsError.code) message=\(shortened)"
}

enum BridgeIOSSHWorkspaceLaunch {
    enum Presentation: Equatable {
        case full
        case sheet
    }

    case manager(defaultHost: String, bridgeServerOrigin: String?, presentation: Presentation, mode: Bool, sessionSelection: BridgeIOSSHSessionSelection?)
    case terminal(host: String, port: Int, username: String, password: String, startupCommand: String, bridgeServerOrigin: String?, keyId: String?)

    var presentation: Presentation {
        switch self {
        case .manager(_, _, let presentation, _, _): return presentation
        case .terminal: return .full
        }
    }

    var sessionSelection: BridgeIOSSHSessionSelection? {
        switch self {
        case .manager(_, _, _, _, let selection): return selection
        case .terminal: return nil
        }
    }

    var bridgeServerOrigin: String? {
        switch self {
        case .manager(_, let origin, _, _, _): return origin
        case .terminal(_, _, _, _, _, let origin, _): return origin
        }
    }
}

struct BridgeIOSSHSessionSelection: Equatable {
    let bridgeOrigin: String
    let sessionId: String
    let createdAt: Int
    let expectedSshHost: String?
    let expectedSshPort: Int?
}

struct BridgeIOSSHSessionContext: Equatable {
    let bridgeOrigin: String
    let sshHost: String
    let sshPort: Int
    let sshUsername: String
    let sessionId: String
    let createdAt: Int

    var key: String {
        [bridgeOrigin, sshHost, String(sshPort), sshUsername, sessionId, String(createdAt)].joined(separator: "\u{0}")
    }
}

struct BridgeIOSSHProfile: Codable, Identifiable {
    let id: String
    var label: String
    var host: String
    var port: Int
    var username: String
    var keyId: String
    var startupCommand: String
}

final class BridgeIOSSHProfileStore {
    static let shared = BridgeIOSSHProfileStore()

    private let defaultsKey = "bridge.ios.ssh.profiles"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func list() -> [BridgeIOSSHProfile] {
        guard let data = defaults.data(forKey: defaultsKey),
              let values = try? JSONDecoder().decode([BridgeIOSSHProfile].self, from: data) else {
            return []
        }
        return values
    }

    func save(host: String, port: Int, username: String, startupCommand: String, keyId: String) {
        var profiles = list()
        let normalized = "\(username)@\(host):\(port)"
        if let index = profiles.firstIndex(where: { $0.host == host && $0.port == port && $0.username == username }) {
            profiles[index].label = normalized
            profiles[index].startupCommand = startupCommand
            profiles[index].keyId = keyId
        } else {
            profiles.insert(BridgeIOSSHProfile(id: UUID().uuidString, label: normalized, host: host,
                                               port: port, username: username, keyId: keyId,
                                               startupCommand: startupCommand), at: 0)
        }
        persist(profiles)
    }

    func clearKeyReference(_ keyId: String) {
        guard !keyId.isEmpty else { return }
        var profiles = list()
        var changed = false
        for index in profiles.indices where profiles[index].keyId == keyId {
            profiles[index].keyId = ""
            changed = true
        }
        if changed { persist(profiles) }
    }

    private func persist(_ profiles: [BridgeIOSSHProfile]) {
        guard let data = try? JSONEncoder().encode(Array(profiles.prefix(32))) else { return }
        defaults.set(data, forKey: defaultsKey)
    }
}

private final class BridgeIOSSHHostKeyStore {
    static let shared = BridgeIOSSHHostKeyStore()

    private let defaultsKey = "bridge.ios.ssh.host-keys.v1"
    private let defaults: UserDefaults
    private let lock = NSLock()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func trustedKey(host: String, port: Int) -> String? {
        withLock {
            guard let data = defaults.data(forKey: defaultsKey),
                  let values = try? JSONDecoder().decode([String: String].self, from: data) else {
                return nil
            }
            return values[storageKey(host: host, port: port)]
        }
    }

    func trust(key: String, host: String, port: Int) {
        withLock {
            var values: [String: String] = [:]
            if let data = defaults.data(forKey: defaultsKey),
               let stored = try? JSONDecoder().decode([String: String].self, from: data) {
                values = stored
            }
            values[storageKey(host: host, port: port)] = key
            guard let data = try? JSONEncoder().encode(values) else { return }
            defaults.set(data, forKey: defaultsKey)
        }
    }

    private func storageKey(host: String, port: Int) -> String {
        "\(host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())\u{0}\(port)"
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

@MainActor
final class BridgeIOSSHWorkspaceViewController: UIViewController, UIAdaptivePresentationControllerDelegate {
    private let launch: BridgeIOSSHWorkspaceLaunch
    private let onClosed: (Bool) -> Void
    private var hostingController: UIHostingController<BridgeIOSSHWorkspaceView>?
    private var closeNotified = false
    private var requestedReturnToWorkbench = false

    init(launch: BridgeIOSSHWorkspaceLaunch, onClosed: @escaping (Bool) -> Void) {
        self.launch = launch
        self.onClosed = onClosed
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let root = BridgeIOSSHWorkspaceView(launch: launch) { [weak self] returnToWorkbench in
            self?.requestClose(returnToWorkbench: returnToWorkbench)
        }
        let hosting = UIHostingController(rootView: root)
        hosting.view.backgroundColor = .clear
        addChild(hosting)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        hosting.didMove(toParent: self)
        hostingController = hosting
    }

    func setWorkspaceVisible(_ visible: Bool) -> Bool {
        guard isViewLoaded else { return false }
        view.isHidden = !visible
        return true
    }

    func canReuse(for nextLaunch: BridgeIOSSHWorkspaceLaunch) -> Bool {
        switch (launch, nextLaunch) {
        case (.manager(_, _, _, _, let current), .manager(_, _, _, _, let next)):
            return current == next
        case (.terminal(let currentHost, let currentPort, let currentUsername, let currentPassword,
                        let currentStartupCommand, let currentOrigin, let currentKeyId),
              .terminal(let nextHost, let nextPort, let nextUsername, let nextPassword,
                        let nextStartupCommand, let nextOrigin, let nextKeyId)):
            return currentHost == nextHost && currentPort == nextPort && currentUsername == nextUsername
                && currentPassword == nextPassword && currentStartupCommand == nextStartupCommand
                && currentOrigin == nextOrigin && currentKeyId == nextKeyId
        default:
            return false
        }
    }

    func requestClose(returnToWorkbench: Bool) {
        requestedReturnToWorkbench = returnToWorkbench
        dismiss(animated: true) { [weak self] in
            self?.notifyClosedIfNeeded()
        }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        notifyClosedIfNeeded()
    }

    private func notifyClosedIfNeeded() {
        guard !closeNotified else { return }
        closeNotified = true
        onClosed(requestedReturnToWorkbench)
    }
}

enum BridgeIOSSHState: Equatable {
    case setup
    case connecting
    case connected
    case failed(String)
}

enum BridgeIOSSHComposerState: Equatable {
    case idle
    case sending
    case sent
    case unknown(String)
    case failed(String)
}

private enum BridgeIOSSHComposerError: LocalizedError {
    case sftpUnavailable
    case disconnected
    case pasteModeChanged

    var errorDescription: String? {
        switch self {
        case .sftpUnavailable: return "SFTP 尚未准备好，无法上传附件。"
        case .disconnected: return "SSH 连接已变化，内容未写入。"
        case .pasteModeChanged: return "当前终端已关闭粘贴保护，无法安全发送多行内容。"
        }
    }
}

enum BridgeIOSSHFilesState: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

struct BridgeIOSSHLocalComposerAttachment: Identifiable, Equatable {
    let id: String
    let name: String
    let fileURL: URL
    let contentType: String
}

enum BridgeIOSSHAuthentication {
    case password(String)
    case privateKey(BridgeIOSSHParsedPrivateKey)
}

enum BridgeIOSSHSessionPickerState: Equatable {
    case idle
    case loading
    case loaded
    case unavailable(String)
}

private struct BridgeIOSSHVisiblePublicKey: Identifiable {
    let id: String
    let label: String
    let value: String
}

@MainActor
private final class BridgeIOSSHWorkspaceModel: ObservableObject {
    @Published var host: String
    @Published var port: String
    @Published var username: String
    @Published var password: String
    @Published var startupCommand: String
    @Published var profiles: [BridgeIOSSHProfile]
    @Published private(set) var selectedProfileId: String?
    @Published private(set) var profileSelectionMessage: String?
    @Published var keys: [BridgeIOSSHKeyMetadata]
    @Published var selectedKeyId: String
    @Published var visiblePublicKey: BridgeIOSSHVisiblePublicKey?
    @Published var state: BridgeIOSSHState = .setup
    @Published var pendingHostKey: String?
    @Published var pendingHostKeyChanged = false
    @Published var session: BridgeIOSSHSession?
    @Published var composerText = ""
    @Published private(set) var composerState: BridgeIOSSHComposerState = .idle
    @Published private(set) var fileEntries: [BridgeIOSSHSFTPEntry] = []
    @Published private(set) var filesState: BridgeIOSSHFilesState = .idle
    @Published private(set) var composerAttachments: [BridgeIOSSHLocalComposerAttachment] = []
    @Published var remoteSessions: [BridgeIOSSHRemoteSession] = []
    @Published private(set) var sessionPickerState: BridgeIOSSHSessionPickerState = .idle
    @Published private(set) var selectedRemoteSession: BridgeIOSSHRemoteSession? = nil
    @Published private(set) var selectedSessionSelection: BridgeIOSSHSessionSelection?
    @Published private(set) var boundContext: BridgeIOSSHSessionContext?
    @Published private(set) var apiBindingState: BridgeIOSSHApiBindingState = .none

    let initialConnection: Bool
    let onClose: (Bool) -> Void
    let bridgeServerOrigin: String?
    private var sessionSelection: BridgeIOSSHSessionSelection?
    private var hasStarted = false
    private var hostKeyDecision: ((Bool) -> Void)?
    private var sessionListTask: Task<Void, Never>?
    private var apiVerificationGeneration = 0
    private let keychainStore = BridgeIOSSHKeychainStore()
    private var sftpClient: BridgeIOSSHSFTPClient?

    init(launch: BridgeIOSSHWorkspaceLaunch, onClose: @escaping (Bool) -> Void) {
        self.onClose = onClose
        let savedProfiles = BridgeIOSSHProfileStore.shared.list()
        let availableKeys = (try? keychainStore.listMetadata()) ?? []
        profiles = savedProfiles
        selectedProfileId = nil
        profileSelectionMessage = nil
        keys = availableKeys
        switch launch {
        case .terminal(let host, let port, let username, let password, let startupCommand, _, let keyId):
            self.host = host
            self.port = String(port)
            self.username = username
            self.password = password
            self.startupCommand = startupCommand
            selectedKeyId = keyId ?? ""
            bridgeServerOrigin = nil
            sessionSelection = nil
            selectedSessionSelection = nil
            initialConnection = true
        case .manager(let defaultHost, _, _, let manageMode, let selection):
            let recent = savedProfiles.first
            selectedProfileId = recent?.id
            self.host = recent?.host ?? defaultHost
            self.port = String(recent?.port ?? 22)
            self.username = recent?.username ?? ""
            self.password = ""
            self.startupCommand = recent?.startupCommand ?? ""
            let recentKeyId = recent.flatMap { profile in availableKeys.contains(where: { $0.id == profile.keyId }) ? profile.keyId : nil } ?? ""
            selectedKeyId = recentKeyId
            bridgeServerOrigin = launch.bridgeServerOrigin
            sessionSelection = selection
            selectedSessionSelection = selection
            // The normal workspace entry is the quick path: use the most recent
            // saved key-backed profile immediately. Management mode keeps the
            // setup screen available for editing or adding a host.
            initialConnection = !manageMode && recent != nil && !recentKeyId.isEmpty
        }
    }

    func startIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true
        if sessionSelection != nil { refreshRemoteSessions() }
        if initialConnection { connect() }
    }

    func select(_ profile: BridgeIOSSHProfile) {
        selectedProfileId = profile.id
        profileSelectionMessage = "已载入主机配置：\(profile.label)"
        host = profile.host
        port = String(profile.port)
        username = profile.username
        startupCommand = profile.startupCommand
        password = ""
        selectedKeyId = keys.contains(where: { $0.id == profile.keyId }) ? profile.keyId : ""
        state = .setup
        clearSessionSelection()
    }

    func connect(profile: BridgeIOSSHProfile) {
        select(profile)
        connect()
    }

    func prepareNewProfile() {
        selectedProfileId = nil
        profileSelectionMessage = nil
        host = ""
        port = "22"
        username = ""
        password = ""
        startupCommand = ""
        selectedKeyId = keys.first?.id ?? ""
        state = .setup
        clearSessionSelection()
    }

    func importKey(from url: URL) {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            let metadata = try keychainStore.importKey(material: data, label: url.deletingPathExtension().lastPathComponent)
            keys = (try? keychainStore.listMetadata()) ?? [metadata]
            selectedKeyId = metadata.id
            password = ""
            state = .setup
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func generateKey() {
        do {
            let id = UUID().uuidString
            let material = BridgeIOSSHPrivateKeyGenerator.generateEd25519PKCS8()
            let metadata = try keychainStore.importKey(
                material: material, label: "iPhone Ed25519 \(id.prefix(8))", id: id
            )
            keys = try keychainStore.listMetadata()
            selectedKeyId = metadata.id
            password = ""
            state = .setup
            showPublicKey(metadata)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func showPublicKey(_ metadata: BridgeIOSSHKeyMetadata) {
        do {
            let parsed = try keychainStore.parsedKey(for: metadata.id)
            visiblePublicKey = BridgeIOSSHVisiblePublicKey(id: metadata.id, label: metadata.label,
                                                          value: parsed.publicKeyOpenSSH)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func deleteKey(_ metadata: BridgeIOSSHKeyMetadata) {
        do {
            try keychainStore.delete(id: metadata.id)
            keys = (try? keychainStore.listMetadata()) ?? []
            if selectedKeyId == metadata.id { selectedKeyId = "" }
            BridgeIOSSHProfileStore.shared.clearKeyReference(metadata.id)
            profiles = BridgeIOSSHProfileStore.shared.list()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func refreshRemoteSessions() {
        guard let bridgeServerOrigin else {
            sessionPickerState = .idle
            return
        }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty, let parsedPort = Int(port), (1...65_535).contains(parsedPort) else {
            sessionPickerState = .unavailable("请先填写有效的 SSH 主机和端口，再读取 Bridge Session。")
            return
        }
        let normalizedHost = trimmedHost.lowercased()
        if let selection = sessionSelection,
           selection.bridgeOrigin != bridgeServerOrigin
            || (selection.expectedSshHost != nil && selection.expectedSshHost != normalizedHost)
            || (selection.expectedSshPort != nil && selection.expectedSshPort != parsedPort) {
            selectedRemoteSession = nil
            sessionPickerState = .unavailable("当前 SSH 目标与已选 Session 不一致，请刷新后重新选择。")
            return
        }
        let username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestKey = [bridgeServerOrigin, normalizedHost, String(parsedPort), username].joined(separator: "\u{0}")
        sessionListTask?.cancel()
        sessionPickerState = .loading
        sessionListTask = Task { @MainActor [weak self] in
            do {
                let sessions = try await BridgeIOSSHSessionAPI.listSessions(
                    bridgeOrigin: bridgeServerOrigin,
                    sshHost: normalizedHost,
                    sshPort: parsedPort,
                    sshUsername: username.isEmpty ? nil : username
                )
                guard let self, !Task.isCancelled else { return }
                let currentHost = self.host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let currentUser = self.username.trimmingCharacters(in: .whitespacesAndNewlines)
                guard [self.bridgeServerOrigin ?? "", currentHost, String(Int(self.port) ?? 0), currentUser].joined(separator: "\u{0}") == requestKey else { return }
                self.remoteSessions = sessions
                self.selectedRemoteSession = self.sessionSelection.flatMap { selection in
                    sessions.first { $0.id == selection.sessionId && $0.createdAt == selection.createdAt }
                }
                if self.sessionSelection != nil && self.selectedRemoteSession == nil {
                    self.sessionPickerState = .unavailable("已选 Session 已结束、重建或不属于当前 Bridge，请重新选择。")
                } else {
                    self.sessionPickerState = .loaded
                }
            } catch is CancellationError {
                return
            } catch let error as BridgeIOSSHSessionAPIError {
                guard let self, !Task.isCancelled else { return }
                self.sessionPickerState = .unavailable(error.localizedDescription)
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.sessionPickerState = .unavailable("无法读取 Bridge Session 列表，请重试。")
            }
        }
    }

    func selectRemoteSession(_ remoteSession: BridgeIOSSHRemoteSession) {
        guard let bridgeServerOrigin else {
            sessionPickerState = .unavailable("当前没有绑定 Bridge 环境，不能选择 Session。")
            return
        }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsedPort = Int(port), !trimmedHost.isEmpty, (1...65_535).contains(parsedPort) else {
            sessionPickerState = .unavailable("请先填写有效的 SSH 主机和端口，再选择 Session。")
            return
        }
        do {
            let selection = try BridgeIOSSHSessionAPI.makeSelection(
                for: remoteSession,
                bridgeOrigin: bridgeServerOrigin,
                sshHost: trimmedHost,
                sshPort: parsedPort
            )
            sessionSelection = selection
            selectedSessionSelection = selection
            selectedRemoteSession = remoteSession
            apiBindingState = .checking
            state = .setup
        } catch let error as BridgeIOSSHSessionAPIError {
            sessionPickerState = .unavailable(error.localizedDescription)
        } catch {
            sessionPickerState = .unavailable("无法绑定所选 Bridge Session，请刷新后重试。")
        }
    }

    func clearSessionSelection() {
        sessionListTask?.cancel()
        sessionListTask = nil
        remoteSessions = []
        sessionSelection = nil
        selectedSessionSelection = nil
        selectedRemoteSession = nil
        apiBindingState = .none
        sessionPickerState = .idle
    }

    func connect() {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedUser = username.trimmingCharacters(in: .whitespacesAndNewlines)
        BridgeIOSSHLog.info(
            "workspace connect requested hostHash=\(bridgeIOSSHLogHash(trimmedHost)) port=\(port) userHash=\(bridgeIOSSHLogHash(trimmedUser)) hasSessionSelection=\(sessionSelection != nil) hasKey=\(!selectedKeyId.isEmpty)"
        )
        guard !trimmedHost.isEmpty, !trimmedUser.isEmpty, let parsedPort = Int(port), (1...65_535).contains(parsedPort) else {
            BridgeIOSSHLog.error("workspace connect rejected: invalid host, port, or username")
            state = .failed("请输入有效的主机、端口和用户名。")
            return
        }
        host = trimmedHost
        username = trimmedUser
        let authentication: BridgeIOSSHAuthentication
        if !selectedKeyId.isEmpty {
            do {
                authentication = .privateKey(try keychainStore.parsedKey(for: selectedKeyId))
            } catch {
                BridgeIOSSHLog.error("workspace private-key load failed: \(bridgeIOSSHErrorDetails(error))")
                state = .failed(error.localizedDescription)
                return
            }
        } else {
            authentication = .password(password)
        }
        BridgeIOSSHLog.debug(
            "workspace authentication prepared method=\(selectedKeyId.isEmpty ? "password" : "private-key")"
        )
        if let selection = sessionSelection {
            BridgeIOSSHLog.debug(
                "workspace session selection validating bridgeOriginHash=\(bridgeIOSSHLogHash(selection.bridgeOrigin)) sessionId=\(selection.sessionId) createdAt=\(selection.createdAt)"
            )
            guard selection.bridgeOrigin == bridgeServerOrigin,
                  selection.sessionId.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
                  selection.createdAt >= 0 else {
                BridgeIOSSHLog.error("workspace session selection rejected: invalid Bridge context")
                state = .failed("Bridge Session 上下文无效，请刷新后重新选择。")
                return
            }
            if selection.expectedSshHost != nil && selection.expectedSshHost != trimmedHost.lowercased()
                || selection.expectedSshPort != nil && selection.expectedSshPort != parsedPort {
                BridgeIOSSHLog.error("workspace session selection rejected: SSH target changed")
                state = .failed("SSH 目标已变化，请重新选择当前 Session。")
                return
            }
            boundContext = BridgeIOSSHSessionContext(
                bridgeOrigin: selection.bridgeOrigin,
                sshHost: trimmedHost.lowercased(),
                sshPort: parsedPort,
                sshUsername: trimmedUser,
                sessionId: selection.sessionId,
                createdAt: selection.createdAt,
            )
            apiBindingState = .checking
        } else {
            boundContext = nil
            apiBindingState = .none
        }
        state = .connecting
        BridgeIOSSHLog.info(
            "workspace starting SSH session hostHash=\(bridgeIOSSHLogHash(trimmedHost)) port=\(parsedPort) apiBinding=\(boundContext != nil)"
        )
        pendingHostKey = nil
        pendingHostKeyChanged = false
        hostKeyDecision = nil
        session?.disconnect()
        let next = BridgeIOSSHSession(host: trimmedHost, port: parsedPort, username: trimmedUser,
                                      authentication: authentication, startupCommand: startupCommand,
                                      onState: { [weak self] nextState in
                                          BridgeIOSSHLog.debug(
                                              "workspace received session state=\(String(describing: nextState))"
                                          )
                                          DispatchQueue.main.async {
                                              guard let self else { return }
                                              switch nextState {
                                              case .connecting: self.state = .connecting
                                              case .connected: self.state = .connected
                                              case .failed:
                                                  BridgeIOSSHLog.error("workspace mapped SSH session failure to generic UI error")
                                                  self.state = .failed("SSH 连接失败，请检查主机、端口、认证信息或网络。")
                                              }
                                          }
                                      }, onHostKey: { [weak self] fingerprint, changed, decision in
                                          BridgeIOSSHLog.info(
                                              "workspace received host-key prompt fingerprint=\(fingerprint) changed=\(changed)"
                                          )
                                          DispatchQueue.main.async {
                                              guard let self else { decision(false); return }
                                              self.pendingHostKey = fingerprint
                                              self.pendingHostKeyChanged = changed
                                              self.hostKeyDecision = decision
                                              BridgeIOSSHLog.debug("workspace displayed host-key confirmation alert")
                                          }
                                      })
        session = next
        next.connect()
        if let context = boundContext {
            apiVerificationGeneration += 1
            let verificationGeneration = apiVerificationGeneration
            BridgeIOSSHLog.debug(
                "workspace API identity verification started bridgeOriginHash=\(bridgeIOSSHLogHash(context.bridgeOrigin)) sessionId=\(context.sessionId) generation=\(verificationGeneration)"
            )
            Task { @MainActor [weak self] in
                do {
                    _ = try await BridgeIOSSHSessionAPI.verifyIdentity(context)
                    guard let self, self.apiVerificationGeneration == verificationGeneration,
                          self.boundContext == context else { return }
                    BridgeIOSSHLog.info("workspace API identity verification succeeded generation=\(verificationGeneration)")
                    self.apiBindingState = .verified
                } catch let error as BridgeIOSSHSessionAPIError {
                    guard let self else { return }
                    guard self.apiVerificationGeneration == verificationGeneration,
                          self.boundContext == context else { return }
                    BridgeIOSSHLog.error(
                        "workspace API identity verification failed generation=\(verificationGeneration) error=\(error.localizedDescription)"
                    )
                    switch error {
                    case .identityMismatch:
                        self.apiBindingState = .mismatch(error.localizedDescription)
                        self.session?.disconnect()
                        self.state = .failed(error.localizedDescription)
                    case .unavailable(_), .resultUnknown(_), .unauthorized, .invalidContext, .invalidResponse, .invalidSelection(_):
                        self.apiBindingState = .unavailable(error.localizedDescription)
                    }
                } catch {
                    guard let self, self.apiVerificationGeneration == verificationGeneration,
                          self.boundContext == context else { return }
                    BridgeIOSSHLog.error(
                        "workspace API identity verification failed with unexpected error generation=\(verificationGeneration) error=\(bridgeIOSSHErrorDetails(error))"
                    )
                    self.apiBindingState = .unavailable("Bridge Session API 暂时不可用；SSH 仍可独立使用。")
                }
            }
        }
    }

    func decideHostKey(_ accepted: Bool) {
        guard let decision = hostKeyDecision else {
            BridgeIOSSHLog.debug(
                "workspace host-key decision ignored accepted=\(accepted) reason=no-pending-decision"
            )
            return
        }
        BridgeIOSSHLog.info(
            "workspace host-key decision accepted=\(accepted) hasPendingDecision=true fingerprint=\(pendingHostKey ?? "none")"
        )
        hostKeyDecision = nil
        pendingHostKey = nil
        pendingHostKeyChanged = false
        decision(accepted)
        if !accepted {
            session?.disconnect()
            state = .failed("已拒绝此 SSH 主机密钥。")
        }
    }

    func sendComposer() {
        guard composerState != .sending else { return }
        guard let session, state == .connected else {
            composerState = .failed("SSH 尚未连接。")
            return
        }
        let text = composerText
        let attachments = composerAttachments
        let preview = BridgeIOSSHComposerEncoding.prompt(text: text, attachments: [])
        guard !preview.isEmpty || !attachments.isEmpty else {
            composerState = .failed("请输入内容或添加附件。")
            return
        }
        guard text.count <= 8_000 else {
            composerState = .failed("消息不能超过 8,000 个字符。")
            return
        }
        if !session.bracketedPasteEnabled && (preview.contains("\n") || !attachments.isEmpty) {
            composerState = .failed("当前终端未启用粘贴保护，无法安全发送多行内容或附件；草稿已保留。")
            return
        }
        composerState = .sending
        Task { @MainActor [weak self] in
            guard let self else { return }
            var client: SFTPClient?
            var transfer: BridgeIOSSHComposerSFTP?
            var uploaded: [BridgeIOSSHComposerRemoteAttachment] = []
            var writeAttempted = false
            defer { client?.channel.close(promise: nil) }
            do {
                if !attachments.isEmpty {
                    guard let future = session.openSFTPClient() else { throw BridgeIOSSHComposerError.sftpUnavailable }
                    let opened = try await future.get()
                    client = opened
                    let uploader = BridgeIOSSHComposerSFTP(client: opened)
                    transfer = uploader
                    for attachment in attachments {
                        guard self.session === session, self.state == .connected else { throw BridgeIOSSHComposerError.disconnected }
                        let remote = try await uploader.upload(fileURL: attachment.fileURL, name: attachment.name,
                                                               contentType: attachment.contentType)
                        uploaded.append(remote)
                    }
                }
                guard self.session === session, self.state == .connected else { throw BridgeIOSSHComposerError.disconnected }
                let prompt = BridgeIOSSHComposerEncoding.prompt(text: text, attachments: uploaded)
                let bracketed = session.bracketedPasteEnabled
                guard bracketed || !prompt.contains("\n") else { throw BridgeIOSSHComposerError.pasteModeChanged }
                let payload = BridgeIOSSHComposerEncoding.paste(prompt, bracketed: bracketed)
                writeAttempted = true
                let result: BridgeIOSSHInputResult = await withCheckedContinuation { continuation in
                    session.sendComposer(payload) { continuation.resume(returning: $0) }
                }
                if result == .notSent {
                    writeAttempted = false
                    await transfer?.remove(uploaded)
                }
                guard self.session === session else { return }
                switch result {
                case .written:
                    self.composerText = ""
                    self.clearComposerAttachments()
                    self.composerState = .sent
                case .notSent:
                    self.composerState = .failed("SSH 连接已断开，内容未写入；草稿已保留。")
                case .unknown:
                    self.composerState = .unknown("SSH 写入结果未知，请先检查当前终端；草稿已保留。")
                }
            } catch {
                if !writeAttempted { await transfer?.remove(uploaded) }
                guard self.session === session else { return }
                self.composerState = .failed("\(error.localizedDescription) 草稿已保留。")
            }
        }
    }

    func sendTerminalKey(_ bytes: [UInt8]) {
        guard state == .connected, let session else { return }
        session.send(BridgeIOSSHComposerEncoding.terminalKey(bytes, applicationCursor: session.applicationCursorEnabled))
    }

    func composerEdited() {
        switch composerState {
        case .sending: break
        case .sent where composerText.isEmpty: break
        default: composerState = .idle
        }
    }

    func importComposerAttachments(from urls: [URL]) {
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bridge-ios-composer", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var imported = composerAttachments
            for url in urls {
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let id = UUID().uuidString
                let destination = directory.appendingPathComponent(id, isDirectory: false)
                try FileManager.default.copyItem(at: url, to: destination)
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                imported.append(BridgeIOSSHLocalComposerAttachment(id: id, name: url.lastPathComponent, fileURL: destination, contentType: type))
            }
            composerAttachments = imported
            composerState = .idle
        } catch {
            composerState = .failed("附件无法加入草稿：\(error.localizedDescription)")
        }
    }

    func removeComposerAttachment(_ attachment: BridgeIOSSHLocalComposerAttachment) {
        composerAttachments.removeAll { $0.id == attachment.id }
        composerState = .idle
        try? FileManager.default.removeItem(at: attachment.fileURL)
    }

    private func clearComposerAttachments() {
        composerAttachments.forEach { try? FileManager.default.removeItem(at: $0.fileURL) }
        composerAttachments = []
    }

    func loadSessionFiles() {
        guard let session, let root = selectedRemoteSession?.cwd, !root.isEmpty else {
            filesState = .failed("需要先绑定一个 Bridge Session，才能读取它的工作目录。")
            return
        }
        guard sftpClient == nil else {
            listFilesWithCurrentClient()
            return
        }
        guard let future = session.openSFTPClient() else {
            filesState = .failed("SFTP 尚未准备好，请稍后重试。")
            return
        }
        filesState = .loading
        future.flatMap { rawClient in
            do {
                let client = try BridgeIOSSHSFTPClient(client: rawClient, canonicalRoot: root)
                return try client.list(relativePath: "").map { (client, $0) }
            } catch {
                return rawClient.channel.eventLoop.makeFailedFuture((error as Error))
            }
        }
            .whenComplete { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .success(let (client, entries)):
                        self.sftpClient = client
                        self.fileEntries = entries.filter { $0.name != "." && $0.name != ".." }
                        self.filesState = .loaded
                    case .failure(let error): self.filesState = .failed(error.localizedDescription)
                    }
                }
            }
    }

    private func listFilesWithCurrentClient() {
        guard let sftpClient else { return }
        filesState = .loading
        do {
            try sftpClient.list(relativePath: "").whenComplete { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .success(let entries): self.fileEntries = entries.filter { $0.name != "." && $0.name != ".." }; self.filesState = .loaded
                    case .failure(let error): self.filesState = .failed(error.localizedDescription)
                    }
                }
            }
        } catch { filesState = .failed(error.localizedDescription) }
    }

    func saveProfile() {
        guard let parsedPort = Int(port), (1...65_535).contains(parsedPort), !host.isEmpty, !username.isEmpty else {
            state = .failed("请先填写有效的主机、端口和用户名。")
            return
        }
        BridgeIOSSHProfileStore.shared.save(host: host, port: parsedPort, username: username,
                                            startupCommand: startupCommand, keyId: selectedKeyId)
        profiles = BridgeIOSSHProfileStore.shared.list()
        selectedProfileId = profiles.first(where: { $0.host == host && $0.port == parsedPort && $0.username == username })?.id
        profileSelectionMessage = "主机配置已保存"
    }

    func disconnect() {
        BridgeIOSSHLog.info(
            "workspace disconnect requested hasSession=\(session != nil) hasBoundContext=\(boundContext != nil)"
        )
        apiVerificationGeneration += 1
        hostKeyDecision?(false)
        hostKeyDecision = nil
        pendingHostKey = nil
        pendingHostKeyChanged = false
        session?.disconnect()
        session = nil
        sftpClient = nil
        clearComposerAttachments()
        boundContext = nil
        apiBindingState = .none
        composerState = .idle
        state = .setup
        password = ""
    }
}

private struct BridgeIOSSHWorkspaceView: View {
    @StateObject private var model: BridgeIOSSHWorkspaceModel
    private let launch: BridgeIOSSHWorkspaceLaunch
    @State private var isImportingKey = false
    @State private var isShowingRemoteSessions: Bool
    @State private var isShowingConfiguration: Bool
    @State private var isShowingSecurityDetails = false
    @State private var isPublicKeyCopied = false
    @State private var isImportingComposerAttachment = false
    @State private var isShowingFiles = false
    @State private var isDiagnosticsCopied = false
    @State private var composerHeight: CGFloat = 52
    @State private var isShowingTerminalKeys = false
    @Environment(\.colorScheme) private var colorScheme

    init(launch: BridgeIOSSHWorkspaceLaunch, onClose: @escaping (Bool) -> Void) {
        self.launch = launch
        _isShowingRemoteSessions = State(initialValue: launch.sessionSelection != nil)
        _isShowingConfiguration = State(initialValue: BridgeIOSSHProfileStore.shared.list().isEmpty)
        _model = StateObject(wrappedValue: BridgeIOSSHWorkspaceModel(launch: launch, onClose: onClose))
    }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            if model.session != nil {
                terminalView
            } else {
                setupView
            }
        }
        .preferredColorScheme(BridgeNativeThemePlugin.preferredColorScheme)
        .onAppear { model.startIfNeeded() }
        .alert(model.pendingHostKeyChanged ? "SSH 主机密钥已变化" : "确认 SSH 主机", isPresented: Binding(
            get: { model.pendingHostKey != nil },
            set: { if !$0 && model.pendingHostKey != nil { model.decideHostKey(false) } }
        )) {
            Button(model.pendingHostKeyChanged ? "重新信任并继续" : "信任并继续") { model.decideHostKey(true) }
            Button("拒绝", role: .cancel) { model.decideHostKey(false) }
        } message: {
            Text(model.pendingHostKeyChanged
                 ? "已保存的 SSH 主机密钥与本次连接不一致。主机重装、IP 复用或中间人攻击都可能导致变化；只有确认目标主机可信时才重新信任。\n\n\(model.pendingHostKey ?? "未知")"
                 : "首次连接会记录 SSH 主机密钥，之后相同主机将自动信任，不再重复询问。\n\n\(model.pendingHostKey ?? "未知")")
        }
        .fileImporter(
            isPresented: $isImportingKey,
            allowedContentTypes: [.data, .plainText],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else {
                if case .failure(let error) = result { model.state = .failed(error.localizedDescription) }
                return
            }
            model.importKey(from: url)
        }
        .fileImporter(
            isPresented: $isImportingComposerAttachment,
            allowedContentTypes: [.data, .image],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            model.importComposerAttachments(from: urls)
        }
        .sheet(isPresented: $isShowingFiles) {
            BridgeIOSSHFilesView(model: model)
        }
        .sheet(item: $model.visiblePublicKey) { key in
            NavigationView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(key.label).font(.headline)
                    Text("将此公钥追加到 SSH 主机的 ~/.ssh/authorized_keys，然后使用此密钥连接。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    ScrollView {
                        Text(key.value)
                            .font(.system(size: 12, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 160)
                    Button {
                        UIPasteboard.general.string = key.value
                        isPublicKeyCopied = true
                    } label: {
                        Label(isPublicKeyCopied ? "已复制公钥" : "复制公钥", systemImage: "doc.on.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    Spacer()
                }
                .padding(20)
                .navigationTitle("SSH 公钥")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完成") { model.visiblePublicKey = nil }
                    }
                }
            }
        }
    }

    private var terminalView: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let session = model.session {
                BridgeIOSSHTerminalRepresentable(session: session)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { terminalHeader }
        .safeAreaInset(edge: .bottom, spacing: 0) { terminalBottomBar }
    }

    private var terminalHeader: some View {
        HStack(spacing: 10) {
            Button {
                model.disconnect()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 34, height: 34)
            }
            Text("\(model.username)@\(model.host)")
                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if model.boundContext != nil {
                Text(apiBindingLabel)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(apiBindingColor)
            }
            if model.selectedRemoteSession != nil {
                Button("文件") {
                    model.loadSessionFiles()
                    isShowingFiles = true
                }
                .font(.system(size: 12, weight: .semibold))
            }
            Text(stateLabel)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(stateColor)
            Button("关闭") { model.onClose(false) }
                .font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 7)
        .frame(maxWidth: .infinity)
        .background(.black.opacity(0.92))
    }

    private var terminalBottomBar: some View {
        VStack(spacing: 0) {
            if case .failed(let message) = model.state {
                HStack(spacing: 8) {
                    Text(message).font(.system(size: 12)).lineLimit(2)
                    Spacer()
                    Button(isDiagnosticsCopied ? "已复制" : "复制日志") {
                        UIPasteboard.general.string = BridgeIOSSHLog.snapshot()
                        isDiagnosticsCopied = true
                    }
                    .font(.system(size: 12, weight: .semibold))
                    Button("重连") {
                        isDiagnosticsCopied = false
                        model.connect()
                    }
                    .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(.red.opacity(0.72))
            }
            composerView
        }
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }

    private var composerView: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.composerAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.composerAttachments) { attachment in
                            HStack(spacing: 5) {
                                Image(systemName: attachment.contentType.hasPrefix("image/") ? "photo" : "doc")
                                Text(attachment.name).lineLimit(1)
                                Button { model.removeComposerAttachment(attachment) } label: {
                                    Image(systemName: "xmark.circle.fill")
                                }
                                .accessibilityLabel("移除附件 \(attachment.name)")
                                .disabled(model.composerState == .sending)
                            }
                            .font(.system(size: 12))
                            .foregroundStyle(composerForeground)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 7)
                            .background(composerForeground.opacity(0.09), in: RoundedRectangle(cornerRadius: 9))
                        }
                    }
                }
            }
            ZStack(alignment: .topLeading) {
                if model.composerText.isEmpty {
                    Text("输入内容，发送到当前 SSH 终端…")
                        .font(.system(size: 16))
                        .foregroundStyle(composerPlaceholder)
                        .padding(.leading, 4)
                        .padding(.top, 8)
                        .allowsHitTesting(false)
                }
                BridgeIOSSHComposerTextView(text: $model.composerText, height: $composerHeight,
                                            textColor: isLightComposer ? .black : .white,
                                            editable: model.state == .connected && model.composerState != .sending)
                    .frame(height: composerHeight)
            }
            HStack(spacing: 3) {
                Button { isImportingComposerAttachment = true } label: {
                    Image(systemName: "plus").font(.system(size: 18, weight: .medium))
                        .frame(width: 36, height: 36).contentShape(Rectangle())
                }
                .accessibilityLabel("添加附件")
                .disabled(model.state != .connected || model.composerState == .sending)
                Button { isShowingTerminalKeys.toggle() } label: {
                    Image(systemName: isShowingTerminalKeys ? "keyboard.chevron.compact.down" : "keyboard")
                        .font(.system(size: 16)).frame(width: 36, height: 36).contentShape(Rectangle())
                }
                .accessibilityLabel(isShowingTerminalKeys ? "收起终端快捷键" : "展开终端快捷键")
                if isShowingTerminalKeys {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 3) {
                            terminalKey("Esc", bytes: [27])
                            terminalKey("Tab", bytes: [9])
                            terminalKey("↑", bytes: [27, 91, 65])
                            terminalKey("↓", bytes: [27, 91, 66])
                            terminalKey("←", bytes: [27, 91, 68])
                            terminalKey("→", bytes: [27, 91, 67])
                            terminalKey("Ctrl-C", bytes: [3])
                            terminalKey("↵", bytes: [13])
                        }
                    }
                } else {
                    Spacer(minLength: 0)
                }
                Button { model.sendComposer() } label: {
                    Group {
                        if model.composerState == .sending {
                            ProgressView().tint(SwiftUI.Color(red: 0.06, green: 0.1, blue: 0.08))
                        } else {
                            Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
                        }
                    }
                    .foregroundStyle(SwiftUI.Color(red: 0.06, green: 0.1, blue: 0.08))
                    .frame(width: 40, height: 40)
                    .background(SwiftUI.Color(red: 0.45, green: 0.84, blue: 0.63).opacity(composerSendDisabled ? 0.5 : 1), in: Circle())
                }
                .accessibilityLabel("发送到当前 SSH 终端")
                .disabled(composerSendDisabled)
            }
            .buttonStyle(.plain)
            .foregroundStyle(composerForeground.opacity(0.72))
            if let message = composerStateMessage {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(composerStateColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(composerBackground, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(composerBorder, lineWidth: 1))
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
        .onChange(of: model.composerText) { _ in model.composerEdited() }
    }

    private func terminalKey(_ title: String, bytes: [UInt8]) -> some View {
        Button { model.sendTerminalKey(bytes) } label: {
            Text(title).font(.system(size: 12, weight: .medium))
                .frame(minWidth: 34, minHeight: 36).contentShape(Rectangle())
        }
        .disabled(model.state != .connected || model.composerState == .sending)
        .accessibilityLabel("发送终端按键 \(title)")
    }

    private var composerSendDisabled: Bool {
        model.state != .connected || model.composerState == .sending ||
            (model.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.composerAttachments.isEmpty)
    }
    private var isLightComposer: Bool { colorScheme == .light }
    private var composerBackground: SwiftUI.Color { isLightComposer ? SwiftUI.Color(red: 0.97, green: 0.98, blue: 0.97) : SwiftUI.Color(red: 0.125, green: 0.13, blue: 0.14) }
    private var composerBorder: SwiftUI.Color { isLightComposer ? SwiftUI.Color.black.opacity(0.15) : SwiftUI.Color(red: 0.24, green: 0.25, blue: 0.29) }
    private var composerForeground: SwiftUI.Color { isLightComposer ? SwiftUI.Color(red: 0.09, green: 0.13, blue: 0.1) : SwiftUI.Color(red: 0.94, green: 0.95, blue: 0.96) }
    private var composerPlaceholder: SwiftUI.Color { isLightComposer ? SwiftUI.Color(red: 0.41, green: 0.45, blue: 0.42) : SwiftUI.Color(red: 0.47, green: 0.52, blue: 0.58) }

    private var setupView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("SSH 直连")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                        Text("连接 Mac 上的 sshd，继续使用远端 tmux / Codex。")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { model.onClose(false) } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .bold))
                            .frame(width: 34, height: 34)
                            .background(.secondary.opacity(0.12), in: Circle())
                    }
                }

                if !model.profiles.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline) {
                            Text("已保存的主机")
                                .font(.system(size: 15, weight: .semibold))
                            Spacer()
                            Text("点击直接进入终端")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                        ForEach(model.profiles) { profile in
                            HStack(spacing: 8) {
                                Button { model.connect(profile: profile) } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: "server.rack")
                                            .foregroundStyle(Color.accentColor)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(profile.label)
                                                .font(.system(size: 15, weight: .semibold))
                                                .lineLimit(1)
                                            Text("\(profile.username)@\(profile.host):\(profile.port)")
                                                .font(.system(size: 12, design: .monospaced))
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                        Spacer(minLength: 6)
                                        Image(systemName: "arrow.right")
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(Color.accentColor)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("连接到 \(profile.label)")
                                .accessibilityHint("直接打开 SSH 终端")

                                Button {
                                    model.select(profile)
                                    isShowingConfiguration = true
                                } label: {
                                    Image(systemName: "pencil")
                                        .font(.system(size: 13, weight: .semibold))
                                        .frame(width: 32, height: 32)
                                }
                                .buttonStyle(.bordered)
                                .accessibilityLabel("编辑 \(profile.label)")
                            }
                            .padding(12)
                            .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }

                        Button {
                            model.prepareNewProfile()
                            isShowingConfiguration = true
                        } label: {
                            Label("添加另一台主机", systemImage: "plus")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .buttonStyle(.borderless)
                    }
                } else {
                    Text("还没有保存的主机，请先配置一台 SSH 主机。")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }

                DisclosureGroup(isExpanded: $isShowingConfiguration) {
                    VStack(alignment: .leading, spacing: 14) {
                        keyPickerView
                        Divider()
                        VStack(alignment: .leading, spacing: 12) {
                            BridgeIOSSHField(title: "主机", prompt: "mac.local 或 IP 地址", text: $model.host, keyboard: .URL)
                            HStack(spacing: 12) {
                                BridgeIOSSHField(title: "端口", prompt: "22", text: $model.port, keyboard: .numberPad)
                                    .frame(width: 104)
                                BridgeIOSSHField(title: "用户名", prompt: "登录用户名", text: $model.username, keyboard: .asciiCapable)
                            }
                            BridgeIOSSHSecureField(title: "密码", prompt: "仅保留在本次连接内", text: $model.password)
                            BridgeIOSSHField(title: "连接后命令（可选）", prompt: "例如 tmux attach -t codex", text: $model.startupCommand, keyboard: .default)
                        }

                        if case .failed(let message) = model.state {
                            Text(message)
                                .font(.system(size: 13))
                                .foregroundStyle(.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        HStack(spacing: 12) {
                            Button { model.saveProfile() } label: {
                                Label("保存主机", systemImage: "bookmark")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            Button { model.connect() } label: {
                                if model.state == .connecting { ProgressView().tint(.white) }
                                else { Label("连接终端", systemImage: "arrow.right") }
                            }
                            .frame(maxWidth: .infinity)
                            .buttonStyle(.borderedProminent)
                            .disabled(model.state == .connecting)
                        }
                    }
                    .padding(.top, 12)
                } label: {
                    Label("连接设置", systemImage: "slider.horizontal.3")
                        .font(.system(size: 15, weight: .semibold))
                }
                .padding(14)
                .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                if model.bridgeServerOrigin != nil {
                    DisclosureGroup("绑定 Bridge Session（可选）", isExpanded: $isShowingRemoteSessions) {
                        remoteSessionPickerView.padding(.top, 8)
                    }
                    .onChange(of: isShowingRemoteSessions) { expanded in
                        if expanded && model.sessionPickerState == .idle { model.refreshRemoteSessions() }
                    }
                }

                DisclosureGroup("安全说明", isExpanded: $isShowingSecurityDetails) {
                    Text("私钥只保存在 iOS Keychain，不会进入 WebView、URL 或日志。支持未加密 Ed25519/ECDSA；加密私钥和 RSA 需要先转换。首次连接会记录主机密钥，之后仅在密钥变化时重新确认。")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                }
                .font(.system(size: 13, weight: .semibold))
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 30)
        }
    }

    private var keyPickerView: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("SSH 私钥")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    isPublicKeyCopied = false
                    model.generateKey()
                } label: {
                    Label("生成", systemImage: "plus")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.bordered)
                Button {
                    isImportingKey = true
                } label: {
                    Label("导入", systemImage: "square.and.arrow.down")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.bordered)
            }

            if model.keys.isEmpty {
                Text("可生成 Ed25519 密钥、导入未加密的 Ed25519/ECDSA 私钥，或使用密码登录。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(model.keys) { key in
                    HStack(spacing: 10) {
                        Button {
                            model.selectedKeyId = key.id
                            model.password = ""
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: model.selectedKeyId == key.id ? "checkmark.circle.fill" : "key.fill")
                                    .foregroundStyle(model.selectedKeyId == key.id ? Color.green : Color.accentColor)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(key.label).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                                    Text("\(key.algorithm.displayName) · \(key.fingerprintSHA256)")
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                        Button("公钥") {
                            isPublicKeyCopied = false
                            model.showPublicKey(key)
                        }
                        .font(.system(size: 12, weight: .semibold))
                        .buttonStyle(.borderless)
                        Button(role: .destructive) {
                            model.deleteKey(key)
                        } label: {
                            Image(systemName: "trash")
                                .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.borderless)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.secondary.opacity(model.selectedKeyId == key.id ? 0.14 : 0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                if !model.selectedKeyId.isEmpty {
                    Button("使用密码登录") {
                        model.selectedKeyId = ""
                    }
                    .font(.system(size: 12, weight: .semibold))
                }
            }
        }
    }

    private var remoteSessionPickerView: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("Bridge Sessions")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    model.refreshRemoteSessions()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.bordered)
                .disabled(model.sessionPickerState == .loading)
            }

            switch model.sessionPickerState {
            case .idle:
                Text("读取当前 Bridge 的 Session 列表后，可绑定到对应的 SSH 主机。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            case .loading:
                HStack(spacing: 8) {
                    ProgressView()
                    Text("正在读取当前 Bridge 的 Session…")
                }
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            case .loaded:
                if model.remoteSessions.isEmpty {
                    Text("当前 Bridge 没有可读取的 Session。")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            case .unavailable(let message):
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let selection = model.selectedSessionSelection {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundStyle(.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("已绑定 \(selection.sessionId) · createdAt \(selection.createdAt)")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        if let remote = model.selectedRemoteSession {
                            Text(remote.name)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("取消") { model.clearSessionSelection() }
                        .font(.system(size: 12, weight: .semibold))
                }
                .padding(10)
                .background(.green.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            ForEach(model.remoteSessions) { remote in
                Button {
                    model.selectRemoteSession(remote)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: remote.isSelectable ? "rectangle.connected.to.line.below" : "archivebox")
                            .foregroundStyle(remote.isSelectable ? Color.accentColor : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(remote.name)
                                .font(.system(size: 14, weight: .semibold))
                                .lineLimit(1)
                            Text("\(remote.id) · \(remote.statusLabel) · createdAt \(remote.createdAt)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if model.selectedSessionSelection?.sessionId == remote.id,
                           model.selectedSessionSelection?.createdAt == remote.createdAt {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        } else {
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.secondary.opacity(remote.isSelectable ? 0.09 : 0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!remote.isSelectable)
            }
        }
    }

    private var stateLabel: String {
        switch model.state {
        case .setup: return "未连接"
        case .connecting: return "连接中"
        case .connected: return "已连接"
        case .failed: return "异常"
        }
    }

    private var stateColor: SwiftUI.Color {
        switch model.state {
        case .connected: return .green
        case .connecting: return .yellow
        case .failed: return .red
        case .setup: return .white.opacity(0.7)
        }
    }

    private var apiBindingLabel: String {
        switch model.apiBindingState {
        case .none: return "API 未绑定"
        case .checking: return "API 校验中"
        case .verified: return "API 已绑定"
        case .unavailable: return "API 不可用"
        case .mismatch: return "上下文不一致"
        }
    }

    private var apiBindingColor: SwiftUI.Color {
        switch model.apiBindingState {
        case .verified: return .green
        case .checking: return .yellow
        case .mismatch: return .red
        case .unavailable, .none: return .white.opacity(0.68)
        }
    }

    private var composerStateMessage: String? {
        switch model.composerState {
        case .idle: return nil
        case .sending: return "正在发送到 SSH 终端…"
        case .sent: return "已写入 SSH；请在终端查看处理结果。"
        case .unknown(let message): return message
        case .failed(let message): return message
        }
    }

    private var composerStateColor: SwiftUI.Color {
        switch model.composerState {
        case .sent: return isLightComposer ? SwiftUI.Color(red: 0.1, green: 0.42, blue: 0.25) : .green
        case .sending: return isLightComposer ? .brown : .yellow
        case .unknown, .failed: return isLightComposer ? SwiftUI.Color(red: 0.7, green: 0.28, blue: 0.08) : .orange
        case .idle: return composerForeground.opacity(0.7)
        }
    }
}

private struct BridgeIOSSHFilesView: View {
    @ObservedObject var model: BridgeIOSSHWorkspaceModel

    var body: some View {
        NavigationView {
            Group {
                switch model.filesState {
                case .idle:
                    Text("点击刷新读取当前 Session 工作目录。")
                        .foregroundStyle(.secondary)
                case .loading:
                    ProgressView("正在读取文件…")
                case .failed(let message):
                    VStack(spacing: 12) {
                        Text(message).foregroundStyle(.red).multilineTextAlignment(.center)
                        Button("重试") { model.loadSessionFiles() }
                    }
                    .padding()
                case .loaded:
                    if model.fileEntries.isEmpty {
                        Text("当前目录为空。").foregroundStyle(.secondary)
                    } else {
                        List(model.fileEntries, id: \.name) { entry in
                            HStack(spacing: 10) {
                                Image(systemName: entry.isDirectory ? "folder" : entry.isSymbolicLink ? "link" : "doc")
                                    .foregroundStyle(entry.isSymbolicLink ? Color.secondary : Color.accentColor)
                                Text(entry.name).lineLimit(1)
                                Spacer()
                                if entry.isSymbolicLink { Text("已阻止").font(.caption).foregroundStyle(.secondary) }
                                else if let size = entry.size { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Session 文件")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { model.loadSessionFiles() } label: { Image(systemName: "arrow.clockwise") }
                }
            }
        }
        .onAppear { if model.filesState == .idle { model.loadSessionFiles() } }
    }

    @Environment(\.dismiss) private var dismiss
}

private struct BridgeIOSSHField: View {
    let title: String
    let prompt: String
    @Binding var text: String
    let keyboard: UIKeyboardType

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
            TextField(prompt, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .textFieldStyle(.roundedBorder)
        }
    }
}

private struct BridgeIOSSHSecureField: View {
    let title: String
    let prompt: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
            SecureField(prompt, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
        }
    }
}

private struct BridgeIOSSHComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let textColor: UIColor
    let editable: Bool

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .systemFont(ofSize: 16)
        view.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 8, right: 4)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = true
        view.accessibilityLabel = "当前 SSH 终端输入"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.textColor = textColor
        view.isEditable = editable
        context.coordinator.updateHeight(view)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: BridgeIOSSHComposerTextView
        init(parent: BridgeIOSSHComposerTextView) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            updateHeight(textView)
        }

        func updateHeight(_ textView: UITextView) {
            guard textView.bounds.width > 0 else { return }
            let proposed = textView.sizeThatFits(CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)).height
            let next = min(max(proposed, 52), 128)
            guard abs(next - parent.height) > 0.5 else { return }
            DispatchQueue.main.async { [weak self] in self?.parent.height = next }
        }
    }
}

private struct BridgeIOSSHTerminalRepresentable: UIViewRepresentable {
    let session: BridgeIOSSHSession

    func makeUIView(context: Context) -> BridgeIOSSHTerminalView {
        let view = BridgeIOSSHTerminalView(frame: .zero)
        view.session = session
        session.attach(terminal: view)
        return view
    }

    func updateUIView(_ view: BridgeIOSSHTerminalView, context: Context) {
        view.session = session
        session.attach(terminal: view)
    }

    static func dismantleUIView(_ view: BridgeIOSSHTerminalView, coordinator: ()) {
        view.session?.detach(terminal: view)
    }
}

private final class BridgeIOSSHTerminalView: TerminalView, TerminalViewDelegate {
    weak var session: BridgeIOSSHSession?

    override init(frame: CGRect) {
        super.init(frame: frame)
        terminalDelegate = self
        nativeBackgroundColor = .black
        backgroundColor = .black
        isOpaque = true
        contentInsetAdjustmentBehavior = .never
        font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        session?.resize(cols: newCols, rows: newRows)
    }

    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        session?.send(Data(data))
    }

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        UIApplication.shared.open(url)
    }

    func bell(source: TerminalView) {}

    func clipboardCopy(source: TerminalView, content: Data) {
        UIPasteboard.general.setValue(content, forPasteboardType: "public.utf8-plain-text")
    }

    func clipboardRead(source: TerminalView) -> Data? {
        UIPasteboard.general.string?.data(using: .utf8)
    }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
}

enum BridgeIOSSHSessionState {
    case connecting
    case connected
    case failed
}

private enum BridgeIOSSHSessionError: Error {
    case invalidChannelType
    case hostKeyRejected
}

private final class BridgeIOSSHHostKeyDelegate: NIOSSHClientServerAuthenticationDelegate {
    private let connectionID: String
    private let host: String
    private let port: Int
    private let onUnknownHostKey: (String, Bool, @escaping (Bool) -> Void) -> Void

    init(connectionID: String, host: String, port: Int,
         onUnknownHostKey: @escaping (String, Bool, @escaping (Bool) -> Void) -> Void) {
        self.connectionID = connectionID
        self.host = host
        self.port = port
        self.onUnknownHostKey = onUnknownHostKey
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let openSSHKey = String(openSSHPublicKey: hostKey)
        let fingerprint = Self.fingerprint(for: openSSHKey)
        BridgeIOSSHLog.info(
            "[\(connectionID)] host-key challenge received fingerprint=\(fingerprint)"
        )
        let trustedKey = BridgeIOSSHHostKeyStore.shared.trustedKey(host: host, port: port)
        if let trustedKey, trustedKey == openSSHKey {
            BridgeIOSSHLog.info("[\(connectionID)] host-key matches stored trust; accepting without prompt")
            validationCompletePromise.succeed(())
            return
        }
        let changed = trustedKey != nil
        if changed {
            BridgeIOSSHLog.error("[\(connectionID)] host-key differs from stored trust; waiting for explicit replacement")
        } else {
            BridgeIOSSHLog.info("[\(connectionID)] host-key is not trusted yet; waiting for explicit approval")
        }
        onUnknownHostKey(fingerprint, changed) { accepted in
            BridgeIOSSHLog.info(
                "[\(self.connectionID)] host-key decision callback accepted=\(accepted)"
            )
            if accepted {
                BridgeIOSSHHostKeyStore.shared.trust(key: openSSHKey, host: self.host, port: self.port)
                BridgeIOSSHLog.info("[\(self.connectionID)] host-key trust saved for hostHash=\(bridgeIOSSHLogHash(self.host)) port=\(self.port)")
                BridgeIOSSHLog.debug("[\(self.connectionID)] completing host-key validation promise")
                validationCompletePromise.succeed(())
            } else {
                BridgeIOSSHLog.debug("[\(self.connectionID)] failing host-key validation promise")
                validationCompletePromise.fail(BridgeIOSSHSessionError.hostKeyRejected)
            }
        }
    }

    private static func fingerprint(for openSSHKey: String) -> String {
        let components = openSSHKey.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
        let material = components.count > 1
            ? Data(base64Encoded: String(components[1])) ?? Data(openSSHKey.utf8)
            : Data(openSSHKey.utf8)
        let digest = SHA256.hash(data: material)
        let encoded = Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
        return "SHA256:\(encoded)"
    }
}

private final class BridgeIOSSHErrorHandler: ChannelInboundHandler {
    typealias InboundIn = Any
    private let connectionID: String
    private let stage: String
    private let onError: (Error) -> Void

    init(connectionID: String, stage: String, onError: @escaping (Error) -> Void) {
        self.connectionID = connectionID
        self.stage = stage
        self.onError = onError
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        BridgeIOSSHLog.error(
            "[\(connectionID)] pipeline error stage=\(stage) channelActive=\(context.channel.isActive) \(bridgeIOSSHErrorDetails(error))"
        )
        onError(error)
        context.close(promise: nil)
    }
}

private final class BridgeIOSSHShellChannelHandler: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    private let connectionID: String
    private weak var terminal: BridgeIOSSHTerminalView?
    private let term: String
    private let initialWindowSize: (cols: Int, rows: Int)

    init(connectionID: String, terminal: BridgeIOSSHTerminalView?, term: String, initialWindowSize: (cols: Int, rows: Int)) {
        self.connectionID = connectionID
        self.terminal = terminal
        self.term = term
        self.initialWindowSize = initialWindowSize
    }

    func handlerAdded(context: ChannelHandlerContext) {
        BridgeIOSSHLog.debug("[\(connectionID)] shell handler added")
        context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure { error in
            BridgeIOSSHLog.error(
                "[\(self.connectionID)] failed to set allowRemoteHalfClosure \(bridgeIOSSHErrorDetails(error))"
            )
            context.fireErrorCaught(error)
        }
    }

    func channelActive(context: ChannelHandlerContext) {
        BridgeIOSSHLog.info(
            "[\(connectionID)] shell channel active; requesting PTY term=\(term) cols=\(initialWindowSize.cols) rows=\(initialWindowSize.rows)"
        )
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.PseudoTerminalRequest(
            wantReply: false, term: term, terminalCharacterWidth: initialWindowSize.cols,
            terminalRowHeight: initialWindowSize.rows, terminalPixelWidth: 0,
            terminalPixelHeight: 0, terminalModes: SSHTerminalModes([:])), promise: nil)
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.EnvironmentRequest(
            wantReply: false, name: "LANG", value: "en_US.UTF-8"), promise: nil)
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ShellRequest(wantReply: false), promise: nil)
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let payload = unwrapInboundIn(data)
        guard case .byteBuffer(var buffer) = payload.data,
              let bytes = buffer.readBytes(length: buffer.readableBytes), !bytes.isEmpty else { return }
        let terminal = terminal
        DispatchQueue.main.async {
            terminal?.feed(byteArray: bytes[...])
        }
    }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let status = event as? SSHChannelRequestEvent.ExitStatus {
            BridgeIOSSHLog.info("[\(connectionID)] remote shell exit status=\(status.exitStatus)")
            let terminal = terminal
            DispatchQueue.main.async { terminal?.feed(text: "\n[SSH] Session exited with status \(status.exitStatus)\n") }
        } else if let signal = event as? SSHChannelRequestEvent.ExitSignal {
            BridgeIOSSHLog.info("[\(connectionID)] remote shell exit signal=\(signal.signalName)")
            let terminal = terminal
            DispatchQueue.main.async { terminal?.feed(text: "\n[SSH] Session closed: \(signal.signalName)\n") }
        } else {
            context.fireUserInboundEventTriggered(event)
        }
    }
}

final class BridgeIOSSHSession {
    private let connectionID = String(UUID().uuidString.prefix(8))
    private let host: String
    private let port: Int
    private let username: String
    private let authentication: BridgeIOSSHAuthentication
    private let startupCommand: String
    private let onState: (BridgeIOSSHSessionState) -> Void
    private let onHostKey: (String, Bool, @escaping (Bool) -> Void) -> Void
    private weak var terminal: BridgeIOSSHTerminalView?
    private var group: MultiThreadedEventLoopGroup?
    private var channel: Channel?
    private var sessionChannel: Channel?
    private var inputQueue: BridgeIOSSHInputQueue?
    private var sshHandler: NIOSSHHandler?
    private var phase = "created"

    init(host: String, port: Int, username: String, authentication: BridgeIOSSHAuthentication, startupCommand: String,
         onState: @escaping (BridgeIOSSHSessionState) -> Void,
         onHostKey: @escaping (String, Bool, @escaping (Bool) -> Void) -> Void) {
        self.host = host
        self.port = port
        self.username = username
        self.authentication = authentication
        self.startupCommand = startupCommand
        self.onState = onState
        self.onHostKey = onHostKey
        BridgeIOSSHLog.debug(
            "[\(connectionID)] session initialized hostHash=\(bridgeIOSSHLogHash(host)) port=\(port) userHash=\(bridgeIOSSHLogHash(username)) auth=\(Self.authenticationLabel(authentication)) startupCommandPresent=\(!startupCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)"
        )
    }

    fileprivate func attach(terminal: BridgeIOSSHTerminalView) {
        self.terminal = terminal
        if case .connected = currentState { sendInitialResize() }
    }

    fileprivate func detach(terminal: BridgeIOSSHTerminalView) {
        if self.terminal === terminal { self.terminal = nil }
    }

    func connect() {
        phase = "starting"
        BridgeIOSSHLog.info("[\(connectionID)] connect started")
        onState(.connecting)
        let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        self.group = group
        let userAuthDelegate: NIOSSHClientUserAuthenticationDelegate
        switch authentication {
        case .password(let password):
            userAuthDelegate = SimplePasswordDelegate(username: username, password: password)
        case .privateKey(let key):
            userAuthDelegate = BridgeIOSSHPrivateKeyAuthDelegate(username: username, key: key)
        }
        BridgeIOSSHLog.debug("[\(connectionID)] authentication delegate prepared")
        let serverAuthDelegate = BridgeIOSSHHostKeyDelegate(
            connectionID: connectionID, host: host, port: port, onUnknownHostKey: onHostKey
        )
        let bootstrap = ClientBootstrap(group: group)
            .channelInitializer { [weak self] channel in
                channel.eventLoop.makeCompletedFuture {
                    self?.phase = "installing-ssh-handler"
                    if let self {
                        BridgeIOSSHLog.debug("[\(self.connectionID)] TCP channel initializer running")
                    }
                    let ssh = NIOSSHHandler(
                        role: .client(.init(userAuthDelegate: userAuthDelegate, serverAuthDelegate: serverAuthDelegate)),
                        allocator: channel.allocator,
                        inboundChildChannelInitializer: nil
                    )
                    try channel.pipeline.syncOperations.addHandler(ssh)
                    if let self {
                        BridgeIOSSHLog.debug("[\(self.connectionID)] NIOSSH handler installed")
                    }
                    try channel.pipeline.syncOperations.addHandler(BridgeIOSSHErrorHandler(
                        connectionID: self?.connectionID ?? "unknown",
                        stage: "transport",
                        onError: { [weak self] error in
                        self?.failed(error)
                        }
                    ))
                }
            }
            .channelOption(ChannelOptions.socket(SocketOptionLevel(SOL_SOCKET), SO_REUSEADDR), value: 1)
            .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_NODELAY), value: 1)
        phase = "tcp-connect"
        BridgeIOSSHLog.debug(
            "[\(connectionID)] starting TCP connect hostHash=\(bridgeIOSSHLogHash(host)) port=\(port)"
        )
        bootstrap.connect(host: host, port: port).whenComplete { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.phase = "tcp-connect-failed"
                BridgeIOSSHLog.error("[\(self.connectionID)] TCP connect failed \(bridgeIOSSHErrorDetails(error))")
                self.failed(error)
            case .success(let channel):
                self.phase = "tcp-connected"
                BridgeIOSSHLog.info("[\(self.connectionID)] TCP connect succeeded; channel active=\(channel.isActive)")
                self.channel = channel
                self.createSessionChannel(on: channel)
            }
        }
    }

    /// Accessed on the UI thread, where SwiftTerm processes terminal output.
    var bracketedPasteEnabled: Bool { terminal?.getTerminal().bracketedPasteMode ?? false }
    var applicationCursorEnabled: Bool { terminal?.getTerminal().applicationCursor ?? false }

    func send(_ data: Data) {
        enqueueTerminalInput(data, composerCompletion: nil)
    }

    func sendComposer(_ data: Data, completion: @escaping (BridgeIOSSHInputResult) -> Void) {
        enqueueTerminalInput(data, composerCompletion: completion)
    }

    private func enqueueTerminalInput(_ data: Data, composerCompletion: ((BridgeIOSSHInputResult) -> Void)?) {
        guard let sessionChannel else {
            BridgeIOSSHLog.error("[\(connectionID)] send ignored: no session channel bytes=\(data.count) phase=\(phase)")
            composerCompletion?(.notSent)
            return
        }
        sessionChannel.eventLoop.execute { [weak self] in
            guard let self else { composerCompletion?(.notSent); return }
            if self.inputQueue == nil {
                self.inputQueue = BridgeIOSSHInputQueue(
                    active: { sessionChannel.isActive },
                    write: { data, done in
                        var buffer = sessionChannel.allocator.buffer(capacity: data.count)
                        buffer.writeBytes(data)
                        sessionChannel.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(buffer)))
                            .whenComplete { result in
                                switch result {
                                case .success: done(true)
                                case .failure: done(false)
                                }
                            }
                    },
                    schedule: { action in
                        let scheduled = sessionChannel.eventLoop.scheduleTask(in: .milliseconds(180), action)
                        // Closing the event loop can cancel the delay after paste was
                        // written. Resolve that as unknown instead of leaving the
                        // Composer permanently in its sending state.
                        scheduled.futureResult.whenFailure { _ in action() }
                    }
                )
            }
            if let composerCompletion { self.inputQueue?.enqueueComposer(data, completion: composerCompletion) }
            else { self.inputQueue?.enqueueRaw(data) }
        }
    }

    func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0, let sessionChannel else {
            BridgeIOSSHLog.debug("[\(connectionID)] resize ignored cols=\(cols) rows=\(rows) hasSessionChannel=\(sessionChannel != nil)")
            return
        }
        BridgeIOSSHLog.debug("[\(connectionID)] resizing PTY cols=\(cols) rows=\(rows)")
        sessionChannel.eventLoop.execute {
            sessionChannel.triggerUserOutboundEvent(SSHChannelRequestEvent.WindowChangeRequest(
                terminalCharacterWidth: cols, terminalRowHeight: rows,
                terminalPixelWidth: 0, terminalPixelHeight: 0), promise: nil)
        }
    }

    func disconnect() {
        let channel = self.channel
        let group = self.group
        BridgeIOSSHLog.info(
            "[\(connectionID)] disconnect requested phase=\(phase) hasTCPChannel=\(channel != nil) hasSessionChannel=\(sessionChannel != nil)"
        )
        phase = "disconnecting"
        self.channel = nil
        self.sessionChannel = nil
        self.sshHandler = nil
        self.group = nil
        channel?.close(promise: nil)
        if let group { group.shutdownGracefully { _ in } }
    }

    fileprivate func openSFTPClient() -> EventLoopFuture<SFTPClient>? {
        guard let channel, let sshHandler else {
            BridgeIOSSHLog.error("[\(connectionID)] cannot open SFTP: SSH channel or handler unavailable phase=\(phase)")
            return nil
        }
        BridgeIOSSHLog.debug("[\(connectionID)] opening SFTP channel")
        return SFTPClient.openChannel(with: sshHandler, on: channel)
    }

    private var currentState: BridgeIOSSHSessionState { sessionChannel == nil ? .connecting : .connected }

    private func createSessionChannel(on channel: Channel) {
        phase = "waiting-for-ssh-handler"
        BridgeIOSSHLog.debug("[\(connectionID)] waiting for NIOSSH handler")
        channel.pipeline.handler(type: NIOSSHHandler.self).whenComplete { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.phase = "ssh-handler-failed"
                BridgeIOSSHLog.error("[\(self.connectionID)] NIOSSH handler lookup failed \(bridgeIOSSHErrorDetails(error))")
                self.failed(error)
            case .success(let sshHandler):
                self.phase = "creating-session-channel"
                BridgeIOSSHLog.debug("[\(self.connectionID)] NIOSSH handler ready; creating session channel")
                self.sshHandler = sshHandler
                let promise = channel.eventLoop.makePromise(of: Channel.self)
                sshHandler.createChannel(promise, channelType: .session) { [weak self] child, type in
                    guard let self, type == .session else {
                        BridgeIOSSHLog.error("[\(self?.connectionID ?? "unknown")] session channel creation returned unexpected channel type")
                        return channel.eventLoop.makeFailedFuture(BridgeIOSSHSessionError.invalidChannelType)
                    }
                    BridgeIOSSHLog.debug("[\(self.connectionID)] configuring session channel pipeline")
                    let terminal = self.terminal
                    let size = terminal?.getTerminal()
                    return child.eventLoop.makeCompletedFuture {
                        try child.pipeline.syncOperations.addHandler(BridgeIOSSHShellChannelHandler(
                            connectionID: self.connectionID, terminal: terminal, term: "xterm-256color",
                            initialWindowSize: (cols: max(size?.cols ?? 80, 1), rows: max(size?.rows ?? 24, 1))))
                        try child.pipeline.syncOperations.addHandler(BridgeIOSSHErrorHandler(
                            connectionID: self.connectionID,
                            stage: "session-channel",
                            onError: { [weak self] error in
                            self?.failed(error)
                            }
                        ))
                    }
                }
                promise.futureResult.whenComplete { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .failure(let error):
                        self.phase = "session-channel-failed"
                        BridgeIOSSHLog.error("[\(self.connectionID)] session channel failed \(bridgeIOSSHErrorDetails(error))")
                        self.failed(error)
                    case .success(let child):
                        self.phase = "connected"
                        BridgeIOSSHLog.info("[\(self.connectionID)] SSH session channel connected active=\(child.isActive)")
                        self.sessionChannel = child
                        self.onState(.connected)
                        self.sendInitialResize()
                        if !self.startupCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                                guard let self else { return }
                                BridgeIOSSHLog.debug("[\(self.connectionID)] sending startup command bytes=\(self.startupCommand.utf8.count)")
                                self.send(Data((self.startupCommand + "\r").utf8))
                            }
                        }
                    }
                }
            }
        }
    }

    private func sendInitialResize() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let size = self.terminal?.getTerminal() else { return }
            self.resize(cols: size.cols, rows: size.rows)
        }
    }

    private func failed(_ error: Error) {
        let failurePhase = phase
        BridgeIOSSHLog.error(
            "[\(connectionID)] session failed phase=\(failurePhase) tcpActive=\(channel?.isActive ?? false) sessionActive=\(sessionChannel?.isActive ?? false) \(bridgeIOSSHErrorDetails(error))"
        )
        phase = "failed"
        onState(.failed)
        let terminal = terminal
        DispatchQueue.main.async {
            terminal?.feed(text: "\n[SSH] 连接已关闭：\(Self.safeError(error))\n")
        }
        disconnect()
    }

    private static func safeError(_ error: Error) -> String {
        let value = String(describing: error)
        return value.count > 180 ? String(value.prefix(180)) + "…" : value
    }

    private static func authenticationLabel(_ authentication: BridgeIOSSHAuthentication) -> String {
        switch authentication {
        case .password: return "password"
        case .privateKey: return "private-key"
        }
    }
}
