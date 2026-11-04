package dev.feishu.codex.bridge

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.SystemClock
import android.provider.OpenableColumns
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import com.getcapacitor.BridgeActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.content.FileProvider
import java.io.FileInputStream
import java.io.File
import java.nio.ByteBuffer
import java.net.URLEncoder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.connectbot.sshlib.AuthResult
import org.connectbot.sshlib.ConnectResult
import org.connectbot.sshlib.SessionExit
import org.json.JSONObject

private enum class SshSetupPage { HOSTS, EDIT_HOST, KEYS }
private data class SshGitDownloadRequest(
    val owner: BridgeSshAppSession,
    val target: BridgeSshTmuxSession,
    val root: String,
    val file: BridgeSshGitFile,
)

/** Native Android host for the ConnectBot cbssh + termlib workspace. */
open class BridgeConnectBotSshActivity : BridgeActivity() {
    protected open fun isEmbeddedSshHost(): Boolean = false
    private var workspaceView: ComposeView? = null
    private var appUpdateBanner by mutableStateOf<BridgeAppUpdateBannerState?>(null)
    private var appUpdateOverlayView: ComposeView? = null
    private var previousStatusBarColor = 0
    private var previousNavigationBarColor = 0
    private var previousLightStatusBar = false
    private var previousLightNavigationBar = false
    private var activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var host by mutableStateOf("")
    private var port by mutableStateOf(BridgeSshProtocol.DEFAULT_PORT.toString())
    private var username by mutableStateOf("")
    private var password by mutableStateOf("")
    private var passphrase by mutableStateOf("")
    private var startupCommand by mutableStateOf("")
    private var keyName by mutableStateOf<String?>(null)
    private var keyFormat by mutableStateOf<String?>(null)
    private var keyEncrypted by mutableStateOf(false)
    private var privateKey by mutableStateOf<CharArray?>(null)
    private var privateKeyReadGeneration = 0L
    private var privateKeyReading by mutableStateOf(false)
    private var generatedPublicKey by mutableStateOf<String?>(null)
    private var generatedPublicKeyDialog by mutableStateOf<String?>(null)
    private var keyGenerationDialog by mutableStateOf(false)
    private var keyGenerationInProgress by mutableStateOf(false)
    private var keyImportInProgress by mutableStateOf(false)
    private var savedKeys by mutableStateOf<List<BridgeSshStoredKey>>(emptyList())
    private var keyStoreError by mutableStateOf<String?>(null)
    private var identitySelection by mutableStateOf(BridgeSshIdentitySelection())
    private val selectedStoredKeyId: String? get() = identitySelection.activeStoredKeyId
    private var savedProfiles by mutableStateOf<List<BridgeSshProfile>>(emptyList())
    private var setupPage by mutableStateOf(SshSetupPage.HOSTS)
    private var keysReturnPage by mutableStateOf(SshSetupPage.HOSTS)
    private var editingProfileId by mutableStateOf<String?>(null)
    private var profileLabel by mutableStateOf("")
    private var hasIncomingConnection by mutableStateOf(false)
    private var bridgeServerOrigin: String? = null
    private var configuredDefaultHost = ""
    private var profileToDelete by mutableStateOf<BridgeSshProfile?>(null)
    private var keyToDelete by mutableStateOf<BridgeSshStoredKey?>(null)
    private val tmuxSessionCache = BridgeSshTmuxSessionCache()
    private val tmuxUsageStore by lazy { BridgeSshTmuxUsageStore(applicationContext) }
    private var tmuxUsageRevision by mutableStateOf(0L)
    private var tmuxClient: BridgeSshTmuxClient? = null
    private var tmuxPickerOpen by mutableStateOf(false)
    private var connectionMessage by mutableStateOf<String?>(null)
    private var connectionErrorDetails by mutableStateOf<String?>(null)
    private var keyGenerationErrorDetails by mutableStateOf<String?>(null)
    private var publicKeyCopied by mutableStateOf(false)
    private var connectionState by mutableStateOf("未连接")
    private var terminalSession by mutableStateOf<BridgeSshTerminalSession?>(null)
    private var pendingHostKey by mutableStateOf<BridgeCbSshHostKeyPrompt?>(null)
    private var hostKeyDecision: CompletableDeferred<Boolean>? = null
    private var transport: BridgeCbSshTransport? = null
    private var shellTransport: BridgeSshAppTerminalTransport? = null
    private var managedSession: BridgeSshAppSession? = null
    private var managedBindingGeneration = -1L
    private var provisionalTransport: BridgeCbSshTransport? = null
    private var connectJob: Job? = null
    private var pendingReconnectTarget: BridgeSshTmuxIdentity? = null
    private var pendingReconnectKey: BridgeSshAppConnectionKey? = null
    private var externalPickerOpen = false
    private var externalPickerReturnedAt = 0L
    private var keyGenerationJob: Job? = null
    private var nativeTheme = "light"
    private val composerDraftStore by lazy { BridgeSshComposerDraftStore(this) }
    private var composerScope by mutableStateOf<String?>(null)
    private var composerDraft by mutableStateOf(BridgeSshComposerDraft())
    private var composerDraftError by mutableStateOf<String?>(null)
    private var composerNotice by mutableStateOf<String?>(null)
    private var composerSending by mutableStateOf(false)
    private var composerStaging by mutableStateOf(false)
    private var selectedTmuxSession by mutableStateOf<BridgeSshTmuxSession?>(null)
    private var sshActionBusy by mutableStateOf(false)
    private var sshCodexHomes by mutableStateOf<List<BridgeSshCodexHome>>(emptyList())
    private var sshSelectedCodexHome by mutableStateOf("")
    private var sshAccountOpen by mutableStateOf(false)
    private var sshAccountError by mutableStateOf<String?>(null)
    private var sshUsageSummary by mutableStateOf("-·-")
    private var sshUsageJob: Job? = null
    private var sshUsageOpen by mutableStateOf(false)
    private var sshUsageResult by mutableStateOf<JSONObject?>(null)
    private var sshUsageError by mutableStateOf<String?>(null)
    private var sshGitOpen by mutableStateOf(false)
    private var sshGitState by mutableStateOf<BridgeSshGitState?>(null)
    private var sshGitSelected by mutableStateOf<BridgeSshGitFile?>(null)
    private var sshGitDetail by mutableStateOf<String?>(null)
    private var sshGitPreview by mutableStateOf(false)
    private var sshGitTruncated by mutableStateOf(false)
    private var sshGitError by mutableStateOf<String?>(null)
    private var sshSuspended by mutableStateOf<List<BridgeSshSuspendedSession>>(emptyList())
    private var sshSuspendedError by mutableStateOf<String?>(null)
    private var sshConfirmAction by mutableStateOf<String?>(null)
    private var shortcutCatalog by mutableStateOf<BridgeSshShortcutCatalog?>(null)
    private var shortcutSourceScope: String? = null
    private var shortcutLoadGeneration = 0L
    private var shortcutUsage by mutableStateOf<Map<String, Long>>(emptyMap())
    private var shortcutPanelOpen by mutableStateOf(false)
    private var shortcutCategory by mutableStateOf("keyboard")
    private var skillPickerOpen by mutableStateOf(false)
    private var skillPickerItems by mutableStateOf<List<BridgeSshSkill>>(emptyList())
    private var skillPickerMessage by mutableStateOf<String?>(null)
    private var skillPickerGeneration = 0L
    private var previewAttachmentId by mutableStateOf<String?>(null)
    private var terminalScrollController: BridgeSshScrollController? = null
    private var terminalHistoryContext by mutableStateOf(0L)
    private var composerDiagnostics = BridgeSshDiagnostics()
    private val diagnosticsRecording: Boolean get() = BridgeSshActivityDiagnostics.recording
    private var diagnosticCopyRetry by mutableStateOf(false)
    private var pendingDiagnostics: ByteArray? = null
    private var remoteFiles: BridgeSshRemoteFiles? = null
    private var remoteFilesOpen by mutableStateOf(false)
    private var remoteFilesRoot by mutableStateOf("")
    private var remoteFilesPath by mutableStateOf("")
    private var remoteFilesRequestedPath: String? = null
    private var remoteFilesEntries by mutableStateOf<List<BridgeSshRemoteFile>>(emptyList())
    private var remoteFilesBusy by mutableStateOf(false)
    private var remoteFilesError by mutableStateOf<String?>(null)
    private var remotePreviewName by mutableStateOf<String?>(null)
    private var remotePreviewText by mutableStateOf<String?>(null)
    private var remotePreviewFile by mutableStateOf<File?>(null)
    private var remotePreviewPdf by mutableStateOf(false)
    private var remotePreviewJob: Job? = null
    private var remoteDownload: BridgeSshRemoteFile? = null
    private var sshGitDownload: SshGitDownloadRequest? = null
    private var attachmentPickerScope: String? = null
    private var composerAttachmentStates by mutableStateOf<Map<String, Pair<BridgeSshComposerAttachmentStatus, String?>>>(emptyMap())
    private var composerUploadedPaths = mutableMapOf<String, String>()
    private var keyPickerForNewHost = false

    private val privateKeyPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        markExternalPickerReturned(uri != null)
        if (uri != null) {
            if (keyPickerForNewHost && !hasIncomingConnection) startNewProfile()
            else setupPage = SshSetupPage.EDIT_HOST
            readPrivateKey(uri)
        }
        keyPickerForNewHost = false
    }

    private val composerAttachmentPicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        markExternalPickerReturned(uris.isNotEmpty())
        val scope = attachmentPickerScope
        attachmentPickerScope = null
        if (scope != null && uris.isNotEmpty()) stageComposerAttachments(scope, uris)
    }
    private val diagnosticsExportPicker = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        markExternalPickerReturned(uri != null)
        val bytes = pendingDiagnostics
        pendingDiagnostics = null
        if (bytes != null && uri != null) activityScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    checkNotNull(contentResolver.openOutputStream(uri)).use { it.write(bytes) }
                }
                composerNotice = "诊断文件已保存。"
            } catch (_: Exception) {
                composerNotice = "诊断文件保存失败。"
            } finally { bytes.fill(0) }
        } else bytes?.fill(0)
    }
    private val remoteUploadPicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        markExternalPickerReturned(uris.isNotEmpty())
        if (uris.isNotEmpty()) uploadRemoteFiles(uris)
    }
    private val remoteDownloadPicker = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        markExternalPickerReturned(uri != null)
        val file = remoteDownload
        remoteDownload = null
        if (uri != null && file != null) downloadRemoteFile(file, uri)
    }
    private val sshGitDownloadPicker = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        markExternalPickerReturned(uri != null)
        val request = sshGitDownload
        sshGitDownload = null
        if (uri != null && request != null) downloadSshGitFile(request, uri)
    }
    private val keyImportPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        markExternalPickerReturned(uri != null)
        if (uri != null) importPrivateKey(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        BridgeSshActivityDiagnostics.initialize(applicationContext)
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.ACTIVITY_CREATED,
            BridgeSshTraceField.SAVED_STATE to (savedInstanceState != null),
            BridgeSshTraceField.EMBEDDED to isEmbeddedSshHost())
        super.onCreate(savedInstanceState)
        nativeTheme = BridgeNativeTheme.read(this)
        if (!isEmbeddedSshHost()) {
            prepareWorkspace(intent)
            applyWindowTheme(nativeTheme)
            setContent { WorkspaceContent() }
        } else if (savedInstanceState?.getBoolean(STATE_WORKSPACE_VISIBLE) == true) {
            val restoredRequest = Intent().putExtra(
                EXTRA_BRIDGE_SERVER_ORIGIN,
                savedInstanceState.getString(STATE_BRIDGE_SERVER_ORIGIN),
            ).putExtra(EXTRA_DEFAULT_HOST, savedInstanceState.getString(STATE_DEFAULT_HOST))
            openEmbeddedSshWorkspace(restoredRequest)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        traceActivity(BridgeSshTraceEvent.ACTIVITY_SAVE_STATE)
        outState.putBoolean(STATE_WORKSPACE_VISIBLE, workspaceView != null)
        bridgeServerOrigin?.let { outState.putString(STATE_BRIDGE_SERVER_ORIGIN, it) }
        if (configuredDefaultHost.isNotBlank()) outState.putString(STATE_DEFAULT_HOST, configuredDefaultHost)
        super.onSaveInstanceState(outState)
    }

    /** Mount in the existing Activity so the WebView and SSH session keep their owners. */
    fun openEmbeddedSshWorkspace(request: Intent?) {
        check(isEmbeddedSshHost())
        check(workspaceView == null) { "SSH workspace is already open" }
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.WORKSPACE_OPENED,
            BridgeSshTraceField.EMBEDDED to true)
        prepareWorkspace(request)
        BridgeSshAppState.ensureBackgroundProtection(applicationContext)
        val insets = WindowCompat.getInsetsController(window, window.decorView)
        previousStatusBarColor = window.statusBarColor
        previousNavigationBarColor = window.navigationBarColor
        previousLightStatusBar = insets.isAppearanceLightStatusBars
        previousLightNavigationBar = insets.isAppearanceLightNavigationBars
        applyWindowTheme(nativeTheme)
        val view = ComposeView(this).apply {
            // Do not allow taps on empty areas to reach the WebView underneath.
            isClickable = true
            isFocusable = true
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            setContent { WorkspaceContent() }
        }
        workspaceView = view
        addContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        appUpdateOverlayView?.bringToFront()
        loadComposerShortcuts()
        if (hasIncomingConnection && terminalSession == null) {
            setupPage = SshSetupPage.EDIT_HOST
            connect()
        } else if (terminalSession != null) {
            // Opening an overlay does not trigger Activity.onResume().
            maybeReconnectOnResume()
        }
    }

    internal fun setAppUpdateBanner(state: BridgeAppUpdateBannerState?) {
        runOnUiThread {
            nativeTheme = BridgeNativeTheme.read(this)
            appUpdateBanner = state
            if (state == null) {
                appUpdateOverlayView?.let { (it.parent as? ViewGroup)?.removeView(it) }
                appUpdateOverlayView = null
                return@runOnUiThread
            }
            val overlay = appUpdateOverlayView ?: ComposeView(this).apply {
                isClickable = false
                isFocusable = false
                setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
                setContent {
                    BridgeSshTheme(nativeTheme) {
                        BridgeAppUpdateOverlay(appUpdateBanner) { action ->
                            (bridge?.getPlugin("BridgeConnectBotSSH")?.instance as? BridgeConnectBotSSHPlugin)?.updateAction(action)
                        }
                    }
                }
            }.also { created ->
                appUpdateOverlayView = created
                addContentView(created, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            overlay.bringToFront()
        }
    }

    /** Temporarily reveal the connection center without detaching the SSH session. */
    internal fun setEmbeddedSshWorkspaceVisible(visible: Boolean): Boolean {
        val view = workspaceView ?: return false
        view.visibility = if (visible) View.VISIBLE else View.INVISIBLE
        if (visible) appUpdateOverlayView?.bringToFront()
        return true
    }

    internal fun closeEmbeddedSshWorkspace() {
        if (workspaceView != null) closeActivity()
    }

    private fun prepareWorkspace(request: Intent?) {
        pendingReconnectTarget = null
        pendingReconnectKey = null
        bridgeServerOrigin = request?.getStringExtra(EXTRA_BRIDGE_SERVER_ORIGIN)?.let { origin ->
            runCatching { BridgeSecureCredentialStore.normalizeServerOrigin(origin) }.getOrNull()
        }
        configuredDefaultHost = request?.getStringExtra(EXTRA_DEFAULT_HOST).orEmpty().trim()
        startNewProfile()
        setupPage = SshSetupPage.HOSTS
        nativeTheme = BridgeNativeTheme.read(this)
        keyStoreError = null
        try {
            savedKeys = BridgeSshKeyStore.list(this)
        } catch (_: Exception) {
            savedKeys = emptyList()
            keyStoreError = "密钥库数据无法读取，原始记录已保留。请排查后再管理密钥。"
        }
        savedProfiles = BridgeSshProfileStore(this).list()
        val incomingUsername = request?.getStringExtra(EXTRA_USERNAME).orEmpty()
        val incoming = incomingUsername.isNotBlank()
        val profile = request?.getStringExtra(EXTRA_PROFILE_ID)?.let { id -> savedProfiles.firstOrNull { it.id == id } }
        if (profile != null) applyProfile(profile)
        if (incoming) {
            host = request?.getStringExtra(EXTRA_HOST).orEmpty().ifBlank { configuredDefaultHost }
            port = (request?.getIntExtra(EXTRA_PORT, BridgeSshProtocol.DEFAULT_PORT) ?: BridgeSshProtocol.DEFAULT_PORT).toString()
            username = incomingUsername
            password = request?.getStringExtra(EXTRA_PASSWORD).orEmpty()
            startupCommand = request?.getStringExtra(EXTRA_STARTUP_COMMAND).orEmpty()
            val keyId = request?.getStringExtra(EXTRA_KEY_ID).orEmpty()
            clearSelectedKey()
            identitySelection = identitySelection.withoutKey()
            if (keyId.isNotBlank()) {
                identitySelection = identitySelection.useStoredKey(keyId)
                savedKeys.firstOrNull { it.id == keyId }?.let { key ->
                    keyName = key.nickname
                    keyFormat = key.algorithm
                    generatedPublicKey = key.publicKeyLine
                }
            }
        }
        hasIncomingConnection = incoming
        val manageOnly = request?.getBooleanExtra(EXTRA_MANAGE, false) == true
        var previous = if (manageOnly) null else if (incoming) {
            port.toIntOrNull()?.let { BridgeSshAppState.find(BridgeSshAppConnectionKey.of(host, it, username)) }
        } else BridgeSshAppState.mostRecent()
        if (incoming && previous != null && previous.terminalSession.status.state != BridgeSshConnectionState.CONNECTED) {
            // An explicit login must not silently reopen a dead transport.
            pendingReconnectTarget = previous.selectedTmuxSession?.let(BridgeSshTmuxIdentity::of) ?: previous.resumeTarget
            pendingReconnectKey = previous.key
            BridgeSshAppState.disconnect(previous)
            previous = null
        }
        previous?.let { attachSession(it, restoreProfile = true) }
        if (previous == null && !incoming && !manageOnly) {
            savedProfiles.firstOrNull { candidate ->
                candidate.keyId.isNotBlank() && savedKeys.any { it.id == candidate.keyId }
            }?.let { candidate ->
                val key = BridgeSshAppConnectionKey.of(candidate.host, candidate.port, candidate.username)
                pendingReconnectKey = key
                pendingReconnectTarget = BridgeSshTmuxResumeStore(applicationContext).load(key)
                connectionMessage = "正在恢复最近使用的 SSH 主机…"
                BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.RECONNECT_STARTED,
                    BridgeSshTraceField.DETAIL to BridgeSshTraceDetail.RESTORED)
                connectProfile(candidate, automatic = true)
            }
        }
        activityScope.launch(Dispatchers.IO) { cleanupRemotePreviewCopies() }
        request?.removeExtra(EXTRA_PASSWORD)
    }

    @Composable
    private fun WorkspaceContent() {
        BridgeSshTheme(nativeTheme) {
            Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Box(Modifier.fillMaxSize()) {
                    val session = terminalSession
                    val appSession = managedSession
                    val generation = appSession?.bindingGeneration
                    LaunchedEffect(appSession, generation) {
                        if (appSession != null && managedSession === appSession) refreshManagedSessionBindings(appSession)
                    }
                    if (session != null) TerminalScreen(session)
                    else Box(Modifier.fillMaxSize().safeDrawingPadding()) { SetupScreen() }
                    pendingHostKey?.let { prompt -> HostKeyDialog(prompt) }
                    if (keyGenerationDialog) KeyGenerationDialog()
                    generatedPublicKeyDialog?.let { PublicKeyDialog(it) }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        traceActivity(BridgeSshTraceEvent.ACTIVITY_STARTED)
    }

    override fun onRestart() {
        super.onRestart()
        traceActivity(BridgeSshTraceEvent.ACTIVITY_RESTARTED)
    }

    override fun onResume() {
        super.onResume()
        traceActivity(BridgeSshTraceEvent.ACTIVITY_RESUMED)
        BridgeSshAppState.ensureBackgroundProtection(applicationContext)
        if (isEmbeddedSshHost() && workspaceView == null) return
        loadComposerShortcuts()
        if (isReturningFromExternalPicker()) {
            // The document provider may briefly stop the Activity. Do not
            // refresh or replace a healthy SSH session during that handoff.
            if (terminalSession?.status?.state != BridgeSshConnectionState.CONNECTED) {
                maybeReconnectOnResume()
            }
        } else {
            maybeReconnectOnResume()
            if (tmuxPickerOpen && terminalSession?.status?.state == BridgeSshConnectionState.CONNECTED) {
                refreshTmuxSessions()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        traceActivity(BridgeSshTraceEvent.ACTIVITY_NEW_INTENT)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.ACTIVITY_CONFIGURATION_CHANGED,
            BridgeSshTraceField.SESSION to managedSession?.diagnosticId, BridgeSshTraceField.ORIENTATION to newConfig.orientation)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.ACTIVITY_FOCUS_CHANGED,
            BridgeSshTraceField.SESSION to managedSession?.diagnosticId, BridgeSshTraceField.WINDOW_FOCUSED to hasFocus)
    }

    override fun onTrimMemory(level: Int) {
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.ACTIVITY_TRIM_MEMORY, BridgeSshTraceField.MEMORY_LEVEL to level)
        super.onTrimMemory(level)
    }

    override fun onLowMemory() {
        traceActivity(BridgeSshTraceEvent.ACTIVITY_LOW_MEMORY)
        super.onLowMemory()
    }

    override fun onPause() {
        traceActivity(BridgeSshTraceEvent.ACTIVITY_PAUSED)
        super.onPause()
    }

    override fun onStop() {
        traceActivity(BridgeSshTraceEvent.ACTIVITY_STOPPED)
        super.onStop()
    }

    private fun traceActivity(event: BridgeSshTraceEvent) {
        BridgeSshActivityDiagnostics.record(event,
            BridgeSshTraceField.SESSION to managedSession?.diagnosticId,
            BridgeSshTraceField.EMBEDDED to isEmbeddedSshHost(),
            BridgeSshTraceField.PICKER_ACTIVE to externalPickerOpen,
            BridgeSshTraceField.FINISHING to isFinishing,
            BridgeSshTraceField.CHANGING_CONFIGURATION to isChangingConfigurations,
            BridgeSshTraceField.AUTHENTICATED to managedSession?.transport?.isAuthenticated)
    }

    @Composable
    private fun SetupScreen() {
        BackHandler(enabled = isEmbeddedSshHost() || setupPage != SshSetupPage.HOSTS || connectJob != null) {
            if (connectJob == null) {
                if (setupPage == SshSetupPage.HOSTS) closeActivity()
                else setupPage = if (setupPage == SshSetupPage.KEYS) keysReturnPage else SshSetupPage.HOSTS
            }
        }
        when (setupPage) {
            SshSetupPage.HOSTS -> HostListScreen()
            SshSetupPage.EDIT_HOST -> HostEditorScreen()
            SshSetupPage.KEYS -> KeyListScreen()
        }
        profileToDelete?.let { profile ->
            AlertDialog(
                onDismissRequest = { profileToDelete = null },
                title = { Text("删除主机？") },
                text = { Text("将删除“${profile.label}”的连接配置，已保存密钥和服务器上的数据不受影响。") },
                confirmButton = {
                    TextButton(onClick = {
                        profileToDelete = null
                        deleteProfile(profile)
                    }) { Text("删除") }
                },
                dismissButton = { TextButton(onClick = { profileToDelete = null }) { Text("取消") } },
            )
        }
        keyToDelete?.let { key ->
            val references = savedProfiles.count { it.keyId == key.id }
            AlertDialog(
                onDismissRequest = { keyToDelete = null },
                title = { Text("删除密钥？") },
                text = {
                    Text(
                        "将删除“${key.nickname}”在此 App 中保存的私钥。" +
                            if (references > 0) " ${references} 个主机引用此密钥，删除后需重新选择密钥才能连接。" else "",
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        keyToDelete = null
                        deleteStoredKey(key)
                    }) { Text("删除") }
                },
                dismissButton = { TextButton(onClick = { keyToDelete = null }) { Text("取消") } },
            )
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun SshSetupTopBar(
        title: String,
        backDescription: String,
        enabled: Boolean,
        onBack: () -> Unit,
        actions: @Composable RowScope.() -> Unit = {},
    ) {
        TopAppBar(
            title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = {
                IconButton(
                    onClick = onBack,
                    enabled = enabled,
                    modifier = Modifier.semantics { contentDescription = backDescription },
                ) {
                    BridgeBackIcon()
                }
            },
            actions = actions,
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.background,
            ),
            // SetupScreen already applies safeDrawingPadding(). Avoid adding the
            // status-bar inset a second time inside the top app bar.
            windowInsets = WindowInsets(0, 0, 0, 0),
        )
    }

    @Composable
    private fun BridgeBackIcon() {
        val color = MaterialTheme.colorScheme.onSurface
        Canvas(Modifier.size(24.dp)) {
            val left = 5.dp.toPx()
            val centerY = 12.dp.toPx()
            val shoulder = 11.dp.toPx()
            val top = 6.dp.toPx()
            val bottom = 18.dp.toPx()
            val right = 19.dp.toPx()
            val stroke = 2.1.dp.toPx()
            drawLine(color, Offset(left, centerY), Offset(shoulder, top), strokeWidth = stroke, cap = StrokeCap.Square)
            drawLine(color, Offset(left, centerY), Offset(shoulder, bottom), strokeWidth = stroke, cap = StrokeCap.Square)
            drawLine(color, Offset(left, centerY), Offset(right, centerY), strokeWidth = stroke, cap = StrokeCap.Square)
        }
    }

    @Composable
    private fun HostListScreen() {
        Column(modifier = Modifier.fillMaxSize()) {
            SshSetupTopBar(
                title = "SSH 主机",
                backDescription = "返回工作台",
                enabled = connectJob == null,
                onBack = { closeActivity() },
            ) {
                TextButton(onClick = { openKeyList(SshSetupPage.HOSTS) }, enabled = connectJob == null) {
                    Text("密钥")
                }
                TextButton(onClick = { startNewProfile() }, enabled = connectJob == null) { Text("＋ 添加") }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 4.dp),
            ) {
                if (hasIncomingConnection) {
                    Row(
                        modifier = Modifier.fillMaxWidth()
                            .clickable(enabled = connectJob == null) { setupPage = SshSetupPage.EDIT_HOST }
                            .padding(vertical = 6.dp, horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("继续本次连接", style = MaterialTheme.typography.titleSmall)
                            Text("$username@$host:$port", style = MaterialTheme.typography.bodySmall)
                        }
                        Text("›", style = MaterialTheme.typography.titleLarge)
                    }
                    HorizontalDivider()
                }

                if (savedProfiles.isEmpty()) {
                    Text(
                        "还没有保存的主机，点击“添加”创建连接。",
                        modifier = Modifier.padding(vertical = 12.dp, horizontal = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    savedProfiles.forEach { profile ->
                        HostRow(profile)
                        HorizontalDivider()
                    }
                }

                val unlisted = BridgeSshAppState.sessions.filter { session ->
                    savedProfiles.none { BridgeSshAppConnectionKey.of(it.host, it.port, it.username) == session.key }
                }
                if (unlisted.isNotEmpty()) {
                    Text("活动连接", modifier = Modifier.padding(start = 8.dp, top = 6.dp), style = MaterialTheme.typography.titleSmall)
                    unlisted.forEach { session ->
                        Row(
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = connectJob == null) {
                                attachSession(session, restoreProfile = true)
                            }.padding(horizontal = 8.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("${session.key.username}@${session.key.host}:${session.key.port}")
                        }
                        HorizontalDivider()
                    }
                }
                SetupMessages()
            }
        }
    }

    @Composable
    private fun HostRow(profile: BridgeSshProfile) {
        var menuOpen by remember(profile.id) { mutableStateOf(false) }
        val active = BridgeSshAppState.find(BridgeSshAppConnectionKey.of(profile.host, profile.port, profile.username))
        Row(
            modifier = Modifier.fillMaxWidth()
                .clickable(enabled = connectJob == null) {
                    if (active != null) attachSession(active, restoreProfile = true) else connectProfile(profile)
                }
                .padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("⌘", modifier = Modifier.padding(end = 16.dp), color = MaterialTheme.colorScheme.primary)
            Column(modifier = Modifier.weight(1f)) {
                Text(profile.label, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${profile.username}@${profile.host}:${profile.port}" +
                        if (active == null) "" else if (active.terminalSession.status.state == BridgeSshConnectionState.CONNECTED) " · 已连接" else " · 已中断",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Box {
                TextButton(onClick = { menuOpen = true }, enabled = connectJob == null) { Text("⋮") }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(text = { Text("编辑") }, onClick = {
                        menuOpen = false
                        applyProfile(profile)
                        setupPage = SshSetupPage.EDIT_HOST
                    })
                    DropdownMenuItem(text = { Text("删除") }, onClick = {
                        menuOpen = false
                        profileToDelete = profile
                    })
                }
            }
        }
    }

    @Composable
    private fun HostEditorScreen() {
        val hasSelectedIdentity = keyName != null || selectedStoredKeyId != null || identitySelection.profileKeyId != null

        Column(modifier = Modifier.fillMaxSize()) {
            SshSetupTopBar(
                title = if (editingProfileId == null) "添加主机" else "编辑主机",
                backDescription = "返回主机列表",
                enabled = connectJob == null,
                onBack = { setupPage = SshSetupPage.HOSTS },
            ) {
                TextButton(onClick = {
                    if (saveCurrentProfile() != null) {
                        setupPage = SshSetupPage.HOSTS
                        connectionMessage = "主机配置已保存。"
                    }
                }, enabled = connectJob == null && !privateKeyReading) { Text("保存") }
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                OutlinedTextField(profileLabel, { profileLabel = it }, label = { Text("名称（可选）") }, singleLine = true, enabled = connectJob == null, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(host, { host = it }, label = { Text("主机") }, singleLine = true, enabled = connectJob == null, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    OutlinedTextField(port, { port = it }, label = { Text("端口") }, singleLine = true, enabled = connectJob == null, modifier = Modifier.weight(1f))
                    OutlinedTextField(username, { username = it }, label = { Text("用户名") }, singleLine = true, enabled = connectJob == null, modifier = Modifier.weight(2f))
                }
                OutlinedTextField(
                    password,
                    { password = it },
                    label = { Text("密码（仅当前连接）") },
                    singleLine = true,
                    enabled = connectJob == null,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )

                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.42f),
                    ),
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text("身份验证", style = MaterialTheme.typography.titleSmall)
                        Text(
                            keyName?.let { "$it · ${keyFormat ?: "SSH"}${if (keyEncrypted) " · 已加密" else ""}" }
                                ?: if (selectedStoredKeyId != null) "关联的密钥已不存在，请重新选择" else "未选择私钥",
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (selectedStoredKeyId != null && keyName == null) {
                                MaterialTheme.colorScheme.error
                            } else MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(
                                onClick = { openKeyList(SshSetupPage.EDIT_HOST) },
                                enabled = connectJob == null,
                                modifier = Modifier.weight(1f),
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) { Text("选择密钥", maxLines = 1) }
                            OutlinedButton(
                                onClick = {
                                    keyPickerForNewHost = false
                                    markExternalPickerLaunched()
                                    privateKeyPicker.launch(arrayOf("*/*"))
                                },
                                enabled = connectJob == null,
                                modifier = Modifier.weight(1f),
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) { Text("选择私钥文件", maxLines = 1) }
                        }
                        Text(
                            "文件私钥仅用于当前连接，不会保存或关联到主机。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (privateKeyReading) {
                            Text("正在读取私钥文件…", style = MaterialTheme.typography.bodySmall)
                        } else if (privateKey != null && identitySelection.profileKeyId != null) {
                            val associated = savedKeys.firstOrNull { it.id == identitySelection.profileKeyId }
                            Text(
                                "本次使用文件私钥；主机保存的密钥关联${associated?.let { "（${it.nickname}）" } ?: "（已不存在）"}保持不变。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (hasSelectedIdentity || generatedPublicKey != null) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                if (hasSelectedIdentity) {
                                    TextButton(
                                        onClick = {
                                            clearSelectedKey()
                                            identitySelection = identitySelection.withoutKey()
                                        },
                                        enabled = connectJob == null,
                                        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                                    ) { Text("不使用私钥") }
                                }
                                generatedPublicKey?.let { publicKey ->
                                    TextButton(
                                        onClick = {
                                            publicKeyCopied = false
                                            generatedPublicKeyDialog = publicKey
                                        },
                                        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                                    ) { Text("查看/复制公钥") }
                                }
                            }
                        }
                        if (keyEncrypted) {
                            OutlinedTextField(
                                passphrase,
                                { passphrase = it },
                                label = { Text("私钥口令") },
                                singleLine = true,
                                enabled = connectJob == null,
                                visualTransformation = PasswordVisualTransformation(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                OutlinedTextField(
                    startupCommand,
                    { startupCommand = it },
                    label = { Text("连接后命令（可选）") },
                    placeholder = { Text("例如 tmux attach -t main") },
                    singleLine = true,
                    enabled = connectJob == null,
                    modifier = Modifier.fillMaxWidth(),
                )
                SetupMessages(showPreviousDiagnostics = false)
                Button(
                    onClick = { connect() },
                    enabled = connectJob == null && !privateKeyReading && host.isNotBlank() && username.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (connectJob == null) "连接" else "连接中…") }
            }
        }
    }

    @Composable
    private fun KeyListScreen() {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { setupPage = keysReturnPage }) { Text("‹ 返回") }
                Text("密钥", modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                TextButton(onClick = {
                    keyGenerationErrorDetails = null
                    keyGenerationDialog = true
                }, enabled = !keyGenerationInProgress && !keyImportInProgress) { Text("＋ 生成") }
            }
            Text(
                if (keysReturnPage == SshSetupPage.EDIT_HOST) "点击密钥用于当前主机。" else "点击密钥查看公钥；在菜单中选择用于主机。",
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (savedKeys.isEmpty()) {
                Text("还没有保存的密钥。", modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium)
            } else {
                savedKeys.forEach { key ->
                    KeyRow(key)
                    HorizontalDivider()
                }
            }
            TextButton(onClick = { markExternalPickerLaunched(); keyImportPicker.launch(arrayOf("*/*")) }, enabled = !keyImportInProgress && !keyGenerationInProgress) {
                Text(if (keyImportInProgress) "正在导入…" else "导入并保存未加密私钥")
            }
            Text(
                "导入后私钥使用 Android Keystore 加密保存。带口令的私钥请使用仅当前连接的方式。",
                modifier = Modifier.padding(horizontal = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = {
                keyPickerForNewHost = keysReturnPage != SshSetupPage.EDIT_HOST
                markExternalPickerLaunched()
                privateKeyPicker.launch(arrayOf("*/*"))
            }) { Text("选择私钥文件（仅当前连接）") }
            SetupMessages()
        }
    }

    @Composable
    private fun KeyRow(key: BridgeSshStoredKey) {
        var menuOpen by remember(key.id) { mutableStateOf(false) }
        Row(
            modifier = Modifier.fillMaxWidth()
                .clickable {
                    if (keysReturnPage == SshSetupPage.EDIT_HOST) useStoredKeyForHost(key)
                    else showPublicKey(key)
                }
                .padding(start = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("⌁", modifier = Modifier.padding(end = 16.dp), color = MaterialTheme.colorScheme.primary)
            Column(modifier = Modifier.weight(1f)) {
                Text(key.nickname, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${key.algorithm}${if (selectedStoredKeyId == key.id) " · 已选择" else ""}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Box {
                TextButton(onClick = { menuOpen = true }) { Text("⋮") }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(text = { Text("用于主机") }, onClick = {
                        menuOpen = false
                        useStoredKeyForHost(key)
                    })
                    DropdownMenuItem(text = { Text("查看公钥") }, onClick = {
                        menuOpen = false
                        showPublicKey(key)
                    })
                    DropdownMenuItem(text = { Text("复制公钥") }, onClick = {
                        menuOpen = false
                        copyPublicKey(key.publicKeyLine)
                    })
                    DropdownMenuItem(text = { Text("删除") }, onClick = {
                        menuOpen = false
                        keyToDelete = key
                    })
                }
            }
        }
    }

    @Composable
    private fun SetupMessages(showPreviousDiagnostics: Boolean = true) {
        keyStoreError?.let {
            Text(it, modifier = Modifier.padding(vertical = 2.dp), color = MaterialTheme.colorScheme.error)
        }
        connectionMessage?.let {
            Text(
                it,
                modifier = Modifier.padding(vertical = 2.dp),
                color = if (connectionErrorDetails != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        connectionErrorDetails?.let { details -> ConnectionErrorCard(details) }
        keyGenerationErrorDetails?.let { details ->
            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("生成错误详情", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
                Text(details, color = MaterialTheme.colorScheme.onSurfaceVariant, style = TextStyle(fontFamily = FontFamily.Monospace))
                OutlinedButton(onClick = { copyKeyGenerationError(details) }) { Text("复制错误详情") }
            }
        }
        if (connectJob != null || connectionState != "未连接") Text(connectionState, style = MaterialTheme.typography.bodySmall)
        if ((diagnosticsRecording || diagnosticCopyRetry || (showPreviousDiagnostics && connectionErrorDetails != null)) &&
            BridgeSshActivityDiagnostics.hasCapture) {
            TextButton(onClick = { if (diagnosticsRecording) stopAndCopyDiagnostics() else copyDiagnosticsReport() }) {
                Text(if (diagnosticsRecording) "停止并复制诊断日志" else "复制诊断日志")
            }
        }
    }

    @Composable
    private fun TmuxSessionPickerDialog() {
        val sessions = tmuxSessionCache.sessions
        val connectionKey = managedSession?.key
        val sortedSessions = remember(sessions, connectionKey, tmuxUsageRevision) {
            if (sessions != null && connectionKey != null) {
                runCatching { tmuxUsageStore.sort(connectionKey, sessions) }.getOrDefault(sessions)
            } else sessions
        }
        LaunchedEffect(managedSession?.key, managedSession?.bindingGeneration) { refreshSshSuspended() }
        BridgeSshTmuxPicker(
            target = "$username@$host:$port",
            sessions = sortedSessions,
            refreshing = tmuxSessionCache.refreshing || sshActionBusy,
            canRefresh = tmuxClient != null && !sshActionBusy,
            message = connectionMessage,
            errorDetails = connectionErrorDetails,
            onRefresh = { refreshTmuxSessions(); refreshSshSuspended() },
            onDismiss = { tmuxPickerOpen = false },
            onSelect = { openTmuxSession(it, userInitiated = true) },
            onCopyError = { copyConnectionError(it) },
            suspendedSessions = sshSuspended,
            suspendedError = sshSuspendedError,
            onRestore = { restoreSshSession(it) },
        )
    }

    @Composable
    private fun TerminalScreen(session: BridgeSshTerminalSession) {
        DisposableEffect(session) { onDispose { session.setComposerFocused(false) } }
        LaunchedEffect(selectedTmuxSession?.id, selectedTmuxSession?.createdAt, managedSession?.bindingGeneration) {
            sshCodexHomes = emptyList()
            sshSelectedCodexHome = ""
            sshUsageSummary = "-·-"
            sshUsageJob?.cancel()
            sshUsageJob = null
            sshGitOpen = false
            sshUsageOpen = false
            sshAccountOpen = false
            if (selectedTmuxSession != null) loadSshAccounts()
        }
        BackHandler {
            when {
                skillPickerOpen -> skillPickerOpen = false
                shortcutPanelOpen -> shortcutPanelOpen = false
                tmuxPickerOpen -> tmuxPickerOpen = false
                remoteFilesOpen -> closeRemoteFiles()
                else -> closeActivity()
            }
        }
        val keyboard = LocalSoftwareKeyboardController.current
        val scope = composerScope
        val composerState = rememberBridgeSshCommandComposerState(
            initialText = composerDraft.text,
            initialSendUncertain = composerDraft.sendUncertain,
            draftKey = scope,
            onDraftChanged = { text -> if (scope != null) saveComposerText(scope, text) },
        )
        val attachments = composerDraft.attachments.map { attachment ->
            val file = scope?.let { runCatching { composerDraftStore.fileFor(it, attachment.id) }.getOrNull() }
            val state = composerAttachmentStates[attachment.id]
            BridgeSshComposerAttachment(
                id = attachment.id,
                name = attachment.name,
                mimeType = attachment.mimeType,
                previewUri = file?.let { Uri.fromFile(it).toString() },
                status = state?.first ?: if (file?.isFile == true) BridgeSshComposerAttachmentStatus.Ready else BridgeSshComposerAttachmentStatus.Failed,
                detail = state?.second ?: if (file?.isFile == true) null else "草稿副本不可用，请移除后重新添加",
            )
        }
        // This Activity uses adjustResize, so the window already excludes the IME.
        // Applying safeDrawing's IME inset again would shrink the terminal twice.
        Column(modifier = Modifier.fillMaxSize().bridgeSshWorkspaceInsets()) {
            BridgeSshTerminalHeader(
                title = selectedTmuxSession?.name ?: "$username@$host",
                connected = session.status.state == BridgeSshConnectionState.CONNECTED,
                reconnecting = managedSession?.reconnecting == true,
                busy = composerSending || composerStaging || sshActionBusy,
                hasTmuxSession = selectedTmuxSession != null,
                accountLabel = sshCodexHomes.firstOrNull { it.id == sshSelectedCodexHome }?.label,
                usageSummary = sshUsageSummary,
                onGitChanges = { sshGitState = null; sshGitSelected = null; loadSshGitChanges() },
                onAccounts = { sshAccountOpen = true; loadSshAccounts() },
                onUsage = { loadSshUsage() },
                onSaveSnapshot = { runSshSessionAction("save") },
                onSuspend = { sshConfirmAction = "suspend" },
                onEnd = { sshConfirmAction = "end" },
                onReturnToWorkbench = { closeActivity(returnToWorkbench = true) },
                onHosts = { detachSession(); setupPage = SshSetupPage.HOSTS },
                onTmux = { openTmuxPicker() },
                onReconnect = {
                    managedSession?.requestReconnect(force = true) { prompt -> awaitHostKey(prompt) }
                },
                onDisconnect = { disconnectCurrentSession(); closeActivity() },
            )
            BridgeSshAppState.backgroundProtectionWarning?.let { warning ->
                Text(warning, modifier = Modifier.padding(horizontal = 10.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                val historyTarget = selectedTmuxSession
                val historyClient = tmuxClient
                BridgeSshTerminalViewport(
                    session = session,
                    historyKey = historyTarget?.let {
                        Triple(it.id, it.createdAt, managedSession?.bindingGeneration to terminalHistoryContext)
                    },
                    captureHistory = if (historyTarget != null && historyClient != null) {
                        { historyClient.captureHistory(historyTarget.id) }
                    } else null,
                    modifier = Modifier.fillMaxSize(),
                    backgroundColor = MaterialTheme.colorScheme.background,
                    foregroundColor = MaterialTheme.colorScheme.onBackground,
                    onTerminalTap = { shortcutPanelOpen = false },
                    onScrollControllerAvailable = { terminalScrollController = it },
                    onHistoryError = { composerNotice = it },
                )
                val catalog = shortcutCatalog
                if (shortcutPanelOpen && catalog != null) {
                    BridgeSshShortcutPanel(
                        catalog = catalog, category = shortcutCategory, usage = shortcutUsage,
                        enabled = !composerSending && !composerStaging && session.status.state == BridgeSshConnectionState.CONNECTED,
                        onCategory = { shortcutCategory = it }, onDismiss = { shortcutPanelOpen = false },
                        onSelect = { shortcut -> activateShortcut(shortcut, session, composerState) },
                        modifier = Modifier.align(Alignment.BottomCenter).padding(horizontal = 8.dp, vertical = 6.dp),
                    )
                }
            }
            BridgeSshCommandComposer(
                state = composerState,
                onSend = { submission, complete -> sendComposerSubmission(submission, complete) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                enabled = shellTransport != null && session.status.state == BridgeSshConnectionState.CONNECTED &&
                    scope != null && !composerDraft.sendUncertain && !composerStaging && !composerSending,
                connectionAvailable = shellTransport != null && session.status.state == BridgeSshConnectionState.CONNECTED,
                draftReadOnly = composerDraftError != null,
                attachments = attachments,
                onAddAttachment = { pickComposerAttachments() },
                onRemoveAttachment = { id -> removeComposerAttachment(id) },
                onPreviewAttachment = { id -> previewAttachmentId = id },
                onSkillTrigger = { keyboard?.hide(); openSkillPicker() },
                stabilizeInputWhileFocused = true,
                onInputFocusChanged = { session.setComposerFocused(it) },
                onHardwareShortcut = { key ->
                    shortcutCatalog?.terminalSequences?.get(key)?.let {
                        session.sendTerminalInput(it.toByteArray(Charsets.UTF_8)); true
                    } ?: false
                },
                connectionStatusMessage = session.status.message?.let { "$it，草稿已保留" } ?: managedSession?.recoveryNotice,
                shortcuts = {
                    val enabled = !composerSending && !composerStaging && session.status.state == BridgeSshConnectionState.CONNECTED
                    BridgeSshComposerToolbar(shortcutCatalog, shortcutPanelOpen, shortcutCategory, enabled, diagnosticsRecording,
                        onShortcut = { shortcut ->
                            if (shortcut.actionKey in setOf("keyboard-panel", "codex-panel", "ctrl-panel")) keyboard?.hide()
                            activateShortcut(shortcut, session, composerState)
                        },
                        onKeyboardFallback = { keyboard?.hide(); shortcutCategory = "keyboard"; shortcutPanelOpen = !shortcutPanelOpen },
                    )
                },
            )
            composerNotice?.let {
                Text(it, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (diagnosticCopyRetry) TextButton(onClick = { copyDiagnosticsReport() }) { Text("复制诊断日志") }
            if (composerDraft.sendUncertain && scope != null && composerDraftError == null) {
                TextButton(onClick = { acknowledgeComposerUncertainty(scope, composerState) }) { Text("已检查终端，允许再次发送") }
            }
            if (tmuxPickerOpen) TmuxSessionPickerDialog()
            if (sshGitOpen) BridgeSshGitChangesDialog(
                sessionName = selectedTmuxSession?.name.orEmpty(), data = sshGitState, busy = sshActionBusy,
                error = sshGitError, selected = sshGitSelected, detail = sshGitDetail,
                preview = sshGitPreview, truncated = sshGitTruncated,
                onDismiss = { sshGitOpen = false }, onRefresh = { loadSshGitChanges() },
                onSelect = { file, preview -> loadSshGitDetail(file, preview) },
                onDownload = { file ->
                    val target = selectedTmuxSession
                    val owner = managedSession
                    val root = sshGitState?.root
                    if (target != null && owner != null && root != null) {
                        sshGitDownload = SshGitDownloadRequest(owner, target, root, file)
                        markExternalPickerLaunched()
                        sshGitDownloadPicker.launch(file.path.substringAfterLast('/'))
                    }
                },
            )
            if (sshAccountOpen) BridgeSshCodexHomesDialog(
                homes = sshCodexHomes, selected = sshSelectedCodexHome, busy = sshActionBusy,
                error = sshAccountError, onSelect = { changeSshAccount(it) },
                onRefreshRunning = { changeSshAccount() }, onDismiss = { sshAccountOpen = false },
            )
            if (sshUsageOpen) BridgeSshCodexUsageDialog(
                label = sshCodexHomes.firstOrNull { it.id == sshSelectedCodexHome }?.label.orEmpty(),
                result = sshUsageResult, busy = sshActionBusy, error = sshUsageError,
                onRefresh = { loadSshUsage() }, onDismiss = { sshUsageOpen = false },
            )
            sshConfirmAction?.let { action ->
                val name = selectedTmuxSession?.name.orEmpty()
                AlertDialog(onDismissRequest = { sshConfirmAction = null },
                    title = { Text(if (action == "suspend") "挂起 Session？" else "终结 Session？") },
                    text = { Text(if (action == "suspend")
                        "将保存「$name」的独立快照并停止其中的进程，之后可从 SSH 或 Web 恢复。"
                        else "将停止「$name」中的进程并结束其可恢复状态；历史记录仍可查看。") },
                    confirmButton = { TextButton(onClick = { sshConfirmAction = null; runSshSessionAction(action) }) { Text("确认") } },
                    dismissButton = { TextButton(onClick = { sshConfirmAction = null }) { Text("取消") } })
            }
            if (skillPickerOpen) BridgeSshSkillPicker(skillPickerItems, skillPickerMessage,
                onDismiss = { composerState.setSkillTrigger(null); skillPickerOpen = false },
                onSelect = { composerState.insertSkill(it); skillPickerOpen = false })
            previewAttachmentId?.let { id ->
                attachments.firstOrNull { it.id == id }?.let { attachment ->
                    BridgeSshAttachmentDialog(attachment) { previewAttachmentId = null }
                }
            }
            if (remoteFilesOpen) BridgeSshRemoteFilesDialog(
                root = remoteFilesRoot, relative = remoteFilesPath, files = remoteFilesEntries,
                busy = remoteFilesBusy, error = remoteFilesError, previewName = remotePreviewName,
                previewText = remotePreviewText, previewFile = remotePreviewFile, previewPdf = remotePreviewPdf,
                onDismiss = { closeRemoteFiles() },
                onDirectory = { refreshRemoteFiles(it) }, onPreview = { previewRemoteFile(it) },
                onDownload = { remoteDownload = it; markExternalPickerLaunched(); remoteDownloadPicker.launch(it.name) },
                onCopyPath = { file ->
                    (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("SSH 文件", file.relativePath))
                    remoteFilesError = null
                },
                onForward = { file -> forwardRemoteFile(file, composerState) },
                onUpload = { markExternalPickerLaunched(); remoteUploadPicker.launch(arrayOf("*/*")) },
                onClosePreview = { closeRemotePreview() }, onCopyPreview = { copyRemotePreview() },
            )
        }
    }

    @Composable
    private fun HostKeyDialog(prompt: BridgeCbSshHostKeyPrompt) {
        AlertDialog(
            onDismissRequest = { decideHostKey(false) },
            title = { Text(if (prompt.changed) "主机指纹已变化" else "确认主机指纹") },
            text = { Text("算法：${prompt.algorithm}\n${prompt.fingerprint}\n\n仅在你确认这是目标 Mac 时接受。") },
            confirmButton = { TextButton(onClick = { decideHostKey(true) }) { Text("接受") } },
            dismissButton = { TextButton(onClick = { decideHostKey(false) }) { Text("拒绝") } },
        )
    }

    @Composable
    private fun KeyGenerationDialog() {
        var algorithm by remember { mutableStateOf(BridgeSshKeyAlgorithm.ED25519) }
        var nickname by remember { mutableStateOf("bridge-ed25519") }
        val generating = keyGenerationInProgress
        fun selectAlgorithm(next: BridgeSshKeyAlgorithm) {
            val defaultNames = setOf("bridge-ed25519", "bridge-rsa-3072")
            if (nickname in defaultNames) {
                nickname = if (next == BridgeSshKeyAlgorithm.ED25519) "bridge-ed25519" else "bridge-rsa-3072"
            }
            algorithm = next
        }

        AlertDialog(
            onDismissRequest = { if (!generating) keyGenerationDialog = false },
            title = { Text("生成 SSH 密钥") },
            text = {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("生成后可在主机中选择此密钥。请把生成的公钥追加到服务器的 ~/.ssh/authorized_keys。")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (algorithm == BridgeSshKeyAlgorithm.ED25519) {
                            Button(onClick = {}, modifier = Modifier.weight(1f)) { Text("Ed25519") }
                        } else {
                            OutlinedButton(
                                onClick = { selectAlgorithm(BridgeSshKeyAlgorithm.ED25519) },
                                modifier = Modifier.weight(1f),
                            ) { Text("Ed25519") }
                        }
                        if (algorithm == BridgeSshKeyAlgorithm.RSA) {
                            Button(onClick = {}, modifier = Modifier.weight(1f)) { Text("RSA 3072") }
                        } else {
                            OutlinedButton(
                                onClick = { selectAlgorithm(BridgeSshKeyAlgorithm.RSA) },
                                modifier = Modifier.weight(1f),
                            ) { Text("RSA 3072") }
                        }
                    }
                    OutlinedTextField(
                        value = nickname,
                        onValueChange = { nickname = it },
                        label = { Text("密钥名称") },
                        singleLine = true,
                        enabled = !generating,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (generating) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.padding(end = 10.dp))
                            Text("正在生成…")
                        }
                    }
                    Text(
                        "密钥会加密保存到当前 App 的私有密钥库；Android Keystore 负责保护包装密钥。使用时才解密到内存。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { generateKey(algorithm, nickname) },
                    enabled = !generating,
                ) { Text("生成并保存") }
            },
            dismissButton = {
                TextButton(
                    onClick = { keyGenerationDialog = false },
                    enabled = !generating,
                ) { Text("取消") }
            },
        )
    }

    @Composable
    private fun PublicKeyDialog(publicKey: String) {
        AlertDialog(
            onDismissRequest = { generatedPublicKeyDialog = null },
            title = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("SSH 公钥")
                    Text(
                        "复制整行后追加到 Mac 的 ~/.ssh/authorized_keys",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 92.dp, max = 180.dp)
                                .horizontalScroll(rememberScrollState())
                                .verticalScroll(rememberScrollState())
                                .padding(14.dp),
                        ) {
                            Text(
                                publicKey,
                                style = TextStyle(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Text(
                        "不要换行；复制后可在 Mac 执行：\ncat >> ~/.ssh/authorized_keys",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (publicKeyCopied) {
                        Text(
                            "已复制到剪贴板",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                }
            },
            confirmButton = {
                Button(onClick = { copyPublicKey(publicKey) }) { Text("复制公钥") }
            },
            dismissButton = {
                TextButton(onClick = { generatedPublicKeyDialog = null }) { Text("完成") }
            },
        )
    }

    @Composable
    private fun ConnectionErrorCard(details: String) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.errorContainer,
            tonalElevation = 2.dp,
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "连接诊断",
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                    TextButton(onClick = { copyConnectionError(details) }) { Text("复制") }
                }
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 220.dp),
                    shape = MaterialTheme.shapes.small,
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.72f),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    ) {
                        Text(
                            details,
                            style = TextStyle(fontFamily = FontFamily.Monospace),
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
                Text(
                    "公钥已加入服务器仍失败时，请重点看 phase、auth.allowed_methods 和 causes。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
        }
    }

    private fun clearSelectedKey() {
        privateKeyReadGeneration += 1
        privateKeyReading = false
        privateKey?.let { BridgeSshKeySupport.clear(it) }
        privateKey = null
        identitySelection = identitySelection.useTemporaryKey()
        keyName = null
        keyFormat = null
        keyEncrypted = false
        passphrase = ""
        generatedPublicKey = null
    }

    private fun startNewProfile() {
        clearSelectedKey()
        identitySelection = identitySelection.withoutKey()
        editingProfileId = null
        profileLabel = ""
        host = configuredDefaultHost
        port = BridgeSshProtocol.DEFAULT_PORT.toString()
        username = ""
        password = ""
        startupCommand = ""
        hasIncomingConnection = false
        connectionMessage = null
        connectionErrorDetails = null
        connectionState = "未连接"
        setupPage = SshSetupPage.EDIT_HOST
    }

    private fun openKeyList(returnPage: SshSetupPage) {
        keysReturnPage = returnPage
        setupPage = SshSetupPage.KEYS
    }

    private fun useStoredKeyForHost(key: BridgeSshStoredKey) {
        if (keysReturnPage == SshSetupPage.HOSTS && !hasIncomingConnection) startNewProfile()
        clearSelectedKey()
        identitySelection = identitySelection.useStoredKey(key.id)
        keyName = key.nickname
        keyFormat = key.algorithm
        generatedPublicKey = key.publicKeyLine
        connectionMessage = "已选择 ${key.nickname}；保存主机后会记住此关联。"
        setupPage = SshSetupPage.EDIT_HOST
    }

    private fun showPublicKey(key: BridgeSshStoredKey) {
        publicKeyCopied = false
        generatedPublicKeyDialog = key.publicKeyLine
    }

    private fun applyProfile(profile: BridgeSshProfile) {
        clearSelectedKey()
        identitySelection = identitySelection.withoutKey()
        hasIncomingConnection = false
        editingProfileId = profile.id
        profileLabel = profile.label
        host = profile.host
        port = profile.port.toString()
        username = profile.username
        password = ""
        startupCommand = profile.startupCommand
        connectionErrorDetails = null
        connectionState = "未连接"
        if (profile.keyId.isNotBlank()) {
            identitySelection = identitySelection.useStoredKey(profile.keyId)
        }
        val storedKey = savedKeys.firstOrNull { it.id == profile.keyId }
        if (storedKey != null) {
            keyName = storedKey.nickname
            keyFormat = storedKey.algorithm
            generatedPublicKey = storedKey.publicKeyLine
            connectionMessage = null
        } else if (selectedStoredKeyId != null) {
            connectionMessage = "此主机关联的密钥不存在，请重新选择密钥。"
        } else {
            connectionMessage = null
        }
    }

    private fun connectProfile(profile: BridgeSshProfile, automatic: Boolean = false) {
        applyProfile(profile)
        if (selectedStoredKeyId == null) {
            connectionMessage = "请输入本次连接的密码，或选择私钥。"
            setupPage = SshSetupPage.EDIT_HOST
        } else if (keyName == null) {
            setupPage = SshSetupPage.EDIT_HOST
        } else {
            connect(automatic)
        }
    }

    private fun deleteProfile(profile: BridgeSshProfile) {
        try {
            val store = BridgeSshProfileStore(this)
            store.delete(profile.id)
            savedProfiles = store.list()
            if (editingProfileId == profile.id) editingProfileId = null
            connectionMessage = "已删除主机 ${profile.label}。"
        } catch (_: Throwable) {
            connectionMessage = "主机删除失败。"
        }
    }

    private fun saveCurrentProfile(): BridgeSshProfile? {
        val normalizedHost = host.trim()
        val normalizedUsername = username.trim()
        val parsedPort = port.toIntOrNull()
        if (normalizedHost.isBlank() || normalizedUsername.isBlank() || parsedPort == null || parsedPort !in 1..65535) {
            connectionMessage = "请填写主机、用户名和 1–65535 范围内的端口。"
            return null
        }

        val store = BridgeSshProfileStore(this)
        val existing = if (editingProfileId != null) {
            savedProfiles.firstOrNull { it.id == editingProfileId }
        } else {
            savedProfiles.firstOrNull {
                profileLabel.isBlank() && it.matchesConnection(
                    normalizedHost, parsedPort, normalizedUsername, identitySelection.profileKeyId.orEmpty(), startupCommand,
                )
            }
        }
        val normalizedLabel = profileLabel.trim().ifBlank { existing?.label ?: "$normalizedUsername@$normalizedHost" }
        val profile = existing?.copy(
            label = normalizedLabel,
            host = normalizedHost,
            port = parsedPort,
            username = normalizedUsername,
            keyId = identitySelection.profileKeyId.orEmpty(),
            startupCommand = startupCommand,
        ) ?: BridgeSshProfile.create(
            label = normalizedLabel,
            host = normalizedHost,
            port = parsedPort,
            username = normalizedUsername,
            keyId = identitySelection.profileKeyId.orEmpty(),
            startupCommand = startupCommand,
        )
        val saved = try {
            store.save(profile)
        } catch (_: Throwable) {
            connectionMessage = "主机配置保存失败，请检查主机、用户名和名称后重试。"
            return null
        }
        savedProfiles = store.list()
        editingProfileId = saved.id
        profileLabel = saved.label
        hasIncomingConnection = privateKey != null || password.isNotEmpty()
        return saved
    }

    private fun markCurrentProfileUsed() {
        val parsedPort = port.toIntOrNull() ?: return
        val profile = savedProfiles.firstOrNull { it.id == editingProfileId } ?: savedProfiles.firstOrNull {
            it.host == host.trim() && it.port == parsedPort && it.username == username.trim()
        } ?: return
        val store = BridgeSshProfileStore(this)
        runCatching {
            store.markUsed(profile.id)
            savedProfiles = store.list()
        }
    }

    private fun activateComposerScope(target: BridgeSshTmuxSession?) {
        val parsedPort = port.toIntOrNull() ?: return
        val scope = BridgeSshComposerDraftStore.scopeKey(host, parsedPort, username, target?.id, target?.createdAt)
        selectedTmuxSession = target
        managedSession?.selectedTmuxSession = target
        composerScope = scope
        composerAttachmentStates = emptyMap()
        composerNotice = null
        try {
            composerDraft = composerDraftStore.load(scope)
            composerDraftError = null
        } catch (_: Exception) {
            composerDraft = BridgeSshComposerDraft()
            composerDraftError = "SSH 草稿无法读取，原始数据已保留。"
        }
    }

    private fun saveComposerText(scope: String, text: String) {
        try {
            composerDraftStore.updateText(scope, text)
            if (composerScope == scope) composerDraft = composerDraft.copy(text = text)
        } catch (_: Exception) {
            if (composerScope == scope) composerDraftError = "SSH 草稿无法保存，原始数据已保留。"
        }
    }

    private fun loadComposerShortcuts() {
        val generation = ++shortcutLoadGeneration
        activityScope.launch {
            val loaded = withContext(Dispatchers.IO) {
                runCatching {
                    val defaults = JSONObject(assets.open("composer-defaults.json").bufferedReader().use { it.readText() })
                    val sequences = BridgeSshShortcutCatalog.sequences(defaults)
                    BridgeComposerDatabase(this@BridgeConnectBotSshActivity).use { database ->
                        val saved = database.readShortcutState()
                        val payload = saved.snapshot?.payload ?: defaults
                        Triple(BridgeSshShortcutCatalog.fromJson(payload, sequences), saved.usage, saved.source)
                    }
                }.recoverCatching {
                    val defaults = JSONObject(assets.open("composer-defaults.json").bufferedReader().use { it.readText() })
                    Triple(BridgeSshShortcutCatalog.fromJson(defaults, BridgeSshShortcutCatalog.sequences(defaults)), emptyMap(), null)
                }.getOrNull()
            }
            if (loaded != null && generation == shortcutLoadGeneration) {
                shortcutCatalog = loaded.first
                shortcutUsage = loaded.second
                shortcutSourceScope = loaded.third
            }
        }
    }

    private fun recordNativeShortcutUse(id: String) {
        composerDiagnostics.record("shortcut")
        shortcutUsage = shortcutUsage + (id to ((shortcutUsage[id] ?: 0L) + 1L))
        val source = shortcutSourceScope
        activityScope.launch(Dispatchers.IO) {
            runCatching { BridgeComposerDatabase(this@BridgeConnectBotSshActivity).use { it.recordShortcutUse(id, source) } }
        }
    }

    private fun activateShortcut(shortcut: BridgeSshShortcut, session: BridgeSshTerminalSession, state: BridgeSshCommandComposerState) {
        val action = shortcut.actionKey
        when (action) {
            "attachment" -> pickComposerAttachments()
            "skill-picker" -> { state.setSkillTrigger(null); openSkillPicker() }
            "scroll-top" -> terminalScrollController?.scrollToTop() ?: run { composerNotice = "终端滚动控件暂不可用。" }
            "scroll-bottom" -> terminalScrollController?.scrollToBottom() ?: run { composerNotice = "终端滚动控件暂不可用。" }
            "session-files" -> openComposerFiles()
            "debug-log" -> toggleComposerDiagnostics()
            "scroll-export" -> exportComposerDiagnostics()
            "keyboard-panel", "codex-panel", "ctrl-panel" -> {
                val target = when (action) { "codex-panel" -> "codex-tui"; "ctrl-panel" -> "ctrl"; else -> "keyboard" }
                shortcutPanelOpen = !(shortcutPanelOpen && shortcutCategory == target)
                shortcutCategory = target
            }
            "close-panel" -> shortcutPanelOpen = false
            else -> {
                val named = shortcutCatalog?.terminalSequences.orEmpty()
                val forced = when (action) {
                    "terminal-answer" -> named["codex-answer"]
                    "terminal-prompt-back" -> named["codex-prompt-back"]
                    "terminal-warnings" -> named["codex-warnings"]
                    else -> null
                }
                val sequence = forced ?: BridgeSshShortcutEncoding.resolve(shortcut, named)
                if (sequence != null) {
                    if (session.status.state != BridgeSshConnectionState.CONNECTED || composerSending || composerStaging) return
                    // A tmux shortcut can switch panes before new PTY output arrives.
                    if (shortcut.groupId == "tmux") terminalHistoryContext += 1
                    session.sendTerminalInput(sequence.toByteArray(Charsets.UTF_8))
                    if (shortcut.value in setOf("tmux-detach", "tmux-detach-client", "tmux-next-session", "tmux-previous-session", "tmux-last-session", "tmux-choose-session", "tmux-choose-tree", "tmux-suspend")) {
                        managedSession?.let { current ->
                            current.resumeTarget = null
                            runCatching { BridgeSshTmuxResumeStore(applicationContext).clear(current.key) }
                        }
                        activateComposerScope(null)
                        composerNotice = "终端会话可能已切换；请通过 tmux 选择器重新定位 Session。"
                    }
                    if (shortcut.groupId == "tmux" || shortcut.groupId == "codex") shortcutPanelOpen = false
                } else if (shortcut.kind == "send" || shortcut.kind == "insert") {
                    sendShortcutText(shortcut.value)
                } else {
                    composerNotice = "此快捷键的终端序列无法识别。"
                    return
                }
            }
        }
        recordNativeShortcutUse(shortcut.id)
    }

    private fun sendShortcutText(text: String) {
        val scope = composerScope ?: return
        val shell = shellTransport ?: return
        if (text.isBlank() || composerSending || composerStaging || composerDraft.sendUncertain) return
        composerSending = true
        activityScope.launch {
            var pendingMarked = false
            try {
                composerDraftStore.markPending(scope)
                pendingMarked = true
                val bytes = BridgeSshCommandEncoding.bracketedPaste(BridgeSshCommandEncoding.preparePrompt(text))
                val result = try { shell.writeComposerPaste(bytes) } finally { bytes.fill(0) }
                if (result != BridgeSshCommandSendResult.Unknown) composerDraftStore.clearPending(scope)
                if (composerScope == scope) {
                    composerDraft = composerDraftStore.load(scope)
                    composerNotice = when (result) {
                        BridgeSshCommandSendResult.Written -> "快捷键已写入 SSH，执行情况请查看终端。"
                        BridgeSshCommandSendResult.NotSent -> "快捷键未发送。"
                        BridgeSshCommandSendResult.Unknown -> "快捷键结果未知，请检查终端。"
                    }
                    if (result == BridgeSshCommandSendResult.Written) shortcutPanelOpen = false
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (composerScope == scope) {
                    composerDraft = runCatching { composerDraftStore.load(scope) }.getOrDefault(composerDraft)
                    composerNotice = if (pendingMarked) "快捷键结果未知，请检查终端。" else "快捷键未发送。"
                }
            } finally { composerSending = false }
        }
    }

    private fun openSkillPicker() {
        val generation = ++skillPickerGeneration
        skillPickerOpen = true
        skillPickerItems = emptyList()
        skillPickerMessage = "正在读取技能…"
        val target = selectedTmuxSession
        val sourceHost = host.trim().lowercase()
        val sourceScope = composerScope
        val tool = currentSessionTool()
        activityScope.launch {
            val cached = withContext(Dispatchers.IO) {
                try {
                    val sameSession = target != null && tmuxClient?.let { client ->
                        val sessions = tool?.listSessions { client.listSessions() } ?: client.listSessions()
                        sessions.any { it.id == target.id && it.createdAt == target.createdAt }
                    } == true
                    BridgeComposerDatabase(this@BridgeConnectBotSshActivity).use { database ->
                        if (database.activeSourceHost() != sourceHost) return@use emptyList<BridgeSshSkill>() to false
                        val key = target?.let { URLEncoder.encode(it.id, "UTF-8").replace("+", "%20") + ":" + it.createdAt }
                        val sessionSkills = if (sameSession && key != null) database.readActive(BridgeComposerDatabase.SESSION_SKILLS, key)?.payload else null
                        if (sessionSkills != null) parseBridgeSshSkills(sessionSkills.getJSONArray("skills")) to true
                        else {
                            val all = database.readActive(BridgeComposerDatabase.SKILLS)?.payload?.optJSONArray("skills")
                            val globals = org.json.JSONArray()
                            if (all != null) for (index in 0 until all.length()) {
                                val item = all.optJSONObject(index) ?: continue
                                if (item.optString("scope") != "project") globals.put(item)
                            }
                            parseBridgeSshSkills(globals) to false
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    emptyList<BridgeSshSkill>() to false
                }
            }
            if (composerScope != sourceScope || !skillPickerOpen || generation != skillPickerGeneration) return@launch
            skillPickerItems = cached.first
            if (cached.first.isNotEmpty()) skillPickerMessage = "正在读取 SSH 主机技能；已显示可用缓存。"
            val remote = try {
                val discover = suspend { transport?.let { BridgeSshRemoteSkills(it, target, tmuxClient).discover() }.orEmpty() }
                tool?.listSkills(target, discover) ?: discover()
            } catch (_: TimeoutCancellationException) {
                emptyList()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                emptyList()
            }
            if (composerScope != sourceScope || !skillPickerOpen || generation != skillPickerGeneration) return@launch
            val preference = cached.first.mapIndexed { index, skill -> skill.name.lowercase() to index }.toMap()
            // A running Codex can use a different home from the SSH login or tmux environment.
            // Retain the server's verified per-session snapshot alongside fresh SSH discovery.
            val combined = if (remote.isNotEmpty() && cached.second) (remote + cached.first)
                .distinctBy { it.name.lowercase() } else remote
            val loaded = if (combined.isNotEmpty()) combined.sortedWith(
                compareBy<BridgeSshSkill> { preference[it.name.lowercase()] ?: Int.MAX_VALUE }.thenBy { it.name },
            ) else cached.first
            skillPickerItems = loaded
            skillPickerMessage = when {
                remote.isNotEmpty() && cached.second -> "技能来自当前 Session 和同一 Session 的缓存。"
                remote.isNotEmpty() && target != null -> "显示当前 Session 的技能。"
                remote.isNotEmpty() -> "显示当前环境的全局技能；可手动输入项目技能。"
                cached.second -> "显示已缓存的 Session 技能。"
                loaded.isNotEmpty() -> "显示同一 Bridge 的全局技能；可手动输入当前项目技能名。"
                else -> "没有匹配当前 SSH 主机的技能缓存，可手动输入技能名。"
            }
        }
    }

    private fun diagnosticSnapshot(): JSONObject {
        val dimensions = terminalSession?.emulator?.dimensions
        return JSONObject().put("state", terminalSession?.status?.state?.name ?: "CLOSED")
            .put("rows", dimensions?.rows ?: 0).put("columns", dimensions?.columns ?: 0)
            .put("scrollbackPosition", terminalScrollController?.scrollbackPosition ?: 0)
            .put("maxScrollback", terminalScrollController?.maxScrollback ?: 0)
    }

    private fun toggleComposerDiagnostics() {
        if (diagnosticsRecording) {
            stopAndCopyDiagnostics()
            return
        }
        BridgeSshActivityDiagnostics.start(applicationContext)
        BridgeSshAppState.sessions.forEach { it.diagnostics.start() }
        if (managedSession == null) composerDiagnostics.start()
        diagnosticCopyRetry = false
        traceActivity(BridgeSshTraceEvent.ACTIVITY_RESUMED)
        managedSession?.let { session ->
            BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.SESSION_ATTACHED,
                BridgeSshTraceField.SESSION to session.diagnosticId,
                BridgeSshTraceField.AUTHENTICATED to session.transport.isAuthenticated)
        }
        BridgeSshAppState.traceService(BridgeSshTraceEvent.SERVICE_SNAPSHOT)
        composerNotice = "已开始记录 SSH 和页面诊断；再次点击将停止并复制。"
    }

    private fun stopAndCopyDiagnostics() {
        val terminal = if (composerDiagnostics.recording) composerDiagnostics.finish(diagnosticSnapshot())
            else composerDiagnostics.snapshot(diagnosticSnapshot())
        BridgeSshAppState.sessions.forEach { session ->
            if (session.diagnostics !== composerDiagnostics && session.diagnostics.recording) session.diagnostics.finish(JSONObject())
        }
        BridgeSshActivityDiagnostics.stop()
        copyDiagnosticsReport(terminal)
    }

    private fun buildDiagnosticsReport(terminal: ByteArray = composerDiagnostics.snapshot(diagnosticSnapshot())): ByteArray =
        JSONObject(terminal.toString(Charsets.UTF_8)).put("version", 2)
            .put("activity", BridgeSshActivityDiagnostics.snapshot(applicationContext)).toString(2).toByteArray(Charsets.UTF_8)

    private fun copyDiagnosticsReport(terminal: ByteArray? = null) {
        try {
            val report = buildDiagnosticsReport(terminal ?: composerDiagnostics.snapshot(diagnosticSnapshot()))
            (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText("SSH diagnostics", report.toString(Charsets.UTF_8)))
            diagnosticCopyRetry = false
            if (terminalSession == null) connectionMessage = "诊断日志已复制。"
            else composerNotice = "诊断日志已复制；可使用导出按钮保存文件。"
        } catch (_: Exception) {
            diagnosticCopyRetry = true
            if (terminalSession == null) connectionMessage = "复制失败，请重试或导出诊断文件。"
            else composerNotice = "诊断日志复制失败，请重试或使用导出按钮保存。"
        }
    }

    private fun exportComposerDiagnostics() {
        pendingDiagnostics = buildDiagnosticsReport()
        markExternalPickerLaunched()
        diagnosticsExportPicker.launch("ssh-scroll-diagnostics.json")
    }

    private fun openComposerFiles() {
        val ssh = transport ?: return
        if (terminalSession?.status?.state != BridgeSshConnectionState.CONNECTED) return
        shortcutPanelOpen = false
        remoteFiles = BridgeSshRemoteFiles(ssh, selectedTmuxSession, tmuxClient, currentSessionTool()?.apiClient)
        remoteFilesBusy = false
        remoteFilesOpen = true
        remoteFilesRoot = ""
        remoteFilesPath = ""
        remoteFilesRequestedPath = null
        remoteFilesEntries = emptyList()
        remoteFilesError = null
        refreshRemoteFiles("")
    }

    private fun closeRemoteFiles() {
        closeRemotePreview()
        remoteFilesOpen = false
        remoteFiles = null
        remoteFilesBusy = false
        remoteFilesRequestedPath = null
    }

    private fun refreshRemoteFiles(path: String) {
        val browser = remoteFiles ?: return
        if (remoteFilesBusy) return
        remoteFilesRequestedPath = path
        remoteFilesBusy = true
        remoteFilesError = null
        activityScope.launch {
            try {
                val (root, entries) = browser.list(path)
                if (remoteFiles === browser && remoteFilesOpen) {
                    remoteFilesRoot = root
                    remoteFilesPath = path
                    remoteFilesRequestedPath = null
                    remoteFilesEntries = entries
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (remoteFiles === browser && remoteFilesOpen) {
                    remoteFilesError = "无法读取 SSH 目录，请检查连接和 Session 状态。"
                    val current = managedSession
                    if (current != null && (!current.transport.isAuthenticated || !current.shellTransport.isLive)) current.requestReconnect()
                }
            } finally { if (remoteFiles === browser) remoteFilesBusy = false }
        }
    }

    private fun previewRemoteFile(file: BridgeSshRemoteFile) {
        val browser = remoteFiles ?: return
        if (remoteFilesBusy) return
        remotePreviewName = file.name
        remotePreviewText = null
        remotePreviewFile = null
        val extension = file.name.substringAfterLast('.', "").lowercase()
        remotePreviewPdf = extension == "pdf"
        val image = extension in setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif")
        remoteFilesBusy = true
        remotePreviewJob = activityScope.launch {
            var temporary: File? = null
            try {
                if (image || remotePreviewPdf) {
                    val candidate = withContext(Dispatchers.IO) {
                        val directory = File(cacheDir, "ssh-previews")
                        check(directory.isDirectory || directory.mkdirs())
                        File.createTempFile("preview-", ".$extension", directory)
                    }
                    temporary = candidate
                    withContext(Dispatchers.IO) { candidate.outputStream().use { browser.download(file.relativePath, it) } }
                    if (remoteFiles === browser && remotePreviewName == file.name) {
                        remotePreviewFile = candidate
                        temporary = null
                    }
                } else {
                    val (text, truncated) = browser.preview(file.relativePath)
                    if (remoteFiles === browser && remotePreviewName == file.name) {
                        remotePreviewText = text + if (truncated) "\n\n（预览已截断，可下载完整文件）" else ""
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (remoteFiles === browser) remotePreviewText = "无法预览此文件，请下载后打开。"
            } finally {
                temporary?.delete()
                if (remoteFiles === browser) remoteFilesBusy = false
                remotePreviewJob = null
            }
        }
    }

    private fun closeRemotePreview() {
        remotePreviewJob?.cancel()
        remotePreviewJob = null
        remotePreviewFile?.delete()
        remotePreviewFile = null
        remotePreviewName = null
        remotePreviewText = null
        remotePreviewPdf = false
    }

    private fun copyRemotePreview() {
        val text = remotePreviewText
        val image = remotePreviewFile
        if (image == null && text != null) {
            (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("SSH 文件内容", text))
            remoteFilesError = null
            composerNotice = "已复制文件内容。"
            return
        }
        if (image == null || remotePreviewPdf) {
            remoteFilesError = "此文件暂不能复制，请下载后打开。"
            return
        }
        remoteFilesBusy = true
        activityScope.launch {
            var copy: File? = null
            try {
                val source = image
                val target = withContext(Dispatchers.IO) {
                    val directory = File(cacheDir, "ssh-previews")
                    check(directory.isDirectory || directory.mkdirs())
                    val destination = File.createTempFile("clipboard-", "." + source.extension, directory)
                    try { source.inputStream().use { input -> destination.outputStream().use { output -> input.copyTo(output) } } }
                    catch (error: Throwable) { destination.delete(); throw error }
                    destination
                }
                copy = target
                val uri = FileProvider.getUriForFile(this@BridgeConnectBotSshActivity, "$packageName.fileprovider", target)
                (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newUri(contentResolver, "SSH 图片", uri))
                copy = null
                remoteFilesError = null
                composerNotice = "已复制图片。"
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                remoteFilesError = "图片复制失败，可下载后重试。"
            } finally {
                copy?.delete()
                remoteFilesBusy = false
            }
        }
    }

    private fun cleanupRemotePreviewCopies() {
        val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1_000
        File(cacheDir, "ssh-previews").listFiles()?.forEach { file ->
            if (file.isFile && file.name.startsWith("clipboard-") && file.lastModified() < cutoff) file.delete()
        }
    }

    private fun forwardRemoteFile(file: BridgeSshRemoteFile, state: BridgeSshCommandComposerState) {
        val browser = remoteFiles ?: return
        val scope = composerScope
        if (remoteFilesBusy || composerDraftError != null) return
        remoteFilesBusy = true
        activityScope.launch {
            try {
                val path = browser.absolutePath(file.relativePath)
                if (remoteFiles === browser && composerScope == scope) {
                    state.insertText(path)
                    remoteFilesOpen = false
                    remoteFilesBusy = false
                    remoteFiles = null
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (remoteFiles === browser) remoteFilesError = (error as? BridgeSshApiRequestException)?.message
                    ?: "文件已失效或无法访问，请刷新后重试。"
            } finally { if (remoteFiles === browser) remoteFilesBusy = false }
        }
    }

    private fun downloadRemoteFile(file: BridgeSshRemoteFile, uri: Uri) {
        val browser = remoteFiles ?: return
        if (remoteFilesBusy) return
        remoteFilesBusy = true
        activityScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    checkNotNull(contentResolver.openOutputStream(uri)).use { browser.download(file.relativePath, it) }
                }
                if (remoteFiles === browser) remoteFilesError = null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (remoteFiles === browser) remoteFilesError = "下载失败，请检查 SSH 连接和手机存储。"
            } finally { if (remoteFiles === browser) remoteFilesBusy = false }
        }
    }

    private fun uploadRemoteFiles(uris: List<Uri>) {
        val browser = remoteFiles ?: return
        val directory = remoteFilesPath
        if (remoteFilesBusy) return
        remoteFilesBusy = true
        activityScope.launch {
            var refreshing = false
            try {
                for (uri in uris) withContext(Dispatchers.IO) {
                    val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) cursor.getString(0) else null
                    } ?: "attachment"
                    checkNotNull(contentResolver.openInputStream(uri)).use { browser.upload(directory, name, it) }
                }
                if (remoteFiles === browser) {
                    remoteFilesBusy = false
                    refreshing = true
                    refreshRemoteFiles(directory)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (remoteFiles === browser) remoteFilesError = if (error is BridgeSshApiRequestException) error.message
                    else "上传失败：请检查连接、文件大小或同名文件。"
            } finally { if (remoteFiles === browser && !refreshing) remoteFilesBusy = false }
        }
    }

    private fun pickComposerAttachments() {
        val scope = composerScope ?: return
        if (composerDraftError != null || composerSending || composerStaging) return
        attachmentPickerScope = scope
        markExternalPickerLaunched()
        composerAttachmentPicker.launch(arrayOf("*/*"))
    }

    private fun stageComposerAttachments(scope: String, uris: List<Uri>) {
        if (composerStaging || composerSending) return
        composerStaging = true
        composerNotice = null
        activityScope.launch {
            try {
                for (uri in uris) {
                    val attachment = composerDraftStore.stage(scope, uri)
                    try {
                        val current = composerDraftStore.load(scope)
                        composerDraftStore.updateAttachments(scope, current.attachments + attachment)
                        if (composerScope == scope) composerDraft = composerDraftStore.load(scope)
                    } catch (error: Throwable) {
                        composerDraftStore.deleteLocalCopy(scope, attachment.id)
                        throw error
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (composerScope == scope) composerNotice = "附件无法加入草稿，请检查文件访问权限和手机存储后重试。"
            } finally {
                composerStaging = false
            }
        }
    }

    private fun removeComposerAttachment(id: String) {
        val scope = composerScope ?: return
        if (composerSending || composerStaging || composerDraftError != null) return
        try {
            val current = composerDraftStore.load(scope)
            if (current.attachments.none { it.id == id }) return
            composerDraftStore.updateAttachments(scope, current.attachments.filterNot { it.id == id })
            composerDraft = composerDraftStore.load(scope)
            composerAttachmentStates = composerAttachmentStates - id
            composerUploadedPaths.remove(id)
            if (!composerDraftStore.deleteLocalCopy(scope, id)) {
                composerNotice = "附件已从草稿移除，但手机上的临时副本未能清理。"
            }
        } catch (_: Exception) {
            composerDraftError = "SSH 草稿无法更新，原始数据已保留。"
        }
    }

    private fun acknowledgeComposerUncertainty(scope: String, state: BridgeSshCommandComposerState) {
        try {
            composerDraftStore.clearPending(scope)
            composerDraft = composerDraftStore.load(scope)
            state.acknowledgeUncertain()
        } catch (_: Exception) {
            composerDraftError = "无法更新 SSH 草稿状态，原始数据已保留。"
        }
    }

    private fun sendComposerSubmission(
        submission: BridgeSshCommandSubmission,
        complete: (BridgeSshCommandSendResult) -> Unit,
    ) {
        val scope = composerScope
        val shell = shellTransport
        val ssh = transport
        if (scope == null || shell == null || ssh == null || composerDraftError != null ||
            composerDraft.sendUncertain || composerSending || composerStaging) {
            submission.utf8.fill(0)
            submission.bracketedPasteUtf8.fill(0)
            complete(BridgeSshCommandSendResult.NotSent)
            return
        }
        val attachments = composerDraft.attachments.toList()
        val attachmentTarget = selectedTmuxSession
        val sessionTool = currentSessionTool()
        composerSending = true
        composerNotice = null
        activityScope.launch {
            var pendingMarked = false
            var outcome = BridgeSshCommandSendResult.NotSent
            try {
                val uploaded = mutableListOf<BridgeSshComposerRemoteAttachment>()
                for (attachment in attachments) {
                    var remotePath = composerUploadedPaths[attachment.id]
                    if (remotePath == null) {
                        composerAttachmentStates = composerAttachmentStates +
                            (attachment.id to (BridgeSshComposerAttachmentStatus.Uploading to "正在上传"))
                        val file = composerDraftStore.fileFor(scope, attachment.id)
                        val progress: (Long) -> Unit = { bytes ->
                            activityScope.launch {
                                if (composerSending && composerScope == scope &&
                                    composerAttachmentStates[attachment.id]?.first == BridgeSshComposerAttachmentStatus.Uploading) {
                                    composerAttachmentStates = composerAttachmentStates +
                                        (attachment.id to (BridgeSshComposerAttachmentStatus.Uploading to "已上传 ${bytes / 1024} KiB"))
                                }
                            }
                        }
                        val fallback: suspend () -> BridgeSshUploadedAttachment = {
                            BridgeSshAttachmentTransfer(ssh).upload(attachment.name, FileInputStream(file), progress)
                        }
                        val result = sessionTool?.uploadComposerAttachment(
                            attachmentTarget, attachment.name, attachment.mimeType, file, progress,
                            canReadRemote = { path ->
                                val check = ssh.exec(BridgeSshAttachmentTransfer.remoteReadCheckCommand(path), maxOutputBytes = 16 * 1024)
                                (check.exitInfo as? SessionExit.Status)?.code == 0L
                            },
                            fallback = fallback,
                        ) ?: fallback()
                        remotePath = result.remotePath
                        composerUploadedPaths[attachment.id] = remotePath
                        composerAttachmentStates = composerAttachmentStates +
                            (attachment.id to (BridgeSshComposerAttachmentStatus.Ready to "已上传，等待发送"))
                    }
                    uploaded.add(BridgeSshComposerRemoteAttachment(attachment.name, attachment.mimeType, remotePath))
                }
                val prompt = BridgeSshCommandEncoding.preparePrompt(BridgeSshComposerPrompt.build(submission.text, uploaded))
                composerDraftStore.markPending(scope)
                pendingMarked = true
                val bytes = BridgeSshCommandEncoding.bracketedPaste(prompt)
                try {
                    outcome = shell.writeComposerPaste(bytes)
                } finally {
                    bytes.fill(0)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                outcome = if (pendingMarked) BridgeSshCommandSendResult.Unknown else BridgeSshCommandSendResult.NotSent
                if (composerScope == scope) {
                    composerNotice = if (pendingMarked) "SSH 写入结果未知，请检查终端。"
                    else (error as? BridgeSshApiRequestException)?.message
                        ?: "附件或草稿准备失败，请检查连接、SFTP 和手机存储后重试。"
                    composerAttachmentStates = composerAttachmentStates.mapValues { (_, value) ->
                        if (value.first == BridgeSshComposerAttachmentStatus.Uploading)
                            BridgeSshComposerAttachmentStatus.Failed to "上传失败，可重试" else value
                    }
                }
            } finally {
                submission.utf8.fill(0)
                submission.bracketedPasteUtf8.fill(0)
            }

            if (outcome == BridgeSshCommandSendResult.Written && composerScope == scope) {
                // The editor persists any cleared text first. Keep the durable
                // pending marker until attachment metadata is also committed.
                complete(outcome)
                try {
                    check(composerDraftError == null) { "Draft text could not be persisted" }
                    val sentIds = attachments.map { it.id }.toSet()
                    val current = composerDraftStore.load(scope)
                    composerDraftStore.updateAttachments(scope, current.attachments.filterNot { it.id in sentIds })
                    composerDraftStore.clearPending(scope)
                    composerDraft = composerDraftStore.load(scope)
                    attachments.forEach { attachment ->
                        composerUploadedPaths.remove(attachment.id)
                        if (!composerDraftStore.deleteLocalCopy(scope, attachment.id)) {
                            composerNotice = "消息已写入 SSH，但手机上的附件副本未能清理。"
                        }
                    }
                    composerAttachmentStates = composerAttachmentStates - sentIds
                } catch (_: Exception) {
                    runCatching { composerDraftStore.markPending(scope) }
                    composerDraft = runCatching { composerDraftStore.load(scope) }.getOrDefault(composerDraft).copy(sendUncertain = true)
                    composerNotice = "消息已写入 SSH，但草稿状态未能保存；请检查终端后再重试。"
                }
            } else {
                if (pendingMarked && outcome == BridgeSshCommandSendResult.NotSent) {
                    try {
                        composerDraftStore.clearPending(scope)
                    } catch (_: Exception) {
                        outcome = BridgeSshCommandSendResult.Unknown
                    }
                }
                if (composerScope == scope && pendingMarked) {
                    composerDraft = runCatching { composerDraftStore.load(scope) }.getOrDefault(composerDraft.copy(sendUncertain = true))
                }
                complete(outcome)
            }
            composerSending = false
        }
    }

    private fun generateKey(algorithm: BridgeSshKeyAlgorithm, nickname: String) {
        if (keyGenerationInProgress) return
        keyGenerationInProgress = true
        connectionMessage = null
        connectionErrorDetails = null
        keyGenerationErrorDetails = null
        var generatedPrivateKey: CharArray? = null
        keyGenerationJob = activityScope.launch(Dispatchers.Default) {
            try {
                val generated = BridgeSshKeyGenerator.generate(algorithm, nickname)
                generatedPrivateKey = generated.privateKeyPem
                val stored = BridgeSshKeyStore.save(this@BridgeConnectBotSshActivity, generated)
                withContext(Dispatchers.Main.immediate) {
                    BridgeSshKeySupport.clear(generatedPrivateKey)
                    generatedPrivateKey = null
                    clearSelectedKey()
                    keyName = generated.nickname
                    keyFormat = generated.algorithm.label
                    keyEncrypted = false
                    passphrase = ""
                    generatedPublicKey = generated.publicKeyLine
                    publicKeyCopied = false
                    generatedPublicKeyDialog = generated.publicKeyLine
                    savedKeys = BridgeSshKeyStore.list(this@BridgeConnectBotSshActivity)
                    identitySelection = identitySelection.useStoredKey(stored.id)
                    keyGenerationDialog = false
                    keyGenerationErrorDetails = null
                    connectionMessage = "已生成并保存 ${generated.algorithm.label} 密钥。"
                }
            } catch (error: Throwable) {
                withContext(Dispatchers.Main.immediate) {
                    keyGenerationDialog = false
                    generatedPublicKeyDialog = null
                    connectionMessage = "密钥生成失败，请复制下面的错误详情。"
                    keyGenerationErrorDetails = formatKeyGenerationError(error, algorithm)
                }
            } finally {
                generatedPrivateKey?.let { BridgeSshKeySupport.clear(it) }
                withContext(Dispatchers.Main.immediate) {
                    keyGenerationInProgress = false
                    keyGenerationJob = null
                }
            }
        }
    }

    private fun deleteStoredKey(key: BridgeSshStoredKey) {
        try {
            BridgeSshKeyStore.delete(this, key.id)
            savedKeys = BridgeSshKeyStore.list(this)
            if (selectedStoredKeyId == key.id) {
                clearSelectedKey()
                identitySelection = identitySelection.restoreSavedKey()
            }
            connectionMessage = "已删除 ${key.nickname} 的保存副本。引用该密钥的主机需重新选择密钥。"
        } catch (_: Throwable) {
            connectionMessage = "密钥删除失败。"
        }
    }

    private fun copyPublicKey(publicKey: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("SSH public key", publicKey))
        publicKeyCopied = true
        connectionMessage = "公钥已复制。"
    }

    private fun copyKeyGenerationError(details: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("SSH key generation error", details))
        connectionMessage = "错误详情已复制。"
    }

    private fun copyConnectionError(details: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("SSH connection diagnostics", details))
        connectionMessage = "连接诊断已复制。"
    }

    private fun formatKeyGenerationError(
        error: Throwable,
        algorithm: BridgeSshKeyAlgorithm,
    ): String {
        val causes = buildList {
            var current: Throwable? = error
            repeat(6) {
                if (current == null) return@repeat
                add(
                    "${current::class.java.name}: ${sanitizeErrorMessage(current.message)}",
                )
                current = current.cause
            }
        }
        return buildString {
            appendLine("operation=ssh-keygen-and-save")
            appendLine("algorithm=${algorithm.label}")
            appendLine("storage=AndroidKeyStore+SharedPreferences")
            appendLine("sdk=${Build.VERSION.SDK_INT}")
            appendLine("causes=")
            causes.forEach { appendLine("- $it") }
        }.trim()
    }

    private fun sanitizeErrorMessage(message: String?): String {
        val value = message.orEmpty()
            .replace(Regex("-----BEGIN [^-]+-----[\\s\\S]*?-----END [^-]+-----"), "[redacted-key]")
            .replace(Regex("(?i)(password|passphrase|private.?key)\\s*[:=]\\s*[^,; ]+"), "$1=[redacted]")
            .replace(Regex("\\s+"), " ")
            .trim()
        return value.take(500).ifBlank { "(no message)" }
    }

    private fun formatConnectionError(
        error: Throwable,
        phase: String,
        usedPublicKey: Boolean,
    ): String {
        val bridgeFailure = error as? BridgeSshConnectionFailure
        val causes = buildList {
            var current: Throwable? = error
            repeat(8) {
                if (current == null) return@repeat
                add(
                    "${current::class.java.name}: ${sanitizeErrorMessage(current.message)}",
                )
                current = current.cause
            }
        }
        return buildString {
            appendLine("operation=ssh-connect")
            appendLine("target=${sanitizeErrorMessage(host)}:${port.toIntOrNull() ?: "invalid"}")
            appendLine("username=${sanitizeErrorMessage(username)}")
            appendLine("phase=${bridgeFailure?.phase ?: phase}")
            appendLine("auth=${if (usedPublicKey) "public-key" else "password"}")
            keyName?.let { appendLine("selected_key=${sanitizeErrorMessage(it)}") }
            appendLine("summary=${sanitizeErrorMessage(bridgeFailure?.summary ?: error.message)}")
            appendLine("causes=")
            causes.forEach { appendLine("- $it") }
        }.trim()
    }

    private fun applyWindowTheme(theme: String) {
        val dark = theme.equals("dark", ignoreCase = true)
        val background = bridgeSshColorScheme(theme).background.toArgb()
        window.statusBarColor = background
        window.navigationBarColor = background
        val insetsController = WindowCompat.getInsetsController(window, window.decorView)
        insetsController.isAppearanceLightStatusBars = !dark
        insetsController.isAppearanceLightNavigationBars = !dark
    }

    /** Mark a system document provider handoff without changing the SSH session. */
    private fun markExternalPickerLaunched() {
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.PICKER_OPENED,
            BridgeSshTraceField.SESSION to managedSession?.diagnosticId)
        externalPickerOpen = true
        externalPickerReturnedAt = 0L
    }

    private fun markExternalPickerReturned(selectionPresent: Boolean) {
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.PICKER_RETURNED,
            BridgeSshTraceField.SESSION to managedSession?.diagnosticId,
            BridgeSshTraceField.SELECTION_PRESENT to selectionPresent)
        externalPickerOpen = false
        externalPickerReturnedAt = SystemClock.elapsedRealtime()
    }

    private fun isReturningFromExternalPicker(): Boolean =
        externalPickerOpen || (externalPickerReturnedAt != 0L &&
            SystemClock.elapsedRealtime() - externalPickerReturnedAt < 1_500L)

    /** The app-owned session also retries while its workspace is not visible. */
    private fun maybeReconnectOnResume() {
        val current = managedSession ?: return
        if (current.terminalSession.status.state in setOf(
                BridgeSshConnectionState.FAILED,
                BridgeSshConnectionState.DISCONNECTED,
                BridgeSshConnectionState.CLOSED,
            ) && !current.reconnecting) current.requestReconnect()
    }

    private fun decideHostKey(accepted: Boolean) {
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.HOST_KEY_DECIDED,
            BridgeSshTraceField.DETAIL to if (accepted) BridgeSshTraceDetail.ACCEPTED else BridgeSshTraceDetail.REJECTED)
        hostKeyDecision?.complete(accepted)
    }

    private fun currentSessionTool(): BridgeSshRemoteSession? = managedSession
        ?.takeIf { it.transport.isAuthenticated }
        ?.let { session ->
            val apiClient = bridgeServerOrigin?.let { origin ->
                runCatching {
                    BridgeSecureCredentialStore(applicationContext).get(origin)
                        ?.takeIf { it.isNotBlank() }
                        ?.let { token -> BridgeSshApiClient(origin, token) }
                }.getOrNull()
            }
            BridgeSshRemoteSession(session.transport, apiClient)
        }

    private fun isCurrentTarget(target: BridgeSshTmuxSession): Boolean =
        selectedTmuxSession?.let { it.id == target.id && it.createdAt == target.createdAt } == true

    private fun loadSshAccounts() {
        val target = selectedTmuxSession ?: return
        val tool = currentSessionTool() ?: return
        if (sshActionBusy) return
        sshActionBusy = true
        sshAccountError = null
        activityScope.launch {
            try {
                val result = tool.call("accounts", target)
                if (isCurrentTarget(target)) {
                    val array = result.optJSONArray("homes")
                    sshCodexHomes = (0 until (array?.length() ?: 0)).mapNotNull { index ->
                        array?.optJSONObject(index)?.let { BridgeSshCodexHome(it.getString("id"), it.getString("path"), it.getString("label")) }
                    }
                    sshSelectedCodexHome = result.optString("selected")
                    loadSshUsageSummary(target, sshSelectedCodexHome)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (isCurrentTarget(target)) sshAccountError = error.message ?: "无法读取账号。" }
            finally { sshActionBusy = false }
        }
    }

    private fun changeSshAccount(home: BridgeSshCodexHome? = null) {
        val target = selectedTmuxSession ?: return
        val tool = currentSessionTool() ?: return
        if (sshActionBusy) return
        sshActionBusy = true
        sshAccountError = null
        activityScope.launch {
            try {
                val action = if (home == null) "refresh_account" else "mark_account"
                val args = home?.let { mapOf("home" to it.id) } ?: emptyMap()
                val result = tool.call(action, target, args)
                if (isCurrentTarget(target)) {
                    sshSelectedCodexHome = result.getString("selected")
                    loadSshUsageSummary(target, sshSelectedCodexHome)
                    composerNotice = if (result.optString("source") == "ssh-fallback")
                        "已通过 SSH 更新账号标记；Web 记录尚未同步，现有 shell 和 Codex 不会切换。"
                    else "已更新账号标记；现有 shell 和正在运行的 Codex 不会切换。"
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (isCurrentTarget(target)) sshAccountError = error.message ?: "无法更新账号标记。" }
            finally { sshActionBusy = false }
        }
    }

    private fun loadSshUsageSummary(target: BridgeSshTmuxSession, home: String) {
        sshUsageJob?.cancel()
        sshUsageSummary = "-·-"
        if (home.isBlank()) return
        val tool = currentSessionTool() ?: return
        sshUsageJob = activityScope.launch {
            try {
                val result = tool.call("usage", target, mapOf("home" to home))
                if (isCurrentTarget(target) && sshSelectedCodexHome == home) {
                    sshUsageSummary = codexUsageSummary(result)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (isCurrentTarget(target) && sshSelectedCodexHome == home) sshUsageSummary = "-·-"
            }
        }
    }

    private fun loadSshUsage() {
        val target = selectedTmuxSession ?: return
        val tool = currentSessionTool() ?: return
        val home = sshSelectedCodexHome.takeIf { it.isNotBlank() } ?: return
        if (sshActionBusy) return
        sshUsageOpen = true
        sshActionBusy = true
        sshUsageError = null
        sshUsageResult = null
        activityScope.launch {
            try {
                val result = tool.call("usage", target, mapOf("home" to home))
                if (isCurrentTarget(target) && sshSelectedCodexHome == home) {
                    sshUsageResult = result
                    sshUsageSummary = codexUsageSummary(result)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (isCurrentTarget(target)) sshUsageError = error.message ?: "无法读取用量。" }
            finally { sshActionBusy = false }
        }
    }

    private fun loadSshGitChanges() {
        val target = selectedTmuxSession ?: return
        val tool = currentSessionTool() ?: return
        if (sshActionBusy) return
        sshGitOpen = true
        sshActionBusy = true
        sshGitError = null
        activityScope.launch {
            try {
                val result = tool.call("git_list", target)
                if (isCurrentTarget(target)) {
                    val array = result.optJSONArray("files")
                    val files = (0 until (array?.length() ?: 0)).mapNotNull { index ->
                        array?.optJSONObject(index)?.let {
                            val size = if (it.isNull("size")) null else it.optLong("size", -1).takeIf { value -> value >= 0 }
                            BridgeSshGitFile(it.getString("path"), it.getString("status"), size)
                        }
                    }
                    sshGitState = BridgeSshGitState(result.getString("root"), result.optString("branch"), files)
                    sshGitSelected = null
                    sshGitDetail = null
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (isCurrentTarget(target)) sshGitError = error.message ?: "无法读取 Git 变更。" }
            finally { sshActionBusy = false }
        }
    }

    private fun downloadSshGitFile(request: SshGitDownloadRequest, uri: Uri) {
        if (managedSession !== request.owner || !isCurrentTarget(request.target) || sshActionBusy) {
            sshGitError = "Session 已切换，请重新选择文件。"
            return
        }
        val tool = currentSessionTool() ?: return
        val browser = BridgeSshRemoteFiles(
            resolveCurrentRoot = {
                val result = tool.call("git_list", request.target, mapOf("root" to request.root))
                val files = result.getJSONArray("files")
                check((0 until files.length()).any { index ->
                    files.optJSONObject(index)?.optString("path") == request.file.path
                }) { "文件已不在当前变更列表中。" }
                result.getString("root")
            },
            openSftp = { request.owner.transport.openSftp() },
        )
        sshActionBusy = true
        sshGitError = null
        activityScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    checkNotNull(contentResolver.openOutputStream(uri)) { "无法打开下载目标。" }.use { output ->
                        tool.downloadGitFile(request.target, request.root, request.file.path, output) {
                            browser.download(request.file.path, output)
                        }
                    }
                }
                sshGitError = null
                composerNotice = "文件已下载。"
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { sshGitError = "下载失败：${error.message ?: "请检查连接和文件状态。"}" }
            finally { sshActionBusy = false }
        }
    }

    private fun loadSshGitDetail(file: BridgeSshGitFile, preview: Boolean) {
        val target = selectedTmuxSession ?: return
        val tool = currentSessionTool() ?: return
        val root = sshGitState?.root ?: return
        if (sshActionBusy) return
        sshGitSelected = file
        sshGitPreview = preview
        sshGitDetail = null
        sshGitTruncated = false
        sshGitError = null
        sshActionBusy = true
        activityScope.launch {
            try {
                val result = tool.call(if (preview) "git_preview" else "git_diff", target, mapOf("root" to root, "path" to file.path))
                if (isCurrentTarget(target) && sshGitSelected == file) {
                    sshGitDetail = result.getString("text")
                    sshGitTruncated = result.optBoolean("truncated")
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (isCurrentTarget(target)) sshGitError = error.message ?: "无法读取文件。" }
            finally { sshActionBusy = false }
        }
    }

    private fun runSshSessionAction(action: String) {
        val target = selectedTmuxSession ?: return
        val tool = currentSessionTool() ?: return
        if (sshActionBusy) return
        sshActionBusy = true
        composerNotice = null
        activityScope.launch {
            try {
                val result = tool.call(action, target)
                if (isCurrentTarget(target)) {
                    if (action == "suspend" || action == "end") {
                        managedSession?.let {
                            it.resumeTarget = null
                            runCatching { BridgeSshTmuxResumeStore(applicationContext).clear(it.key) }
                        }
                        activateComposerScope(null)
                        sshCodexHomes = emptyList()
                        sshSelectedCodexHome = ""
                        tmuxSessionCache.reset()
                    }
                    composerNotice = if (result.optString("source") == "ssh-fallback") when (action) {
                        "save" -> "已保存「${target.name}」的 SSH 降级快照；它与 Web 快照分开。"
                        "suspend" -> "已挂起「${target.name}」；请在 SSH 会话列表中恢复，Web 状态尚未同步。"
                        else -> "已通过 SSH 终结「${target.name}」；Web 状态尚未同步。"
                    } else when (action) {
                        "save" -> "已保存「${target.name}」的独立快照。"
                        "suspend" -> "已挂起「${target.name}」，可从 tmux 会话列表恢复。"
                        else -> "已终结「${target.name}」。"
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (isCurrentTarget(target)) composerNotice = "操作未确认：${error.message ?: "请刷新会话列表核对。"}"
            } finally { sshActionBusy = false }
        }
    }

    private fun refreshSshSuspended() {
        val tool = currentSessionTool() ?: return
        val owner = managedSession ?: return
        activityScope.launch {
            try {
                val result = tool.call("list_suspended")
                if (managedSession === owner) {
                    val array = result.optJSONArray("sessions")
                    sshSuspended = (0 until (array?.length() ?: 0)).mapNotNull { index ->
                        array?.optJSONObject(index)?.let {
                            BridgeSshSuspendedSession(it.getString("id"), it.getLong("createdAt"), it.getString("name"),
                                it.optString("cwd"), it.optString("source"), it.optBoolean("uncertain"))
                        }
                    }
                    sshSuspendedError = null
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (managedSession === owner) sshSuspendedError = error.message ?: "无法读取挂起的会话。" }
        }
    }

    private fun restoreSshSession(session: BridgeSshSuspendedSession) {
        val tool = currentSessionTool() ?: return
        if (sshActionBusy) return
        sshActionBusy = true
        sshSuspendedError = null
        activityScope.launch {
            try {
                val result = tool.call("restore", arguments = mapOf("source" to session.source).filterValues { it.isNotBlank() },
                    identity = BridgeSshTmuxIdentity(session.id, session.createdAt))
                connectionMessage = if (result.optString("source") == "ssh-fallback")
                    "已通过 SSH 恢复「${session.name}」；Web 状态尚未同步。" else "已恢复「${session.name}」，请选择它进入。"
                tmuxSessionCache.reset()
                refreshTmuxSessions()
                refreshSshSuspended()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { sshSuspendedError = "恢复结果未确认：${error.message ?: "请刷新核对。"}" }
            finally { sshActionBusy = false }
        }
    }

    private fun refreshTmuxSessions(force: Boolean = true) {
        val client = tmuxClient ?: return
        val tool = currentSessionTool()
        if (tmuxSessionCache.refreshing || (!force && tmuxSessionCache.sessions != null)) return
        connectionMessage = null
        connectionErrorDetails = null
        activityScope.launch {
            when (val result = tmuxSessionCache.load(force) {
                withContext(Dispatchers.IO) { tool?.listSessions { client.listSessions() } ?: client.listSessions() }
            }) {
                BridgeSshTmuxLoadResult.Loaded -> {
                    connectionState = "请选择 tmux Session"
                    val selected = selectedTmuxSession
                    val updated = selected?.let { previous ->
                        tmuxSessionCache.sessions?.firstOrNull { it.id == previous.id && it.createdAt == previous.createdAt }
                    }
                    if (updated != null) {
                        selectedTmuxSession = updated
                        managedSession?.selectedTmuxSession = updated
                    }
                }
                is BridgeSshTmuxLoadResult.Failed -> {
                    connectionMessage = "tmux Session 列表读取失败。"
                    connectionErrorDetails = formatConnectionError(
                        error = result.error,
                        phase = "list-tmux",
                        usedPublicKey = false,
                    )
                }
                BridgeSshTmuxLoadResult.Skipped -> Unit
            }
        }
    }

    private fun openTmuxPicker() {
        tmuxPickerOpen = true
        refreshTmuxSessions(force = false)
    }

    private fun openTmuxSession(session: BridgeSshTmuxSession, userInitiated: Boolean = false) {
        val shell = shellTransport ?: return
        if (composerSending || composerStaging) return
        if (userInitiated) managedSession?.key?.let { key ->
            if (runCatching { tmuxUsageStore.recordOpen(key, session) }.isSuccess) tmuxUsageRevision += 1
        }
        val current = selectedTmuxSession
        composerSending = true
        connectionMessage = if (current == null) "正在进入 tmux Session…" else "正在切换 tmux Session…"
        activityScope.launch {
            val attachCommand = BridgeSshTmuxCommandBuilder.attachInCurrentShellCommand(session.id)
            val detachSequence = current?.let {
                shortcutCatalog?.terminalSequences?.get("tmux-detach")
                    ?.toByteArray(Charsets.UTF_8)
                    ?: BridgeSshCommandEncoding.tmuxDetach()
            }
            val attachBytes = if (detachSequence == null) {
                BridgeSshCommandEncoding.bracketedPaste(attachCommand)
            } else null
            try {
                val result = if (attachBytes != null) {
                    shell.writeComposerPaste(attachBytes)
                } else {
                    shell.detachAndAttachTmux(checkNotNull(detachSequence), attachCommand)
                }
                when (result) {
                    BridgeSshCommandSendResult.Written -> {
                        activateComposerScope(session)
                        managedSession?.let { current ->
                            current.resumeTarget = BridgeSshTmuxIdentity.of(session)
                            current.clearRecoveryNotice()
                            runCatching { BridgeSshTmuxResumeStore(applicationContext).save(current.key, session) }
                        }
                        tmuxPickerOpen = false
                        connectionMessage = null
                    }
                    BridgeSshCommandSendResult.NotSent -> connectionMessage = "进入会话的指令未发送，请检查连接。"
                    BridgeSshCommandSendResult.Unknown -> connectionMessage = "进入会话的结果未知，请先查看终端。"
                }
            } finally {
                attachBytes?.fill(0)
                detachSequence?.fill(0)
                composerSending = false
            }
        }
    }

    private fun connect(automatic: Boolean = false) {
        if (connectJob != null || privateKeyReading) return
        val parsedPort = port.toIntOrNull()
        if (parsedPort == null || parsedPort !in 1..65535) {
            connectionMessage = "端口无效。"
            return
        }
        if (selectedStoredKeyId != null && savedKeys.none { it.id == selectedStoredKeyId }) {
            connectionMessage = "此主机关联的密钥不存在，请重新选择密钥。"
            setupPage = SshSetupPage.EDIT_HOST
            return
        }
        if (!automatic && saveCurrentProfile() == null) return
        val connectionKey = BridgeSshAppConnectionKey.of(host, parsedPort, username)
        BridgeSshAppState.find(connectionKey)?.let { existing ->
            if (existing.terminalSession.status.state == BridgeSshConnectionState.CONNECTED && !existing.reconnecting) {
                attachSession(existing, restoreProfile = true)
                return
            }
            // A user-supplied replacement credential must not reopen a failed session.
            pendingReconnectKey = connectionKey
            pendingReconnectTarget = existing.selectedTmuxSession?.let(BridgeSshTmuxIdentity::of) ?: existing.resumeTarget
            if (managedSession === existing) detachSession()
            BridgeSshAppState.disconnect(existing, BridgeSshTraceDetail.USER)
        }
        connectionMessage = null
        connectionErrorDetails = null
        connectionState = "连接中"
        val attempt = BridgeSshActivityDiagnostics.nextAttemptId()
        val isAutomatic = automatic || pendingReconnectKey == connectionKey
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.CONNECTION_STARTED,
            BridgeSshTraceField.ATTEMPT to attempt,
            BridgeSshTraceField.DETAIL to if (isAutomatic) BridgeSshTraceDetail.AUTOMATIC else BridgeSshTraceDetail.USER)
        BridgeSshAppState.beginConnection(applicationContext)
        connectJob = activityScope.launch {
            var key: CharArray? = null
            var keyPassphrase: CharArray? = null
            var phase = "connect"
            try {
                key = privateKey?.clone()
                if (key == null && selectedStoredKeyId != null) {
                    phase = "load-key"
                    traceConnectionPhase(attempt, phase)
                    key = withContext(Dispatchers.IO) {
                        BridgeSshKeyStore.loadPrivateKey(
                            this@BridgeConnectBotSshActivity,
                            selectedStoredKeyId!!,
                        )
                    }
                }
                val selectedPublicKeyLine = selectedStoredKeyId
                    ?.let { id -> savedKeys.firstOrNull { it.id == id }?.publicKeyLine }
                keyPassphrase = passphrase.takeIf {
                    key != null && selectedPublicKeyLine == null && it.isNotEmpty()
                }?.toCharArray()
                val verifier = BridgeCbSshHostKeyVerifier(
                    applicationContext.getSharedPreferences(BRIDGE_SSH_KNOWN_HOSTS_PREFERENCES, Context.MODE_PRIVATE),
                    host,
                    parsedPort,
                ) { prompt -> awaitHostKey(prompt) }
                traceConnectionPhase(attempt, "connect")
                val nextTransport = withContext(Dispatchers.IO) { BridgeCbSshTransport(host, parsedPort, verifier) }
                provisionalTransport = nextTransport
                val result = try {
                    withContext(Dispatchers.IO) { nextTransport.connect() }
                } finally {
                    verifier.clearApprovalHandler()
                }
                when (result) {
                    is ConnectResult.Success -> Unit
                    is ConnectResult.AlgorithmMismatch -> throw BridgeSshConnectionFailure(
                        category = BridgeSshTraceDetail.ALGORITHM_MISMATCH, phase = "connect",
                        summary = "算法协商失败：${result.message}",
                    )
                    is ConnectResult.HostKeyRejected -> throw BridgeSshConnectionFailure(
                        category = BridgeSshTraceDetail.HOST_KEY_REJECTED, phase = "host-key",
                        summary = "主机指纹未被接受（${result.key.type.ifBlank { "unknown" }}）",
                    )
                    is ConnectResult.ProtocolError -> throw BridgeSshConnectionFailure(
                        category = BridgeSshTraceDetail.PROTOCOL_ERROR, phase = "connect",
                        summary = result.message,
                        cause = result.cause,
                    )
                    is ConnectResult.TransportError -> {
                        BridgeAutoVpnRecoverySignal.request()
                        throw BridgeSshConnectionFailure(
                            category = BridgeSshTraceDetail.TRANSPORT_ERROR, phase = "connect",
                            summary = "传输层错误",
                            cause = result.cause,
                        )
                    }
                    else -> throw BridgeSshConnectionFailure(
                        phase = "connect",
                        summary = "未处理的连接结果：${result::class.java.name}",
                    )
                }
                phase = "authenticate"
                BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.CONNECTION_PHASE,
                    BridgeSshTraceField.ATTEMPT to attempt, BridgeSshTraceField.DETAIL to BridgeSshTraceDetail.AUTHENTICATE,
                    BridgeSshTraceField.AUTH_METHOD to if (key != null) BridgeSshTraceDetail.PUBLIC_KEY else BridgeSshTraceDetail.PASSWORD)
                connectionState = "认证中"
                val auth = withContext(Dispatchers.IO) {
                    if (key != null) {
                        nextTransport.authenticatePublicKey(
                            username,
                            key,
                            keyPassphrase,
                            selectedPublicKeyLine,
                        )
                    }
                    else nextTransport.authenticatePassword(username, password)
                }
                when (auth) {
                    is AuthResult.Success -> Unit
                    is AuthResult.Failure -> throw BridgeSshConnectionFailure(
                        category = BridgeSshTraceDetail.AUTH_REJECTED, phase = "authenticate",
                        summary = "服务器拒绝认证；auth.allowed_methods=${auth.allowedMethods.sorted().joinToString(",").ifBlank { "unknown" }}",
                    )
                    is AuthResult.Error -> throw BridgeSshConnectionFailure(
                        category = BridgeSshTraceDetail.AUTH_ERROR, phase = "authenticate",
                        summary = auth.message,
                        cause = auth.cause,
                    )
                    else -> throw BridgeSshConnectionFailure(
                        phase = "authenticate",
                        summary = "未处理的认证结果：${auth::class.java.name}",
                    )
                }
                phase = "open-shell"
                traceConnectionPhase(attempt, phase)
                val shell = withContext(Dispatchers.IO) { nextTransport.openShell() }
                val reconnectCredentials = when {
                    selectedStoredKeyId != null -> BridgeSshReconnectCredentials.StoredKey(selectedStoredKeyId!!)
                    key != null -> BridgeSshReconnectCredentials.TemporaryKey(key, keyPassphrase)
                    else -> BridgeSshReconnectCredentials.Password(password.toCharArray())
                }
                val (session, created) = BridgeSshAppState.register(connectionKey, nextTransport, shell, reconnectCredentials)
                password = ""
                BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.CONNECTION_SUCCEEDED,
                    BridgeSshTraceField.ATTEMPT to attempt, BridgeSshTraceField.SESSION to session.diagnosticId,
                    BridgeSshTraceField.DETAIL to if (created) BridgeSshTraceDetail.REGISTERED else BridgeSshTraceDetail.RESTORED)
                val reconnectTarget = pendingReconnectTarget.takeIf { pendingReconnectKey == connectionKey }
                if (created && reconnectTarget != null) session.resumeTarget = reconnectTarget
                pendingReconnectTarget = null
                pendingReconnectKey = null
                provisionalTransport = null
                attachSession(session, restoreProfile = !created)
                markCurrentProfileUsed()
                if (created && reconnectTarget != null) {
                    val liveTarget = try {
                        withContext(Dispatchers.IO) {
                            session.tmuxClient.findResumeTarget(reconnectTarget)
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Throwable) {
                        null
                    }
                    BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.RECONNECT_TARGET,
                        BridgeSshTraceField.SESSION to session.diagnosticId,
                        BridgeSshTraceField.DETAIL to if (liveTarget != null) BridgeSshTraceDetail.TARGET_FOUND else BridgeSshTraceDetail.TARGET_MISSING)
                    if (liveTarget != null) {
                        openTmuxSession(liveTarget)
                    } else {
                        connectionMessage = "无法恢复上次 tmux Session；请点击 tmux 重新选择。"
                        composerNotice = connectionMessage
                    }
                } else if (created && startupCommand.isNotBlank()) {
                    val commandBytes = (startupCommand + "\n").toByteArray(Charsets.UTF_8)
                    session.shellTransport.writeToSsh(commandBytes, 0, commandBytes.size)
                    commandBytes.fill(0)
                }
            } catch (cancelled: CancellationException) {
                BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.CONNECTION_CANCELLED,
                    BridgeSshTraceField.ATTEMPT to attempt, BridgeSshTraceField.DETAIL to tracePhase(phase), BridgeSshTraceField.ERROR to cancelled)
                throw cancelled
            } catch (error: Throwable) {
                BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.CONNECTION_FAILED,
                    BridgeSshTraceField.ATTEMPT to attempt, BridgeSshTraceField.DETAIL to tracePhase(phase),
                    BridgeSshTraceField.FAILURE_REASON to (error as? BridgeSshConnectionFailure)?.category, BridgeSshTraceField.ERROR to error)
                connectionState = "连接失败"
                connectionMessage = "SSH 连接失败，下面是可复制的详细诊断。"
                setupPage = SshSetupPage.EDIT_HOST
                connectionErrorDetails = formatConnectionError(
                    error = error,
                    phase = (error as? BridgeSshConnectionFailure)?.phase ?: phase,
                    usedPublicKey = key != null,
                )
            } finally {
                closeProvisionalTransport()
                BridgeSshKeySupport.clear(key)
                BridgeSshKeySupport.clear(keyPassphrase)
                privateKey?.let { BridgeSshKeySupport.clear(it) }
                privateKey = null
                if (selectedStoredKeyId == null && keyName != null) {
                    identitySelection = identitySelection.restoreSavedKey()
                    val savedKey = savedKeys.firstOrNull { it.id == selectedStoredKeyId }
                    keyName = savedKey?.nickname
                    keyFormat = savedKey?.algorithm
                    keyEncrypted = false
                    generatedPublicKey = savedKey?.publicKeyLine
                    if (connectionErrorDetails != null) {
                        connectionMessage = "SSH 连接失败。文件私钥已从内存清除，重试时请重新选择；下面是详细诊断。"
                    }
                }
                passphrase = ""
                connectJob = null
                BridgeSshAppState.finishConnection()
            }
        }
    }

    private fun tracePhase(phase: String): BridgeSshTraceDetail = when (phase) {
        "connect" -> BridgeSshTraceDetail.CONNECT
        "load-key" -> BridgeSshTraceDetail.LOAD_KEY
        "authenticate" -> BridgeSshTraceDetail.AUTHENTICATE
        "open-shell" -> BridgeSshTraceDetail.OPEN_SHELL
        else -> BridgeSshTraceDetail.UNKNOWN
    }

    private fun traceConnectionPhase(attempt: Int, phase: String) {
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.CONNECTION_PHASE,
            BridgeSshTraceField.ATTEMPT to attempt, BridgeSshTraceField.DETAIL to tracePhase(phase))
    }

    private suspend fun awaitHostKey(prompt: BridgeCbSshHostKeyPrompt): Boolean {
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.HOST_KEY_PROMPTED,
            BridgeSshTraceField.HOST_KEY_CHANGED to prompt.changed)
        val decision = CompletableDeferred<Boolean>()
        withContext(Dispatchers.Main.immediate) {
            hostKeyDecision?.complete(false)
            hostKeyDecision = decision
            pendingHostKey = prompt
        }
        return try {
            decision.await()
        } finally {
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                if (hostKeyDecision === decision) {
                    hostKeyDecision = null
                    pendingHostKey = null
                }
            }
        }
    }

    private fun readPrivateKey(uri: Uri) {
        val generation = ++privateKeyReadGeneration
        privateKeyReading = true
        activityScope.launch(Dispatchers.IO) {
            var chars: CharArray? = null
            try {
                chars = readPrivateKeyChars(uri)
                val info = BridgeSshKeySupport.inspectForPicker(chars)
                val name = queryDisplayName(uri)
                withContext(Dispatchers.Main.immediate) {
                    if (generation != privateKeyReadGeneration) return@withContext
                    clearSelectedKey()
                    privateKey = chars
                    chars = null
                    keyName = name
                    keyFormat = info.format
                    keyEncrypted = info.encrypted
                    connectionMessage = "已选择私钥文件，仅用于当前连接。"
                    connectionErrorDetails = null
                    if (setupPage == SshSetupPage.HOSTS && username.isNotBlank()) {
                        hasIncomingConnection = true
                    }
                }
            } catch (_: Throwable) {
                withContext(Dispatchers.Main.immediate) {
                    if (generation == privateKeyReadGeneration) {
                        connectionMessage = "私钥无法读取或格式不支持，请选择 OpenSSH/PKCS#8 私钥。"
                    }
                }
            } finally {
                chars?.let { BridgeSshKeySupport.clear(it) }
                withContext(Dispatchers.Main.immediate) {
                    if (generation == privateKeyReadGeneration) privateKeyReading = false
                }
            }
        }
    }

    private fun importPrivateKey(uri: Uri) {
        if (keyImportInProgress) return
        keyImportInProgress = true
        connectionMessage = null
        activityScope.launch(Dispatchers.IO) {
            var chars: CharArray? = null
            try {
                val importedChars = readPrivateKeyChars(uri)
                chars = importedChars
                val name = queryDisplayName(uri)
                val stored = BridgeSshKeyStore.importKey(this@BridgeConnectBotSshActivity, importedChars, name)
                withContext(Dispatchers.Main.immediate) {
                    savedKeys = BridgeSshKeyStore.list(this@BridgeConnectBotSshActivity)
                    connectionMessage = "已加密保存 ${stored.nickname}；可从密钥列表选用。"
                    connectionErrorDetails = null
                }
            } catch (_: BridgeSshEncryptedImportException) {
                withContext(Dispatchers.Main.immediate) {
                    connectionMessage = "带口令的私钥暂不支持保存，请使用“选择私钥文件（仅当前连接）”。"
                }
            } catch (_: Throwable) {
                withContext(Dispatchers.Main.immediate) {
                    connectionMessage = "私钥无法导入。请确认文件是可解析的未加密 OpenSSH 或 PKCS#8 私钥。"
                }
            } finally {
                chars?.let { BridgeSshKeySupport.clear(it) }
                withContext(Dispatchers.Main.immediate) { keyImportInProgress = false }
            }
        }
    }

    private fun readPrivateKeyChars(uri: Uri): CharArray {
        val bytes = readBounded(uri)
        return try {
            val decoded = Charsets.UTF_8.decode(ByteBuffer.wrap(bytes))
            try {
                CharArray(decoded.remaining()).also { decoded.get(it) }
            } finally {
                if (decoded.hasArray()) decoded.array().fill('\u0000')
            }
        } finally {
            bytes.fill(0)
        }
    }

    private fun readBounded(uri: Uri): ByteArray {
        contentResolver.openInputStream(uri).use { input ->
            requireNotNull(input) { "private key" }
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                output.write(buffer, 0, count)
                require(output.size() <= BridgeSshKeySupport.MAX_PRIVATE_KEY_BYTES) { "private key too large" }
            }
            buffer.fill(0)
            return output.toByteArray()
        }
    }

    private fun queryDisplayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null).use { cursor ->
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0) ?: "private-key"
        }
        return "private-key"
    }

    /** Attach a native screen to an existing app-owned session. */
    private fun attachSession(session: BridgeSshAppSession, restoreProfile: Boolean) {
        if (managedSession !== session) detachSession()
        if (restoreProfile) {
            val profile = savedProfiles.firstOrNull {
                BridgeSshAppConnectionKey.of(it.host, it.port, it.username) == session.key
            }
            if (profile != null) applyProfile(profile) else {
                clearSelectedKey()
                identitySelection = identitySelection.withoutKey()
                editingProfileId = null
                profileLabel = ""
                host = session.key.host
                port = session.key.port.toString()
                username = session.key.username
                password = ""
                startupCommand = ""
            }
        }
        BridgeSshAppState.view(session)
        managedSession = session
        managedBindingGeneration = session.bindingGeneration
        transport = session.transport
        shellTransport = session.shellTransport
        tmuxClient = session.tmuxClient
        composerDiagnostics = session.diagnostics
        if (diagnosticsRecording && !composerDiagnostics.recording) composerDiagnostics.start()
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.SESSION_ATTACHED,
            BridgeSshTraceField.SESSION to session.diagnosticId, BridgeSshTraceField.AUTHENTICATED to session.transport.isAuthenticated)
        composerUploadedPaths = session.uploadedPaths
        activateComposerScope(session.selectedTmuxSession)
        terminalSession = session.terminalSession
        connectionState = if (session.terminalSession.status.state == BridgeSshConnectionState.CONNECTED) "已连接" else "未连接"
        connectionMessage = null
        connectionErrorDetails = null
        // Enter the remote shell immediately. The tmux picker is opened only
        // when the user taps the tmux control.
        tmuxPickerOpen = false
    }

    /** Rebind screen-owned helpers after the app replaces a broken SSH transport. */
    private fun refreshManagedSessionBindings(session: BridgeSshAppSession) {
        if (managedSession !== session || managedBindingGeneration == session.bindingGeneration) return
        managedBindingGeneration = session.bindingGeneration
        val reopenFiles = remoteFilesOpen
        val requestedPath = remoteFilesRequestedPath ?: remoteFilesPath
        if (remotePreviewJob != null) {
            remotePreviewJob?.cancel()
            remotePreviewJob = null
            if (remotePreviewFile == null && remotePreviewText == null) remotePreviewText = "连接中断，请关闭后重新打开预览。"
        }
        transport = session.transport
        shellTransport = session.shellTransport
        tmuxClient = session.tmuxClient
        tmuxSessionCache.reset()
        val previous = selectedTmuxSession
        val restored = session.selectedTmuxSession
        val targetChanged = previous?.id != restored?.id || previous?.createdAt != restored?.createdAt
        if (targetChanged) activateComposerScope(restored) else selectedTmuxSession = restored
        if (reopenFiles && targetChanged) {
            // Do not silently reinterpret the old relative directory under a different root.
            closeRemoteFiles()
        } else if (reopenFiles) {
            remoteFiles = BridgeSshRemoteFiles(session.transport, session.selectedTmuxSession, session.tmuxClient, currentSessionTool()?.apiClient)
            remoteFilesBusy = false
            remoteFilesError = null
            refreshRemoteFiles(requestedPath)
        }
        session.recoveryNotice?.let { composerNotice = it }
    }

    /** Release only screen-owned UI state; the app session keeps running. */
    private fun detachSession() {
        managedSession?.let { session ->
            BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.SESSION_DETACHED, BridgeSshTraceField.SESSION to session.diagnosticId)
        }
        managedSession = null
        managedBindingGeneration = -1L
        terminalSession = null
        closeRemotePreview()
        remoteFiles = null
        remoteFilesOpen = false
        remoteFilesBusy = false
        remoteFilesRequestedPath = null
        terminalScrollController = null
        shellTransport = null
        transport = null
        tmuxClient = null
        tmuxSessionCache.reset()
        tmuxPickerOpen = false
        skillPickerOpen = false
        skillPickerGeneration += 1
        shortcutPanelOpen = false
        composerScope = null
        selectedTmuxSession = null
        composerUploadedPaths = mutableMapOf()
        composerDiagnostics = BridgeSshDiagnostics()
        composerAttachmentStates = emptyMap()
        composerSending = false
        composerStaging = false
    }

    private fun disconnectCurrentSession() {
        val session = managedSession
        detachSession()
        if (session != null) BridgeSshAppState.disconnect(session, BridgeSshTraceDetail.USER)
    }

    private fun closeProvisionalTransport() {
        val current = provisionalTransport ?: return
        provisionalTransport = null
        BridgeSshAppState.closeUnregistered(current)
    }

    private fun closeActivity(returnToWorkbench: Boolean = false) {
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.WORKSPACE_CLOSED,
            BridgeSshTraceField.SESSION to managedSession?.diagnosticId, BridgeSshTraceField.EMBEDDED to isEmbeddedSshHost())
        connectJob?.cancel()
        keyGenerationJob?.cancel()
        hostKeyDecision?.complete(false)
        closeProvisionalTransport()
        activityScope.cancel()
        detachSession()
        pendingReconnectTarget = null
        pendingReconnectKey = null
        password = ""
        clearSelectedKey()
        if (isEmbeddedSshHost()) {
            val view = workspaceView
            workspaceView = null
            (view?.parent as? ViewGroup)?.removeView(view)
            val insets = WindowCompat.getInsetsController(window, window.decorView)
            window.statusBarColor = previousStatusBarColor
            window.navigationBarColor = previousNavigationBarColor
            insets.isAppearanceLightStatusBars = previousLightStatusBar
            insets.isAppearanceLightNavigationBars = previousLightNavigationBar
            activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
            (bridge?.getPlugin("BridgeConnectBotSSH")?.instance as? BridgeConnectBotSSHPlugin)?.workspaceClosed(returnToWorkbench)
        } else {
            super.finish()
        }
    }

    override fun onDestroy() {
        traceActivity(BridgeSshTraceEvent.ACTIVITY_DESTROYED)
        appUpdateOverlayView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        appUpdateOverlayView = null
        connectJob?.cancel()
        keyGenerationJob?.cancel()
        privateKey?.let { BridgeSshKeySupport.clear(it) }
        privateKey = null
        passphrase = ""
        password = ""
        hostKeyDecision?.complete(false)
        closeProvisionalTransport()
        activityScope.cancel()
        detachSession()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_HOST = "bridge.ssh.host"
        const val EXTRA_PORT = "bridge.ssh.port"
        const val EXTRA_USERNAME = "bridge.ssh.username"
        const val EXTRA_PASSWORD = "bridge.ssh.password"
        const val EXTRA_STARTUP_COMMAND = "bridge.ssh.startupCommand"
        const val EXTRA_PROFILE_ID = "bridge.ssh.profileId"
        const val EXTRA_KEY_ID = "bridge.ssh.keyId"
        const val EXTRA_BRIDGE_SERVER_ORIGIN = "bridge.ssh.bridgeServerOrigin"
        const val EXTRA_DEFAULT_HOST = "bridge.ssh.defaultHost"
        const val EXTRA_MANAGE = "bridge.ssh.manage"
        private const val STATE_WORKSPACE_VISIBLE = "bridge.ssh.workspaceVisible"
        private const val STATE_BRIDGE_SERVER_ORIGIN = "bridge.ssh.bridgeServerOrigin.state"
        private const val STATE_DEFAULT_HOST = "bridge.ssh.defaultHost.state"
    }
}

private fun codexUsageSummary(response: JSONObject): String {
    val byId = response.optJSONObject("rateLimitsByLimitId")
    val snapshot = byId?.optJSONObject("codex") ?: byId?.let { values ->
        val keys = values.keys()
        while (keys.hasNext()) {
            values.optJSONObject(keys.next())?.let { return@let it }
        }
        null
    } ?: response.optJSONObject("rateLimits")
    fun remaining(window: JSONObject?): String {
        val used = window?.optDouble("usedPercent", Double.NaN) ?: Double.NaN
        if (!used.isFinite()) return "-"
        return "${(100.0 - used).coerceIn(0.0, 100.0).toInt()}%"
    }
    return "${remaining(snapshot?.optJSONObject("primary"))}·${remaining(snapshot?.optJSONObject("secondary"))}"
}

private class BridgeSshConnectionFailure(
    val phase: String,
    val category: BridgeSshTraceDetail = BridgeSshTraceDetail.UNKNOWN,
    val summary: String,
    cause: Throwable? = null,
) : Exception(summary, cause)
