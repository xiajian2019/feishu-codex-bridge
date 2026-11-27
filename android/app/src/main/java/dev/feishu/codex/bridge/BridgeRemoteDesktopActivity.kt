package dev.feishu.codex.bridge

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.lang.ref.WeakReference
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

internal class BridgeRemoteDesktopActivity : ComponentActivity(), BridgeRemoteDesktopSession.Callbacks {
    private var host = ""
    private var port = DEFAULT_VNC_PORT
    private var desktopTitle by mutableStateOf("远程桌面")
    private var status by mutableStateOf("连接中")
    private var connected by mutableStateOf(false)
    private var errorMessage by mutableStateOf<String?>(null)
    private var remoteClipboard by mutableStateOf("")
    private var clipboardDraft by mutableStateOf("")
    private var controlsExpanded by mutableStateOf(false)
    private var clipboardOpen by mutableStateOf(false)
    private var viewOnly by mutableStateOf(false)
    private var keyboardOpen by mutableStateOf(false)
    private var keyboardDraft by mutableStateOf("")
    private var panMode by mutableStateOf(false)
    private var immersiveMode by mutableStateOf(false)
    private var credentials by mutableStateOf<CredentialsPrompt?>(null)
    private var frameBitmap by mutableStateOf<Bitmap?>(null)
    private var fps by mutableStateOf(0)
    private var frameCount = 0
    private var pendingCredentialSave: PendingCredentialSave? = null
    private var session: BridgeRemoteDesktopSession? = null
    private val credentialStore by lazy { BridgeVncCredentialStore(this) }
    private var canvasView: RemoteDesktopCanvasView? = null
    private val frameExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "bridge-remote-desktop-bitmap").apply { isDaemon = true }
    }
    private val frameLock = Any()
    private var pendingFrame: PendingFrame? = null
    private var frameRenderScheduled = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val fpsUpdate = object : Runnable {
        override fun run() {
            fps = frameCount
            frameCount = 0
            mainHandler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setLandscapeMode(false)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.BLACK
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        readIntent(intent)
        activeRef = WeakReference(this)
        createSession()
        setContent { BridgeRemoteDesktopScreen() }
        mainHandler.post(fpsUpdate)
        session?.start()
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        val nextHost = intent.getStringExtra(EXTRA_HOST) ?: return
        val nextPort = intent.getIntExtra(EXTRA_PORT, DEFAULT_VNC_PORT)
        val nextTitle = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "远程桌面" }
        reconnect(nextHost, nextPort, nextTitle)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(fpsUpdate)
        session?.close()
        frameExecutor.shutdownNow()
        frameBitmap?.recycle()
        frameBitmap = null
        if (activeRef?.get() === this) {
            activeRef = null
            if (isFinishing) BridgeRemoteDesktopPlugin.notifyWorkspaceClosed()
        }
        super.onDestroy()
    }

    private fun setLandscapeMode(locked: Boolean) {
        requestedOrientation = if (locked) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        }
    }

    private fun applyImmersiveMode(enabled: Boolean) {
        immersiveMode = enabled
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (enabled) controller.hide(WindowInsetsCompat.Type.systemBars())
        else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    private fun toggleFullscreen() {
        val enabled = !immersiveMode
        applyImmersiveMode(enabled)
        // Fullscreen is the deliberate landscape action. The normal workspace
        // follows the device sensor just like the Web/noVNC page.
        setLandscapeMode(enabled)
    }

    fun reconnect(nextHost: String, nextPort: Int, nextTitle: String) {
        host = nextHost
        port = nextPort
        desktopTitle = nextTitle
        session?.close()
        createSession()
        errorMessage = null
        connected = false
        status = "连接中"
        session?.start()
    }

    fun finishWorkspace() {
        session?.close()
        finish()
    }

    override fun onCredentialsRequired(needsUsername: Boolean, needsPassword: Boolean) {
        val saved = credentialStore.get(host, port)
        if (saved != null && (!needsUsername || saved.username.isNotBlank()) && (!needsPassword || saved.password.isNotBlank())) {
            status = "正在使用本机保存的凭据"
            session?.provideCredentials(saved.username, saved.password)
        } else {
            credentials = CredentialsPrompt(
                needsUsername = needsUsername,
                needsPassword = needsPassword,
                initialUsername = saved?.username.orEmpty(),
                initialPassword = saved?.password.orEmpty(),
            )
        }
    }

    override fun onConnected(name: String, width: Int, height: Int) {
        connected = true
        errorMessage = null
        status = "已连接"
        if (name.isNotBlank()) desktopTitle = name
        pendingCredentialSave?.takeIf { it.host == host && it.port == port }?.let { pending ->
            try {
                credentialStore.set(host, port, pending.credentials)
                status = "已连接 · 凭据已保存"
            } catch (_: Exception) {
                status = "已连接 · 凭据保存失败"
            }
            pendingCredentialSave = null
        }
    }

    override fun onFrame(width: Int, height: Int, pixels: IntArray) {
        frameCount += 1
        synchronized(frameLock) {
            pendingFrame = PendingFrame(width, height, pixels)
            if (frameRenderScheduled) return
            frameRenderScheduled = true
        }
        try {
            frameExecutor.execute { renderLatestFrame() }
        } catch (_: RejectedExecutionException) {
            // Activity teardown can race with the last native framebuffer callback.
        }
    }

    override fun onClipboard(text: String) {
        remoteClipboard = text
        clipboardDraft = text
        status = "收到远程剪贴板"
    }

    override fun onError(message: String) {
        connected = false
        status = "连接失败"
        errorMessage = message
        pendingCredentialSave = null
        if (isAuthenticationError(message)) {
            credentialStore.remove(host, port)
        }
    }

    private fun isAuthenticationError(message: String): Boolean =
        message.contains("authentication", ignoreCase = true) ||
            message.contains("credential", ignoreCase = true) ||
            message.contains("认证", ignoreCase = true)

    private fun readIntent(source: android.content.Intent?) {
        host = source?.getStringExtra(EXTRA_HOST).orEmpty()
        port = source?.getIntExtra(EXTRA_PORT, DEFAULT_VNC_PORT) ?: DEFAULT_VNC_PORT
        desktopTitle = source?.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "远程桌面" }
    }

    private fun createSession() {
        session = BridgeRemoteDesktopSession(host, port, this, mainHandler)
    }

    private fun completeCredentials(prompt: CredentialsPrompt, username: String, password: String, remember: Boolean) {
        if (credentials === prompt) credentials = null
        if (remember && password.isNotBlank()) {
            pendingCredentialSave = PendingCredentialSave(host, port, BridgeVncCredentials(username.trim(), password))
        } else {
            pendingCredentialSave = null
        }
        session?.provideCredentials(username, password)
    }

    private fun retry() {
        errorMessage = null
        status = "等待授权"
        BridgeRemoteDesktopPlugin.notifyReconnectRequested("user")
    }

    private fun renderLatestFrame() {
        var frame: PendingFrame? = null
        synchronized(frameLock) {
            if (pendingFrame == null) {
                frameRenderScheduled = false
                return
            }
            frame = pendingFrame
            pendingFrame = null
        }
        if (frame == null) return
        val bitmap = Bitmap.createBitmap(frame.pixels, frame.width, frame.height, Bitmap.Config.ARGB_8888)
        runOnUiThread {
            if (isFinishing || isDestroyed) bitmap.recycle() else frameBitmap = bitmap
        }
        try {
            frameExecutor.execute { renderLatestFrame() }
        } catch (_: RejectedExecutionException) {
            // The executor is intentionally shut down with the Activity.
        }
    }

    @Composable
    private fun BridgeRemoteDesktopScreen() {
        val nativeTheme = remember { BridgeNativeTheme.read(this) }
        BridgeSshTheme(nativeTheme) {
            val context = LocalContext.current
            val isLandscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
            val keyboardController = LocalSoftwareKeyboardController.current
            val focusRequester = remember { FocusRequester() }
            fun submitKeyboardInput(includeEnter: Boolean = false) {
                if (!viewOnly) {
                    if (keyboardDraft.isNotEmpty()) session?.sendText(keyboardDraft)
                    if (includeEnter) {
                        session?.sendKey(0xff0d, down = true)
                        session?.sendKey(0xff0d, down = false)
                    }
                }
                keyboardDraft = ""
            }

            LaunchedEffect(keyboardOpen, controlsExpanded) {
                if (keyboardOpen && controlsExpanded) {
                    focusRequester.requestFocus()
                    keyboardController?.show()
                } else {
                    keyboardController?.hide()
                }
            }
            BackHandler {
                when {
                    keyboardOpen -> keyboardOpen = false
                    controlsExpanded -> controlsExpanded = false
                    else -> finishWorkspace()
                }
            }

            Surface(Modifier.fillMaxSize(), color = Color.Black) {
                Box(Modifier.fillMaxSize().background(Color.Black)) {
                    val canvasModifier = if (isLandscape && controlsExpanded) {
                        Modifier.fillMaxSize().padding(end = 360.dp)
                    } else {
                        Modifier.fillMaxSize()
                    }
                    AndroidView(
                        factory = { RemoteDesktopCanvasView(it).also { canvasView = it } },
                        modifier = canvasModifier,
                        update = { view ->
                            view.viewOnly = viewOnly
                            view.panMode = panMode
                            view.setBitmap(frameBitmap)
                            view.pointerHandler = { x, y, mask -> session?.sendPointer(x, y, mask) }
                        },
                    )
                    if (!connected) {
                        Column(
                            Modifier.align(Alignment.Center).padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                errorMessage ?: "正在连接 Mac 屏幕…",
                                color = Color.White.copy(alpha = .86f),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            if (errorMessage != null) {
                                Spacer(Modifier.height(14.dp))
                                Button(onClick = ::retry) { Text("重新连接") }
                            }
                        }
                    }
                    TopBar(Modifier.align(Alignment.TopCenter), compact = isLandscape)
                    if (connected && controlsExpanded) {
                        Controls(context, focusRequester, ::submitKeyboardInput, isLandscape, Modifier.align(Alignment.BottomEnd))
                    } else if (connected) {
                        CollapsedControls(
                            onKeyboard = { controlsExpanded = true; keyboardOpen = true },
                            onFullscreen = ::toggleFullscreen,
                            onExpand = { controlsExpanded = true },
                            isLandscape = isLandscape,
                            modifier = Modifier.align(Alignment.BottomEnd),
                        )
                    }
                }
            }

            credentials?.let { prompt ->
                CredentialDialog(prompt)
            }
        }
    }

    @Composable
    private fun TopBar(modifier: Modifier = Modifier, compact: Boolean = false) {
        val iconModifier = if (compact) {
            Modifier.size(42.dp).background(Color(0xB9141820), RoundedCornerShape(12.dp))
        } else {
            Modifier.size(48.dp)
        }
        Row(
            modifier.fillMaxWidth().statusBarsPadding().height(if (compact) 52.dp else 68.dp)
                .then(if (compact) Modifier else Modifier.background(Color(0xD9141820)))
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = ::finishWorkspace, modifier = iconModifier) { Text("×", color = Color.White, fontSize = 32.sp) }
            if (!compact) {
                Column(Modifier.weight(1f).padding(horizontal = 6.dp)) {
                    Text(desktopTitle, color = Color.White, maxLines = 1, style = MaterialTheme.typography.titleSmall)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(if (connected) Color(0xFF55E58A) else Color(0xFFFFB454)))
                        Text("  $status  ·  $fps fps", color = Color.White.copy(alpha = .65f), fontSize = 11.sp)
                    }
                }
            } else {
                Spacer(Modifier.weight(1f))
            }
            IconButton(onClick = { controlsExpanded = true; keyboardOpen = !keyboardOpen }, modifier = iconModifier) { Text("⌨", color = Color.White, fontSize = 22.sp) }
            IconButton(onClick = {
                controlsExpanded = !controlsExpanded
                if (!controlsExpanded) keyboardOpen = false
            }, modifier = iconModifier) { Text(if (controlsExpanded) "⌄" else "•••", color = Color.White, fontSize = 20.sp) }
        }
    }

    @Composable
    private fun CollapsedControls(
        onKeyboard: () -> Unit,
        onFullscreen: () -> Unit,
        onExpand: () -> Unit,
        isLandscape: Boolean,
        modifier: Modifier = Modifier,
    ) {
        val content: @Composable () -> Unit = {
            IconControlButton("打开键盘", "⌨", onClick = onKeyboard)
            IconControlButton("全屏横屏", "⛶", onClick = onFullscreen)
            IconControlButton("展开操作", "•••", onClick = onExpand)
        }
        if (isLandscape) {
            Column(
                modifier.navigationBarsPadding().padding(12.dp).background(Color(0xD9141820), RoundedCornerShape(16.dp)).padding(5.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) { content() }
        } else {
            Row(
                modifier.navigationBarsPadding().padding(12.dp).background(Color(0xD9141820), RoundedCornerShape(16.dp)).padding(5.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) { content() }
        }
    }

    @Composable
    private fun Controls(
        context: Context,
        focusRequester: FocusRequester,
        submitKeyboardInput: (Boolean) -> Unit,
        isLandscape: Boolean,
        modifier: Modifier = Modifier,
    ) {
        val canvas = canvasView
        val panelModifier = if (isLandscape) {
            modifier.fillMaxHeight().fillMaxWidth(.42f).widthIn(min = 280.dp, max = 360.dp)
                .padding(top = 60.dp, bottom = 8.dp, end = 8.dp)
        } else {
            modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 8.dp)
        }
        Column(
            panelModifier
                .background(Color(0xE9141820), RoundedCornerShape(16.dp))
                .padding(7.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                IconControlButton(if (immersiveMode) "退出全屏" else "全屏横屏", "⛶", onClick = ::toggleFullscreen)
                IconControlButton("适应屏幕", "⤢") { canvas?.fit() }
                IconControlButton("缩小画面", "−") { canvas?.adjustZoom(.8f) }
                IconControlButton("放大画面", "+") { canvas?.adjustZoom(1.25f) }
                IconControlButton("重置画面", "↺") { canvas?.fit() }
                IconControlButton(if (panMode) "停止移动" else "移动画面", "✥", active = panMode) {
                    panMode = !panMode
                    canvas?.panMode = panMode
                }
                IconControlButton(if (viewOnly) "切换为可控制" else "切换为只读", if (viewOnly) "◌" else "◉", active = viewOnly) { viewOnly = !viewOnly }
                IconControlButton("刷新屏幕", "⟳") { session?.refresh() }
                IconControlButton("剪贴板", "▣", active = clipboardOpen) { clipboardOpen = !clipboardOpen }
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                KeyButton("↵", 0xff0d)
                KeyButton("⌫", 0xff08)
                KeyButton("←", 0xff51)
                KeyButton("↑", 0xff52)
                KeyButton("↓", 0xff54)
                KeyButton("→", 0xff53)
                KeyButton("⇥", 0xff09)
                KeyButton("⎋", 0xff1b)
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                IconControlButton("切换 App", "⌘Tab", enabled = !viewOnly, onClick = { sendShortcut(0xff09, 0xffeb) })
                IconControlButton("打开 Spotlight", "⌘Space", enabled = !viewOnly, onClick = { sendShortcut(0x20, 0xffeb) })
                IconControlButton("切换窗口", "⌘`", enabled = !viewOnly, onClick = { sendShortcut(0x60, 0xffeb) })
                IconControlButton("调度中心", "⌃↑", enabled = !viewOnly, onClick = { sendShortcut(0xff52, 0xffe3) })
                KeyButton("⌘", 0xffeb)
                KeyButton("⌃", 0xffe3)
                KeyButton("⌥", 0xffe9)
            }
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = keyboardDraft,
                    onValueChange = { keyboardDraft = it },
                    modifier = Modifier.weight(1f).focusRequester(focusRequester),
                    enabled = !viewOnly,
                    textStyle = TextStyle(color = Color.White, fontSize = 16.sp),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submitKeyboardInput(true) }),
                    decorationBox = { field ->
                        Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                            Row(Modifier.padding(start = 10.dp, end = 3.dp, top = 3.dp, bottom = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("⌨", color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(end = 6.dp))
                                Box(Modifier.weight(1f)) {
                                    if (keyboardDraft.isEmpty()) Text("点击输入文字", color = Color.White.copy(alpha = .45f), fontSize = 15.sp)
                                    field()
                                }
                                TextButton(onClick = { submitKeyboardInput(false) }, enabled = keyboardDraft.isNotEmpty() && !viewOnly) { Text("发送") }
                            }
                        }
                    },
                )
            }
            if (clipboardOpen) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = clipboardDraft,
                        onValueChange = { clipboardDraft = it },
                        modifier = Modifier.weight(1f),
                        maxLines = 2,
                        label = { Text("剪贴板") },
                    )
                    Column(Modifier.padding(start = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = { if (!viewOnly) session?.sendClipboard(clipboardDraft) }) { Text("发送") }
                        TextButton(onClick = {
                            val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            manager.setPrimaryClip(ClipData.newPlainText("远程剪贴板", remoteClipboard))
                        }) { Text("复制") }
                    }
                }
            }
        }
    }

    private fun sendShortcut(keysym: Int, modifier: Int) {
        if (viewOnly) return
        session?.sendKey(modifier, down = true)
        session?.sendKey(keysym, down = true)
        session?.sendKey(keysym, down = false)
        session?.sendKey(modifier, down = false)
    }

    @Composable
    private fun IconControlButton(
        label: String,
        glyph: String,
        enabled: Boolean = true,
        active: Boolean = false,
        onClick: () -> Unit,
    ) {
        FilledTonalButton(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.size(44.dp).semantics { contentDescription = label },
            shape = RoundedCornerShape(11.dp),
            colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(
                containerColor = if (active) MaterialTheme.colorScheme.primary.copy(alpha = .28f) else MaterialTheme.colorScheme.surfaceVariant,
            ),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
        ) {
            Text(glyph, fontSize = if (glyph.length > 2) 10.sp else 20.sp, maxLines = 1)
        }
    }

    @Composable
    private fun KeyButton(label: String, keysym: Int) {
        IconControlButton(label, label, enabled = !viewOnly) {
            if (!viewOnly) {
                session?.sendKey(keysym, down = true)
                session?.sendKey(keysym, down = false)
            }
        }
    }

    @Composable
    private fun CredentialDialog(prompt: CredentialsPrompt) {
        var username by remember(prompt) { mutableStateOf(prompt.initialUsername) }
        var password by remember(prompt) { mutableStateOf(prompt.initialPassword) }
        var rememberCredential by remember(prompt) { mutableStateOf(true) }
        AlertDialog(
            onDismissRequest = { completeCredentials(prompt, username, password, rememberCredential) },
            title = { Text("登录屏幕共享") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("凭据不会保存到 Bridge；勾选后会加密保存到本机，下次连接 $host:$port 时自动使用。", style = MaterialTheme.typography.bodySmall)
                    if (prompt.needsUsername) OutlinedTextField(value = username, onValueChange = { username = it }, label = { Text("Mac 用户名") }, singleLine = true)
                    if (prompt.needsPassword) OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("密码") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = rememberCredential, onCheckedChange = { rememberCredential = it })
                        Text("保存到本机，下次自动连接")
                    }
                }
            },
            confirmButton = { Button(onClick = { completeCredentials(prompt, username, password, rememberCredential) }) { Text("连接") } },
            dismissButton = { TextButton(onClick = { completeCredentials(prompt, "", "", false) }) { Text("取消") } },
        )
    }

    private data class CredentialsPrompt(
        val needsUsername: Boolean,
        val needsPassword: Boolean,
        val initialUsername: String = "",
        val initialPassword: String = "",
    )
    private data class PendingCredentialSave(
        val host: String,
        val port: Int,
        val credentials: BridgeVncCredentials,
    )
    private data class PendingFrame(val width: Int, val height: Int, val pixels: IntArray)

    companion object {
        const val DEFAULT_VNC_PORT = 5900
        const val EXTRA_HOST = "bridge.remoteDesktop.host"
        const val EXTRA_PORT = "bridge.remoteDesktop.port"
        const val EXTRA_TITLE = "bridge.remoteDesktop.title"
        var activeRef: WeakReference<BridgeRemoteDesktopActivity>? = null

        fun activeInstance(): BridgeRemoteDesktopActivity? = activeRef?.get()
    }
}

private class RemoteDesktopCanvasView(context: Context) : View(context) {
    var viewOnly = false
    var panMode = false
    var pointerHandler: ((x: Int, y: Int, mask: Int) -> Unit)? = null

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private var bitmap: Bitmap? = null
    private var frameWidth = 0
    private var frameHeight = 0
    private var zoom = 1f
    private var panX = 0f
    private var panY = 0f
    private var pointerDown = false
    private var multiTouch = false
    private var lastCenterX = 0f
    private var lastCenterY = 0f
    private var lastDistance = 0f
    private var lastSingleX = 0f
    private var lastSingleY = 0f
    private var singlePanActive = false
    private var twoFingerTapCandidate = false
    private var twoFingerMoved = false
    private var twoFingerStartedAt = 0L

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(android.graphics.Color.BLACK)
        val source = bitmap ?: return
        val rect = displayedRect()
        canvas.drawBitmap(source, null, rect, paint)
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        clampPan()
    }

    fun setBitmap(next: Bitmap?) {
        if (bitmap === next) return
        bitmap?.recycle()
        bitmap = next
        if (next != null && (frameWidth != next.width || frameHeight != next.height)) {
            frameWidth = next.width
            frameHeight = next.height
            fit()
        }
        invalidate()
    }

    fun fit() {
        zoom = 1f
        panX = 0f
        panY = 0f
        invalidate()
    }

    fun adjustZoom(factor: Float) {
        zoom = (zoom * factor).coerceIn(1f, 5f)
        clampPan()
        invalidate()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                multiTouch = false
                twoFingerTapCandidate = false
                twoFingerMoved = false
                pointerDown = !viewOnly && !panMode
                singlePanActive = panMode || (viewOnly && zoom > 1f)
                lastSingleX = event.x
                lastSingleY = event.y
                if (pointerDown) sendPointer(event.x, event.y, 1)
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    if (pointerDown) sendPointer(event.getX(0), event.getY(0), 0)
                    pointerDown = false
                    singlePanActive = false
                    multiTouch = true
                    twoFingerTapCandidate = true
                    twoFingerStartedAt = event.eventTime
                    lastCenterX = centerX(event)
                    lastCenterY = centerY(event)
                    lastDistance = distance(event)
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (event.pointerCount >= 2 || multiTouch) {
                    val centerX = centerX(event)
                    val centerY = centerY(event)
                    panX += centerX - lastCenterX
                    panY += centerY - lastCenterY
                    val distance = distance(event)
                    if (lastDistance > 0f && distance > 0f) zoom = (zoom * distance / lastDistance).coerceIn(1f, 5f)
                    if (Math.hypot((centerX - lastCenterX).toDouble(), (centerY - lastCenterY).toDouble()) > TWO_FINGER_MOVE_THRESHOLD_PX) {
                        twoFingerMoved = true
                        twoFingerTapCandidate = false
                    }
                    lastCenterX = centerX
                    lastCenterY = centerY
                    lastDistance = distance
                    clampPan()
                    invalidate()
                } else if (pointerDown) {
                    val deltaX = event.x - lastSingleX
                    val deltaY = event.y - lastSingleY
                    if (zoom > 1f && Math.hypot(deltaX.toDouble(), deltaY.toDouble()) > SINGLE_PAN_THRESHOLD_PX) {
                        sendPointer(event.x, event.y, 0)
                        pointerDown = false
                        singlePanActive = true
                    }
                    if (singlePanActive) {
                        panX += deltaX
                        panY += deltaY
                        clampPan()
                        invalidate()
                    } else {
                        sendPointer(event.x, event.y, 1)
                    }
                    lastSingleX = event.x
                    lastSingleY = event.y
                } else if (singlePanActive || panMode || (viewOnly && zoom > 1f)) {
                    panX += event.x - lastSingleX
                    panY += event.y - lastSingleY
                    lastSingleX = event.x
                    lastSingleY = event.y
                    clampPan()
                    invalidate()
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (!viewOnly && twoFingerTapCandidate && !twoFingerMoved && event.pointerCount >= 2 && event.eventTime - twoFingerStartedAt <= TWO_FINGER_TAP_TIMEOUT_MS) {
                    sendPointer(centerX(event), centerY(event), 2)
                    sendPointer(centerX(event), centerY(event), 0)
                }
                twoFingerTapCandidate = false
                if (event.pointerCount <= 2) multiTouch = false
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (pointerDown) sendPointer(event.x, event.y, 0)
                pointerDown = false
                multiTouch = false
                singlePanActive = false
                twoFingerTapCandidate = false
                performClick()
            }
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun displayedRect(): RectF {
        if (frameWidth <= 0 || frameHeight <= 0) return RectF()
        val fit = minOf(width.toFloat() / frameWidth, height.toFloat() / frameHeight)
        val scale = fit.coerceAtLeast(.01f) * zoom
        val imageWidth = frameWidth * scale
        val imageHeight = frameHeight * scale
        return RectF(
            (width - imageWidth) / 2f + panX,
            (height - imageHeight) / 2f + panY,
            (width + imageWidth) / 2f + panX,
            (height + imageHeight) / 2f + panY,
        )
    }

    private fun clampPan() {
        val rect = displayedRect()
        val maxX = maxOf(0f, (rect.width() - width) / 2f)
        val maxY = maxOf(0f, (rect.height() - height) / 2f)
        panX = panX.coerceIn(-maxX, maxX)
        panY = panY.coerceIn(-maxY, maxY)
    }

    private fun sendPointer(viewX: Float, viewY: Float, mask: Int) {
        val rect = displayedRect()
        if (rect.width() <= 0f || rect.height() <= 0f) return
        val x = ((viewX - rect.left) / rect.width() * frameWidth).coerceIn(0f, (frameWidth - 1).coerceAtLeast(0).toFloat()).toInt()
        val y = ((viewY - rect.top) / rect.height() * frameHeight).coerceIn(0f, (frameHeight - 1).coerceAtLeast(0).toFloat()).toInt()
        pointerHandler?.invoke(x, y, mask)
    }

    private fun centerX(event: MotionEvent): Float = (event.getX(0) + event.getX(1)) / 2f
    private fun centerY(event: MotionEvent): Float = (event.getY(0) + event.getY(1)) / 2f
    private fun distance(event: MotionEvent): Float {
        val dx = event.getX(0) - event.getX(1)
        val dy = event.getY(0) - event.getY(1)
        return kotlin.math.sqrt(dx * dx + dy * dy)
    }

    private companion object {
        const val TWO_FINGER_TAP_TIMEOUT_MS = 350L
        const val TWO_FINGER_MOVE_THRESHOLD_PX = 24f
        const val SINGLE_PAN_THRESHOLD_PX = 12f
    }
}
