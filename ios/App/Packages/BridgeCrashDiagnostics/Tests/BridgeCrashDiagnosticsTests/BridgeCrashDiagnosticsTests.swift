import Foundation
import XCTest
@testable import BridgeCrashDiagnostics

final class BridgeCrashDiagnosticsTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("bridge-crash-tests-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testStoredCrashIsDeduplicatedAndCanBeRead() throws {
        let store = BridgeCrashReportStore(directory: directory)
        let stack: [String: Any] = [
            "callStacks": [
                [
                    "callStackRootFrames": [
                        [
                            "binaryName": "App",
                            "binaryUUID": "8d7e7ba6-f7e2-3ed4-89d1-0df954b738c2",
                            "offsetIntoBinaryTextSegment": 42,
                        ],
                    ],
                ],
            ],
        ]
        let stackData = try JSONSerialization.data(withJSONObject: stack)
        func saveCrash() throws -> String {
            try store.saveSystemCrash(stackData: stackData, capturedAt: "2026-11-13T13:00:00.000Z",
                                      periodStart: "2026-11-13T12:59:00.000Z", appBuild: "6", osVersion: "27.2",
                                      signal: 5, exceptionType: 6, exceptionCode: nil)
        }
        let first = try saveCrash()
        XCTAssertEqual(try saveCrash(), first)
        let summaries = try store.summaries()
        XCTAssertEqual(summaries.count, 1)
        XCTAssertEqual(summaries[0]["kind"] as? String, "crash")
        XCTAssertEqual(summaries[0]["appBuild"] as? String, "6")
        XCTAssertEqual(summaries[0]["appBinaryUUID"] as? String, "8D7E7BA6-F7E2-3ED4-89D1-0DF954B738C2")
        XCTAssertEqual(try store.report(id: first)["appBinaryUUID"] as? String, "8D7E7BA6-F7E2-3ED4-89D1-0DF954B738C2")
        XCTAssertEqual(try store.report(id: first)["signal"] as? Int, 5)
    }

    func testMalformedCrashStackIsNotSaved() throws {
        let store = BridgeCrashReportStore(directory: directory)
        XCTAssertThrowsError(try store.saveSystemCrash(stackData: Data("not-json".utf8), capturedAt: "2026-11-13T13:00:00.000Z",
                                                       periodStart: "2026-11-13T12:59:00.000Z", appBuild: "6", osVersion: "27.2",
                                                       signal: 5, exceptionType: nil, exceptionCode: nil))
        XCTAssertTrue(try store.summaries().isEmpty)
    }

    func testLegacyCrashGetsSymbolicationUUIDWhenRead() throws {
        let store = BridgeCrashReportStore(directory: directory)
        let stack: [String: Any] = [
            "callStacks": [[
                "callStackRootFrames": [[
                    "binaryName": "App",
                    "binaryUUID": "8d7e7ba6-f7e2-3ed4-89d1-0df954b738c2",
                ]],
            ]],
        ]
        let id = try store.save([
            "schema": 1,
            "kind": "crash",
            "capturedAt": "2026-11-13T13:00:00.000Z",
            "appBuild": "1",
            "stack": stack,
        ])
        let report = try store.report(id: id)
        XCTAssertEqual(report["appBinaryUUID"] as? String, "8D7E7BA6-F7E2-3ED4-89D1-0DF954B738C2")
        XCTAssertEqual((report["symbolication"] as? [String: Any])?["requiresMatchingDSYM"] as? Bool, true)
    }

    func testOnlyOwnedReportIdentifiersCanBeRead() throws {
        let store = BridgeCrashReportStore(directory: directory)
        XCTAssertThrowsError(try store.url(for: "../../secret"))
        XCTAssertThrowsError(try store.url(for: String(repeating: "a", count: 64)))
    }

    func testLiveSnapshotContainsThreadFramesAndIsNotReportedAsCrash() throws {
        let diagnostics = BridgeCrashDiagnostics(directory: directory)
        let id = try diagnostics.captureSnapshot()
        let status = try diagnostics.status()
        let summaries = try XCTUnwrap(status["reports"] as? [[String: Any]])
        XCTAssertEqual(summaries.count, 1)
        XCTAssertEqual(summaries[0]["kind"] as? String, "snapshot")
        let report = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: diagnostics.reportURL(id: id))) as? [String: Any])
        let threads = try XCTUnwrap(report["threads"] as? [[String: Any]])
        XCTAssertFalse(threads.isEmpty)
        XCTAssertTrue(threads.contains { !($0["frames"] as? [[String: Any]] ?? []).isEmpty })
        XCTAssertNil(report["signal"])
    }
}
