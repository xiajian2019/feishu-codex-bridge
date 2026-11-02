package dev.feishu.codex.bridge

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.systemGestures
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A submission contains no Enter; the transport owns write and Enter timing. */
class BridgeSshCommandSubmission private constructor(
    val text: String,
    val utf8: ByteArray,
    val bracketedPasteUtf8: ByteArray,
) {
    companion object {
        fun from(text: String): BridgeSshCommandSubmission = BridgeSshCommandSubmission(
            text = text,
            utf8 = BridgeSshCommandEncoding.utf8(text),
            bracketedPasteUtf8 = BridgeSshCommandEncoding.bracketedPaste(text),
        )
    }
}

/** Encoding is independent of the SSH connection and does not send anything. */
object BridgeSshCommandEncoding {
    const val BRACKETED_PASTE_START = "\u001B[200~"
    const val BRACKETED_PASTE_END = "\u001B[201~"

    /** Default tmux prefix plus detach. This is sent as terminal input, not a shell command. */
    fun tmuxDetach(): ByteArray = byteArrayOf(0x02.toByte(), 'd'.code.toByte())

    fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)
    fun bracketedPaste(text: String): ByteArray = utf8(BRACKETED_PASTE_START + text + BRACKETED_PASTE_END)
    fun enter(): ByteArray = byteArrayOf('\r'.code.toByte())

    /** Codex's skill popup otherwise consumes the synthetic Enter. */
    fun preparePrompt(text: String): String =
        if (Regex("(?:^|\\s)\\$[^\\s$]+$").containsMatchIn(text)) "$text " else text
}

/**
 * Written means both SSH write calls returned, not that the remote program
 * received or executed the message. Unknown covers partial writes and any
 * failure where the transport cannot prove that no bytes were sent.
 */
enum class BridgeSshCommandSendResult { Written, NotSent, Unknown }

enum class BridgeSshComposerAttachmentStatus { Uploading, Ready, Failed }

/** Detect a committed single '$' edit without interrupting IME composition. */
internal fun bridgeSshSkillTrigger(before: TextFieldValue, after: TextFieldValue): TextRange? {
    if (before.composition != null || after.composition != null) return null
    val start = minOf(before.selection.start, before.selection.end).coerceIn(0, before.text.length)
    val end = maxOf(before.selection.start, before.selection.end).coerceIn(start, before.text.length)
    if (after.text != before.text.replaceRange(start, end, "$") || after.selection != TextRange(start + 1)) return null
    return TextRange(start, start + 1)
}

/** The host owns file bytes, upload, remote paths, and attachment persistence. */
data class BridgeSshComposerAttachment(
    val id: String,
    val name: String,
    val status: BridgeSshComposerAttachmentStatus,
    val detail: String? = null,
    val mimeType: String? = null,
    // Local app/content URI only; never interpret it as an SSH destination.
    val previewUri: String? = null,
)

/**
 * Text, history, and in-flight state, independent of the SSH transport.
 * All state methods and send completions must be called on the UI thread.
 * A draft callback lets the host persist under the remote host/session scope.
 */
@Stable
class BridgeSshCommandComposerState internal constructor(
    initialText: String = "",
    initialHistory: List<String> = emptyList(),
    private val maxHistoryEntries: Int = DEFAULT_MAX_HISTORY_ENTRIES,
    initialSendUncertain: Boolean = false,
    private val onDraftChanged: (String) -> Unit = {},
) {
    init {
        require(maxHistoryEntries > 0) { "maxHistoryEntries must be positive" }
    }

    var fieldValue by mutableStateOf(TextFieldValue(initialText, TextRange(initialText.length)))
        private set

    val text: String get() = fieldValue.text

    private var historyState by mutableStateOf(
        initialHistory.filter(String::isNotBlank).takeLast(maxHistoryEntries),
    )
    private var historyIndex by mutableStateOf<Int?>(null)
    private var historyDraft by mutableStateOf<String?>(null)
    private var skillTrigger: TextRange? = null
    private var revision = 0L
    private var nextSubmissionId = 0L
    private var pending: Pending? = null
    private var editorAttached = true

    var isSending by mutableStateOf(false)
        private set
    var feedback by mutableStateOf<BridgeSshCommandSendResult?>(
        if (initialSendUncertain) BridgeSshCommandSendResult.Unknown else null,
    )
        private set

    val history: List<String> get() = historyState

    fun replaceFieldValue(value: TextFieldValue) {
        if (text != value.text) {
            leaveHistoryNavigation()
            revision += 1
            if (feedback == BridgeSshCommandSendResult.Written) feedback = null
            fieldValue = value
            onDraftChanged(value.text)
        } else {
            // Preserve IME composition and selection even when text is unchanged.
            fieldValue = value
        }
    }

    fun replaceText(value: String) {
        replaceFieldValue(TextFieldValue(value, TextRange(value.length)))
    }

    fun clear() = replaceText("")

    fun insertText(value: String) {
        if (value.isEmpty()) return
        val selection = fieldValue.selection
        val start = minOf(selection.start, selection.end).coerceIn(0, text.length)
        val end = maxOf(selection.start, selection.end).coerceIn(start, text.length)
        val prefix = if (start > 0 && !text[start - 1].isWhitespace()) "\n" else ""
        val suffix = if (end < text.length && !text[end].isWhitespace()) "\n" else ""
        val next = text.substring(0, start) + prefix + value + suffix + text.substring(end)
        replaceFieldValue(TextFieldValue(next, TextRange(start + prefix.length + value.length + suffix.length)))
    }

    /** Insert a skill at the current selection without losing the surrounding draft. */
    fun insertSkill(name: String) {
        val safe = name.trim().removePrefix("$")
        if (!safe.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}"))) return
        val selection = skillTrigger?.takeIf {
            it.start >= 0 && it.end == it.start + 1 && it.end <= text.length && text.substring(it.start, it.end) == "$"
        } ?: fieldValue.selection
        skillTrigger = null
        val start = minOf(selection.start, selection.end).coerceIn(0, text.length)
        val end = maxOf(selection.start, selection.end).coerceIn(start, text.length)
        val after = text.substring(end)
        val token = "\$$safe"
        val separator = if (after.firstOrNull()?.isWhitespace() == true) "" else " "
        val next = text.substring(0, start) + token + separator + after
        replaceFieldValue(TextFieldValue(next, TextRange(start + token.length + separator.length)))
    }

    internal fun setSkillTrigger(range: TextRange?) { skillTrigger = range }

    fun acknowledgeUncertain() {
        if (feedback == BridgeSshCommandSendResult.Unknown) feedback = null
    }

    /**
     * Keep the editor intact while the transport writes. A completion may clear
     * only the exact revision it submitted; edits made during sending survive.
     * The callback is invoked exactly once per attempt by the transport, on the
     * UI thread. Duplicate or late completions are ignored.
     */
    fun submit(
        allowEmptyText: Boolean = false,
        onSend: (BridgeSshCommandSubmission, (BridgeSshCommandSendResult) -> Unit) -> Unit,
    ): Boolean {
        val value = text
        if (pending != null || (value.isBlank() && !allowEmptyText)) return false

        val attempt = Pending(++nextSubmissionId, value, revision)
        pending = attempt
        isSending = true
        feedback = null
        try {
            onSend(BridgeSshCommandSubmission.from(value)) { result -> complete(attempt.id, result) }
        } catch (_: Exception) {
            // A callback can fail after starting a write; assume it may have sent.
            complete(attempt.id, BridgeSshCommandSendResult.Unknown)
        }
        return true
    }

    private fun complete(id: Long, result: BridgeSshCommandSendResult) {
        val attempt = pending ?: return
        if (attempt.id != id) return
        pending = null
        isSending = false
        feedback = result
        if (result == BridgeSshCommandSendResult.Written) {
            if (attempt.text.isNotBlank()) {
                historyState = (historyState + attempt.text).takeLast(maxHistoryEntries)
            }
            if (editorAttached && revision == attempt.revision) {
                leaveHistoryNavigation()
                // Keep the success message visible until the next edit or send.
                fieldValue = TextFieldValue("")
                revision += 1
                onDraftChanged("")
            }
        }
    }

    fun previousHistory(): String? {
        if (historyState.isEmpty()) return null
        val nextIndex = if (historyIndex == null) {
            historyDraft = text
            historyState.lastIndex
        } else {
            (historyIndex!! - 1).coerceAtLeast(0)
        }
        historyIndex = nextIndex
        setHistoryText(historyState[nextIndex])
        return text
    }

    fun nextHistory(): String? {
        val currentIndex = historyIndex ?: return null
        if (currentIndex >= historyState.lastIndex) {
            val draft = historyDraft.orEmpty()
            leaveHistoryNavigation()
            setHistoryText(draft)
            return text
        }
        historyIndex = currentIndex + 1
        setHistoryText(historyState[historyIndex!!])
        return text
    }

    private fun setHistoryText(value: String) {
        if (text != value) {
            revision += 1
            fieldValue = TextFieldValue(value, TextRange(value.length))
            onDraftChanged(value)
        }
    }

    private fun leaveHistoryNavigation() {
        historyIndex = null
        historyDraft = null
    }

    internal fun attachEditor() { editorAttached = true }
    internal fun detachEditor() { editorAttached = false }

    private data class Pending(val id: Long, val text: String, val revision: Long)

    companion object {
        const val DEFAULT_MAX_HISTORY_ENTRIES = 50
    }
}

/** Pass a distinct draftKey for each SSH host/session and restore its draft before creating state. */
@Composable
fun rememberBridgeSshCommandComposerState(
    initialText: String = "",
    initialHistory: List<String> = emptyList(),
    maxHistoryEntries: Int = BridgeSshCommandComposerState.DEFAULT_MAX_HISTORY_ENTRIES,
    draftKey: Any? = null,
    initialSendUncertain: Boolean = false,
    onDraftChanged: (String) -> Unit = {},
): BridgeSshCommandComposerState {
    // Capture the callback for this key rather than the latest callback from a
    // new host/session. A late write completion must update its original draft.
    return remember(draftKey, maxHistoryEntries) {
        BridgeSshCommandComposerState(initialText, initialHistory, maxHistoryEntries, initialSendUncertain, onDraftChanged)
    }
}

/** Compact shortcut that can also be used by the host-provided shortcut row. */
@Composable
fun BridgeSshComposerShortcut(
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    description: String = label,
    active: Boolean = false,
    icon: String? = null,
) {
    Box(
        modifier = Modifier.sizeIn(minWidth = 34.dp, maxWidth = 38.dp, minHeight = 36.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = description }
            .padding(horizontal = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        val color = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .38f)
        if (icon in setOf("scroll-top", "scroll-bottom", "session-files", "scroll-export", "keyboard-panel")) {
            Canvas(Modifier.size(20.dp)) {
                val scale = size.width / 24f
                fun point(x: Float, y: Float) = Offset(x * scale, y * scale)
                fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(color, point(x1, y1), point(x2, y2), 1.8f * scale, cap = StrokeCap.Round)
                when (icon) {
                    "scroll-top" -> { line(5f, 5f, 19f, 5f); line(12f, 19f, 12f, 8f); line(12f, 8f, 7f, 13f); line(12f, 8f, 17f, 13f) }
                    "scroll-bottom" -> { line(5f, 19f, 19f, 19f); line(12f, 5f, 12f, 16f); line(12f, 16f, 7f, 11f); line(12f, 16f, 17f, 11f) }
                    "session-files" -> {
                        val path = Path().apply { moveTo(3f * scale, 7f * scale); lineTo(9f * scale, 7f * scale); lineTo(11f * scale, 9f * scale); lineTo(21f * scale, 9f * scale); lineTo(21f * scale, 18f * scale); lineTo(3f * scale, 18f * scale); close() }
                        drawPath(path, color, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.8f * scale))
                    }
                    "scroll-export" -> { line(12f, 4f, 12f, 14f); line(12f, 14f, 8f, 10f); line(12f, 14f, 16f, 10f); line(5f, 16f, 5f, 20f); line(5f, 20f, 19f, 20f); line(19f, 20f, 19f, 16f) }
                    "keyboard-panel" -> {
                        drawRoundRect(color, topLeft = point(3f, 6f), size = androidx.compose.ui.geometry.Size(18f * scale, 12f * scale),
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f * scale), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.6f * scale))
                        for (y in listOf(9f, 12f)) for (x in listOf(6f, 9f, 12f, 15f, 18f)) drawCircle(color, radius = .75f * scale, center = point(x, y))
                        line(8f, 15f, 16f, 15f)
                    }
                }
            }
        } else Text(label, fontSize = if (label.any { it.code > 0x2fff } && label.length > 1) 12.sp else if (label.length <= 2) 17.sp else 12.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis, color = color)
    }
}

/** Loads a small local thumbnail off the UI thread; unsupported files use a type label. */
@Composable
private fun BridgeSshAttachmentPreview(attachment: BridgeSshComposerAttachment) {
    val context = LocalContext.current
    val isImage = attachment.mimeType?.startsWith("image/", ignoreCase = true) == true
    var thumbnail by remember(attachment.previewUri, isImage) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(attachment.previewUri, isImage) {
        val uri = attachment.previewUri?.let(Uri::parse)
        thumbnail = if (isImage && uri != null && uri.scheme in setOf("content", "file", "android.resource")) {
            withContext(Dispatchers.IO) {
                try {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
                    var sample = 1
                    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 256) sample *= 2
                    val options = BitmapFactory.Options().apply { inSampleSize = sample }
                    context.contentResolver.openInputStream(uri)?.use {
                        BitmapFactory.decodeStream(it, null, options)?.asImageBitmap()
                    }
                } catch (_: Exception) {
                    null
                }
            }
        } else null
    }
    val previewSize = if (isImage) 64.dp else 40.dp
    Box(
        modifier = Modifier.size(previewSize).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center,
    ) {
        val bitmap = thumbnail
        if (bitmap != null) {
            Image(bitmap, contentDescription = null, modifier = Modifier.size(previewSize), contentScale = ContentScale.Crop)
        } else {
            Text(if (isImage) "图片" else "文件", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Images stay compact like Web Composer; only failures need explanatory text. */
@Composable
private fun BridgeSshComposerAttachments(
    attachments: List<BridgeSshComposerAttachment>,
    canRemove: Boolean,
    onRemove: ((String) -> Unit)?,
    onPreview: ((String) -> Unit)?,
    attachmentPreview: @Composable (BridgeSshComposerAttachment) -> Unit,
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth()
                .windowInsetsPadding(WindowInsets.systemGestures.only(WindowInsetsSides.Horizontal))
                .padding(start = 4.dp, end = 4.dp, top = 2.dp, bottom = 4.dp)
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            attachments.forEach { attachment ->
                val isImage = attachment.mimeType?.startsWith("image/", ignoreCase = true) == true
                if (isImage) {
                    Box(
                        Modifier.size(64.dp).clip(RoundedCornerShape(8.dp))
                            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(8.dp))
                            .clickable(enabled = onPreview != null) { onPreview?.invoke(attachment.id) }
                            .semantics { contentDescription = "预览 ${attachment.name}" },
                    ) {
                        attachmentPreview(attachment)
                        if (onRemove != null) {
                            // Keep the two targets separate: do not expand the delete
                            // hit area over the centre of the image preview.
                            Box(
                                Modifier.align(Alignment.TopEnd).size(32.dp)
                                    .pointerInput(attachment.id, canRemove, onRemove) {
                                        detectTapGestures { if (canRemove) onRemove(attachment.id) }
                                    }
                                    .semantics {
                                        contentDescription = "移除 ${attachment.name}"
                                        role = Role.Button
                                        if (canRemove) onClick { onRemove(attachment.id); true } else disabled()
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Box(
                                    Modifier.size(22.dp).background(MaterialTheme.colorScheme.surface.copy(alpha = .92f), RoundedCornerShape(50)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text("×", fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurface)
                                }
                            }
                        }
                    }
                } else {
                    Row(
                        modifier = Modifier.background(MaterialTheme.colorScheme.surface, RoundedCornerShape(10.dp))
                            .padding(start = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.clickable(enabled = onPreview != null) { onPreview?.invoke(attachment.id) }) {
                            attachmentPreview(attachment)
                        }
                        Column(modifier = Modifier.widthIn(max = 180.dp).padding(start = 6.dp, top = 4.dp, bottom = 4.dp)) {
                            Text(attachment.name, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val status = when (attachment.status) {
                                BridgeSshComposerAttachmentStatus.Uploading -> "上传中"
                                BridgeSshComposerAttachmentStatus.Ready -> "待发送"
                                BridgeSshComposerAttachmentStatus.Failed -> "上传失败，可重试"
                            }
                            Text(attachment.detail ?: status, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
                        }
                        if (onRemove != null) {
                            IconButton(onClick = { onRemove(attachment.id) }, enabled = canRemove,
                                modifier = Modifier.size(40.dp).semantics { contentDescription = "移除 ${attachment.name}" }) {
                                Text("×", fontSize = 20.sp)
                            }
                        }
                    }
                }
            }
        }
        attachments.firstOrNull {
            it.mimeType?.startsWith("image/", ignoreCase = true) == true &&
                it.status == BridgeSshComposerAttachmentStatus.Failed
        }?.let { failed ->
            Text("图片不可用：${failed.detail ?: "上传失败，可重试"}",
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                color = MaterialTheme.colorScheme.error, fontSize = 11.sp)
        }
    }
}

/**
 * Uses Compose's native IME-backed field. The caller owns transport, files,
 * shortcuts, and remote session identity; this UI never assumes Bridge paths
 * are meaningful on the connected SSH host.
 */
@Composable
fun BridgeSshCommandComposer(
    state: BridgeSshCommandComposerState,
    onSend: (BridgeSshCommandSubmission, (BridgeSshCommandSendResult) -> Unit) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    connectionAvailable: Boolean = enabled,
    draftReadOnly: Boolean = false,
    placeholder: String = "输入命令或消息…",
    attachments: List<BridgeSshComposerAttachment> = emptyList(),
    onAddAttachment: (() -> Unit)? = null,
    onRemoveAttachment: ((String) -> Unit)? = null,
    onPreviewAttachment: ((String) -> Unit)? = null,
    onSkillTrigger: (() -> Unit)? = null,
    onHardwareShortcut: (String) -> Boolean = { false },
    stabilizeInputWhileFocused: Boolean = false,
    onInputFocusChanged: (Boolean) -> Unit = {},
    attachmentPreview: @Composable (BridgeSshComposerAttachment) -> Unit = { BridgeSshAttachmentPreview(it) },
    connectionStatusMessage: String? = null,
    shortcuts: @Composable RowScope.() -> Unit = {},
) {
    DisposableEffect(state) {
        state.attachEditor()
        onDispose { state.detachEditor() }
    }
    val shape = RoundedCornerShape(18.dp)
    // Failed uploads can be retried explicitly; an active upload cannot.
    val attachmentsAvailable = attachments.none { it.status == BridgeSshComposerAttachmentStatus.Uploading }
    val canSend = enabled && !draftReadOnly && !state.isSending && attachmentsAvailable &&
        (state.text.isNotBlank() || attachments.isNotEmpty())
    var historyMenuOpen by remember(state) { mutableStateOf(false) }
    var inputFocused by remember(state) { mutableStateOf(false) }
    Column(modifier = modifier) {
        Column(
            modifier = Modifier.fillMaxWidth()
                .border(1.dp, MaterialTheme.colorScheme.outline, shape)
                .background(MaterialTheme.colorScheme.background, shape)
                .padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        ) {
            if (attachments.isNotEmpty()) {
                BridgeSshComposerAttachments(
                    attachments = attachments,
                    canRemove = !draftReadOnly && !state.isSending,
                    onRemove = onRemoveAttachment,
                    onPreview = onPreviewAttachment,
                    attachmentPreview = attachmentPreview,
                )
            }
            BasicTextField(
                value = state.fieldValue,
                onValueChange = { value ->
                    val trigger = if (!draftReadOnly && onSkillTrigger != null) bridgeSshSkillTrigger(state.fieldValue, value) else null
                    state.replaceFieldValue(value)
                    if (trigger != null) { state.setSkillTrigger(trigger); onSkillTrigger?.invoke() }
                },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 5.dp)
                    .onFocusChanged {
                        inputFocused = it.isFocused
                        onInputFocusChanged(it.isFocused)
                    }
                    .semantics { contentDescription = "SSH 消息输入" }
                    .onPreviewKeyEvent { event ->
                        val key = event.nativeKeyEvent
                        if (!enabled || state.isSending || state.fieldValue.composition != null ||
                            key.action != android.view.KeyEvent.ACTION_DOWN || key.isAltPressed || key.isMetaPressed || key.isShiftPressed) {
                            false
                        } else {
                            val shortcut = if (key.isCtrlPressed) when (key.keyCode) {
                                android.view.KeyEvent.KEYCODE_C -> "codex-interrupt"
                                android.view.KeyEvent.KEYCODE_L -> if (state.text.isEmpty()) "ctrl-l" else null
                                android.view.KeyEvent.KEYCODE_R -> if (state.text.isEmpty()) "ctrl-r" else null
                                else -> null
                            } else if (state.text.isEmpty()) when (key.keyCode) {
                                android.view.KeyEvent.KEYCODE_ESCAPE -> "codex-escape"
                                android.view.KeyEvent.KEYCODE_DPAD_UP -> "codex-up"
                                android.view.KeyEvent.KEYCODE_DPAD_DOWN -> "codex-down"
                                android.view.KeyEvent.KEYCODE_ENTER -> "codex-enter"
                                else -> null
                            } else null
                            if (shortcut == null) false else onHardwareShortcut(shortcut)
                        }
                    },
                readOnly = draftReadOnly,
                textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                // Keep the PTY viewport stable while editing, including on
                // small phones with the IME open. Longer drafts scroll here.
                minLines = 3,
                maxLines = if (stabilizeInputWhileFocused && inputFocused) 3 else 6,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                decorationBox = { innerTextField ->
                    Box(modifier = Modifier.defaultMinSize(minHeight = 62.dp)) {
                        if (state.text.isEmpty()) {
                            Text(placeholder, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 16.sp)
                        }
                        innerTextField()
                    }
                },
            )
            Row(
                modifier = Modifier.fillMaxWidth()
                    // Keep the horizontal shortcut scroller away from Android's
                    // edge-swipe navigation region.
                    .windowInsetsPadding(WindowInsets.systemGestures)
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    modifier = Modifier.weight(1f).horizontalScroll(rememberScrollState())
                        .semantics { contentDescription = "SSH 快捷键，可左右滑动" },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (onAddAttachment != null) {
                        BridgeSshComposerShortcut("＋", onAddAttachment, enabled && !draftReadOnly && !state.isSending, "添加附件")
                    }
                    shortcuts()
                    Box {
                        BridgeSshComposerShortcut("⋮", { historyMenuOpen = true }, !draftReadOnly, "输入操作")
                        DropdownMenu(expanded = historyMenuOpen, onDismissRequest = { historyMenuOpen = false }) {
                            DropdownMenuItem(text = { Text("上一条输入") }, enabled = !draftReadOnly && state.history.isNotEmpty(),
                                onClick = { historyMenuOpen = false; state.previousHistory() })
                            DropdownMenuItem(text = { Text("下一条输入") }, enabled = !draftReadOnly && state.history.isNotEmpty(),
                                onClick = { historyMenuOpen = false; state.nextHistory() })
                            DropdownMenuItem(text = { Text("清空输入") }, enabled = !draftReadOnly && state.text.isNotEmpty(),
                                onClick = { historyMenuOpen = false; state.clear() })
                        }
                    }
                }
                Spacer(Modifier.width(6.dp))
                Box(
                    modifier = Modifier.size(42.dp).clip(RoundedCornerShape(50)).background(
                        if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
                        RoundedCornerShape(50),
                    ).clickable(enabled = canSend) { state.submit(allowEmptyText = attachments.isNotEmpty(), onSend = onSend) }
                        .semantics { contentDescription = if (state.isSending) "发送中" else "发送" },
                    contentAlignment = Alignment.Center,
                ) {
                    if (state.isSending) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        Text("↑", color = if (canSend) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 24.sp)
                    }
                }
            }
        }
        val feedbackText = if (draftReadOnly) "草稿数据损坏，原始数据已保留；当前输入不可编辑" else when (state.feedback) {
            BridgeSshCommandSendResult.Written -> if (connectionAvailable) "已写入 SSH，执行情况请查看终端"
                else connectionStatusMessage ?: "SSH 未连接，草稿已保留"
            BridgeSshCommandSendResult.NotSent -> "未发送，草稿已保留"
            BridgeSshCommandSendResult.Unknown -> "发送结果未知，草稿已保留；重试前请先查看终端"
            null -> if (!connectionAvailable) connectionStatusMessage ?: "SSH 未连接，草稿已保留" else null
        }
        if (feedbackText != null) {
            Text(
                feedbackText,
                modifier = Modifier.padding(start = 8.dp, top = 3.dp),
                color = if (draftReadOnly || state.feedback == BridgeSshCommandSendResult.Unknown || state.feedback == BridgeSshCommandSendResult.NotSent)
                    MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
            )
        }
    }
}
