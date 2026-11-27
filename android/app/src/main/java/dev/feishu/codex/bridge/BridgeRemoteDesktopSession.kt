package dev.feishu.codex.bridge

import android.os.Handler
import android.os.Looper
import com.gaurav.avnc.vnc.UserCredential
import com.gaurav.avnc.vnc.VncClient
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Owns one direct-TCP LibVNCClient session and keeps all blocking work off UI. */
internal class BridgeRemoteDesktopSession(
    private val host: String,
    private val port: Int,
    private val callbacks: Callbacks,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) {
    interface Callbacks {
        fun onCredentialsRequired(needsUsername: Boolean, needsPassword: Boolean)
        fun onConnected(name: String, width: Int, height: Int)
        fun onFrame(width: Int, height: Int, pixels: IntArray)
        fun onClipboard(text: String)
        fun onError(message: String)
    }

    private val stopped = AtomicBoolean(false)
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "bridge-remote-desktop-session").apply { isDaemon = true }
    }
    private val inputExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "bridge-remote-desktop-input").apply { isDaemon = true }
    }
    @Volatile private var client: VncClient? = null
    private var prompt: CredentialPrompt? = null

    fun start() {
        stopped.set(false)
        executor.execute { run() }
    }

    fun stop() {
        stopped.set(true)
        synchronized(this) {
            prompt?.complete(UserCredential())
            prompt = null
        }
    }

    fun close() {
        stop()
        executor.shutdownNow()
        inputExecutor.shutdownNow()
    }

    fun provideCredentials(username: String, password: String) {
        synchronized(this) {
            prompt?.complete(UserCredential(username, password))
            prompt = null
        }
    }

    fun sendPointer(x: Int, y: Int, mask: Int) {
        enqueueInput { it.sendPointerEvent(x, y, mask) }
    }

    fun sendKey(keySym: Int, xtCode: Int = 0, down: Boolean) {
        enqueueInput { it.sendKeyEvent(keySym, xtCode, down) }
    }

    fun sendText(text: String) {
        if (stopped.get()) return
        enqueueInput { current ->
            text.codePoints().forEach { codePoint ->
                when (codePoint) {
                    10, 13 -> {
                        current.sendKeyEvent(0xff0d, 0, true)
                        current.sendKeyEvent(0xff0d, 0, false)
                    }
                    9 -> {
                        current.sendKeyEvent(0xff09, 0, true)
                        current.sendKeyEvent(0xff09, 0, false)
                    }
                    else -> if (codePoint >= 0x20) {
                        current.sendKeyEvent(codePoint, 0, true)
                        current.sendKeyEvent(codePoint, 0, false)
                    }
                }
            }
        }
    }

    fun sendClipboard(text: String) {
        enqueueInput { it.sendCutText(text.take(MAX_CLIPBOARD_CHARS)) }
    }

    fun refresh() {
        enqueueInput { it.refreshFrameBuffer() }
    }

    private fun enqueueInput(action: (VncClient) -> Unit) {
        if (stopped.get()) return
        try {
            inputExecutor.execute {
                if (!stopped.get()) client?.let(action)
            }
        } catch (_: RejectedExecutionException) {
            // Activity teardown can race with a final input tap.
        }
    }

    private fun run() {
        val observer = object : VncClient.Observer {
            override fun getVncPassword(): String = awaitCredentials(false, true).password

            override fun getVncCredentials(): UserCredential = awaitCredentials(true, true)

            override fun verifyVncServerCertificate(certificate: java.security.cert.X509Certificate): Boolean = false

            override fun onCutTextReceived(text: String) {
                post { callbacks.onClipboard(text) }
            }

            override fun onFramebufferUpdated() {
                val current = client ?: return
                val width = current.getWidth()
                val height = current.getHeight()
                val pixels = current.copyFrameBuffer() ?: return
                if (width > 0 && height > 0 && pixels.size == width * height) {
                    post { callbacks.onFrame(width, height, pixels) }
                }
            }

            override fun onFramebufferSizeChanged(width: Int, height: Int) = Unit
            override fun onPointerMoved(x: Int, y: Int) = Unit
            override fun onBell() = Unit
        }
        val next = try { VncClient(observer) } catch (error: Exception) {
            post { callbacks.onError(errorMessage(error, "无法初始化原生 VNC。")) }
            return
        }
        synchronized(this) { client = next }
        try {
            next.configure(0, false, 6, false)
            next.connect(host, port)
            if (stopped.get()) return
            post { callbacks.onConnected(next.getDesktopName(), next.getWidth(), next.getHeight()) }
            while (!stopped.get()) next.processServerMessage()
        } catch (error: Exception) {
            if (!stopped.get()) post { callbacks.onError(errorMessage(error, "VNC 连接或认证失败，请检查 Mac 屏幕共享和 5900 端口。")) }
        } finally {
            synchronized(this) {
                if (client === next) {
                    next.cleanup()
                    client = null
                }
                prompt?.complete(UserCredential())
                prompt = null
            }
        }
    }

    private fun awaitCredentials(needsUsername: Boolean, needsPassword: Boolean): UserCredential {
        val request = CredentialPrompt(needsUsername, needsPassword)
        synchronized(this) { prompt = request }
        mainHandler.post { callbacks.onCredentialsRequired(needsUsername, needsPassword) }
        request.latch.await(CREDENTIAL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        synchronized(this) {
            if (prompt === request) prompt = null
        }
        return request.result ?: UserCredential()
    }

    private fun post(action: () -> Unit) = mainHandler.post(action)

    private fun errorMessage(error: Exception, fallback: String): String =
        error.message?.trim()?.takeIf { it.isNotEmpty() } ?: fallback

    private class CredentialPrompt(val needsUsername: Boolean, val needsPassword: Boolean) {
        val latch = CountDownLatch(1)
        @Volatile var result: UserCredential? = null
        fun complete(value: UserCredential) {
            result = value
            latch.countDown()
        }
    }

    private companion object {
        const val CREDENTIAL_TIMEOUT_SECONDS = 120L
        const val MAX_CLIPBOARD_CHARS = 1_048_576
    }
}
