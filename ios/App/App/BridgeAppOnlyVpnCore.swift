#if BRIDGE_APP_ONLY_VPN_POC
import Foundation
import Network
import TunnelKitCore
import TunnelKitOpenVPNCore
import TunnelKitOpenVPNProtocol
import BridgeLwIP

enum BridgeAppOnlyVpnCoreError: LocalizedError {
    case alreadyRunning
    case noRemote
    case unsupportedRemote
    case invalidTunnelAddress
    case missingPushedIPv4
    case tunnelNotReady
    case sessionStopped
    case lwipStartFailed(String)
    case probeFailed(String)
    case webProxyFailed(String)

    var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            return "App-only VPN 已经在运行。"
        case .noRemote:
            return "OpenVPN 配置没有可用的 remote。"
        case .unsupportedRemote:
            return "实验版 App-only VPN 当前只支持 UDP/UDP4 remote。"
        case .invalidTunnelAddress:
            return "OpenVPN 服务端没有返回有效的 IPv4 隧道地址。"
        case .missingPushedIPv4:
            return "服务端没有推送 IPv4 隧道参数，暂时无法初始化 lwIP。"
        case .tunnelNotReady:
            return "App-only VPN 尚未 connected，请先连接并等待状态变为 connected 后再进行 HTTP probe。"
        case .sessionStopped:
            return "OpenVPN 在连接完成前停止，未提供具体错误。"
        case .lwipStartFailed(let message):
            return "lwIP 初始化失败：\(message)"
        case .probeFailed(let message):
            return "HTTP probe 失败：\(message)"
        case .webProxyFailed(let message):
            return "App 内网页代理启动失败：\(message)"
        }
    }
}

private struct BridgeAppOnlyVpnDiagnosticEvent: Codable {
    let at: String
    let stage: String
    let message: String
    let processID: Int32
}

private struct BridgeAppOnlyVpnDiagnosticSnapshot: Codable {
    var runID: String
    var processID: Int32
    var active: Bool
    var stage: String
    var message: String
    var updatedAt: String
    var events: [BridgeAppOnlyVpnDiagnosticEvent]
}

/// Persists only lifecycle stages and sanitized errors so a next launch can
/// explain where a native fatal exit happened. It never stores profile data,
/// usernames, passwords, or server addresses.
final class BridgeAppOnlyVpnDiagnostics {
    static let shared = BridgeAppOnlyVpnDiagnostics()

    private static let key = "BridgeAppOnlyVpnPOC.diagnostics.v1"
    private let defaults = UserDefaults.standard
    private let lock = NSLock()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let fileURL: URL
    private var exceptionHandlerInstalled = false

    private init() {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        fileURL = applicationSupport
            .appendingPathComponent("BridgeAppOnlyVpnPOC", isDirectory: true)
            .appendingPathComponent("diagnostics.json")
    }

    /// Install a last-resort Objective-C exception breadcrumb. Swift
    /// fatalError/SIGABRT still cannot be recovered in-process, but this
    /// handler records exceptions before iOS terminates the process.
    static func installExceptionHandler() {
        shared.installExceptionHandlerIfNeeded()
    }

    private func installExceptionHandlerIfNeeded() {
        lock.lock()
        guard !exceptionHandlerInstalled else {
            lock.unlock()
            return
        }
        exceptionHandlerInstalled = true
        lock.unlock()
        NSSetUncaughtExceptionHandler { exception in
            let name = exception.name.rawValue
            BridgeAppOnlyVpnDiagnostics.shared.record(
                stage: "uncaught_exception",
                message: "未捕获 Objective-C 异常：\(name)",
                active: true
            )
        }
    }

    func begin() {
        lock.lock()
        defer { lock.unlock() }
        var snapshot = BridgeAppOnlyVpnDiagnosticSnapshot(
            runID: UUID().uuidString,
            processID: ProcessInfo.processInfo.processIdentifier,
            active: true,
            stage: "start_requested",
            message: "连接流程已开始。",
            updatedAt: Self.timestamp(),
            events: []
        )
        append(stage: snapshot.stage, message: snapshot.message, to: &snapshot)
        save(snapshot)
    }

    func record(stage: String, message: String, active: Bool? = nil) {
        lock.lock()
        defer { lock.unlock() }
        var snapshot = load() ?? BridgeAppOnlyVpnDiagnosticSnapshot(
            runID: UUID().uuidString,
            processID: ProcessInfo.processInfo.processIdentifier,
            active: true,
            stage: "unknown",
            message: "未记录连接阶段。",
            updatedAt: Self.timestamp(),
            events: []
        )
        snapshot.processID = ProcessInfo.processInfo.processIdentifier
        snapshot.active = active ?? snapshot.active
        snapshot.stage = stage
        snapshot.message = message
        snapshot.updatedAt = Self.timestamp()
        append(stage: stage, message: message, to: &snapshot)
        save(snapshot)
    }

    func status() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard let snapshot = load() else {
            return [
                "active": false,
                "previousProcessAbnormal": false,
                "snapshotAvailable": false,
                "storage": "Application Support/BridgeAppOnlyVpnPOC/diagnostics.json",
                "lastStage": "none",
                "lastMessage": "没有可读取的持久化连接记录。",
                "currentProcessID": ProcessInfo.processInfo.processIdentifier,
                "events": [],
            ]
        }
        let currentProcessID = ProcessInfo.processInfo.processIdentifier
        return [
            "active": snapshot.active,
            "previousProcessAbnormal": snapshot.active && snapshot.processID != currentProcessID,
            "snapshotAvailable": true,
            "storage": "Application Support/BridgeAppOnlyVpnPOC/diagnostics.json",
            "runID": snapshot.runID,
            "processID": snapshot.processID,
            "currentProcessID": currentProcessID,
            "lastStage": snapshot.stage,
            "lastMessage": snapshot.message,
            "updatedAt": snapshot.updatedAt,
            "events": snapshot.events.map { [
                "at": $0.at,
                "stage": $0.stage,
                "message": $0.message,
                "processID": $0.processID,
            ] },
        ]
    }

    private func append(stage: String, message: String, to snapshot: inout BridgeAppOnlyVpnDiagnosticSnapshot) {
        snapshot.events.append(BridgeAppOnlyVpnDiagnosticEvent(
            at: snapshot.updatedAt,
            stage: stage,
            message: message,
            processID: snapshot.processID
        ))
        if snapshot.events.count > 40 {
            snapshot.events.removeFirst(snapshot.events.count - 40)
        }
    }

    private func load() -> BridgeAppOnlyVpnDiagnosticSnapshot? {
        if let data = try? Data(contentsOf: fileURL),
           let snapshot = try? decoder.decode(BridgeAppOnlyVpnDiagnosticSnapshot.self, from: data) {
            return snapshot
        }
        guard let data = defaults.data(forKey: Self.key) else { return nil }
        return try? decoder.decode(BridgeAppOnlyVpnDiagnosticSnapshot.self, from: data)
    }

    private func save(_ snapshot: BridgeAppOnlyVpnDiagnosticSnapshot) {
        guard let data = try? encoder.encode(snapshot) else { return }
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            // Keep the UserDefaults fallback even if the durable file cannot
            // be created on an unusual device state.
        }
        defaults.set(data, forKey: Self.key)
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

enum BridgeAppOnlyVpnCoreState: String {
    case idle
    case connecting
    case connected
    case stopping
    case failed
}

final class BridgeAppOnlyMemoryTunnel: TunnelInterface {
    let isPersistent = false

    private let stateQueue = DispatchQueue(label: "dev.feishu.codex.bridge.app-only-tunnel")
    private var readHandler: (([Data]?, Error?) -> Void)?
    var onWrite: (([Data]) -> Void)?

    func setReadHandler(queue: DispatchQueue, _ handler: @escaping ([Data]?, Error?) -> Void) {
        stateQueue.sync {
            readHandler = { packets, error in
                queue.async {
                    handler(packets, error)
                }
            }
        }
    }

    func writePacket(_ packet: Data, completionHandler: ((Error?) -> Void)?) {
        writePackets([packet], completionHandler: completionHandler)
    }

    func writePackets(_ packets: [Data], completionHandler: ((Error?) -> Void)?) {
        onWrite?(packets)
        completionHandler?(nil)
    }

    func deliver(_ packets: [Data]) {
        let handler = stateQueue.sync { readHandler }
        handler?(packets, nil)
    }
}

final class BridgeAppOnlyUDPLink: LinkInterface {
    let isReliable = false
    let remoteAddress: String?
    let remoteProtocol: String?
    let packetBufferSize = 64 * 1024

    private let connection: NWConnection
    private let connectionQueue: DispatchQueue
    private let stateQueue = DispatchQueue(label: "dev.feishu.codex.bridge.app-only-link")
    private var readHandler: (([Data]?, Error?) -> Void)?
    private var readyHandler: ((Result<Void, Error>) -> Void)?
    private var started = false

    init(endpoint: Endpoint) throws {
        guard endpoint.proto.socketType == .udp || endpoint.proto.socketType == .udp4 else {
            throw BridgeAppOnlyVpnCoreError.unsupportedRemote
        }
        guard let port = NWEndpoint.Port(rawValue: endpoint.proto.port) else {
            throw BridgeAppOnlyVpnCoreError.noRemote
        }
        remoteAddress = endpoint.address
        remoteProtocol = endpoint.proto.socketType.rawValue
        connectionQueue = DispatchQueue(label: "dev.feishu.codex.bridge.app-only-link.io", qos: .utility)
        connection = NWConnection(
            host: NWEndpoint.Host(endpoint.address),
            port: port,
            using: NWParameters.udp
        )
    }

    func activate(completion: @escaping (Result<Void, Error>) -> Void) {
        stateQueue.sync {
            readyHandler = completion
            guard !started else { return }
            started = true
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.stateQueue.sync {
                        self.readyHandler?(.success(()))
                        self.readyHandler = nil
                    }
                    self.receiveNext()
                case .failed(let error):
                    self.stateQueue.sync {
                        self.readyHandler?(.failure(error))
                        self.readyHandler = nil
                        self.readHandler?(nil, error)
                    }
                case .cancelled:
                    self.stateQueue.sync {
                        self.readHandler?(nil, CancellationError())
                    }
                default:
                    break
                }
            }
            connection.start(queue: connectionQueue)
        }
    }

    func setReadHandler(queue: DispatchQueue, _ handler: @escaping ([Data]?, Error?) -> Void) {
        stateQueue.sync {
            readHandler = { packets, error in
                queue.async {
                    handler(packets, error)
                }
            }
        }
    }

    func writePacket(_ packet: Data, completionHandler: ((Error?) -> Void)?) {
        connection.send(content: packet, completion: .contentProcessed { error in
            completionHandler?(error)
        })
    }

    func writePackets(_ packets: [Data], completionHandler: ((Error?) -> Void)?) {
        guard !packets.isEmpty else {
            // Never complete synchronously on the caller's queue. TunnelKit
            // may submit an empty flush while it is already on its serial
            // core queue; a synchronous callback would make its queue.sync
            // completion path trap in libdispatch.
            connectionQueue.async {
                completionHandler?(nil)
            }
            return
        }
        let group = DispatchGroup()
        var firstError: Error?
        let errorQueue = DispatchQueue(label: "dev.feishu.codex.bridge.app-only-link.errors")
        for packet in packets {
            group.enter()
            connection.send(content: packet, completion: .contentProcessed { error in
                if let error {
                    errorQueue.sync { firstError = firstError ?? error }
                }
                group.leave()
            })
        }
        group.notify(queue: connectionQueue) {
            completionHandler?(firstError)
        }
    }

    func cancel() {
        connection.cancel()
    }

    private func receiveNext() {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                let handler = self.stateQueue.sync { self.readHandler }
                handler?([data], nil)
            }
            if let error {
                let handler = self.stateQueue.sync { self.readHandler }
                handler?(nil, error)
                return
            }
            self.receiveNext()
        }
    }
}

private func bridgeAppOnlyLwIPOutput(
    _ packet: UnsafePointer<UInt8>?,
    _ length: Int,
    _ context: UnsafeMutableRawPointer?
) {
    guard let packet, length > 0, let context else { return }
    let tunnel = Unmanaged<BridgeAppOnlyMemoryTunnel>.fromOpaque(context).takeUnretainedValue()
    tunnel.deliver([Data(bytes: packet, count: length)])
}

final class BridgeAppOnlyVpnCore: NSObject, OpenVPNSessionDelegate {
    static let shared = BridgeAppOnlyVpnCore()

    private let stateQueue = DispatchQueue(label: "dev.feishu.codex.bridge.app-only-core", qos: .utility)
    private let probeQueue = DispatchQueue(label: "dev.feishu.codex.bridge.app-only-probe", qos: .utility)
    private let diagnostics = BridgeAppOnlyVpnDiagnostics.shared
    private var state: BridgeAppOnlyVpnCoreState = .idle
    private var lastError: String?
    private var session: OpenVPNSession?
    private var link: BridgeAppOnlyUDPLink?
    private var tunnel: BridgeAppOnlyMemoryTunnel?
    private var startCompletion: ((Result<Void, Error>) -> Void)?
    private var webProxyPort: Int?

    func status() -> [String: Any] {
        stateQueue.sync {
            var result: [String: Any] = [
                "state": state.rawValue,
                "lastError": lastError as Any,
                "transport": "TunnelKitCore + lwIP MemoryNetif",
                "networkExtension": false,
                "ipv6": false,
            ]
            if let webProxyPort {
                result["webProxyOrigin"] = "http://127.0.0.1:\(webProxyPort)"
            } else {
                result["webProxyOrigin"] = NSNull()
            }
            result["diagnostics"] = diagnostics.status()
            return result
        }
    }

    func start(
        configuration: OpenVPN.Configuration,
        credentials: OpenVPN.Credentials?,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        stateQueue.async {
            guard self.state == .idle || self.state == .failed else {
                self.diagnostics.record(stage: "start_rejected", message: "连接流程已在运行。", active: true)
                completion(.failure(BridgeAppOnlyVpnCoreError.alreadyRunning))
                return
            }
            self.diagnostics.begin()
            guard let endpoint = configuration.processedRemotes?.first else {
                self.diagnostics.record(stage: "configuration_invalid", message: "配置没有可用的 remote。", active: false)
                completion(.failure(BridgeAppOnlyVpnCoreError.noRemote))
                return
            }
            do {
                self.diagnostics.record(stage: "remote_selected", message: "已选择 OpenVPN remote。")
                self.diagnostics.record(stage: "link_creating", message: "正在创建 UDP 链路。")
                let link = try BridgeAppOnlyUDPLink(endpoint: endpoint)
                self.diagnostics.record(stage: "link_created", message: "UDP 链路已创建。")
                let tunnel = BridgeAppOnlyMemoryTunnel()
                self.diagnostics.record(stage: "random_generator_initializing", message: "正在初始化 OpenVPN 随机数生成器。")
                guard OpenVPN.prepareRandomNumberGenerator(seedLength: 64) else {
                    throw BridgeAppOnlyVpnCoreError.probeFailed("无法初始化随机数生成器")
                }
                self.diagnostics.record(stage: "cache_preparing", message: "正在准备 OpenVPN 缓存目录。")
                let cacheURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("BridgeAppOnlyVpnPOC", isDirectory: true)
                try FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: true)
                self.diagnostics.record(stage: "session_creating", message: "正在创建 OpenVPN session。")
                let session = try OpenVPNSession(
                    queue: self.stateQueue,
                    configuration: configuration,
                    cachesURL: cacheURL
                )
                self.diagnostics.record(stage: "session_created", message: "OpenVPN session 已创建。")
                session.diagnosticHandler = { [weak self] stage in
                    self?.diagnostics.record(stage: "tunnelkit_\(stage)", message: Self.diagnosticMessage(stage))
                }
                session.credentials = credentials
                self.diagnostics.record(stage: "credentials_attached", message: "OpenVPN 凭据已交给 session。")
                if let credentials {
                    let password = credentials.password
                    let isASCII = password.unicodeScalars.allSatisfy { $0.value <= 0x7f }
                    self.diagnostics.record(
                        stage: "password_encoding_checked",
                        message: "密码 ASCII：\(isASCII ? "是" : "否")；字符数：\(password.count)；UTF-8 字节数：\(password.utf8.count)。"
                    )
                }
                session.delegate = self
                self.session = session
                self.link = link
                self.tunnel = tunnel
                self.startCompletion = completion
                self.state = .connecting
                self.lastError = nil
                self.diagnostics.record(stage: "connecting", message: "正在等待 OpenVPN 握手。")
                tunnel.onWrite = { packets in
                    for packet in packets {
                        _ = packet.withUnsafeBytes { bytes in
                            bridge_lwip_input_packet(
                                bytes.bindMemory(to: UInt8.self).baseAddress,
                                packet.count
                            )
                        }
                    }
                }
                self.diagnostics.record(stage: "link_activating", message: "正在启动 UDP 链路。")
                link.activate { result in
                    switch result {
                    case .success:
                        self.diagnostics.record(stage: "link_ready", message: "UDP 链路已 ready。")
                        // OpenVPNSession owns its mutable state on stateQueue;
                        // do not attach the link from Network.framework's
                        // callback queue.
                        self.stateQueue.async {
                            guard self.state == .connecting, self.session === session else { return }
                            session.setLink(link)
                            self.diagnostics.record(stage: "session_link_attached", message: "OpenVPN session 已绑定 UDP 链路。")
                        }
                    case .failure(let error):
                        self.fail(error)
                    }
                }
            } catch {
                self.state = .failed
                self.lastError = error.localizedDescription
                self.diagnostics.record(stage: "failed", message: Self.safeDiagnosticError(error), active: false)
                completion(.failure(error))
            }
        }
    }

    func stop() {
        stateQueue.async {
            self.diagnostics.record(stage: "stopping", message: "用户请求停止连接。", active: false)
            self.state = .stopping
            self.session?.shutdown(error: nil)
            self.session?.diagnosticHandler = nil
            self.link?.cancel()
            bridge_lwip_stop()
            self.webProxyPort = nil
            self.session = nil
            self.link = nil
            self.tunnel = nil
            self.startCompletion = nil
            self.state = .idle
        }
    }

    func startWebProxy(
        address: String,
        port: UInt16,
        token: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        stateQueue.async {
            guard self.state == .connected else {
                completion(.failure(BridgeAppOnlyVpnCoreError.tunnelNotReady))
                return
            }
            bridge_lwip_proxy_stop()
            self.webProxyPort = nil
            let localPort = address.withCString { addressPointer in
                token.withCString { tokenPointer in
                    bridge_lwip_proxy_start(addressPointer, port, tokenPointer)
                }
            }
            guard localPort > 0 else {
                completion(.failure(BridgeAppOnlyVpnCoreError.webProxyFailed("无法监听 App 本地回环端口。")))
                return
            }
            self.webProxyPort = Int(localPort)
            self.diagnostics.record(stage: "web_proxy_started", message: "App 内 WebView 代理已启动。")
            completion(.success("http://127.0.0.1:\(localPort)"))
        }
    }

    func stopWebProxy(completion: @escaping () -> Void) {
        stateQueue.async {
            bridge_lwip_proxy_stop()
            self.webProxyPort = nil
            self.diagnostics.record(stage: "web_proxy_stopped", message: "App 内 WebView 代理已停止。")
            completion()
        }
    }

    func probeHTTP(
        address: String,
        port: UInt16,
        path: String,
        timeoutMs: UInt32,
        completion: @escaping (Result<Data, Error>) -> Void
    ) {
        probeQueue.async {
            let connected = self.stateQueue.sync { self.state == .connected }
            guard connected else {
                completion(.failure(BridgeAppOnlyVpnCoreError.tunnelNotReady))
                return
            }
            let request = "GET \(path) HTTP/1.1\r\nHost: \(address)\r\nConnection: close\r\nUser-Agent: Bridge-AppOnly-VPN-POC\r\n\r\n"
            let responseCapacity = 128 * 1024
            var response = Data(count: responseCapacity)
            let result = response.withUnsafeMutableBytes { responseBytes in
                request.withCString { requestCString in
                    bridge_lwip_http_probe_ipv4(
                        address,
                        port,
                        UnsafePointer<UInt8>(OpaquePointer(requestCString)),
                        request.utf8.count,
                        responseBytes.bindMemory(to: UInt8.self).baseAddress,
                        responseCapacity,
                        timeoutMs
                    )
                }
            }
            guard result >= 0 else {
                let message = String(cString: bridge_lwip_last_error())
                completion(.failure(BridgeAppOnlyVpnCoreError.probeFailed(message)))
                return
            }
            response.count = Int(result)
            completion(.success(response))
        }
    }

    func sessionDidStart(
        _ session: OpenVPNSession,
        remoteAddress: String,
        remoteProtocol: String?,
        options: OpenVPN.Configuration
    ) {
        stateQueue.async {
            guard self.session === session, self.state == .connecting else { return }
            self.diagnostics.record(stage: "session_started", message: "OpenVPN 握手完成，开始初始化 lwIP。")
            guard let ipv4 = options.ipv4,
                  !ipv4.address.isEmpty,
                  !ipv4.addressMask.isEmpty,
                  !ipv4.defaultGateway.isEmpty,
                  let tunnel = self.tunnel else {
                self.fail(BridgeAppOnlyVpnCoreError.missingPushedIPv4)
                return
            }
            self.diagnostics.record(stage: "lwip_starting", message: "正在初始化 lwIP 隧道。")
            let result = ipv4.address.withCString { address in
                ipv4.addressMask.withCString { mask in
                    ipv4.defaultGateway.withCString { gateway in
                        var config = bridge_lwip_config(
                            local_address: address,
                            address_mask: mask,
                            gateway_address: gateway,
                            mtu: UInt16(options.mtu ?? 1400)
                        )
                        return bridge_lwip_start(
                            &config,
                            bridgeAppOnlyLwIPOutput,
                            Unmanaged.passUnretained(tunnel).toOpaque()
                        )
                    }
                }
            }
            guard result == 0 else {
                self.fail(BridgeAppOnlyVpnCoreError.lwipStartFailed(String(cString: bridge_lwip_last_error())))
                return
            }
            session.setTunnel(tunnel: tunnel)
            self.state = .connected
            self.diagnostics.record(stage: "connected", message: "OpenVPN 和 lwIP 均已 ready。", active: true)
            self.startCompletion?(.success(()))
            self.startCompletion = nil
        }
    }

    func sessionDidStop(_ session: OpenVPNSession, withError error: Error?, shouldReconnect: Bool) {
        stateQueue.async {
            guard self.session === session else { return }
            if let error {
                let reason = Self.safeDiagnosticError(error)
                self.diagnostics.record(stage: "session_stopped", message: "\(reason)；建议重连：\(shouldReconnect ? "是" : "否")。", active: false)
                self.fail(error)
            } else if self.state == .connecting {
                self.fail(BridgeAppOnlyVpnCoreError.sessionStopped)
            } else {
                self.state = .idle
                self.diagnostics.record(stage: "stopped", message: "连接已停止。", active: false)
            }
            bridge_lwip_stop()
            self.webProxyPort = nil
            self.link?.cancel()
            self.session?.diagnosticHandler = nil
            self.session = nil
            self.link = nil
            self.tunnel = nil
        }
    }

    private func fail(_ error: Error) {
        stateQueue.async {
            self.state = .failed
            self.lastError = error.localizedDescription
            self.diagnostics.record(stage: "failed", message: Self.safeDiagnosticError(error), active: false)
            self.link?.cancel()
            bridge_lwip_stop()
            self.webProxyPort = nil
            self.session?.diagnosticHandler = nil
            self.session = nil
            self.link = nil
            self.tunnel = nil
            self.startCompletion?(.failure(error))
            self.startCompletion = nil
        }
    }

    static func safeDiagnosticError(_ error: Error) -> String {
        if let error = error as? OpenVPNError {
            switch error {
            case .badCredentials: return "服务器拒绝认证，请检查凭据或账号状态。"
            case .controlChannel: return "OpenVPN 控制通道发生错误。"
            default: return error.localizedDescription
            }
        }
        if let error = error as? BridgeAppOnlyVpnCoreError {
            switch error {
            case .lwipStartFailed(let message):
                if message.hasPrefix("sem_init:") { return "lwIP 初始化失败：\(message)" }
                return "lwIP 隧道初始化失败。"
            case .probeFailed: return "网络探测失败。"
            default: return error.localizedDescription
            }
        }
        let nsError = error as NSError
        return "原生连接错误（代码 \(nsError.code)）。"
    }

    private static func diagnosticMessage(_ stage: String) -> String {
        switch stage {
        case "link_set": return "已绑定 UDP 链路，开始 OpenVPN 握手。"
        case "hard_reset_started": return "正在初始化 OpenVPN 控制通道。"
        case "hard_reset_sent": return "已发送初始握手包，等待服务器响应。"
        case "tls_connected": return "TLS 握手完成，正在准备身份认证。"
        case "authentication_sending": return "正在准备并发送身份认证。"
        case "authentication_sent": return "身份认证数据已提交，等待服务器响应。"
        case "authentication_reply_received": return "已收到服务器认证阶段响应，正在等待隧道配置。"
        case "authentication_rejected": return "服务器拒绝认证；请检查凭据或账号状态。"
        case "push_reply_received": return "已收到服务器推送的隧道配置。"
        case "encryption_setup_started": return "正在初始化数据通道加密。"
        case "encryption_setup_complete": return "数据通道加密初始化完成。"
        case "connection_complete": return "OpenVPN 协商完成，准备初始化本地网络。"
        case "stop_requested": return "OpenVPN 会话正在停止，等待具体原因。"
        default: return "TunnelKit 阶段：\(stage)"
        }
    }
}
#endif
