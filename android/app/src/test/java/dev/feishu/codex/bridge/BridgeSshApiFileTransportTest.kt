package dev.feishu.codex.bridge

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshApiFileTransportTest {
    @Test
    fun streamingTransfersRejectRedirectsAndDoNotRetryPartialDownloads() = runBlocking {
        val content = ByteArray(100_000) { (it % 127).toByte() }
        val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val redirected = AtomicBoolean(false)
        val uploaded = AtomicReference(ByteArray(0))
        val running = AtomicBoolean(true)
        val thread = Thread {
            while (running.get()) {
                val socket = try { server.accept() } catch (_: SocketException) { break }
                socket.use {
                    try {
                        val input = socket.getInputStream()
                        val request = readLine(input).split(' ')
                        val headers = mutableMapOf<String, String>()
                        while (true) {
                            val line = readLine(input)
                            if (line.isEmpty()) break
                            headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
                        }
                        val body = if (headers["transfer-encoding"]?.lowercase() == "chunked") readChunked(input)
                            else readBytes(input, headers["content-length"]?.toIntOrNull() ?: 0)
                        val output = socket.getOutputStream()
                        fun respond(status: String, bytes: ByteArray, length: Int = bytes.size, extra: String = "") {
                            output.write("HTTP/1.1 $status\r\nContent-Length: $length\r\nConnection: close\r\n${extra}\r\n".toByteArray())
                            output.write(bytes)
                            output.flush()
                        }
                        when (request[1]) {
                            "/file" -> respond("200 OK", content)
                            "/partial" -> respond("200 OK", byteArrayOf(1, 2), 20)
                            "/redirect" -> respond("302 Found", byteArrayOf(), extra = "Location: /destination\r\n")
                            "/destination" -> { redirected.set(true); respond("200 OK", byteArrayOf()) }
                            "/upload" -> { uploaded.set(body); respond("201 Created", byteArrayOf()) }
                            "/chunk" -> respond("200 OK", """{"offset":${body.size}}""".toByteArray())
                            else -> respond("404 Not Found", byteArrayOf())
                        }
                    } catch (_: java.io.IOException) { /* A bounded preview can close its response early. */ }
                }
            }
        }.apply { isDaemon = true; start() }
        try {
            val transport = AndroidBridgeSshApiFileTransport()
            val origin = "http://127.0.0.1:${server.localPort}"
            val headers = mapOf("Authorization" to "Bearer fixture")
            val output = ByteArrayOutputStream()
            assertFalse(transport.download("$origin/file", headers, output, null))
            assertArrayEquals(content, output.toByteArray())
            val preview = ByteArrayOutputStream()
            assertTrue(transport.download("$origin/file", headers, preview, 32))
            assertArrayEquals(content.copyOf(32), preview.toByteArray())
            val partial = ByteArrayOutputStream()
            val partialError = runCatching { transport.download("$origin/partial", headers, partial, null) }.exceptionOrNull()
            assertTrue(partialError is BridgeSshApiRequestException)
            assertArrayEquals(byteArrayOf(1, 2), partial.toByteArray())
            val redirectError = runCatching { transport.download("$origin/redirect", headers, ByteArrayOutputStream(), null) }.exceptionOrNull()
            assertTrue(redirectError is BridgeSshApiRequestException)
            assertFalse(redirected.get())
            transport.upload("$origin/upload", headers, ByteArrayInputStream(content))
            assertArrayEquals(content, uploaded.get())
            assertEquals("""{"offset":32}""", transport.uploadChunk("$origin/chunk", headers, content, 32))
        } finally {
            running.set(false)
            server.close()
            thread.join(2_000)
        }
    }

    private fun readLine(input: InputStream): String {
        val result = ByteArrayOutputStream()
        while (true) {
            val value = input.read()
            if (value < 0) throw java.io.EOFException()
            if (value == '\n'.code) return result.toString("UTF-8").trimEnd('\r')
            result.write(value)
            check(result.size() < 16_384)
        }
    }

    private fun readBytes(input: InputStream, length: Int): ByteArray {
        val bytes = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val count = input.read(bytes, offset, length - offset)
            if (count < 0) throw java.io.EOFException()
            offset += count
        }
        return bytes
    }

    private fun readChunked(input: InputStream): ByteArray {
        val result = ByteArrayOutputStream()
        while (true) {
            val count = readLine(input).substringBefore(';').toInt(16)
            if (count == 0) { readLine(input); return result.toByteArray() }
            result.write(readBytes(input, count))
            readLine(input)
        }
    }
}
