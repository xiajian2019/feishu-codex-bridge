import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

private final class FakeTransport {
    var connected = true
    var writes: [Data] = []
    var callbacks: [(Bool) -> Void] = []
    var scheduled: [() -> Void] = []
    lazy var queue = BridgeIOSSHInputQueue(
        active: { self.connected },
        write: { data, done in self.writes.append(data); self.callbacks.append(done) },
        schedule: { self.scheduled.append($0) }
    )
    func complete(_ success: Bool = true) { callbacks.removeFirst()(success) }
    func tick() { scheduled.removeFirst()() }
}

@main
struct BridgeIOSSHComposerTests {
    static func main() {
        let image = BridgeIOSSHComposerRemoteAttachment(name: "photo.png", contentType: "IMAGE/png", path: "/tmp/a&b.png")
        let file = BridgeIOSSHComposerRemoteAttachment(name: "a\"<\n.txt", contentType: "text/plain", path: "/tmp/f.txt")
        let prompt = BridgeIOSSHComposerEncoding.prompt(text: "  hi\r\nthere\u{1b}[201~", attachments: [image, file])
        expect(prompt.hasPrefix("  hi\nthere[201~\n\n"), "preserves whitespace, normalizes newlines, removes terminal control bytes")
        expect(prompt.contains("<image name=[Image #1] path=\"/tmp/a&amp;b.png\">"), "formats image path")
        expect(prompt.contains("name=\"a&quot;&lt; .txt\" path=\"/tmp/f.txt\""), "escapes attachment attributes")
        expect(!BridgeIOSSHComposerEncoding.prompt(text: "", attachments: [file]).isEmpty, "attachment-only prompt")
        expect(String(data: BridgeIOSSHComposerEncoding.paste("echo ok", bracketed: false), encoding: .utf8) == "echo ok", "plain shell gets plain input")
        expect(String(data: BridgeIOSSHComposerEncoding.paste("say $skill", bracketed: true), encoding: .utf8) == "\u{1b}[200~say $skill \u{1b}[201~", "skill token and bracketed paste")
        expect(String(data: BridgeIOSSHComposerEncoding.paste("normal", bracketed: true), encoding: .utf8) == "\u{1b}[200~normal\u{1b}[201~", "normal message is not padded")

        expect(BridgeIOSSHComposerEncoding.terminalKey([27, 91, 65], applicationCursor: false) == Data([27, 91, 65]), "normal arrow key")
        expect(BridgeIOSSHComposerEncoding.terminalKey([27, 91, 65], applicationCursor: true) == Data([27, 79, 65]), "application cursor arrow key")
        expect(BridgeIOSSHComposerEncoding.terminalKey([3], applicationCursor: true) == Data([3]), "control key is unchanged")

        let transport = FakeTransport()
        var results: [BridgeIOSSHInputResult] = []
        transport.queue.enqueueComposer(Data("hello".utf8)) { results.append($0) }
        transport.queue.enqueueRaw(Data("X".utf8))
        expect(transport.writes == [Data("hello".utf8)], "composer starts with paste only")
        transport.complete()
        expect(transport.writes.count == 1 && transport.scheduled.count == 1, "enter waits for paste and delay")
        transport.tick()
        expect(transport.writes == [Data("hello".utf8), Data([13])], "enter follows paste")
        transport.complete()
        expect(results == [.written] && transport.writes.last == Data("X".utf8), "raw terminal input waits for composer")
        transport.complete()

        let disconnected = FakeTransport()
        disconnected.connected = false
        disconnected.queue.enqueueComposer(Data("hello".utf8)) { results.append($0) }
        expect(results.last == .notSent && disconnected.writes.isEmpty, "disconnected channel does not send")
        let pasteFailed = FakeTransport()
        pasteFailed.queue.enqueueComposer(Data("hello".utf8)) { results.append($0) }
        pasteFailed.complete(false)
        expect(results.last == .unknown && pasteFailed.scheduled.isEmpty, "paste error is unknown and does not send enter")
        let enterFailed = FakeTransport()
        enterFailed.queue.enqueueComposer(Data("hello".utf8)) { results.append($0) }
        enterFailed.complete()
        enterFailed.tick()
        enterFailed.complete(false)
        expect(results.last == .unknown, "enter write failure is unknown")
        let lostAfterPaste = FakeTransport()
        lostAfterPaste.queue.enqueueComposer(Data("hello".utf8)) { results.append($0) }
        lostAfterPaste.complete()
        lostAfterPaste.connected = false
        lostAfterPaste.tick()
        expect(results.last == .unknown && lostAfterPaste.writes.count == 1, "disconnect after paste is unknown")
        print("iOS SSH Composer tests passed")
    }
}
