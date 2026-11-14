import Foundation
import XCTest
import TunnelKitCore
import TunnelKitOpenVPNCore
import TunnelKitOpenVPNProtocol

private final class ImmediateCompletionLink: LinkInterface {
    let isReliable = false
    let remoteAddress: String? = "127.0.0.1"
    let remoteProtocol: String? = "udp"
    let packetBufferSize = 64 * 1024
    let writeError: Error?
    private(set) var batches: [[Data]] = []

    init(writeError: Error? = nil) {
        self.writeError = writeError
    }

    func setReadHandler(queue: DispatchQueue, _ handler: @escaping ([Data]?, Error?) -> Void) {}

    func writePacket(_ packet: Data, completionHandler: ((Error?) -> Void)?) {
        writePackets([packet], completionHandler: completionHandler)
    }

    func writePackets(_ packets: [Data], completionHandler: ((Error?) -> Void)?) {
        batches.append(packets)
        completionHandler?(writeError)
    }
}

private final class StopObserver: OpenVPNSessionDelegate {
    let stopped: (Error?, Bool) -> Void

    init(stopped: @escaping (Error?, Bool) -> Void) {
        self.stopped = stopped
    }

    func sessionDidStart(_ session: OpenVPNSession, remoteAddress: String, remoteProtocol: String?, options: OpenVPN.Configuration) {}

    func sessionDidStop(_ session: OpenVPNSession, withError error: Error?, shouldReconnect: Bool) {
        stopped(error, shouldReconnect)
    }
}

final class BridgeOpenVPNSessionQueueTests: XCTestCase {
    private func makeSession(queue: DispatchQueue, cache: URL) throws -> OpenVPNSession {
        XCTAssertTrue(OpenVPN.prepareRandomNumberGenerator(seedLength: 64))
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        var builder = OpenVPN.ConfigurationBuilder()
        // No TLS exchange takes place; a dummy CA is sufficient for the initial hard reset.
        builder.ca = OpenVPN.CryptoContainer(pem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----")
        return try OpenVPNSession(queue: queue, configuration: builder.build(), cachesURL: cache)
    }

    func testInitialHardResetAcceptsImmediateWriteCompletionOnSessionQueue() throws {
        let queue = DispatchQueue(label: "bridge.test.openvpn.session")
        let cache = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: cache) }
        let session = try makeSession(queue: queue, cache: cache)
        let link = ImmediateCompletionLink()
        let progressed = expectation(description: "initial reset and its completion have finished")

        queue.async {
            session.setLink(link)
            XCTAssertEqual(link.batches.count, 1)
            XCTAssertTrue(link.batches.allSatisfy { !$0.isEmpty })
            queue.async {
                session.cleanup()
                progressed.fulfill()
            }
        }
        wait(for: [progressed], timeout: 3)
    }

    func testImmediateWriteErrorStopsSessionOnItsQueue() throws {
        let queue = DispatchQueue(label: "bridge.test.openvpn.failure")
        let cache = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: cache) }
        let session = try makeSession(queue: queue, cache: cache)
        let link = ImmediateCompletionLink(writeError: NSError(domain: "bridge.test", code: 1))
        let stopped = expectation(description: "link failure stops session")
        let observer = StopObserver { error, shouldReconnect in
            guard case .failedLinkWrite? = error as? OpenVPNError else {
                XCTFail("Expected the link write failure")
                stopped.fulfill()
                return
            }
            XCTAssertFalse(shouldReconnect)
            stopped.fulfill()
        }
        session.delegate = observer
        queue.async { session.setLink(link) }
        wait(for: [stopped], timeout: 3)
        let cleanedUp = expectation(description: "session queue remains responsive")
        queue.async {
            session.cleanup()
            cleanedUp.fulfill()
        }
        wait(for: [cleanedUp], timeout: 3)
        withExtendedLifetime(observer) {}
    }
}
