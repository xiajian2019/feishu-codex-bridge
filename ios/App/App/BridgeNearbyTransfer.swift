import Capacitor
import Foundation
import Network
import UIKit
import UniformTypeIdentifiers

@objc(BridgeNearbyTransferPlugin)
public final class BridgeNearbyTransferPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, UIDocumentInteractionControllerDelegate {
    public let identifier = "BridgeNearbyTransferPlugin"
    public let jsName = "BridgeNearbyTransfer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNetworkInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rejectConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rejectFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listReceived", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openReceived", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteReceived", returnType: CAPPluginReturnPromise),
    ]

    private lazy var implementation = BridgeNearbyTransferCore(plugin: self)
    private var pendingPicker: CAPPluginCall?
    private var documentInteractionController: UIDocumentInteractionController?
    private var selections: [String: NearbyFileSelection] = [:]
    private let selectionLock = NSLock()

    @objc func startServer(_ call: CAPPluginCall) {
        let name = Self.safeDisplayName(call.getString("displayName"))
        let port = call.getInt("port") ?? BridgeNearbyTransferCore.defaultPort
        // Keep the Capacitor call alive until the Network.framework listener has
        // been created. A weak capture can deallocate the call before the
        // asynchronous NWListener setup completes, leaving JavaScript waiting
        // forever even though the TCP listener is already ready.
        implementation.startServer(displayName: name, port: port) { [call] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let info):
                    print("[BridgeNearbyTransfer] server.resolve: resolving Capacitor startServer call")
                    call.resolve(info)
                case .failure(let error):
                    print("[BridgeNearbyTransfer] server.reject: \(error.localizedDescription)")
                    call.reject(error.localizedDescription, "NEARBY_SERVER_FAILED")
                }
            }
        }
    }

    @objc func stopServer(_ call: CAPPluginCall) {
        implementation.stopServer()
        call.resolve()
    }

    @objc func startDiscovery(_ call: CAPPluginCall) {
        implementation.startDiscovery()
        call.resolve()
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        implementation.stopDiscovery()
        call.resolve()
    }

    @objc func getNetworkInfo(_ call: CAPPluginCall) {
        call.resolve(implementation.networkInfo())
    }

    @objc func connect(_ call: CAPPluginCall) {
        let peerID = Self.trim(call.getString("peerId"))
        let host = Self.trim(call.getString("host"))
        let port = call.getInt("port")
        let token = Self.trim(call.getString("token"))
        let name = Self.safeDisplayName(call.getString("name"), fallback: "附近设备")
        let source = call.getString("source") == "hotspot" ? "hotspot" : "mdns"
        do {
            let id = try implementation.connect(peerID: peerID, host: host, port: port, token: token, name: name, source: source)
            call.resolve(["connectionId": id])
        } catch {
            call.reject(error.localizedDescription, "NEARBY_CONNECT_FAILED")
        }
    }

    @objc func pickFile(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self, call] in
            guard let self else { return }
            guard self.pendingPicker == nil else { call.reject("已有一个文件选择器正在打开。", "NEARBY_PICKER_BUSY"); return }
            guard let presenter = self.bridge?.viewController else { call.reject("无法打开文件选择器。", "NEARBY_PICKER_UNAVAILABLE"); return }
            self.pendingPicker = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            presenter.present(picker, animated: true)
        }
    }

    @objc func acceptConnection(_ call: CAPPluginCall) {
        do { try implementation.acceptConnection(Self.required(call, "connectionId")); call.resolve() }
        catch { call.reject(error.localizedDescription, "NEARBY_CONNECTION_FAILED") }
    }

    @objc func rejectConnection(_ call: CAPPluginCall) {
        do { try implementation.rejectConnection(Self.required(call, "connectionId")); call.resolve() }
        catch { call.reject(error.localizedDescription, "NEARBY_CONNECTION_FAILED") }
    }

    @objc func beginFile(_ call: CAPPluginCall) {
        do {
            let selection = try selection(Self.required(call, "selectionId"))
            try implementation.beginFile(
                connectionID: Self.required(call, "connectionId"),
                transferID: Self.required(call, "transferId"),
                fileName: selection.fileName,
                mimeType: selection.mimeType,
                size: selection.size
            )
            call.resolve()
        } catch { call.reject(error.localizedDescription, "NEARBY_FILE_FAILED") }
    }

    @objc func sendFile(_ call: CAPPluginCall) {
        do {
            let selectionID = try Self.required(call, "selectionId")
            let selection = try selection(selectionID)
            try implementation.sendFile(connectionID: Self.required(call, "connectionId"), transferID: Self.required(call, "transferId"), selection: selection) { [weak self, call] result in
                DispatchQueue.main.async {
                    switch result {
                    case .success:
                        self?.removeSelection(selectionID)
                        call.resolve()
                    case .failure(let error):
                        call.reject(error.localizedDescription, "NEARBY_FILE_FAILED")
                    }
                }
            }
        } catch { call.reject(error.localizedDescription, "NEARBY_FILE_FAILED") }
    }

    @objc func sendChunk(_ call: CAPPluginCall) {
        do {
            try implementation.sendChunk(
                connectionID: Self.required(call, "connectionId"),
                transferID: Self.required(call, "transferId"),
                dataBase64: Self.required(call, "dataBase64"),
                isFinal: call.getBool("final") ?? false
            )
            call.resolve()
        } catch { call.reject(error.localizedDescription, "NEARBY_FILE_FAILED") }
    }

    @objc func acceptFile(_ call: CAPPluginCall) {
        do { try implementation.acceptFile(connectionID: Self.required(call, "connectionId"), transferID: Self.required(call, "transferId")); call.resolve() }
        catch { call.reject(error.localizedDescription, "NEARBY_FILE_FAILED") }
    }

    @objc func rejectFile(_ call: CAPPluginCall) {
        do { try implementation.rejectFile(connectionID: Self.required(call, "connectionId"), transferID: Self.required(call, "transferId")); call.resolve() }
        catch { call.reject(error.localizedDescription, "NEARBY_FILE_FAILED") }
    }

    @objc func listReceived(_ call: CAPPluginCall) {
        call.resolve(["files": implementation.listReceived()])
    }

    @objc func openReceived(_ call: CAPPluginCall) {
        do {
            let url = try implementation.receivedFileURL(Self.required(call, "id"))
            DispatchQueue.main.async { [weak self, call] in
                guard let self, let presenter = self.bridge?.viewController else {
                    call.reject("无法打开系统文件查看器。", "NEARBY_FILE_OPEN_FAILED")
                    return
                }
                let controller = UIDocumentInteractionController(url: url)
                controller.delegate = self
                self.documentInteractionController = controller
                if controller.presentPreview(animated: true) || controller.presentOpenInMenu(from: presenter.view.bounds, in: presenter.view, animated: true) {
                    call.resolve()
                } else {
                    self.documentInteractionController = nil
                    call.reject("设备上没有可查看此文件的应用。", "NEARBY_FILE_OPEN_FAILED")
                }
            }
        } catch {
            call.reject(error.localizedDescription, "NEARBY_FILE_OPEN_FAILED")
        }
    }

    @objc func deleteReceived(_ call: CAPPluginCall) {
        do { try implementation.deleteReceived(Self.required(call, "id")); call.resolve() }
        catch { call.reject(error.localizedDescription, "NEARBY_FILE_FAILED") }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let call = pendingPicker
        pendingPicker = nil
        call?.reject("已取消选择文件。", "NEARBY_PICKER_CANCELLED")
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPicker, let url = urls.first else {
            documentPickerWasCancelled(controller)
            return
        }
        pendingPicker = nil
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .nameKey, .contentTypeKey])
            guard let size = values.fileSize else { throw NearbyTransferError.transfer("文件提供方没有返回文件大小，暂不支持直接流式发送。") }
            guard size >= 0, Int64(size) <= 1_073_741_824 else { throw NearbyTransferError.transfer("文件大小超过附近传输限制。") }
            let fileName = Self.safeFileName(values.name ?? url.lastPathComponent)
            let mimeType = Self.safeMime(values.contentType?.preferredMIMEType)
            let selectionID = UUID().uuidString.lowercased()
            let selection = NearbyFileSelection(url: url, fileName: fileName, mimeType: mimeType, size: Int64(size))
            selectionLock.lock(); selections[selectionID] = selection; selectionLock.unlock()
            call.resolve(["selectionId": selectionID, "fileName": fileName, "mimeType": mimeType, "size": Int64(size)])
        } catch { call.reject(error.localizedDescription, "NEARBY_PICKER_FAILED") }
    }

    private func selection(_ id: String) throws -> NearbyFileSelection {
        selectionLock.lock(); defer { selectionLock.unlock() }
        guard let selection = selections[id] else { throw NearbyTransferError.transfer("文件选择已失效，请重新选择文件。") }
        return selection
    }

    private func removeSelection(_ id: String) {
        selectionLock.lock(); let selection = selections.removeValue(forKey: id); selectionLock.unlock()
        if let url = selection?.url { try? FileManager.default.removeItem(at: url) }
    }

    deinit { implementation.close() }

    private static func trim(_ value: String?) -> String { value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }

    fileprivate static func safeDisplayName(_ value: String?, fallback: String = UIDevice.current.name) -> String {
        let result = trim(value).filter { !$0.isNewline && !isControl($0) }
        let fallbackName = trim(fallback).filter { !$0.isNewline && !isControl($0) }
        let candidate = result.isEmpty ? fallbackName : result
        return candidate.isEmpty ? "iPhone" : String(candidate.prefix(80))
    }

    fileprivate static func safeFileName(_ value: String) -> String {
        let replaced = value.map { character -> Character in
            if character == "/" || character == "\\" || character.isNewline || isControl(character) { return "_" }
            return character
        }
        let result = String(replaced).trimmingCharacters(in: .whitespacesAndNewlines)
        if result.isEmpty || result == "." || result == ".." { return "received-file" }
        return String(result.prefix(180))
    }

    fileprivate static func safeMime(_ value: String?) -> String {
        let result = trim(value)
        return result.isEmpty ? "application/octet-stream" : String(result.prefix(120))
    }

    private static func isControl(_ character: Character) -> Bool {
        character.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }

    private static func required(_ call: CAPPluginCall, _ key: String) throws -> String {
        let value = trim(call.getString(key))
        guard !value.isEmpty else { throw NearbyTransferError.invalidArgument("\(key) 不能为空。") }
        return value
    }

    public func documentInteractionControllerViewControllerForPreview(_ controller: UIDocumentInteractionController) -> UIViewController {
        bridge?.viewController ?? UIViewController()
    }

    public func documentInteractionControllerDidEndPreview(_ controller: UIDocumentInteractionController) {
        if documentInteractionController === controller { documentInteractionController = nil }
    }

}

private enum NearbyTransferError: LocalizedError {
    case invalidArgument(String)
    case unavailable(String)
    case transfer(String)

    var errorDescription: String? {
        switch self {
        case .invalidArgument(let message), .unavailable(let message), .transfer(let message): return message
        }
    }
}

private struct NearbyFileSelection {
    let url: URL
    let fileName: String
    let mimeType: String
    let size: Int64
}

private final class BridgeNearbyTransferCore {
    static let serviceType = "_bridge-nearby._tcp"
    static let defaultPort = 43_891
    private static let maxFileBytes: Int64 = 1_073_741_824
    private static let maxFrameBytes = 1_400_000

    fileprivate weak var plugin: BridgeNearbyTransferPlugin?
    private let queue = DispatchQueue(label: "dev.feishu.codex.bridge.nearby", qos: .userInitiated)
    private let fileManager = FileManager.default
    fileprivate let deviceID = UUID().uuidString.lowercased()
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var browserResults: [String: NWBrowser.Result] = [:]
    private var connections: [String: BridgeNearbyConnection] = [:]
    fileprivate var displayName = UIDevice.current.name
    private var serviceName = ""
    fileprivate var token = ""
    private var serverPort: Int = 0
    private var receiveRoot: URL {
        fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("bridge-downloads/nearby", isDirectory: true)
    }

    init(plugin: BridgeNearbyTransferPlugin) { self.plugin = plugin }

    fileprivate func diagnostic(_ level: String = "info", _ phase: String, _ message: String, connectionID: String? = nil, transferID: String? = nil) {
        let line = "[BridgeNearbyTransfer] \(phase): \(message)"
        print(line)
        var event: [String: Any] = [
            "timestamp": Int(Date().timeIntervalSince1970 * 1_000),
            "level": level,
            "phase": phase,
            "message": message,
        ]
        if let connectionID { event["connectionId"] = connectionID }
        if let transferID { event["transferId"] = transferID }
        plugin?.notifyListeners("diagnostic", data: event)
    }

    func startServer(displayName: String, port: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard (1 ... 65_535).contains(port), let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            completion(.failure(NearbyTransferError.invalidArgument("端口无效。")))
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            self.diagnostic("info", "server.start", "requested port=\(port)")
            if self.listener != nil && self.serverPort == port && self.displayName == displayName && !self.token.isEmpty {
                self.diagnostic("debug", "server.reuse", "reusing existing listener port=\(self.serverPort)")
                completion(.success(["deviceId": self.deviceID, "displayName": self.displayName, "port": self.serverPort, "token": self.token]))
                return
            }
            self.stopServerOnQueue()
            self.displayName = displayName
            self.token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            self.serviceName = "BridgeNearby-" + String(self.deviceID.prefix(8))
            do {
                let parameters = NWParameters.tcp
                parameters.includePeerToPeer = true
                let listener = try NWListener(using: parameters, on: nwPort)
                listener.service = NWListener.Service(
                    name: self.serviceName,
                    type: Self.serviceType,
                    domain: "local.",
                    txtRecord: Self.txtRecord(["protocol": "1", "name": displayName, "deviceId": self.deviceID, "platform": "ios", "token": self.token])
                )
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self, let listener else { return }
                    switch state {
                    case .ready:
                        self.diagnostic("info", "server.ready", "port=\(listener.port?.rawValue ?? UInt16(port))")
                    case .waiting(let error):
                        self.diagnostic("error", "server.waiting", error.localizedDescription)
                    case .failed(let error):
                        self.diagnostic("error", "server.failed", error.localizedDescription)
                        self.emitError(code: "NEARBY_SERVER_FAILED", message: error.localizedDescription)
                        self.listener = nil
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    self?.accept(connection: connection)
                }
                self.listener = listener
                listener.start(queue: self.queue)
                self.serverPort = port
                self.diagnostic("debug", "server.started", "listener created; waiting for Network framework state")
                completion(.success([
                    "deviceId": self.deviceID,
                    "displayName": self.displayName,
                    "port": port,
                    "token": self.token,
                ]))
            } catch { completion(.failure(error)) }
        }
    }

    func stopServer() { queue.async { [weak self] in self?.stopServerOnQueue() } }

    func startDiscovery() {
        queue.async { [weak self] in
            guard let self, self.browser == nil else { return }
            self.diagnostic("info", "discovery.start", "serviceType=\(Self.serviceType)")
            let parameters = NWParameters.tcp
            parameters.includePeerToPeer = true
            let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: "local."), using: parameters)
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                self?.updateBrowseResults(results)
            }
            browser.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.diagnostic("info", "discovery.ready", "Bonjour browser ready")
                case .waiting(let error):
                    self?.diagnostic("error", "discovery.waiting", error.localizedDescription)
                case .failed(let error):
                    self?.diagnostic("error", "discovery.failed", error.localizedDescription)
                    self?.emitError(code: "NEARBY_DISCOVERY_FAILED", message: error.localizedDescription)
                case .cancelled:
                    self?.diagnostic("debug", "discovery.cancelled", "Bonjour browser cancelled")
                default:
                    break
                }
            }
            self.browser = browser
            browser.start(queue: self.queue)
            self.diagnostic("debug", "discovery.started", "Bonjour browser created")
        }
    }

    func stopDiscovery() { queue.async { [weak self] in self?.stopDiscoveryOnQueue() } }

    func networkInfo() -> [String: Any] {
        var addresses: [String] = []
        var hasWiFi = false
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0 else { return ["addresses": addresses, "wifi": false] }
        defer { freeifaddrs(pointer) }
        var current = pointer
        while let value = current?.pointee {
            let interface = String(cString: value.ifa_name)
            if interface == "en0" || interface == "bridge100" { hasWiFi = true }
            if let address = value.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) || address.pointee.sa_family == UInt8(AF_INET6), interface == "en0" || interface == "bridge100" {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
                let text = String(cString: host)
                if !text.isEmpty && !text.hasPrefix("127.") && text != "::1" && !addresses.contains(text) { addresses.append(text) }
            }
            current = value.ifa_next
        }
        return ["addresses": addresses, "wifi": hasWiFi]
    }

    func connect(peerID: String, host: String, port: Int?, token: String, name: String, source: String) throws -> String {
        let id = UUID().uuidString.lowercased()
        let endpoint: NWEndpoint
        let peer: [String: Any]
        if !peerID.isEmpty, let result = queue.sync(execute: { browserResults[peerID] }) {
            endpoint = result.endpoint
            let info = Self.peerInfo(id: peerID, result: result)
            peer = info
        } else {
            guard !host.isEmpty, let port, (1 ... 65_535).contains(port), let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
                throw NearbyTransferError.invalidArgument("附近设备地址无效。")
            }
            endpoint = .hostPort(host: NWEndpoint.Host(host), port: nwPort)
            peer = ["id": host + ":" + String(port), "name": name.isEmpty ? host : name, "host": host, "port": port, "source": source]
        }
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        let connection = NWConnection(to: endpoint, using: parameters)
        let item = BridgeNearbyConnection(id: id, peer: peer, connection: connection, incoming: false, core: self)
        item.remoteToken = token
        item.remoteDeviceID = peer["deviceId"] as? String ?? ""
        queue.async {
            self.connections[id] = item
            self.diagnostic("info", "connect.request", "source=\(source) peer=\(peerID.isEmpty ? host : peerID)", connectionID: id)
            self.emitConnection(item, state: "connecting", error: nil)
            item.start()
        }
        return id
    }

    func acceptConnection(_ id: String) throws {
        try connection(id).acceptRemote()
    }

    func rejectConnection(_ id: String) throws {
        let item = try connection(id)
        item.send(["type": "reject"])
        item.close(notify: true, reason: "对方拒绝了连接。")
    }

    func beginFile(connectionID: String, transferID: String, fileName: String, mimeType: String, size: Int64) throws {
        guard size >= 0, size <= Self.maxFileBytes else { throw NearbyTransferError.transfer("文件大小超过附近传输限制。") }
        let item = try connection(connectionID)
        guard item.connected else { throw NearbyTransferError.transfer("附近设备尚未连接。") }
        item.send(["type": "offer", "id": transferID, "name": fileName, "mime": mimeType, "size": size])
    }

    func sendFile(connectionID: String, transferID: String, selection: NearbyFileSelection, completion: @escaping (Result<Void, Error>) -> Void) throws {
        guard selection.size >= 0, selection.size <= Self.maxFileBytes else { throw NearbyTransferError.transfer("文件大小超过附近传输限制。") }
        let item = try connection(connectionID)
        guard item.connected else { throw NearbyTransferError.transfer("附近设备尚未连接。") }
        item.sendFile(transferID: transferID, selection: selection, completion: completion)
    }

    func sendChunk(connectionID: String, transferID: String, dataBase64: String, isFinal: Bool) throws {
        guard dataBase64.utf8.count <= Self.maxFrameBytes else { throw NearbyTransferError.transfer("文件分块过大。") }
        let item = try connection(connectionID)
        guard item.connected else { throw NearbyTransferError.transfer("附近设备尚未连接。") }
        item.send(["type": "chunk", "id": transferID, "data": dataBase64, "final": isFinal])
    }

    func acceptFile(connectionID: String, transferID: String) throws { try connection(connectionID).acceptFile(transferID: transferID) }

    func rejectFile(connectionID: String, transferID: String) throws {
        let item = try connection(connectionID)
        item.send(["type": "fileReject", "id": transferID])
        item.pendingReceive = nil
    }

    func listReceived() -> [[String: Any]] {
        guard let directories = try? fileManager.contentsOfDirectory(at: receiveRoot, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return [] }
        return directories.compactMap { directory in
            let metadata = directory.appendingPathComponent("meta.json")
            guard let data = try? Data(contentsOf: metadata), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return object
        }
    }

    func deleteReceived(_ id: String) throws {
        let directory = try receivedDirectory(id)
        try fileManager.removeItem(at: directory)
    }

    func receivedFileURL(_ id: String) throws -> URL {
        let directory = try receivedDirectory(id)
        let metadataURL = directory.appendingPathComponent("meta.json")
        guard let data = try? Data(contentsOf: metadataURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawName = object["fileName"] as? String else {
            throw NearbyTransferError.transfer("接收文件记录无效。")
        }
        let file = directory.appendingPathComponent(BridgeNearbyTransferPlugin.safeFileName(rawName)).standardizedFileURL
        guard file.path.hasPrefix(directory.path + "/"), fileManager.fileExists(atPath: file.path) else {
            throw NearbyTransferError.transfer("接收文件不存在。")
        }
        return file
    }

    func close() {
        queue.sync {
            stopDiscoveryOnQueue()
            stopServerOnQueue()
            connections.values.forEach { $0.close(notify: false, reason: nil) }
            connections.removeAll()
        }
    }

    fileprivate func accept(connection: NWConnection) {
        let id = UUID().uuidString.lowercased()
        let peer: [String: Any] = ["id": id, "name": "附近设备", "source": "mdns"]
        let item = BridgeNearbyConnection(id: id, peer: peer, connection: connection, incoming: true, core: self)
        queue.async {
            self.connections[id] = item
            self.diagnostic("info", "socket.accepted", "incoming connection", connectionID: id)
            item.start()
        }
    }

    fileprivate func emitConnection(_ connection: BridgeNearbyConnection, state: String, error: String?) {
        var value: [String: Any] = [
            "id": connection.id,
            "peer": connection.peer,
            "state": state,
            "incoming": connection.incoming,
        ]
        if let error { value["error"] = error }
        plugin?.notifyListeners("connectionState", data: ["connection": value], retainUntilConsumed: true)
    }

    fileprivate func emitError(code: String, message: String, connectionID: String? = nil, transferID: String? = nil) {
        var value: [String: Any] = ["code": code, "message": message]
        if let connectionID { value["connectionId"] = connectionID }
        if let transferID { value["transferId"] = transferID }
        plugin?.notifyListeners("error", data: value, retainUntilConsumed: true)
    }

    fileprivate func emitPeer(_ peer: [String: Any], event: String) {
        plugin?.notifyListeners(event, data: ["peer": peer])
    }

    fileprivate func emitFileOffer(_ offer: [String: Any]) { plugin?.notifyListeners("fileOffer", data: ["offer": offer], retainUntilConsumed: true) }
    fileprivate func emitProgress(_ progress: [String: Any]) { plugin?.notifyListeners("fileProgress", data: ["progress": progress]) }
    fileprivate func emitReceived(_ file: [String: Any], connectionID: String, transferID: String) { plugin?.notifyListeners("fileReceived", data: ["file": file, "connectionId": connectionID, "transferId": transferID], retainUntilConsumed: true) }

    fileprivate func registerRemoteIdentity(_ connection: BridgeNearbyConnection, remoteDeviceID: String) -> Bool {
        guard !remoteDeviceID.isEmpty else { return true }
        if remoteDeviceID == deviceID {
            diagnostic("error", "connection.self", "peer reported the local device id", connectionID: connection.id)
            return false
        }
        return queue.sync {
            for existing in connections.values where existing !== connection && existing.remoteDeviceID == remoteDeviceID {
                let preferIncoming = deviceID > remoteDeviceID
                if existing.incoming == connection.incoming || connection.incoming != preferIncoming {
                    diagnostic("info", "connection.duplicate", "keeping existing connection for deviceId=\(remoteDeviceID)", connectionID: connection.id)
                    return false
                }
                diagnostic("info", "connection.duplicate", "replacing duplicate connection for deviceId=\(remoteDeviceID)", connectionID: connection.id)
                existing.close(notify: true, reason: "同一设备的重复连接已合并。")
            }
            return true
        }
    }

    fileprivate func remove(_ connection: BridgeNearbyConnection, reason: String?, notify: Bool) {
        queue.async {
            self.connections.removeValue(forKey: connection.id)
            if notify { self.emitConnection(connection, state: "closed", error: reason) }
        }
    }

    fileprivate func receiveDirectory(_ id: String) throws -> URL {
        guard id.range(of: #"^[a-f0-9-]{36}$"#, options: .regularExpression) != nil else { throw NearbyTransferError.transfer("接收文件标识无效。") }
        try fileManager.createDirectory(at: receiveRoot, withIntermediateDirectories: true)
        let directory = receiveRoot.appendingPathComponent(id).standardizedFileURL
        guard directory.path.hasPrefix(receiveRoot.standardizedFileURL.path + "/") else { throw NearbyTransferError.transfer("接收文件路径无效。") }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func connection(_ id: String) throws -> BridgeNearbyConnection {
        guard let item = queue.sync(execute: { connections[id] }) else { throw NearbyTransferError.transfer("附近连接不存在或已断开。") }
        return item
    }

    private func stopServerOnQueue() {
        diagnostic("debug", "server.stop", "stopping local server")
        listener?.cancel()
        listener = nil
        connections.values.forEach { $0.close(notify: false, reason: "服务已停止。") }
        connections.removeAll()
        token = ""
        serviceName = ""
        serverPort = 0
    }

    private func stopDiscoveryOnQueue() {
        if browser != nil { diagnostic("debug", "discovery.stop", "stopping Bonjour browser") }
        browser?.cancel()
        browser = nil
        browserResults.removeAll()
    }

    private func updateBrowseResults(_ results: Set<NWBrowser.Result>) {
        queue.async {
            let next = Dictionary(uniqueKeysWithValues: results.compactMap { result -> (String, NWBrowser.Result)? in
                guard case let .service(name, _, _, _) = result.endpoint, name != self.serviceName else { return nil }
                return (name, result)
            })
            for (id, result) in next where self.browserResults[id] == nil {
                self.browserResults[id] = result
                self.diagnostic("info", "discovery.found", "service=\(id)")
                self.emitPeer(Self.peerInfo(id: id, result: result), event: "peerFound")
            }
            for id in self.browserResults.keys where next[id] == nil {
                if let result = self.browserResults.removeValue(forKey: id) {
                    self.diagnostic("info", "discovery.lost", "service=\(id)")
                    self.emitPeer(Self.peerInfo(id: id, result: result), event: "peerLost")
                }
            }
            self.browserResults = next
        }
    }

    private static func txtRecord(_ values: [String: String]) -> NWTXTRecord {
        NWTXTRecord(values)
    }

    private static func txt(_ result: NWBrowser.Result) -> [String: String] {
        guard case let .bonjour(record) = result.metadata else { return [:] }
        return record.dictionary
    }

    private static func peerInfo(id: String, result: NWBrowser.Result) -> [String: Any] {
        let metadata = txt(result)
        return ["id": id, "name": metadata["name"] ?? id, "deviceId": metadata["deviceId"] ?? "", "platform": metadata["platform"] ?? "unknown", "token": metadata["token"] ?? "", "source": "mdns"]
    }

    private func receivedDirectory(_ id: String) throws -> URL {
        guard id.range(of: #"^[a-f0-9-]{36}$"#, options: .regularExpression) != nil else { throw NearbyTransferError.invalidArgument("接收文件标识无效。") }
        let directory = receiveRoot.appendingPathComponent(id).standardizedFileURL
        guard directory.path.hasPrefix(receiveRoot.standardizedFileURL.path + "/") else { throw NearbyTransferError.invalidArgument("接收文件路径无效。") }
        return directory
    }
}

private final class BridgeNearbyConnection {
    let id: String
    var peer: [String: Any]
    let connection: NWConnection
    let incoming: Bool
    weak var core: BridgeNearbyTransferCore?
    var remoteToken = ""
    var remoteDeviceID = ""
    var remotePlatform = "unknown"
    var connected = false
    var accepted = false
    var pendingReceive: NearbyPendingReceive?
    private var receiveBuffer = Data()
    private var binaryTransferID: String?
    private var binaryRemaining: Int64 = 0
    private var sendingFile = false
    private let sendQueue = DispatchQueue(label: "dev.feishu.codex.bridge.nearby.connection", qos: .userInitiated)

    init(id: String, peer: [String: Any], connection: NWConnection, incoming: Bool, core: BridgeNearbyTransferCore) {
        self.id = id; self.peer = peer; self.connection = connection; self.incoming = incoming; self.core = core
    }

    func start() {
        core?.diagnostic("debug", "connection.start", "incoming=\(incoming)", connectionID: id)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.core?.diagnostic("info", "connection.ready", "incoming=\(self.incoming)", connectionID: self.id)
                self.core?.diagnostic("debug", "protocol.hello_sent", "incoming=\(self.incoming) hello", connectionID: self.id)
                self.send(["type": "hello", "deviceId": self.core?.deviceID ?? "", "name": self.core?.displayName ?? UIDevice.current.name,
                           "platform": "ios", "token": self.incoming ? (self.core?.token ?? "") : self.remoteToken])
                self.receiveNext()
            case .waiting(let error):
                self.core?.diagnostic("error", "connection.waiting", error.localizedDescription, connectionID: self.id)
            case .failed(let error):
                self.core?.diagnostic("error", "connection.failed", error.localizedDescription, connectionID: self.id)
                self.core?.emitConnection(self, state: "failed", error: error.localizedDescription)
                self.close(notify: false, reason: error.localizedDescription)
            case .cancelled:
                self.core?.diagnostic("info", "connection.cancelled", "network connection cancelled", connectionID: self.id)
                self.close(notify: true, reason: "附近设备已断开。")
            default: break
            }
        }
        connection.start(queue: sendQueue)
    }

    func send(_ object: [String: Any]) {
        guard let type = object["type"] as? String else {
            core?.diagnostic("error", "protocol.send_failed", "frame type missing", connectionID: id)
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8)?.data(using: .utf8) else {
            core?.diagnostic("error", "protocol.send_failed", "could not encode frame type=\(type)", connectionID: id)
            return
        }
        var payload = line
        payload.append(contentsOf: [0x0A])
        sendQueue.async { [weak self] in
            self?.connection.send(content: payload, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                if let error {
                    self.core?.diagnostic("error", "protocol.send_failed", "type=\(type): \(error.localizedDescription)", connectionID: self.id)
                    self.core?.emitError(code: "NEARBY_SEND_FAILED", message: error.localizedDescription, connectionID: self.id)
                } else {
                    self.core?.diagnostic("debug", "protocol.frame_sent", "type=\(type)", connectionID: self.id)
                }
            })
        }
    }

    func acceptRemote() throws {
        guard incoming else { throw NearbyTransferError.transfer("当前连接不是待接受的连接。") }
        core?.diagnostic("info", "connection.accepted_local", "local user accepted incoming connection", connectionID: id)
        accepted = true
        send(["type": "accept"])
        connected = true
        core?.emitConnection(self, state: "connected", error: nil)
    }

    func acceptFile(transferID: String) throws {
        guard let pending = pendingReceive, pending.transferID == transferID else { throw NearbyTransferError.transfer("文件接收请求已失效。") }
        guard let core else { throw NearbyTransferError.transfer("接收目录不可用。") }
        core.diagnostic("info", "file.accepted_local", "local user accepted file size=\(pending.size)", connectionID: id, transferID: transferID)
        let directory = try core.receiveDirectory(transferID)
        let path = directory.appendingPathComponent(pending.fileName)
        fileManagerCreate(directory: directory)
        FileManager.default.createFile(atPath: path.path, contents: nil)
        pending.path = path
        pending.fileHandle = try FileHandle(forWritingTo: path)
        send(["type": "fileAccept", "id": transferID])
    }

    func sendFile(transferID: String, selection: NearbyFileSelection, completion: @escaping (Result<Void, Error>) -> Void) {
        sendQueue.async { [weak self] in
            guard let self else { return }
            guard !self.sendingFile else {
                completion(.failure(NearbyTransferError.transfer("当前连接已有文件正在发送。")))
                return
            }
            self.sendingFile = true
            do {
                let handle = try FileHandle(forReadingFrom: selection.url)
                let header = try Self.frameData(["type": "dataStart", "id": transferID, "size": selection.size])
                self.sendPayload(header, type: "dataStart") { [weak self] error in
                    guard let self else { return }
                    if let error { self.finishFileSend(handle: handle, result: .failure(error), completion: completion); return }
                    self.streamFile(handle: handle, transferID: transferID, size: selection.size, sent: 0, reported: 0, completion: completion)
                }
            } catch {
                self.sendingFile = false
                completion(.failure(error))
            }
        }
    }

    func close(notify: Bool, reason: String?) {
        core?.diagnostic(reason == nil ? "debug" : "info", "connection.close", reason ?? "closed", connectionID: id)
        pendingReceive?.fileHandle?.closeFile()
        pendingReceive = nil
        connection.cancel()
        core?.remove(self, reason: reason, notify: notify)
    }

    private func receiveNext() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.receiveBuffer.append(data)
                self.consumeFrames()
            }
            if isComplete || error != nil {
                self.core?.diagnostic("error", "protocol.receive_end", error?.localizedDescription ?? "peer closed connection", connectionID: self.id)
                self.close(notify: true, reason: error?.localizedDescription ?? "附近设备已断开。")
            }
            else { self.receiveNext() }
        }
    }

    private func consumeFrames() {
        while true {
            if let transferID = binaryTransferID {
                guard let pending = pendingReceive, pending.transferID == transferID, let handle = pending.fileHandle else {
                    close(notify: true, reason: "收到未授权的二进制文件流。"); return
                }
                if !receiveBuffer.isEmpty {
                    let count = Int(min(Int64(receiveBuffer.count), binaryRemaining))
                    let bytes = receiveBuffer.prefix(count)
                    handle.write(bytes)
                    receiveBuffer.removeFirst(count)
                    pending.bytes += Int64(count)
                    binaryRemaining -= Int64(count)
                    core?.emitProgress(["connectionId": id, "transferId": transferID, "direction": "receive", "bytes": pending.bytes, "totalBytes": pending.size])
                }
                if binaryRemaining > 0 { return }
                binaryTransferID = nil
                finish(pending)
                continue
            }
            guard let newline = receiveBuffer.firstIndex(of: 10) else { break }
            let line = receiveBuffer.prefix(upTo: newline)
            receiveBuffer.removeSubrange(receiveBuffer.startIndex...newline)
            guard line.count <= 1_400_000, let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else {
                core?.diagnostic("error", "protocol.frame_invalid", "invalid JSON frame", connectionID: id)
                close(notify: true, reason: "附近协议帧无效。"); return
            }
            if object["type"] as? String == "dataStart" {
                guard let transferID = object["id"] as? String, let size = object["size"] as? NSNumber,
                      let pending = pendingReceive, pending.transferID == transferID, pending.fileHandle != nil,
                      size.int64Value == pending.size, size.int64Value >= 0 else {
                    close(notify: true, reason: "收到未授权或大小不匹配的二进制文件流。"); return
                }
                binaryTransferID = transferID
                binaryRemaining = size.int64Value
                core?.diagnostic("info", "file.binary_start", "name=\(pending.fileName) size=\(pending.size)", connectionID: id, transferID: transferID)
                if binaryRemaining == 0 {
                    binaryTransferID = nil
                    finish(pending)
                }
            } else {
                handle(object)
            }
        }
        if binaryTransferID == nil && receiveBuffer.count > 1_400_000 {
            core?.diagnostic("error", "protocol.frame_too_large", "buffer exceeds 1400000 bytes", connectionID: id)
            close(notify: true, reason: "附近协议帧过大。")
        }
    }

    private func handle(_ object: [String: Any]) {
        guard let type = object["type"] as? String else {
            core?.diagnostic("error", "protocol.frame_invalid", "frame type missing", connectionID: id)
            return
        }
        if type != "chunk" { core?.diagnostic("debug", "protocol.frame_received", "type=\(type)", connectionID: id) }
        switch type {
        case "hello":
            let incomingDeviceID = (object["deviceId"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !remoteDeviceID.isEmpty && !incomingDeviceID.isEmpty && remoteDeviceID != incomingDeviceID {
                core?.diagnostic("error", "protocol.identity_mismatch", "peer device id changed", connectionID: id)
                send(["type": "reject"]); close(notify: true, reason: "附近设备身份发生变化。"); return
            }
            if !incomingDeviceID.isEmpty { remoteDeviceID = incomingDeviceID }
            remotePlatform = Self.safePlatform(object["platform"] as? String)
            peer["deviceId"] = remoteDeviceID
            peer["platform"] = remotePlatform
            peer["name"] = BridgeNearbyTransferPlugin.safeDisplayName(object["name"] as? String, fallback: "附近设备")
            let offeredToken = object["token"] as? String ?? ""
            let expectedToken = incoming ? (core?.token ?? "") : remoteToken
            if !expectedToken.isEmpty && !offeredToken.isEmpty && offeredToken != expectedToken {
                core?.diagnostic("error", "protocol.token_mismatch", "incoming hello token did not match local server", connectionID: id)
                send(["type": "reject"]); close(notify: true, reason: "附近设备配对信息不匹配。"); return
            }
            guard core?.registerRemoteIdentity(self, remoteDeviceID: remoteDeviceID) == true else {
                send(["type": "reject"]); close(notify: true, reason: "同一设备的重复连接已合并。"); return
            }
            if incoming {
                core?.diagnostic("info", "connection.waiting_accept", "incoming hello from \(peer["name"] as? String ?? "附近设备")", connectionID: id)
                core?.emitConnection(self, state: "requested", error: nil)
            }
        case "accept":
            core?.diagnostic("info", "connection.accepted_remote", "peer accepted connection", connectionID: id)
            accepted = true; connected = true; core?.emitConnection(self, state: "connected", error: nil)
        case "fileAccept":
            core?.diagnostic("info", "file.accepted_remote", "peer accepted file", connectionID: id, transferID: object["id"] as? String)
            core?.plugin?.notifyListeners("fileAccepted", data: ["connectionId": id, "transferId": object["id"] as? String ?? ""], retainUntilConsumed: true)
        case "reject":
            core?.diagnostic("info", "connection.rejected_remote", "peer rejected connection", connectionID: id)
            close(notify: true, reason: "对方拒绝了连接。")
        case "offer":
            guard let transferID = object["id"] as? String, let name = object["name"] as? String, let size = object["size"] as? NSNumber, size.int64Value >= 0, size.int64Value <= 1_073_741_824 else { return }
            let pending = NearbyPendingReceive(transferID: transferID, fileName: BridgeNearbyTransferPlugin.safeFileName(name), mimeType: BridgeNearbyTransferPlugin.safeMime(object["mime"] as? String), size: size.int64Value)
            pendingReceive = pending
            core?.diagnostic("info", "file.offer_received", "name=\(pending.fileName) size=\(pending.size)", connectionID: id, transferID: transferID)
            core?.emitFileOffer(["connectionId": id, "transferId": transferID, "fileName": pending.fileName, "mimeType": pending.mimeType, "size": pending.size])
        case "chunk":
            guard let pending = pendingReceive, let transferID = object["id"] as? String, pending.transferID == transferID,
                  let encoded = object["data"] as? String, let data = Data(base64Encoded: encoded), let handle = pending.fileHandle else { return }
            guard pending.bytes + Int64(data.count) <= pending.size else { close(notify: true, reason: "接收文件大小异常。"); return }
            handle.write(data); pending.bytes += Int64(data.count)
            core?.emitProgress(["connectionId": id, "transferId": transferID, "direction": "receive", "bytes": pending.bytes, "totalBytes": pending.size])
            if object["final"] as? Bool == true { finish(pending) }
        case "fileReject":
            core?.diagnostic("info", "file.rejected_remote", "peer rejected file", connectionID: id, transferID: object["id"] as? String)
            core?.emitError(code: "NEARBY_FILE_REJECTED", message: "对方拒绝接收文件。", connectionID: id, transferID: object["id"] as? String)
        case "dataEnd":
            core?.diagnostic("debug", "file.binary_end", "peer completed binary stream", connectionID: id, transferID: object["id"] as? String)
        default:
            core?.diagnostic("error", "protocol.frame_unknown", "unknown type=\(type)", connectionID: id)
        }
    }

    private static func safePlatform(_ value: String?) -> String {
        guard let value, value == "ios" || value == "android" else { return "unknown" }
        return value
    }

    private static func frameData(_ object: [String: Any]) throws -> Data {
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(contentsOf: [0x0A])
        return data
    }

    private func sendPayload(_ payload: Data, type: String, completion: @escaping (Error?) -> Void) {
        connection.send(content: payload, completion: .contentProcessed { [weak self] error in
            if let error {
                self?.core?.diagnostic("error", "protocol.send_failed", "type=\(type): \(error.localizedDescription)", connectionID: self?.id)
            }
            completion(error)
        })
    }

    private func streamFile(handle: FileHandle, transferID: String, size: Int64, sent: Int64, reported: Int64, completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            guard let data = try handle.read(upToCount: 64 * 1024), !data.isEmpty else {
                if sent != size { throw NearbyTransferError.transfer("发送文件大小校验失败。") }
                let end = try Self.frameData(["type": "dataEnd", "id": transferID])
                sendPayload(end, type: "dataEnd") { [weak self] error in
                    guard let self else { return }
                    self.finishFileSend(handle: handle, result: error.map { .failure($0) } ?? .success(()), completion: completion)
                }
                return
            }
            let nextSent = sent + Int64(data.count)
            guard nextSent <= size else { throw NearbyTransferError.transfer("发送文件大小异常。") }
            sendPayload(data, type: "binary") { [weak self] error in
                guard let self else { return }
                if let error { self.finishFileSend(handle: handle, result: .failure(error), completion: completion); return }
                let nextReported = nextSent - reported >= 256 * 1024 || nextSent == size ? nextSent : reported
                if nextReported != reported {
                    self.core?.emitProgress(["connectionId": self.id, "transferId": transferID, "direction": "send", "bytes": nextSent, "totalBytes": size])
                }
                self.sendQueue.async { self.streamFile(handle: handle, transferID: transferID, size: size, sent: nextSent, reported: nextReported, completion: completion) }
            }
        } catch {
            finishFileSend(handle: handle, result: .failure(error), completion: completion)
        }
    }

    private func finishFileSend(handle: FileHandle, result: Result<Void, Error>, completion: @escaping (Result<Void, Error>) -> Void) {
        try? handle.close()
        sendingFile = false
        switch result {
        case .success:
            core?.diagnostic("info", "file.binary_sent", "binary file stream completed", connectionID: id)
        case .failure(let error):
            core?.diagnostic("error", "file.binary_failed", error.localizedDescription, connectionID: id)
            close(notify: true, reason: error.localizedDescription)
        }
        completion(result)
    }

    private func finish(_ pending: NearbyPendingReceive) {
        guard pending.bytes == pending.size, let path = pending.path else {
            core?.diagnostic("error", "file.receive_failed", "size mismatch bytes=\(pending.bytes) expected=\(pending.size)", connectionID: id, transferID: pending.transferID)
            close(notify: true, reason: "接收文件大小校验失败。"); return
        }
        pending.fileHandle?.closeFile()
        let metadata: [String: Any] = ["id": pending.transferID, "fileName": pending.fileName, "mimeType": pending.mimeType, "size": pending.size, "createdAt": Int(Date().timeIntervalSince1970 * 1_000), "path": "bridge-downloads/nearby/\(pending.transferID)/\(pending.fileName)"]
        if let data = try? JSONSerialization.data(withJSONObject: metadata) { try? data.write(to: path.deletingLastPathComponent().appendingPathComponent("meta.json"), options: .atomic) }
        core?.diagnostic("info", "file.received", "name=\(pending.fileName) size=\(pending.size)", connectionID: id, transferID: pending.transferID)
        core?.emitReceived(metadata, connectionID: id, transferID: pending.transferID)
        pendingReceive = nil
    }

    private func fileManagerCreate(directory: URL) { try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
}

private final class NearbyPendingReceive {
    let transferID: String
    let fileName: String
    let mimeType: String
    let size: Int64
    var bytes: Int64 = 0
    var path: URL?
    var fileHandle: FileHandle?

    init(transferID: String, fileName: String, mimeType: String, size: Int64) {
        self.transferID = transferID; self.fileName = fileName; self.mimeType = mimeType; self.size = size
    }
}
