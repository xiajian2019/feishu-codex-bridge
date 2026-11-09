import CryptoKit
import Foundation
import NIOCore
import NIOPosix
import NIOSSH
import NIOSFTP
import SwiftTerm
import SwiftUI
import UIKit
import UniformTypeIdentifiers

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

@MainActor
private final class BridgeIOSSHWorkspaceModel: ObservableObject {
    @Published var host: String
    @Published var port: String
    @Published var username: String
    @Published var password: String
    @Published var startupCommand: String
    @Published var profiles: [BridgeIOSSHProfile]
    @Published var keys: [BridgeIOSSHKeyMetadata]
    @Published var selectedKeyId: String
    @Published var state: BridgeIOSSHState = .setup
    @Published var pendingHostKey: String?
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
        case .manager(let defaultHost, _, _, _, let selection):
            let recent = savedProfiles.first
            self.host = recent?.host ?? defaultHost
            self.port = String(recent?.port ?? 22)
            self.username = recent?.username ?? ""
            self.password = ""
            self.startupCommand = recent?.startupCommand ?? ""
            selectedKeyId = recent.flatMap { profile in availableKeys.contains(where: { $0.id == profile.keyId }) ? profile.keyId : nil } ?? ""
            bridgeServerOrigin = launch.bridgeServerOrigin
            sessionSelection = selection
            selectedSessionSelection = selection
            initialConnection = false
        }
    }

    func startIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true
        if initialConnection { connect() }
        else { refreshRemoteSessions() }
    }

    func select(_ profile: BridgeIOSSHProfile) {
        host = profile.host
        port = String(profile.port)
        username = profile.username
        startupCommand = profile.startupCommand
        password = ""
        selectedKeyId = keys.contains(where: { $0.id == profile.keyId }) ? profile.keyId : ""
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
        sessionSelection = nil
        selectedSessionSelection = nil
        selectedRemoteSession = nil
        apiBindingState = .none
        sessionPickerState = bridgeServerOrigin == nil ? .idle : .loaded
    }

    func connect() {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedUser = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty, !trimmedUser.isEmpty, let parsedPort = Int(port), (1...65_535).contains(parsedPort) else {
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
                state = .failed(error.localizedDescription)
                return
            }
        } else {
            authentication = .password(password)
        }
        if let selection = sessionSelection {
            guard selection.bridgeOrigin == bridgeServerOrigin,
                  selection.sessionId.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
                  selection.createdAt >= 0 else {
                state = .failed("Bridge Session 上下文无效，请刷新后重新选择。")
                return
            }
            if selection.expectedSshHost != nil && selection.expectedSshHost != trimmedHost.lowercased()
                || selection.expectedSshPort != nil && selection.expectedSshPort != parsedPort {
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
        pendingHostKey = nil
        hostKeyDecision = nil
        session?.disconnect()
        let next = BridgeIOSSHSession(host: trimmedHost, port: parsedPort, username: trimmedUser,
                                      authentication: authentication, startupCommand: startupCommand,
                                      onState: { [weak self] nextState in
                                          DispatchQueue.main.async {
                                              guard let self else { return }
                                              switch nextState {
                                              case .connecting: self.state = .connecting
                                              case .connected: self.state = .connected
                                              case .failed: self.state = .failed("SSH 连接失败，请检查主机、端口、认证信息或网络。")
                                              }
                                          }
                                      }, onHostKey: { [weak self] fingerprint, decision in
                                          DispatchQueue.main.async {
                                              guard let self else { decision(false); return }
                                              self.pendingHostKey = fingerprint
                                              self.hostKeyDecision = decision
                                          }
                                      })
        session = next
        next.connect()
        if let context = boundContext {
            apiVerificationGeneration += 1
            let verificationGeneration = apiVerificationGeneration
            Task { @MainActor [weak self] in
                do {
                    _ = try await BridgeIOSSHSessionAPI.verifyIdentity(context)
                    guard let self, self.apiVerificationGeneration == verificationGeneration,
                          self.boundContext == context else { return }
                    self.apiBindingState = .verified
                } catch let error as BridgeIOSSHSessionAPIError {
                    guard let self else { return }
                    guard self.apiVerificationGeneration == verificationGeneration,
                          self.boundContext == context else { return }
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
                    self.apiBindingState = .unavailable("Bridge Session API 暂时不可用；SSH 仍可独立使用。")
                }
            }
        }
    }

    func decideHostKey(_ accepted: Bool) {
        let decision = hostKeyDecision
        hostKeyDecision = nil
        pendingHostKey = nil
        decision?(accepted)
        if !accepted {
            session?.disconnect()
            state = .failed("已拒绝此 SSH 主机密钥。")
        }
    }

    func sendComposer() {
        guard let session, state == .connected else {
            composerState = .failed("SSH 尚未连接。")
            return
        }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            composerState = .failed("请输入要发送给 Codex 的内容。")
            return
        }
        guard text.count <= 8_000 else {
            composerState = .failed("消息不能超过 8,000 个字符。")
            return
        }
        composerState = .sending
        let idempotencyKey = UUID().uuidString
        let localAttachments = composerAttachments
        if let context = boundContext, apiBindingState == .verified {
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    var uploaded: [BridgeIOSSHComposerAttachment] = []
                    for attachment in localAttachments {
                        let item = try await BridgeIOSSHSessionAPI.uploadComposerAttachment(
                            context: context,
                            fileURL: attachment.fileURL,
                            fileName: attachment.name,
                            contentType: attachment.contentType,
                        )
                        uploaded.append(item)
                    }
                    let result = try await BridgeIOSSHSessionAPI.sendComposer(
                        context: context,
                        idempotencyKey: idempotencyKey,
                        text: text,
                        attachments: uploaded,
                    )
                    if result.resultUnknown == true {
                        self.composerState = .unknown(result.error ?? "Composer 结果未知，请先查看 Session。")
                    } else if result.ok {
                        self.composerText = ""
                        self.clearComposerAttachments()
                        self.composerState = .sent
                    } else {
                        self.composerState = .failed(result.error ?? "Composer 未发送。")
                    }
                } catch let error as BridgeIOSSHSessionAPIError {
                    switch error {
                    case .resultUnknown(let message):
                        self.composerState = .unknown(message)
                    case .unavailable:
                        if localAttachments.isEmpty { self.sendComposerViaPTY(text, session: session) }
                        else { self.composerState = .failed("附件需要 Bridge API，当前 API 不可用；附件草稿已保留。") }
                    default:
                        self.composerState = .failed(error.localizedDescription)
                    }
                } catch {
                    self.composerState = .failed("Composer 发送失败，请重试。")
                }
            }
            return
        }
        if !localAttachments.isEmpty {
            composerState = .failed("附件需要已绑定的 Bridge API；附件草稿已保留。")
            return
        }
        sendComposerViaPTY(text, session: session)
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
        } catch {
            composerState = .failed("附件无法加入草稿：\(error.localizedDescription)")
        }
    }

    func removeComposerAttachment(_ attachment: BridgeIOSSHLocalComposerAttachment) {
        composerAttachments.removeAll { $0.id == attachment.id }
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

    private func sendComposerViaPTY(_ text: String, session: BridgeIOSSHSession) {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        session.send(Data(("\u{001B}[200~" + normalized + " \u{001B}[201~\r").utf8))
        composerText = ""
        composerState = .sent
    }

    func saveProfile() {
        guard let parsedPort = Int(port), (1...65_535).contains(parsedPort), !host.isEmpty, !username.isEmpty else {
            state = .failed("请先填写有效的主机、端口和用户名。")
            return
        }
        BridgeIOSSHProfileStore.shared.save(host: host, port: parsedPort, username: username,
                                            startupCommand: startupCommand, keyId: selectedKeyId)
        profiles = BridgeIOSSHProfileStore.shared.list()
    }

    func disconnect() {
        apiVerificationGeneration += 1
        hostKeyDecision?(false)
        hostKeyDecision = nil
        pendingHostKey = nil
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
    @State private var isImportingComposerAttachment = false
    @State private var isShowingFiles = false

    init(launch: BridgeIOSSHWorkspaceLaunch, onClose: @escaping (Bool) -> Void) {
        self.launch = launch
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
        .alert("确认 SSH 主机", isPresented: Binding(
            get: { model.pendingHostKey != nil },
            set: { if !$0 { model.decideHostKey(false) } }
        )) {
            Button("信任并继续") { model.decideHostKey(true) }
            Button("拒绝", role: .cancel) { model.decideHostKey(false) }
        } message: {
            Text("首次连接必须确认主机密钥。当前 NIOSSH 只能提供本次连接标识，不是 OpenSSH 标准指纹。\n\n\(model.pendingHostKey ?? "未知")\n\n只在确认目标主机可信时继续。")
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
    }

    private var terminalView: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            if let session = model.session {
                BridgeIOSSHTerminalRepresentable(session: session)
                    .ignoresSafeArea(.container, edges: [.bottom, .leading, .trailing])
            }
            VStack(spacing: 0) {
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
                    Spacer()
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
                .background(.black.opacity(0.84))
                Spacer()
                composerView
                if case .failed(let message) = model.state {
                    HStack(spacing: 8) {
                        Text(message).font(.system(size: 12)).lineLimit(2)
                        Spacer()
                        Button("重连") { model.connect() }.font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(.red.opacity(0.72))
                }
            }
        }
    }

    private var composerView: some View {
        VStack(spacing: 6) {
            if !model.composerAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.composerAttachments) { attachment in
                            HStack(spacing: 4) {
                                Image(systemName: attachment.contentType.hasPrefix("image/") ? "photo" : "doc")
                                Text(attachment.name).lineLimit(1)
                                Button { model.removeComposerAttachment(attachment) } label: {
                                    Image(systemName: "xmark.circle.fill")
                                }
                            }
                            .font(.system(size: 11))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 5)
                            .background(.white.opacity(0.14), in: Capsule())
                        }
                    }
                }
            }
            if let message = composerStateMessage {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(composerStateColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(2)
            }
            HStack(spacing: 8) {
                Button { isImportingComposerAttachment = true } label: {
                    Image(systemName: "paperclip")
                }
                .frame(width: 34, height: 34)
                .buttonStyle(.bordered)
                .disabled(model.state != .connected || model.composerState == .sending)
                TextField("发送消息给 Codex…", text: $model.composerText)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit { model.sendComposer() }
                Button {
                    model.sendComposer()
                } label: {
                    if model.composerState == .sending {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "arrow.up")
                    }
                }
                .frame(width: 36, height: 36)
                .buttonStyle(.borderedProminent)
                .disabled(model.state != .connected || model.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.composerState == .sending)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.black.opacity(0.88))
    }

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
                        Text("已保存的主机").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                        ForEach(model.profiles) { profile in
                            Button { model.select(profile) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "server.rack")
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(profile.label).font(.system(size: 14, weight: .semibold))
                                        Text("\(profile.username)@\(profile.host):\(profile.port)")
                                            .font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if model.bridgeServerOrigin != nil {
                    remoteSessionPickerView
                }

                keyPickerView

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
                Text("私钥只保存在 iOS Keychain，不会进入 WebView、URL 或日志。支持未加密 Ed25519/ECDSA；加密私钥和 RSA 需要先转换。主机指纹不会默认接受，首次连接需要确认。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
                    isImportingKey = true
                } label: {
                    Label("导入", systemImage: "square.and.arrow.down")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.bordered)
            }

            if model.keys.isEmpty {
                Text("尚未导入私钥。选择密码登录，或从“文件”导入未加密的 Ed25519/ECDSA 私钥。")
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
        case .sending: return "正在发送 Composer…"
        case .sent: return "已发送；终端仍可能需要时间开始处理。"
        case .unknown(let message): return message
        case .failed(let message): return message
        }
    }

    private var composerStateColor: SwiftUI.Color {
        switch model.composerState {
        case .sent: return .green
        case .sending: return .yellow
        case .unknown, .failed: return .orange
        case .idle: return .white.opacity(0.7)
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
    private let onUnknownHostKey: (String, @escaping (Bool) -> Void) -> Void

    init(onUnknownHostKey: @escaping (String, @escaping (Bool) -> Void) -> Void) {
        self.onUnknownHostKey = onUnknownHostKey
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let fingerprint = Self.fingerprint(for: hostKey)
        onUnknownHostKey(fingerprint) { accepted in
            if accepted { validationCompletePromise.succeed(()) }
            else { validationCompletePromise.fail(BridgeIOSSHSessionError.hostKeyRejected) }
        }
    }

    private static func fingerprint(for hostKey: NIOSSHPublicKey) -> String {
        // NIOSSH exposes the key as a Hashable verification object, but not its
        // wire bytes. Hash the stable reflected key representation for a
        // user-visible, per-session confirmation label; never accept silently.
        let material = String(reflecting: hostKey)
        let digest = SHA256.hash(data: Data(material.utf8))
        return "本次连接标识：" + Data(digest).base64EncodedString().trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }
}

private final class BridgeIOSSHErrorHandler: ChannelInboundHandler {
    typealias InboundIn = Any
    private let onError: (Error) -> Void

    init(onError: @escaping (Error) -> Void) {
        self.onError = onError
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        onError(error)
        context.close(promise: nil)
    }
}

private final class BridgeIOSSHShellChannelHandler: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    private weak var terminal: BridgeIOSSHTerminalView?
    private let term: String
    private let initialWindowSize: (cols: Int, rows: Int)

    init(terminal: BridgeIOSSHTerminalView?, term: String, initialWindowSize: (cols: Int, rows: Int)) {
        self.terminal = terminal
        self.term = term
        self.initialWindowSize = initialWindowSize
    }

    func handlerAdded(context: ChannelHandlerContext) {
        context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure { error in
            context.fireErrorCaught(error)
        }
    }

    func channelActive(context: ChannelHandlerContext) {
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
            let terminal = terminal
            DispatchQueue.main.async { terminal?.feed(text: "\n[SSH] Session exited with status \(status.exitStatus)\n") }
        } else if let signal = event as? SSHChannelRequestEvent.ExitSignal {
            let terminal = terminal
            DispatchQueue.main.async { terminal?.feed(text: "\n[SSH] Session closed: \(signal.signalName)\n") }
        } else {
            context.fireUserInboundEventTriggered(event)
        }
    }
}

final class BridgeIOSSHSession {
    private let host: String
    private let port: Int
    private let username: String
    private let authentication: BridgeIOSSHAuthentication
    private let startupCommand: String
    private let onState: (BridgeIOSSHSessionState) -> Void
    private let onHostKey: (String, @escaping (Bool) -> Void) -> Void
    private weak var terminal: BridgeIOSSHTerminalView?
    private var group: MultiThreadedEventLoopGroup?
    private var channel: Channel?
    private var sessionChannel: Channel?
    private var sshHandler: NIOSSHHandler?

    init(host: String, port: Int, username: String, authentication: BridgeIOSSHAuthentication, startupCommand: String,
         onState: @escaping (BridgeIOSSHSessionState) -> Void,
         onHostKey: @escaping (String, @escaping (Bool) -> Void) -> Void) {
        self.host = host
        self.port = port
        self.username = username
        self.authentication = authentication
        self.startupCommand = startupCommand
        self.onState = onState
        self.onHostKey = onHostKey
    }

    fileprivate func attach(terminal: BridgeIOSSHTerminalView) {
        self.terminal = terminal
        if case .connected = currentState { sendInitialResize() }
    }

    fileprivate func detach(terminal: BridgeIOSSHTerminalView) {
        if self.terminal === terminal { self.terminal = nil }
    }

    func connect() {
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
        let serverAuthDelegate = BridgeIOSSHHostKeyDelegate(onUnknownHostKey: onHostKey)
        let bootstrap = ClientBootstrap(group: group)
            .channelInitializer { [weak self] channel in
                channel.eventLoop.makeCompletedFuture {
                    let ssh = NIOSSHHandler(
                        role: .client(.init(userAuthDelegate: userAuthDelegate, serverAuthDelegate: serverAuthDelegate)),
                        allocator: channel.allocator,
                        inboundChildChannelInitializer: nil
                    )
                    try channel.pipeline.syncOperations.addHandler(ssh)
                    try channel.pipeline.syncOperations.addHandler(BridgeIOSSHErrorHandler { [weak self] error in
                        self?.failed(error)
                    })
                }
            }
            .channelOption(ChannelOptions.socket(SocketOptionLevel(SOL_SOCKET), SO_REUSEADDR), value: 1)
            .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_NODELAY), value: 1)
        bootstrap.connect(host: host, port: port).whenComplete { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): self.failed(error)
            case .success(let channel):
                self.channel = channel
                self.createSessionChannel(on: channel)
            }
        }
    }

    func send(_ data: Data) {
        guard let sessionChannel else { return }
        sessionChannel.eventLoop.execute {
            var buffer = sessionChannel.allocator.buffer(capacity: data.count)
            buffer.writeBytes(data)
            sessionChannel.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(buffer)), promise: nil)
        }
    }

    func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0, let sessionChannel else { return }
        sessionChannel.eventLoop.execute {
            sessionChannel.triggerUserOutboundEvent(SSHChannelRequestEvent.WindowChangeRequest(
                terminalCharacterWidth: cols, terminalRowHeight: rows,
                terminalPixelWidth: 0, terminalPixelHeight: 0), promise: nil)
        }
    }

    func disconnect() {
        let channel = self.channel
        let group = self.group
        self.channel = nil
        self.sessionChannel = nil
        self.sshHandler = nil
        self.group = nil
        channel?.close(promise: nil)
        if let group { group.shutdownGracefully { _ in } }
    }

    fileprivate func openSFTPClient() -> EventLoopFuture<SFTPClient>? {
        guard let channel, let sshHandler else { return nil }
        return SFTPClient.openChannel(with: sshHandler, on: channel)
    }

    private var currentState: BridgeIOSSHSessionState { sessionChannel == nil ? .connecting : .connected }

    private func createSessionChannel(on channel: Channel) {
        channel.pipeline.handler(type: NIOSSHHandler.self).whenComplete { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): self.failed(error)
            case .success(let sshHandler):
                self.sshHandler = sshHandler
                let promise = channel.eventLoop.makePromise(of: Channel.self)
                sshHandler.createChannel(promise, channelType: .session) { [weak self] child, type in
                    guard let self, type == .session else {
                        return channel.eventLoop.makeFailedFuture(BridgeIOSSHSessionError.invalidChannelType)
                    }
                    let terminal = self.terminal
                    let size = terminal?.getTerminal()
                    return child.eventLoop.makeCompletedFuture {
                        try child.pipeline.syncOperations.addHandler(BridgeIOSSHShellChannelHandler(
                            terminal: terminal, term: "xterm-256color",
                            initialWindowSize: (cols: max(size?.cols ?? 80, 1), rows: max(size?.rows ?? 24, 1))))
                        try child.pipeline.syncOperations.addHandler(BridgeIOSSHErrorHandler { [weak self] error in
                            self?.failed(error)
                        })
                    }
                }
                promise.futureResult.whenComplete { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .failure(let error): self.failed(error)
                    case .success(let child):
                        self.sessionChannel = child
                        self.onState(.connected)
                        self.sendInitialResize()
                        if !self.startupCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                                guard let self else { return }
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
}
