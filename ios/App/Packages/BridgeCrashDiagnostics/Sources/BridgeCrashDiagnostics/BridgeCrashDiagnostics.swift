import CrashReporter
import CryptoKit
import Foundation
import MetricKit
#if os(iOS)
import UIKit
#endif

public enum BridgeCrashDiagnosticsError: LocalizedError {
    case invalidReport
    case invalidIdentifier
    case reporterUnavailable

    public var errorDescription: String? {
        switch self {
        case .invalidReport: return "诊断报告格式无效。"
        case .invalidIdentifier: return "诊断报告不存在或标识无效。"
        case .reporterUnavailable: return "无法创建线程快照。"
        }
    }
}

/// Stores only locally generated diagnostic data, and never accepts a file path
/// from the WebView. Existing reports are retained until the user removes them.
final class BridgeCrashReportStore {
    let directory: URL
    private let fileManager: FileManager

    init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        self.fileManager = fileManager
    }

    func save(_ record: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(record) else { throw BridgeCrashDiagnosticsError.invalidReport }
        let data = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
        let id = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        let path = directory.appendingPathComponent("\(id).json", isDirectory: false)
        if !fileManager.fileExists(atPath: path.path) {
            #if os(iOS)
            try data.write(to: path, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: path, options: [.atomic])
            #endif
        }
        return id
    }

    func saveSystemCrash(stackData: Data, capturedAt: String, periodStart: String, appBuild: String,
                         osVersion: String, signal: NSNumber?, exceptionType: NSNumber?, exceptionCode: NSNumber?,
                         metadata: [String: Any] = [:]) throws -> String {
        let stack = try JSONSerialization.jsonObject(with: stackData)
        let appBinaryUUID = Self.findAppBinaryUUID(in: stack, executable: metadata["executable"] as? String)
        var record: [String: Any] = [
            "schema": 1, "kind": "crash", "capturedAt": capturedAt, "periodStart": periodStart,
            "appBuild": appBuild, "osVersion": osVersion, "stack": stack,
        ]
        metadata.forEach { key, value in
            if JSONSerialization.isValidJSONObject([key: value]) { record[key] = value }
        }
        if let appBinaryUUID {
            record["appBinaryUUID"] = appBinaryUUID
            record["symbolication"] = [
                "binaryName": metadata["executable"] as? String ?? "App",
                "binaryUUID": appBinaryUUID,
                "requiresMatchingDSYM": true,
            ]
        }
        if let signal { record["signal"] = signal }
        if let exceptionType { record["exceptionType"] = exceptionType }
        if let exceptionCode { record["exceptionCode"] = exceptionCode }
        return try save(Self.enrichedRecord(record))
    }

    private static func findAppBinaryUUID(in object: Any, executable: String?) -> String? {
        if let dictionary = object as? [String: Any] {
            if let binaryUUID = dictionary["binaryUUID"] as? String,
               !binaryUUID.isEmpty,
               let binaryName = dictionary["binaryName"] as? String,
               binaryName == (executable ?? "App") {
                return binaryUUID.uppercased()
            }
            for value in dictionary.values {
                if let uuid = findAppBinaryUUID(in: value, executable: executable) { return uuid }
            }
        } else if let array = object as? [Any] {
            for value in array {
                if let uuid = findAppBinaryUUID(in: value, executable: executable) { return uuid }
            }
        }
        return nil
    }

    func url(for id: String) throws -> URL {
        guard id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw BridgeCrashDiagnosticsError.invalidIdentifier
        }
        let url = directory.appendingPathComponent("\(id).json", isDirectory: false)
        guard fileManager.fileExists(atPath: url.path) else { throw BridgeCrashDiagnosticsError.invalidIdentifier }
        return url
    }

    func report(id: String) throws -> [String: Any] {
        let data = try Data(contentsOf: url(for: id))
        guard let report = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BridgeCrashDiagnosticsError.invalidReport
        }
        return Self.enrichedRecord(report)
    }

    private static func enrichedRecord(_ record: [String: Any]) -> [String: Any] {
        var result = record
        let executable = record["executable"] as? String ?? "App"
        let appBinaryUUID = (record["appBinaryUUID"] as? String)
            ?? (record["stack"].flatMap { findAppBinaryUUID(in: $0, executable: executable) })
        guard let appBinaryUUID, !appBinaryUUID.isEmpty else { return result }
        let normalizedUUID = appBinaryUUID.uppercased()
        result["appBinaryUUID"] = normalizedUUID
        if result["symbolication"] == nil {
            result["symbolication"] = [
                "binaryName": executable,
                "binaryUUID": normalizedUUID,
                "requiresMatchingDSYM": true,
            ]
        }
        return result
    }

    func summaries() throws -> [[String: Any]] {
        guard fileManager.fileExists(atPath: directory.path) else { return [] }
        let entries = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        return entries.compactMap { path -> [String: Any]? in
            let id = path.deletingPathExtension().lastPathComponent
            guard path.pathExtension == "json", let record = try? report(id: id),
                  let kind = record["kind"] as? String, let capturedAt = record["capturedAt"] as? String else { return nil }
            var summary: [String: Any] = ["id": id, "kind": kind, "capturedAt": capturedAt,
                                          "appBuild": record["appBuild"] as? String ?? "unknown"]
            if let signal = record["signal"] as? NSNumber { summary["signal"] = signal }
            if let appBinaryUUID = record["appBinaryUUID"] as? String { summary["appBinaryUUID"] = appBinaryUUID }
            if let bundleIdentifier = record["bundleIdentifier"] as? String { summary["bundleIdentifier"] = bundleIdentifier }
            return summary
        }.sorted { ($0["capturedAt"] as? String ?? "") > ($1["capturedAt"] as? String ?? "") }
    }
}

/// MetricKit receives system crash diagnostics on a later launch. PLCrashReporter
/// is used only to capture user-requested live snapshots: no signal or exception
/// handler is installed, so it does not replace Apple's crash reporter or the
/// existing App-only VPN exception breadcrumb.
public final class BridgeCrashDiagnostics: NSObject, MXMetricManagerSubscriber {
    public static let shared = BridgeCrashDiagnostics()
    private let queue = DispatchQueue(label: "dev.feishu.codex.bridge.crash-diagnostics")
    private let snapshotLock = NSLock()
    private let store: BridgeCrashReportStore
    private var started = false
    private var lastError: String?

    public override convenience init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        self.init(directory: base.appendingPathComponent("BridgeCrashReports", isDirectory: true))
    }

    init(directory: URL) {
        store = BridgeCrashReportStore(directory: directory)
        super.init()
    }

    public func start() {
        let shouldStart = queue.sync { () -> Bool in
            guard !started else { return false }
            started = true
            return true
        }
        if shouldStart { MXMetricManager.shared.add(self) }
    }

    public func didReceive(_ payloads: [MXDiagnosticPayload]) {
        queue.async {
            for payload in payloads {
                for diagnostic in payload.crashDiagnostics ?? [] {
                    do {
                        _ = try self.store.saveSystemCrash(
                            stackData: diagnostic.callStackTree.jsonRepresentation(),
                            capturedAt: Self.timestamp(payload.timeStampEnd),
                            periodStart: Self.timestamp(payload.timeStampBegin),
                            appBuild: diagnostic.metaData.applicationBuildVersion,
                            osVersion: diagnostic.metaData.osVersion,
                            signal: diagnostic.signal, exceptionType: diagnostic.exceptionType,
                            exceptionCode: diagnostic.exceptionCode,
                            metadata: Self.appMetadata()
                        )
                        self.lastError = nil
                    } catch {
                        self.lastError = "无法保存系统崩溃诊断。"
                    }
                }
            }
        }
    }

    public func status() throws -> [String: Any] {
        try queue.sync {
            var result: [String: Any] = [
                "enabled": started,
                "storage": "Library/Application Support/BridgeCrashReports",
                "reports": try store.summaries(),
            ]
            if let lastError { result["error"] = lastError }
            return result
        }
    }

    public func reportText(id: String) throws -> String {
        try queue.sync {
            let data = try JSONSerialization.data(withJSONObject: store.report(id: id), options: [.prettyPrinted, .sortedKeys])
            guard let text = String(data: data, encoding: .utf8) else { throw BridgeCrashDiagnosticsError.invalidReport }
            return text
        }
    }

    public func reportURL(id: String) throws -> URL { try queue.sync { try store.url(for: id) } }

    /// Capture all available threads on explicit request, without crashing or
    /// registering a process-wide signal/exception handler.
    @discardableResult public func captureSnapshot() throws -> String {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        let config = PLCrashReporterConfig()
        guard let reporter = PLCrashReporter(configuration: config) else { throw BridgeCrashDiagnosticsError.reporterUnavailable }
        let data = try reporter.generateLiveReportAndReturnError()
        let report = try PLCrashReport(data: data)
        let images = (report.images as? [PLCrashReportBinaryImageInfo]) ?? []
        let imageRecords: [[String: Any]] = images.map { image in
            ["name": URL(fileURLWithPath: image.imageName).lastPathComponent,
             "uuid": image.imageUUID ?? "", "base": Self.hex(image.imageBaseAddress), "size": image.imageSize]
        }
        let threads: [[String: Any]] = ((report.threads as? [PLCrashReportThreadInfo]) ?? []).map { thread in
            let frames: [[String: Any]] = ((thread.stackFrames as? [PLCrashReportStackFrameInfo]) ?? []).map { frame in
                let address = frame.instructionPointer
                var item: [String: Any] = ["address": Self.hex(address)]
                if let image = images.first(where: { address >= $0.imageBaseAddress && address - $0.imageBaseAddress < $0.imageSize }) {
                    item["image"] = URL(fileURLWithPath: image.imageName).lastPathComponent
                    item["imageUUID"] = image.imageUUID ?? ""
                    item["imageOffset"] = Self.hex(address - image.imageBaseAddress)
                }
                if let symbol = frame.symbolInfo?.symbolName { item["symbol"] = symbol }
                return item
            }
            return ["number": thread.threadNumber, "frames": frames]
        }
        let record: [String: Any] = [
            "schema": 1, "kind": "snapshot", "capturedAt": Self.timestamp(Date()),
            "appBuild": report.applicationInfo.applicationVersion ?? "unknown",
            "osVersion": report.systemInfo.operatingSystemVersion ?? "unknown",
            "note": "这是手动创建的运行中线程快照，不代表发生闪退。",
            "threads": threads, "images": imageRecords,
        ]
        var enrichedRecord = record
        Self.appMetadata().forEach { key, value in enrichedRecord[key] = value }
        if let appImage = imageRecords.first(where: {
            guard let name = $0["name"] as? String else { return false }
            return name == (Self.appMetadata()["executable"] as? String ?? "App")
        }), let appBinaryUUID = appImage["uuid"] as? String, !appBinaryUUID.isEmpty {
            enrichedRecord["appBinaryUUID"] = appBinaryUUID.uppercased()
            enrichedRecord["symbolication"] = [
                "binaryName": Self.appMetadata()["executable"] as? String ?? "App",
                "binaryUUID": appBinaryUUID.uppercased(),
                "requiresMatchingDSYM": true,
            ]
        }
        return try queue.sync { try store.save(enrichedRecord) }
    }

    private static func appMetadata() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        var metadata: [String: Any] = [:]
        if let bundleIdentifier = Bundle.main.bundleIdentifier { metadata["bundleIdentifier"] = bundleIdentifier }
        if let executable = info["CFBundleExecutable"] as? String, !executable.isEmpty {
            metadata["executable"] = executable
        }
        if let version = info["CFBundleShortVersionString"] as? String, !version.isEmpty {
            metadata["appVersion"] = version
        }
        if let build = info["CFBundleVersion"] as? String, !build.isEmpty {
            metadata["appBuild"] = build
        }
        metadata["osVersion"] = ProcessInfo.processInfo.operatingSystemVersionString
        #if os(iOS)
        metadata["deviceModel"] = UIDevice.current.model
        #endif
        return metadata
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    private static func hex(_ value: UInt64) -> String { String(format: "0x%llx", value) }
}
