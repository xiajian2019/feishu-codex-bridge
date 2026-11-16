import CryptoKit
import Foundation
import NIOCore
import NIOSSH

/// The private-key algorithms that can be converted to `NIOSSHPrivateKey` in
/// the pinned NIOSSH 0.13.0 dependency.
enum BridgeIOSSHPrivateKeyAlgorithm: String, Codable, CaseIterable, Sendable {
    case ed25519 = "ed25519"
    case ecdsaP256 = "ecdsa-p256"
    case ecdsaP384 = "ecdsa-p384"
    case ecdsaP521 = "ecdsa-p521"

    var sshAlgorithmName: String {
        switch self {
        case .ed25519: return "ssh-ed25519"
        case .ecdsaP256: return "ecdsa-sha2-nistp256"
        case .ecdsaP384: return "ecdsa-sha2-nistp384"
        case .ecdsaP521: return "ecdsa-sha2-nistp521"
        }
    }

    var sshCurveName: String? {
        switch self {
        case .ed25519: return nil
        case .ecdsaP256: return "nistp256"
        case .ecdsaP384: return "nistp384"
        case .ecdsaP521: return "nistp521"
        }
    }

    var displayName: String {
        switch self {
        case .ed25519: return "Ed25519"
        case .ecdsaP256: return "ECDSA P-256"
        case .ecdsaP384: return "ECDSA P-384"
        case .ecdsaP521: return "ECDSA P-521"
        }
    }
}

enum BridgeIOSSHPrivateKeyFormat: String, Codable, Sendable {
    case openSSH = "openssh"
    case pkcs8 = "pkcs8"
}

enum BridgeIOSSHPrivateKeyGenerator {
    static func generateEd25519PKCS8() -> Data {
        let key = Curve25519.Signing.PrivateKey()
        // RFC 8410 PrivateKeyInfo: Ed25519 OID and the nested 32-byte seed.
        var der = Data([
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
            0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
        ])
        der.append(key.rawRepresentation)
        return der
    }
}

enum BridgeIOSSHPrivateKeyParseError: Error, LocalizedError {
    case malformedPEM
    case unsupportedPEMLabel(String)
    case malformedOpenSSH(String)
    case malformedDER(String)
    case unsupportedAlgorithm(String)
    case invalidKeyMaterial(String)
    case encryptedOpenSSH(cipher: String, kdf: String)
    case encryptedPKCS8
    case rsaUnsupported(String)
    case sec1Unsupported

    var errorDescription: String? {
        switch self {
        case .malformedPEM:
            return "私钥 PEM 格式无效。"
        case .unsupportedPEMLabel(let label):
            return "不支持的私钥格式：\(label)。"
        case .malformedOpenSSH(let reason):
            return "OpenSSH 私钥无效：\(reason)。"
        case .malformedDER(let reason):
            return "PKCS#8 DER 私钥无效：\(reason)。"
        case .unsupportedAlgorithm(let algorithm):
            return "不支持的 SSH 私钥算法：\(algorithm)。"
        case .invalidKeyMaterial(let reason):
            return "私钥材料无效：\(reason)。"
        case .encryptedOpenSSH(let cipher, let kdf):
            return "暂不支持加密 OpenSSH 私钥（cipher=\(cipher), kdf=\(kdf)）；请先在受信环境解密后导入。"
        case .encryptedPKCS8:
            return "暂不支持加密 PKCS#8 私钥；请先在受信环境解密后导入。"
        case .rsaUnsupported(let source):
            return "RSA 私钥暂不支持（\(source)）。当前 NIOSSH 0.13.0 仅提供 Ed25519 和 ECDSA 私钥初始化入口。"
        case .sec1Unsupported:
            return "暂不支持裸 SEC1 EC PRIVATE KEY；请导出为 PKCS#8 PRIVATE KEY。"
        }
    }
}

/// A parsed key and the exact NIOSSH values needed to offer public-key auth.
/// The private material is intentionally not Codable and never belongs in
/// metadata or WebView messages.
struct BridgeIOSSHParsedPrivateKey: Sendable {
    let format: BridgeIOSSHPrivateKeyFormat
    let algorithm: BridgeIOSSHPrivateKeyAlgorithm
    let comment: String?
    let privateKey: NIOSSHPrivateKey
    let publicKey: NIOSSHPublicKey
    let publicKeyOpenSSH: String
    let fingerprintSHA256: String

    func authenticationOffer(username: String) -> NIOSSHUserAuthenticationOffer {
        NIOSSHUserAuthenticationOffer(
            username: username,
            serviceName: "ssh-connection",
            offer: .privateKey(.init(privateKey: privateKey))
        )
    }
}

/// A one-shot NIOSSH public-key authentication delegate. It deliberately
/// offers one key only; NIOSSH performs the actual SSH userauth signing using
/// `NIOSSHPrivateKey.sign` internally.
final class BridgeIOSSHPrivateKeyAuthDelegate: NIOSSHClientUserAuthenticationDelegate {
    private var authRequest: NIOSSHUserAuthenticationOffer?

    init(username: String, key: BridgeIOSSHParsedPrivateKey) {
        self.authRequest = key.authenticationOffer(username: username)
    }

    func nextAuthenticationType(
        availableMethods: NIOSSHAvailableUserAuthenticationMethods,
        nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>
    ) {
        guard availableMethods.contains(.publicKey), let authRequest else {
            nextChallengePromise.succeed(nil)
            return
        }
        self.authRequest = nil
        nextChallengePromise.succeed(authRequest)
    }
}

@available(*, unavailable)
extension BridgeIOSSHPrivateKeyAuthDelegate: Sendable {}

enum BridgeIOSSHPrivateKeyParser {
    private static let openSSHMagic = Data("openssh-key-v1\0".utf8)

    private static let ed25519OID = "1.3.101.112"
    private static let ecPublicKeyOID = "1.2.840.10045.2.1"
    private static let p256OID = "1.2.840.10045.3.1.7"
    private static let p384OID = "1.3.132.0.34"
    private static let p521OID = "1.3.132.0.35"
    private static let rsaEncryptionOID = "1.2.840.113549.1.1.1"

    static func parse(
        pem: String,
        passphrase: String? = nil
    ) throws -> BridgeIOSSHParsedPrivateKey {
        try parse(data: Data(pem.utf8), passphrase: passphrase)
    }

    static func parse(
        data: Data,
        passphrase: String? = nil
    ) throws -> BridgeIOSSHParsedPrivateKey {
        guard data.count <= 4 * 1024 * 1024 else {
            throw BridgeIOSSHPrivateKeyParseError.invalidKeyMaterial("文件过大")
        }

        if let text = String(data: data, encoding: .utf8),
           text.range(of: "-----BEGIN ") != nil {
            let block = try BridgeIOSSHPEM.decode(text)
            return try parseDER(block.der, label: block.label, passphrase: passphrase)
        }

        guard data.first == 0x30 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedPEM
        }
        return try parseDER(data, label: "PRIVATE KEY", passphrase: passphrase)
    }

    private static func parseDER(
        _ der: Data,
        label: String,
        passphrase: String?
    ) throws -> BridgeIOSSHParsedPrivateKey {
        switch label {
        case "OPENSSH PRIVATE KEY":
            return try parseOpenSSH(der, passphrase: passphrase)
        case "PRIVATE KEY":
            return try parsePKCS8(der)
        case "ENCRYPTED PRIVATE KEY":
            throw BridgeIOSSHPrivateKeyParseError.encryptedPKCS8
        case "RSA PRIVATE KEY", "RSA PRIVATE KEY ENCRYPTED":
            throw BridgeIOSSHPrivateKeyParseError.rsaUnsupported("PEM 标记 (label)")
        case "EC PRIVATE KEY":
            throw BridgeIOSSHPrivateKeyParseError.sec1Unsupported
        default:
            throw BridgeIOSSHPrivateKeyParseError.unsupportedPEMLabel(label)
        }
    }

    private static func parseOpenSSH(
        _ der: Data,
        passphrase: String?
    ) throws -> BridgeIOSSHParsedPrivateKey {
        var reader = BridgeSSHWireReader(data: der)
        guard try reader.readRaw(count: openSSHMagic.count) == openSSHMagic else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("magic 不匹配")
        }

        let cipher = try reader.readStringUTF8()
        let kdf = try reader.readStringUTF8()
        let kdfOptions = try reader.readString()
        guard cipher == "none", kdf == "none", kdfOptions.isEmpty else {
            _ = passphrase
            throw BridgeIOSSHPrivateKeyParseError.encryptedOpenSSH(cipher: cipher, kdf: kdf)
        }

        let keyCount = try reader.readUInt32()
        guard keyCount == 1 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("仅支持单密钥文件")
        }
        let publicBlob = try reader.readString()
        let privateBlob = try reader.readString()
        guard reader.isAtEnd else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("尾部存在多余数据")
        }

        var privateReader = BridgeSSHWireReader(data: privateBlob)
        let check1 = try privateReader.readUInt32()
        let check2 = try privateReader.readUInt32()
        guard check1 == check2 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("校验值不一致")
        }

        let keyType = try privateReader.readStringUTF8()
        let parsed: BridgeIOSSHParsedPrivateKey
        switch keyType {
        case "ssh-ed25519":
            let embeddedPublic = try privateReader.readString()
            let privateBytes = try privateReader.readString()
            guard embeddedPublic.count == 32, privateBytes.count == 64 else {
                throw BridgeIOSSHPrivateKeyParseError.invalidKeyMaterial("Ed25519 长度不正确")
            }
            let seed = Data(privateBytes.prefix(32))
            let privatePublic = Data(privateBytes.suffix(32))
            guard privatePublic == embeddedPublic else {
                throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("Ed25519 公钥副本不一致")
            }
            let comment = try readComment(from: &privateReader)
            let built = try makeEd25519(seed)
            guard built.publicBytes == embeddedPublic else {
                throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("Ed25519 公钥与私钥不一致")
            }
            try validatePublicBlob(publicBlob, algorithm: .ed25519, publicBytes: embeddedPublic)
            parsed = try makeParsed(
                built.privateKey,
                algorithm: .ed25519,
                publicBytes: embeddedPublic,
                format: .openSSH,
                comment: comment
            )

        case "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521":
            let curve = try privateReader.readStringUTF8()
            guard let algorithm = algorithm(forSSHCurve: curve),
                  algorithm.sshAlgorithmName == keyType else {
                throw BridgeIOSSHPrivateKeyParseError.unsupportedAlgorithm(keyType)
            }
            let publicBytes = try privateReader.readString()
            let scalar = try privateReader.readString()
            let comment = try readComment(from: &privateReader)
            let built = try makeECDSA(algorithm: algorithm, scalar: scalar)
            guard built.publicBytes == publicBytes else {
                throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("ECDSA 公钥与私钥不一致")
            }
            try validatePublicBlob(publicBlob, algorithm: algorithm, publicBytes: publicBytes)
            parsed = try makeParsed(
                built.privateKey,
                algorithm: algorithm,
                publicBytes: publicBytes,
                format: .openSSH,
                comment: comment
            )

        case "ssh-rsa":
            throw BridgeIOSSHPrivateKeyParseError.rsaUnsupported("OpenSSH ssh-rsa")
        default:
            throw BridgeIOSSHPrivateKeyParseError.unsupportedAlgorithm(keyType)
        }

        let padding = try privateReader.readRemaining()
        guard !padding.isEmpty else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("缺少 padding")
        }
        for (index, byte) in padding.enumerated() {
            guard index < 255, byte == UInt8(index + 1) else {
                throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("padding 不正确")
            }
        }
        return parsed
    }

    private static func parsePKCS8(_ der: Data) throws -> BridgeIOSSHParsedPrivateKey {
        var outer = BridgeDERReader(data: der)
        var body = try outer.readSequence()
        guard outer.isAtEnd else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("顶层存在多余数据")
        }
        guard try body.readSmallInteger() == 0 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("PKCS#8 版本不支持")
        }

        var algorithmIdentifier = try body.readSequence()
        let algorithmOID = try algorithmIdentifier.readOID()
        var parametersOID: String?
        if algorithmIdentifier.isAtEnd {
            parametersOID = nil
        } else {
            parametersOID = try algorithmIdentifier.readOID()
            guard algorithmIdentifier.isAtEnd else {
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("算法参数过多")
            }
        }

        let privateOctets = try body.readOctetString()
        var outerPublicKey: Data?
        while !body.isAtEnd {
            let field = try body.readTLV()
            switch field.tag {
            case 0xa0:
                // Attributes are not relevant to SSH authentication.
                continue
            case 0x81, 0xa1:
                outerPublicKey = try BridgeDERReader.bitStringValue(from: field)
            default:
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("未知的 PKCS#8 可选字段")
            }
        }

        if algorithmOID == rsaEncryptionOID {
            throw BridgeIOSSHPrivateKeyParseError.rsaUnsupported("PKCS#8 rsaEncryption")
        }

        if algorithmOID == ed25519OID {
            guard parametersOID == nil else {
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("Ed25519 不应带算法参数")
            }
            let raw = try unwrapEd25519PrivateOctets(privateOctets)
            let built = try makeEd25519(raw)
            if let outerPublicKey, outerPublicKey != built.publicBytes {
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("Ed25519 公钥与私钥不一致")
            }
            return try makeParsed(
                built.privateKey,
                algorithm: .ed25519,
                publicBytes: built.publicBytes,
                format: .pkcs8,
                comment: nil
            )
        }

        guard algorithmOID == ecPublicKeyOID,
              let parametersOID,
              let algorithm = algorithm(forCurveOID: parametersOID) else {
            throw BridgeIOSSHPrivateKeyParseError.unsupportedAlgorithm(algorithmOID)
        }

        var sec1 = BridgeDERReader(data: privateOctets)
        var sec1Body = try sec1.readSequence()
        guard sec1.isAtEnd, try sec1Body.readSmallInteger() == 1 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("ECPrivateKey 版本不支持")
        }
        let scalar = try sec1Body.readOctetString()
        var sec1PublicKey: Data?
        while !sec1Body.isAtEnd {
            let field = try sec1Body.readTLV()
            switch field.tag {
            case 0xa0:
                var parameters = BridgeDERReader(data: field.value)
                let nestedOID = try parameters.readOID()
                guard parameters.isAtEnd, nestedOID == parametersOID else {
                    throw BridgeIOSSHPrivateKeyParseError.malformedDER("EC 曲线参数不一致")
                }
            case 0x81, 0xa1:
                sec1PublicKey = try BridgeDERReader.bitStringValue(from: field)
            default:
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("未知的 ECPrivateKey 可选字段")
            }
        }

        let built = try makeECDSA(algorithm: algorithm, scalar: scalar)
        if let sec1PublicKey, sec1PublicKey != built.publicBytes {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("EC 公钥与私钥不一致")
        }
        if let outerPublicKey, outerPublicKey != built.publicBytes {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("PKCS#8 公钥与私钥不一致")
        }
        return try makeParsed(
            built.privateKey,
            algorithm: algorithm,
            publicBytes: built.publicBytes,
            format: .pkcs8,
            comment: nil
        )
    }

    private static func unwrapEd25519PrivateOctets(_ value: Data) throws -> Data {
        if value.count == 32 { return value }
        var reader = BridgeDERReader(data: value)
        let nested = try reader.readOctetString()
        guard reader.isAtEnd, nested.count == 32 else {
            throw BridgeIOSSHPrivateKeyParseError.invalidKeyMaterial("Ed25519 PKCS#8 私钥长度不正确")
        }
        return nested
    }

    private static func makeEd25519(_ raw: Data) throws -> (privateKey: NIOSSHPrivateKey, publicBytes: Data) {
        guard raw.count == 32 else {
            throw BridgeIOSSHPrivateKeyParseError.invalidKeyMaterial("Ed25519 私钥应为 32 字节")
        }
        do {
            let key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
            return (NIOSSHPrivateKey(ed25519Key: key), key.publicKey.rawRepresentation)
        } catch {
            throw BridgeIOSSHPrivateKeyParseError.invalidKeyMaterial("Ed25519 私钥无法解析")
        }
    }

    private static func makeECDSA(
        algorithm: BridgeIOSSHPrivateKeyAlgorithm,
        scalar: Data
    ) throws -> (privateKey: NIOSSHPrivateKey, publicBytes: Data) {
        do {
            switch algorithm {
            case .ecdsaP256:
                let key = try P256.Signing.PrivateKey(rawRepresentation: scalar)
                return (NIOSSHPrivateKey(p256Key: key), key.publicKey.x963Representation)
            case .ecdsaP384:
                let key = try P384.Signing.PrivateKey(rawRepresentation: scalar)
                return (NIOSSHPrivateKey(p384Key: key), key.publicKey.x963Representation)
            case .ecdsaP521:
                let key = try P521.Signing.PrivateKey(rawRepresentation: scalar)
                return (NIOSSHPrivateKey(p521Key: key), key.publicKey.x963Representation)
            case .ed25519:
                throw BridgeIOSSHPrivateKeyParseError.invalidKeyMaterial("Ed25519 不能作为 ECDSA 曲线")
            }
        } catch let error as BridgeIOSSHPrivateKeyParseError {
            throw error
        } catch {
            throw BridgeIOSSHPrivateKeyParseError.invalidKeyMaterial("ECDSA 私钥无法解析")
        }
    }

    private static func makeParsed(
        _ privateKey: NIOSSHPrivateKey,
        algorithm: BridgeIOSSHPrivateKeyAlgorithm,
        publicBytes: Data,
        format: BridgeIOSSHPrivateKeyFormat,
        comment: String?
    ) throws -> BridgeIOSSHParsedPrivateKey {
        let blob = BridgeSSHKeyEncoding.publicBlob(algorithm: algorithm, publicBytes: publicBytes)
        let publicText = BridgeSSHKeyEncoding.openSSH(
            algorithm: algorithm,
            publicBytes: publicBytes,
            comment: comment
        )
        let publicKey = try NIOSSHPublicKey(openSSHPublicKey: publicText)
        return BridgeIOSSHParsedPrivateKey(
            format: format,
            algorithm: algorithm,
            comment: comment,
            privateKey: privateKey,
            publicKey: publicKey,
            publicKeyOpenSSH: publicText,
            fingerprintSHA256: BridgeSSHKeyEncoding.fingerprint(publicBlob: blob)
        )
    }

    private static func validatePublicBlob(
        _ actual: Data,
        algorithm: BridgeIOSSHPrivateKeyAlgorithm,
        publicBytes: Data
    ) throws {
        guard actual == BridgeSSHKeyEncoding.publicBlob(algorithm: algorithm, publicBytes: publicBytes) else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("公钥 blob 与私钥不一致")
        }
    }

    private static func readComment(from reader: inout BridgeSSHWireReader) throws -> String? {
        let data = try reader.readString()
        guard !data.isEmpty else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private static func algorithm(forSSHCurve curve: String) -> BridgeIOSSHPrivateKeyAlgorithm? {
        switch curve {
        case "nistp256": return .ecdsaP256
        case "nistp384": return .ecdsaP384
        case "nistp521": return .ecdsaP521
        default: return nil
        }
    }

    private static func algorithm(forCurveOID oid: String) -> BridgeIOSSHPrivateKeyAlgorithm? {
        switch oid {
        case p256OID: return .ecdsaP256
        case p384OID: return .ecdsaP384
        case p521OID: return .ecdsaP521
        default: return nil
        }
    }
}

private struct BridgeIOSSHPEM {
    let label: String
    let der: Data

    static func decode(_ text: String) throws -> BridgeIOSSHPEM {
        let lines = text.components(separatedBy: .newlines).map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let beginIndex = lines.firstIndex(where: { $0.hasPrefix("-----BEGIN ") }),
              beginIndex == 0,
              let endIndex = lines.firstIndex(where: { $0.hasPrefix("-----END ") }),
              endIndex > beginIndex else {
            throw BridgeIOSSHPrivateKeyParseError.malformedPEM
        }

        let begin = lines[beginIndex]
        guard begin.hasSuffix("-----") else {
            throw BridgeIOSSHPrivateKeyParseError.malformedPEM
        }
        let beginPrefix = "-----BEGIN "
        let label = String(begin.dropFirst(beginPrefix.count).dropLast(5))
        guard !label.isEmpty, lines[endIndex] == "-----END \(label)-----" else {
            throw BridgeIOSSHPrivateKeyParseError.malformedPEM
        }
        guard lines[(endIndex + 1)...].allSatisfy({ $0.isEmpty }) else {
            throw BridgeIOSSHPrivateKeyParseError.malformedPEM
        }

        let encoded = lines[(beginIndex + 1)..<endIndex].joined()
        guard !encoded.isEmpty, let der = Data(base64Encoded: encoded) else {
            throw BridgeIOSSHPrivateKeyParseError.malformedPEM
        }
        return BridgeIOSSHPEM(label: label, der: der)
    }
}

private struct BridgeSSHWireReader {
    private let data: Data
    private var offset: Int = 0

    init(data: Data) {
        self.data = data
    }

    var isAtEnd: Bool { offset == data.count }

    mutating func readUInt32() throws -> UInt32 {
        let bytes = try readRaw(count: 4)
        return bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }

    mutating func readString() throws -> Data {
        let length = Int(try readUInt32())
        guard length <= 4 * 1024 * 1024 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("SSH string 过大")
        }
        return try readRaw(count: length)
    }

    mutating func readStringUTF8() throws -> String {
        let bytes = try readString()
        guard let value = String(data: bytes, encoding: .utf8) else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("文本字段不是 UTF-8")
        }
        return value
    }

    mutating func readRaw(count: Int) throws -> Data {
        guard count >= 0, offset <= data.count - count else {
            throw BridgeIOSSHPrivateKeyParseError.malformedOpenSSH("数据提前结束")
        }
        let result = data.subdata(in: offset..<(offset + count))
        offset += count
        return result
    }

    mutating func readRemaining() throws -> Data {
        try readRaw(count: data.count - offset)
    }
}

private struct BridgeDERReader {
    struct TLV {
        let tag: UInt8
        let value: Data
    }

    private let data: Data
    private var offset: Int = 0

    init(data: Data) {
        self.data = data
    }

    var isAtEnd: Bool { offset == data.count }

    mutating func readSequence() throws -> BridgeDERReader {
        BridgeDERReader(data: try readValue(tag: 0x30))
    }

    mutating func readOctetString() throws -> Data {
        try readValue(tag: 0x04)
    }

    mutating func readSmallInteger() throws -> Int {
        let value = try readValue(tag: 0x02)
        guard !value.isEmpty, value.count <= 4, value.first! & 0x80 == 0 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("INTEGER 无效")
        }
        return value.reduce(0) { ($0 << 8) | Int($1) }
    }

    mutating func readOID() throws -> String {
        let value = try readValue(tag: 0x06)
        guard let first = value.first else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("OID 为空")
        }
        var components = [Int(min(first / 40, 2)), Int(first) - min(Int(first / 40), 2) * 40]
        var current: UInt64 = 0
        var hasCurrent = false
        for byte in value.dropFirst() {
            if current > (UInt64.max >> 7) {
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("OID 溢出")
            }
            current = (current << 7) | UInt64(byte & 0x7f)
            hasCurrent = true
            if byte & 0x80 == 0 {
                guard current <= UInt64(Int.max) else {
                    throw BridgeIOSSHPrivateKeyParseError.malformedDER("OID 过大")
                }
                components.append(Int(current))
                current = 0
                hasCurrent = false
            }
        }
        guard !hasCurrent else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("OID 未结束")
        }
        return components.map(String.init).joined(separator: ".")
    }

    mutating func readTLV() throws -> TLV {
        let tag = try readRawByte()
        let length = try readLength()
        guard length <= data.count - offset else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("字段长度超出范围")
        }
        let value = data.subdata(in: offset..<(offset + length))
        offset += length
        return TLV(tag: tag, value: value)
    }

    static func bitStringValue(from field: TLV) throws -> Data {
        switch field.tag {
        case 0x81:
            return try readBitStringContents(field.value)
        case 0xa1:
            var nested = BridgeDERReader(data: field.value)
            let value = try nested.readValue(tag: 0x03)
            guard nested.isAtEnd else {
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("BIT STRING 字段过长")
            }
            return try readBitStringContents(value)
        default:
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("BIT STRING 标签不正确")
        }
    }

    private static func readBitStringContents(_ value: Data) throws -> Data {
        guard let unusedBits = value.first, unusedBits == 0 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("BIT STRING 必须按字节对齐")
        }
        return Data(value.dropFirst())
    }

    private mutating func readValue(tag: UInt8) throws -> Data {
        let field = try readTLV()
        guard field.tag == tag else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("期望标签 0x\(String(tag, radix: 16))")
        }
        return field.value
    }

    private mutating func readRawByte() throws -> UInt8 {
        guard offset < data.count else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("数据提前结束")
        }
        let byte = data[offset]
        offset += 1
        return byte
    }

    private mutating func readLength() throws -> Int {
        let first = try readRawByte()
        if first & 0x80 == 0 { return Int(first) }
        let count = Int(first & 0x7f)
        guard count > 0, count <= 4 else {
            throw BridgeIOSSHPrivateKeyParseError.malformedDER("DER 长度格式不支持")
        }
        var length = 0
        for index in 0..<count {
            let byte = try readRawByte()
            if index == 0, byte == 0 {
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("DER 长度不是最短编码")
            }
            guard length <= (Int.max >> 8) else {
                throw BridgeIOSSHPrivateKeyParseError.malformedDER("DER 长度溢出")
            }
            length = (length << 8) | Int(byte)
        }
        return length
    }
}

private enum BridgeSSHKeyEncoding {
    static func publicBlob(
        algorithm: BridgeIOSSHPrivateKeyAlgorithm,
        publicBytes: Data
    ) -> Data {
        var writer = BridgeSSHWireWriter()
        writer.writeString(algorithm.sshAlgorithmName)
        if let curve = algorithm.sshCurveName {
            writer.writeString(curve)
        }
        writer.writeString(publicBytes)
        return writer.data
    }

    static func openSSH(
        algorithm: BridgeIOSSHPrivateKeyAlgorithm,
        publicBytes: Data,
        comment: String?
    ) -> String {
        let base64 = publicBlob(algorithm: algorithm, publicBytes: publicBytes).base64EncodedString()
        guard let comment, !comment.isEmpty else {
            return "\(algorithm.sshAlgorithmName) \(base64)"
        }
        return "\(algorithm.sshAlgorithmName) \(base64) \(comment)"
    }

    static func fingerprint(publicBlob: Data) -> String {
        let digest = SHA256.hash(data: publicBlob)
        return "SHA256:" + Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
    }
}

private struct BridgeSSHWireWriter {
    private(set) var data = Data()

    mutating func writeString(_ value: String) {
        writeString(Data(value.utf8))
    }

    mutating func writeString(_ value: Data) {
        precondition(value.count <= Int(UInt32.max), "SSH string too large")
        writeUInt32(UInt32(value.count))
        data.append(value)
    }

    private mutating func writeUInt32(_ value: UInt32) {
        data.append(UInt8((value >> 24) & 0xff))
        data.append(UInt8((value >> 16) & 0xff))
        data.append(UInt8((value >> 8) & 0xff))
        data.append(UInt8(value & 0xff))
    }
}
