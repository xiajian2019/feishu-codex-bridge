import Foundation

enum BridgeIOSSHApiBindingState: Equatable {
    case none
    case checking
    case verified
    case unavailable(String)
    case mismatch(String)
}

struct BridgeIOSSHRemoteSessionIdentity: Decodable {
    let id: String
    let createdAt: Int
}

struct BridgeIOSSHRemoteSession: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let windows: Int
    let attachedClients: Int
    let cwd: String
    let createdAt: Int
    let endedAt: String?
    let suspendedAt: String?
    let source: String?
    let uncertain: Bool?

    var isSelectable: Bool {
        windows > 0 && endedAt == nil && suspendedAt == nil && uncertain != true
    }

    var statusLabel: String {
        if endedAt != nil { return "已结束" }
        if suspendedAt != nil { return "已挂起" }
        if uncertain == true { return "待确认" }
        return "可连接"
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, windows, attachedClients, cwd, createdAt, endedAt, suspendedAt, source, uncertain
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        createdAt = try container.decode(Int.self, forKey: .createdAt)
        name = (try? container.decode(String.self, forKey: .name)) ?? id
        windows = (try? container.decode(Int.self, forKey: .windows)) ?? 0
        attachedClients = (try? container.decode(Int.self, forKey: .attachedClients)) ?? 0
        cwd = (try? container.decode(String.self, forKey: .cwd)) ?? ""
        endedAt = try container.decodeIfPresent(String.self, forKey: .endedAt)
        suspendedAt = try container.decodeIfPresent(String.self, forKey: .suspendedAt)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        uncertain = try container.decodeIfPresent(Bool.self, forKey: .uncertain)
    }
}

struct BridgeIOSSHComposerAttachment: Encodable, Equatable {
    let uploadId: String
    let name: String
    let contentType: String
}

struct BridgeIOSSHComposerResult: Decodable, Equatable {
    let ok: Bool
    let actionId: String?
    let status: String?
    let duplicate: Bool?
    let resultUnknown: Bool?
    let error: String?
}

private struct BridgeIOSSHIdentityResponse: Decodable {
    let session: BridgeIOSSHRemoteSessionIdentity
}

private struct BridgeIOSSHSessionListResponse: Decodable {
    let sessions: [BridgeIOSSHRemoteSession]
}

enum BridgeIOSSHSessionAPIError: Error, LocalizedError {
    case invalidContext
    case unauthorized
    case invalidResponse
    case identityMismatch
    case invalidSelection(String)
    case resultUnknown(String)
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalidContext: return "Session API 上下文不完整。"
        case .unauthorized: return "Bridge 凭据不可用，请重新配对。"
        case .invalidResponse: return "Bridge 返回的 Session 身份无效。"
        case .identityMismatch: return "Bridge Session 已变化或属于其他环境，请刷新后重试。"
        case .invalidSelection(let message): return message
        case .resultUnknown(let message): return message
        case .unavailable(let message): return message
        }
    }
}

enum BridgeIOSSHSessionAPI {
    static func listSessions(
        bridgeOrigin: String,
        sshHost: String,
        sshPort: Int,
        sshUsername: String?
    ) async throws -> [BridgeIOSSHRemoteSession] {
        let origin = try validatedOrigin(bridgeOrigin)
        let host = try validatedHost(sshHost)
        guard (1...65_535).contains(sshPort) else { throw BridgeIOSSHSessionAPIError.invalidContext }
        let username = try validatedUsername(sshUsername)
        guard let token = try readToken(for: origin) else {
            throw BridgeIOSSHSessionAPIError.unavailable("当前 Bridge 没有可用的配对凭据；无法读取 Session 列表。")
        }
        let url = try makeURL(origin: origin, path: "/tmux-dashboard/api/sessions",
                              queryItems: [URLQueryItem(name: "includeHomes", value: "0")])
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 12
        applyHeaders(to: &request, token: token, host: host, port: sshPort, username: username, createdAt: nil)
        let (data, response) = try await fetch(request)
        guard let http = response as? HTTPURLResponse else { throw BridgeIOSSHSessionAPIError.invalidResponse }
        try validateStatus(http.statusCode, unavailableMessage: "Bridge Session 列表返回 HTTP \(http.statusCode)。")
        let decoded: BridgeIOSSHSessionListResponse
        do { decoded = try JSONDecoder().decode(BridgeIOSSHSessionListResponse.self, from: data) }
        catch { throw BridgeIOSSHSessionAPIError.invalidResponse }
        for session in decoded.sessions {
            guard session.id.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
                  session.createdAt >= 0 else {
                throw BridgeIOSSHSessionAPIError.invalidResponse
            }
        }
        return decoded.sessions
    }

    static func makeSelection(
        for session: BridgeIOSSHRemoteSession,
        bridgeOrigin: String,
        sshHost: String,
        sshPort: Int
    ) throws -> BridgeIOSSHSessionSelection {
        let origin = try validatedOrigin(bridgeOrigin)
        let host = try validatedHost(sshHost)
        guard (1...65_535).contains(sshPort) else { throw BridgeIOSSHSessionAPIError.invalidContext }
        guard session.id.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
              session.createdAt >= 0 else {
            throw BridgeIOSSHSessionAPIError.invalidSelection("Bridge 返回的 Session 身份无效，请刷新后重试。")
        }
        guard session.isSelectable else {
            throw BridgeIOSSHSessionAPIError.invalidSelection("该 Session 已结束、挂起或需要重新确认，不能建立原生绑定。")
        }
        return BridgeIOSSHSessionSelection(
            bridgeOrigin: origin,
            sessionId: session.id,
            createdAt: session.createdAt,
            expectedSshHost: host,
            expectedSshPort: sshPort
        )
    }

    static func verifyIdentity(_ context: BridgeIOSSHSessionContext) async throws -> BridgeIOSSHRemoteSessionIdentity {
        let origin = try validatedOrigin(context.bridgeOrigin)
        guard context.sessionId.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
              context.createdAt >= 0,
              (1...65_535).contains(context.sshPort) else {
            throw BridgeIOSSHSessionAPIError.invalidContext
        }
        let host = try validatedHost(context.sshHost)
        let username = try validatedUsername(context.sshUsername)
        guard let token = try readToken(for: origin) else {
            throw BridgeIOSSHSessionAPIError.unavailable("当前 Bridge 没有可用的配对凭据；SSH 仍可独立使用。")
        }
        let url = try makeURL(origin: origin, path: "/tmux-dashboard/api/sessions/\(context.sessionId)/identity")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 12
        applyHeaders(to: &request, token: token, host: host, port: context.sshPort,
                     username: username, createdAt: context.createdAt)
        let (data, response) = try await fetch(request)
        guard let http = response as? HTTPURLResponse else { throw BridgeIOSSHSessionAPIError.invalidResponse }
        try validateStatus(http.statusCode, unavailableMessage: "Bridge Session API 返回 HTTP \(http.statusCode)。")
        let decoded: BridgeIOSSHIdentityResponse
        do { decoded = try JSONDecoder().decode(BridgeIOSSHIdentityResponse.self, from: data) }
        catch { throw BridgeIOSSHSessionAPIError.invalidResponse }
        guard decoded.session.id == context.sessionId, decoded.session.createdAt == context.createdAt else {
            throw BridgeIOSSHSessionAPIError.identityMismatch
        }
        return decoded.session
    }

    static func sendComposer(
        context: BridgeIOSSHSessionContext,
        idempotencyKey: String,
        text: String,
        attachments: [BridgeIOSSHComposerAttachment] = []
    ) async throws -> BridgeIOSSHComposerResult {
        guard !idempotencyKey.isEmpty, idempotencyKey.count <= 200,
              !text.isEmpty, text.count <= 32_768 else {
            throw BridgeIOSSHSessionAPIError.invalidContext
        }
        let origin = try validatedOrigin(context.bridgeOrigin)
        let host = try validatedHost(context.sshHost)
        let username = try validatedUsername(context.sshUsername) ?? context.sshUsername
        guard context.sessionId.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
              context.createdAt >= 0, (1...65_535).contains(context.sshPort) else {
            throw BridgeIOSSHSessionAPIError.invalidContext
        }
        guard let token = try readToken(for: origin) else {
            throw BridgeIOSSHSessionAPIError.unavailable("当前 Bridge 没有可用的配对凭据；SSH 仍可独立使用。")
        }
        let actionToken = try await readActionToken(origin: origin, token: token)
        let url = try makeURL(origin: origin, path: "/tmux-dashboard/api/sessions/\(context.sessionId)/composer")
        let payload: [String: Any] = [
            "idempotencyKey": idempotencyKey,
            "text": text,
            "attachments": attachments.map { [
                "uploadId": $0.uploadId,
                "name": $0.name,
                "contentType": $0.contentType,
            ] },
        ]
        let body = try JSONSerialization.data(withJSONObject: payload, options: [])
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyHeaders(to: &request, token: token, host: host, port: context.sshPort,
                     username: username, createdAt: context.createdAt, sessionId: context.sessionId)
        request.setValue(actionToken, forHTTPHeaderField: "X-Bridge-Action-Token")
        request.setValue("ios-native-ssh", forHTTPHeaderField: "X-Bridge-Client")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw BridgeIOSSHSessionAPIError.resultUnknown("Composer 请求结果未知；请先查看 Session，不要生成新幂等键重试。")
        }
        guard let http = response as? HTTPURLResponse else { throw BridgeIOSSHSessionAPIError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 403 { throw BridgeIOSSHSessionAPIError.unauthorized }
        if http.statusCode >= 500 { throw BridgeIOSSHSessionAPIError.resultUnknown("Bridge 可能已处理 Composer 请求；请先查看 Session。") }
        if http.statusCode == 409 {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw BridgeIOSSHSessionAPIError.invalidSelection(message ?? "Composer 请求与当前 Session 不一致。")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BridgeIOSSHSessionAPIError.unavailable("Bridge Composer API 返回 HTTP \(http.statusCode)。")
        }
        let decoded: BridgeIOSSHComposerResult
        do { decoded = try JSONDecoder().decode(BridgeIOSSHComposerResult.self, from: data) }
        catch { throw BridgeIOSSHSessionAPIError.invalidResponse }
        return decoded
    }

    static func uploadComposerAttachment(
        context: BridgeIOSSHSessionContext,
        fileURL: URL,
        fileName: String,
        contentType: String,
        onProgress: ((Int64, Int64) -> Void)? = nil
    ) async throws -> BridgeIOSSHComposerAttachment {
        let origin = try validatedOrigin(context.bridgeOrigin)
        let host = try validatedHost(context.sshHost)
        let username = try validatedUsername(context.sshUsername) ?? context.sshUsername
        guard context.sessionId.range(of: #"^\$\d{1,16}$"#, options: .regularExpression) != nil,
              context.createdAt >= 0, (1...65_535).contains(context.sshPort) else {
            throw BridgeIOSSHSessionAPIError.invalidContext
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        guard let sizeNumber = attributes[.size] as? NSNumber else { throw BridgeIOSSHSessionAPIError.invalidContext }
        let size = sizeNumber.int64Value
        guard size >= 0, size <= Int64.max else { throw BridgeIOSSHSessionAPIError.invalidContext }
        guard let token = try readToken(for: origin) else {
            throw BridgeIOSSHSessionAPIError.unavailable("当前 Bridge 没有可用的配对凭据；无法上传附件。")
        }
        let actionToken = try await readActionToken(origin: origin, token: token)
        let createURL = try makeURL(origin: origin, path: "/tmux-dashboard/api/attachments/uploads")
        var create = URLRequest(url: createURL)
        create.httpMethod = "POST"
        create.timeoutInterval = 15
        create.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyHeaders(to: &create, token: token, host: host, port: context.sshPort,
                     username: username, createdAt: context.createdAt, sessionId: context.sessionId)
        create.setValue(actionToken, forHTTPHeaderField: "X-Bridge-Action-Token")
        let createPayload: [String: Any] = [
            "fileName": fileName,
            "contentType": contentType,
            "sizeBytes": size,
        ]
        create.httpBody = try JSONSerialization.data(withJSONObject: createPayload, options: [])
        let createData: Data
        let createResponse: URLResponse
        do { (createData, createResponse) = try await URLSession.shared.data(for: create) }
        catch { throw BridgeIOSSHSessionAPIError.unavailable("附件上传尚未开始，请检查 Bridge 连接。") }
        guard let createHTTP = createResponse as? HTTPURLResponse else { throw BridgeIOSSHSessionAPIError.invalidResponse }
        if createHTTP.statusCode == 401 || createHTTP.statusCode == 403 { throw BridgeIOSSHSessionAPIError.unauthorized }
        guard (200..<300).contains(createHTTP.statusCode),
              let createdObject = try? JSONSerialization.jsonObject(with: createData),
              let created = createdObject as? [String: Any],
              let uploadId = created["id"] as? String,
              let chunkNumber = created["chunkBytes"] as? NSNumber,
              chunkNumber.int64Value > 0 else {
            throw BridgeIOSSHSessionAPIError.unavailable("Bridge 附件上传接口不可用。")
        }
        let chunkBytes = min(Int64(8 * 1024 * 1024), chunkNumber.int64Value)
        var offset: Int64 = 0
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        do {
            while offset < size {
                let length = Int(min(chunkBytes, size - offset))
                let data = try handle.read(upToCount: length) ?? Data()
                guard !data.isEmpty else { throw BridgeIOSSHSessionAPIError.invalidResponse }
                var part = URLRequest(url: try makeURL(origin: origin, path: "/tmux-dashboard/api/attachments/uploads/\(uploadId)"))
                part.httpMethod = "PUT"
                part.timeoutInterval = 30
                if var components = part.url.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) {
                    components.queryItems = [URLQueryItem(name: "offset", value: String(offset))]
                    part.url = components.url
                }
                part.httpBody = data
                part.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                applyHeaders(to: &part, token: token, host: host, port: context.sshPort,
                             username: username, createdAt: context.createdAt, sessionId: context.sessionId)
                part.setValue(actionToken, forHTTPHeaderField: "X-Bridge-Action-Token")
                let partData: Data
                let partResponse: URLResponse
                do { (partData, partResponse) = try await URLSession.shared.upload(for: part, from: data) }
                catch { throw BridgeIOSSHSessionAPIError.resultUnknown("附件分块上传结果未知；请保留原附件后重试。") }
                guard let partHTTP = partResponse as? HTTPURLResponse else { throw BridgeIOSSHSessionAPIError.invalidResponse }
                if partHTTP.statusCode == 401 || partHTTP.statusCode == 403 { throw BridgeIOSSHSessionAPIError.unauthorized }
                guard (200..<300).contains(partHTTP.statusCode),
                      let resultObject = try? JSONSerialization.jsonObject(with: partData),
                      let result = resultObject as? [String: Any],
                      let nextOffset = result["offset"] as? NSNumber, nextOffset.int64Value == offset + Int64(data.count) else {
                    throw BridgeIOSSHSessionAPIError.resultUnknown("附件分块进度未知；请保留原附件后重试。")
                }
                offset = nextOffset.int64Value
                onProgress?(offset, size)
            }
        } catch let error as BridgeIOSSHSessionAPIError {
            throw error
        } catch {
            throw BridgeIOSSHSessionAPIError.resultUnknown("附件上传结果未知；请保留原附件后重试。")
        }
        var complete = URLRequest(url: try makeURL(origin: origin, path: "/tmux-dashboard/api/attachments/uploads/\(uploadId)/complete"))
        complete.httpMethod = "POST"
        complete.timeoutInterval = 15
        complete.httpBody = Data("{}".utf8)
        complete.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyHeaders(to: &complete, token: token, host: host, port: context.sshPort,
                     username: username, createdAt: context.createdAt, sessionId: context.sessionId)
        complete.setValue(actionToken, forHTTPHeaderField: "X-Bridge-Action-Token")
        let completedResponse: URLResponse
        do { (_, completedResponse) = try await URLSession.shared.data(for: complete) }
        catch { throw BridgeIOSSHSessionAPIError.resultUnknown("附件完成结果未知；请保留原附件后重试。") }
        guard let completedHTTP = completedResponse as? HTTPURLResponse else { throw BridgeIOSSHSessionAPIError.invalidResponse }
        if completedHTTP.statusCode == 401 || completedHTTP.statusCode == 403 { throw BridgeIOSSHSessionAPIError.unauthorized }
        guard (200..<300).contains(completedHTTP.statusCode) else {
            throw BridgeIOSSHSessionAPIError.resultUnknown("附件完成结果未知；请保留原附件后重试。")
        }
        return BridgeIOSSHComposerAttachment(uploadId: uploadId, name: fileName, contentType: contentType)
    }

    private static func readToken(for origin: String) throws -> String? {
        do { return try BridgeIOSecureCredentialStore.readToken(server: origin) }
        catch { throw BridgeIOSSHSessionAPIError.unavailable("无法读取当前 Bridge 的配对凭据。") }
    }

    private static func readActionToken(origin: String, token: String) async throws -> String {
        let url = try makeURL(origin: origin, path: "/api/session")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 12
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("ios-native-ssh", forHTTPHeaderField: "X-Bridge-Client")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch { throw BridgeIOSSHSessionAPIError.unavailable("无法读取当前 Bridge Action Token。") }
        guard let http = response as? HTTPURLResponse else { throw BridgeIOSSHSessionAPIError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 403 { throw BridgeIOSSHSessionAPIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw BridgeIOSSHSessionAPIError.unavailable("Bridge Action Token 暂时不可用。")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let actionToken = object["actionToken"] as? String, !actionToken.isEmpty else {
            throw BridgeIOSSHSessionAPIError.invalidResponse
        }
        return actionToken
    }

    private static func fetch(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do { return try await URLSession.shared.data(for: request) }
        catch { throw BridgeIOSSHSessionAPIError.unavailable("Bridge Session API 暂时不可达；请检查网络或重新配对。") }
    }

    private static func validateStatus(_ statusCode: Int, unavailableMessage: String) throws {
        if statusCode == 401 || statusCode == 403 { throw BridgeIOSSHSessionAPIError.unauthorized }
        guard (200..<300).contains(statusCode) else {
            throw BridgeIOSSHSessionAPIError.unavailable(unavailableMessage)
        }
    }

    private static func validatedOrigin(_ value: String) throws -> String {
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              value.count <= 2_048 else {
            throw BridgeIOSSHSessionAPIError.invalidContext
        }
        var components = URLComponents()
        components.scheme = scheme
        components.host = url.host
        components.port = url.port
        guard let origin = components.string else { throw BridgeIOSSHSessionAPIError.invalidContext }
        return origin
    }

    private static func validatedHost(_ value: String) throws -> String {
        let host = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            .lowercased()
        guard !host.isEmpty, host.count <= 253,
              !host.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f || $0.value == 0x2f || $0.value == 0x3f || $0.value == 0x23 || $0.value == 0x40 }) else {
            throw BridgeIOSSHSessionAPIError.invalidContext
        }
        return host
    }

    private static func validatedUsername(_ value: String?) throws -> String? {
        guard let value else { return nil }
        let username = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard username.isEmpty || (username.count <= 255 && !username.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f || CharacterSet.whitespacesAndNewlines.contains($0) })) else {
            throw BridgeIOSSHSessionAPIError.invalidContext
        }
        return username.isEmpty ? nil : username
    }

    private static func makeURL(origin: String, path: String, queryItems: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(string: origin) else { throw BridgeIOSSHSessionAPIError.invalidContext }
        components.percentEncodedPath = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { throw BridgeIOSSHSessionAPIError.invalidContext }
        return url
    }

    private static func applyHeaders(
        to request: inout URLRequest,
        token: String,
        host: String,
        port: Int,
        username: String?,
        createdAt: Int?,
        sessionId: String? = nil
    ) {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("ios-native-ssh", forHTTPHeaderField: "X-Bridge-Client")
        request.setValue(host, forHTTPHeaderField: "X-Bridge-SSH-Host")
        request.setValue(String(port), forHTTPHeaderField: "X-Bridge-SSH-Port")
        if let username { request.setValue(username, forHTTPHeaderField: "X-Bridge-SSH-Username") }
        if let createdAt { request.setValue(String(createdAt), forHTTPHeaderField: "X-Bridge-Session-Created-At") }
        if let sessionId { request.setValue(sessionId, forHTTPHeaderField: "X-Bridge-SSH-Session-Id") }
    }
}
