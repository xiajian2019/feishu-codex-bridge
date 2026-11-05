package dev.feishu.codex.bridge

import java.io.InputStream
import java.io.OutputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Streaming file requests; no credentials or file bodies enter URLs or logs. */
internal interface BridgeSshApiFileTransport {
    suspend fun download(url: String, headers: Map<String, String>, output: OutputStream, maxBytes: Long?): Boolean
    suspend fun upload(url: String, headers: Map<String, String>, input: InputStream)
    suspend fun uploadChunk(url: String, headers: Map<String, String>, data: ByteArray, length: Int): String =
        throw BridgeSshApiRequestException("分片上传不可用。")
}

internal class AndroidBridgeSshApiFileTransport : BridgeSshApiFileTransport {
    override suspend fun download(
        url: String, headers: Map<String, String>, output: OutputStream, maxBytes: Long?,
    ): Boolean = withContext(Dispatchers.IO) {
        val connection = open(url, "GET", headers)
        var written = 0L
        var outputStarted = false
        try {
            val status = try { connection.responseCode }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { throw BridgeSshApiFallbackException("文件 API 不可达") }
            if (status == 401 || status >= 500) throw BridgeSshApiFallbackException("文件 API HTTP $status")
            if (status !in 200..299) throw BridgeSshApiRequestException("文件读取失败（HTTP $status），请刷新后核对。")
            val expected = connection.contentLengthLong
            val buffer = ByteArray(CHUNK_BYTES)
            try {
                connection.inputStream.use { input ->
                    while (maxBytes == null || written < maxBytes) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer, 0, if (maxBytes == null) buffer.size else minOf(buffer.size.toLong(), maxBytes - written).toInt())
                        if (count < 0) {
                            if (expected >= 0 && written < expected) throw BridgeSshApiRequestException("文件下载中断，请重试。")
                            return@withContext false
                        }
                        if (count == 0) continue
                        outputStarted = true
                        output.write(buffer, 0, count)
                        written += count
                    }
                    val more = input.read()
                    if (more < 0 && expected >= 0 && written < expected) throw BridgeSshApiRequestException("文件下载中断，请重试。")
                    return@withContext more >= 0
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: BridgeSshApiRequestException) {
                throw error
            } catch (_: Exception) {
                // Once output may contain bytes, do not append an SFTP retry to
                // the partially written destination.
                if (outputStarted) throw BridgeSshApiRequestException("文件下载中断，请重新下载。")
                throw BridgeSshApiFallbackException("文件 API 不可达")
            }
        } finally { connection.disconnect() }
    }

    override suspend fun upload(
        url: String, headers: Map<String, String>, input: InputStream,
    ) = withContext(Dispatchers.IO) {
        val connection = open(url, "POST", headers)
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/octet-stream")
        connection.setChunkedStreamingMode(CHUNK_BYTES)
        var started = false
        try {
            started = true
            val stream = connection.outputStream
            stream.use { output ->
                val buffer = ByteArray(CHUNK_BYTES)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count > 0) output.write(buffer, 0, count)
                }
            }
            val status = connection.responseCode
            if (status !in 200..299) {
                val detail = if (status >= 500) "上传结果可能未知，请先刷新目录核对。" else "请检查目录、大小或同名文件。"
                throw BridgeSshApiRequestException("文件上传失败（HTTP $status）。$detail")
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: BridgeSshApiRequestException) {
            throw error
        } catch (_: Exception) {
            if (started) throw BridgeSshApiRequestException("上传结果未知，请先刷新目录核对，不会自动重复上传。")
            throw BridgeSshApiFallbackException("文件 API 不可达")
        } finally { connection.disconnect() }
    }

    override suspend fun uploadChunk(
        url: String, headers: Map<String, String>, data: ByteArray, length: Int,
    ): String = withContext(Dispatchers.IO) {
        require(length in 1..data.size)
        val connection = open(url, "PUT", headers)
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/octet-stream")
        connection.setFixedLengthStreamingMode(length)
        try {
            currentCoroutineContext().ensureActive()
            connection.outputStream.use { it.write(data, 0, length) }
            val status = connection.responseCode
            if (status !in 200..299) {
                throw BridgeSshApiRequestException("附件分片上传失败（HTTP $status），请检查后重试。")
            }
            connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val responseBuffer = ByteArray(4 * 1024)
                while (true) {
                    val count = input.read(responseBuffer)
                    if (count < 0) break
                    if (output.size() + count > 64 * 1024) throw BridgeSshApiRequestException("附件上传响应无效，请检查后重试。")
                    output.write(responseBuffer, 0, count)
                }
                output.toString(Charsets.UTF_8.name())
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: BridgeSshApiRequestException) {
            throw error
        } catch (_: Exception) {
            throw BridgeSshApiRequestException("附件上传进度未知，请检查连接后重试。")
        } finally { connection.disconnect() }
    }

    private fun open(url: String, method: String, headers: Map<String, String>): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8_000
            readTimeout = 35_000
            instanceFollowRedirects = false
            useCaches = false
            headers.forEach { (name, value) -> setRequestProperty(name, value) }
        }

    private companion object { const val CHUNK_BYTES = 64 * 1024 }
}
