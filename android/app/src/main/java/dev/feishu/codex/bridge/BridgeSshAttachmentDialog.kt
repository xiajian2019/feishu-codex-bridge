package dev.feishu.codex.bridge

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun BridgeSshAttachmentDialog(attachment: BridgeSshComposerAttachment, onDismiss: () -> Unit) {
    if (attachment.mimeType?.startsWith("image/", ignoreCase = true) != true) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(attachment.name) },
            text = { Text("文件已加入草稿。") },
            confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
        )
        return
    }
    val context = LocalContext.current
    var image by remember(attachment.id, attachment.previewUri) { mutableStateOf<ImageBitmap?>(null) }
    var loading by remember(attachment.id, attachment.previewUri) { mutableStateOf(true) }
    LaunchedEffect(attachment.id, attachment.previewUri) {
        image = withContext(Dispatchers.IO) {
            val uri = attachment.previewUri?.let(Uri::parse) ?: return@withContext null
            if (uri.scheme !in setOf("content", "file", "android.resource")) return@withContext null
            runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                require(bounds.outWidth > 0 && bounds.outHeight > 0)
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
                context.contentResolver.openInputStream(uri)?.use {
                    BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
                }
            }.getOrNull()
        }
        loading = false
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .78f)).clickable(onClick = onDismiss)) {
            BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding().padding(start = 12.dp, end = 12.dp, top = 60.dp, bottom = 12.dp),
                contentAlignment = Alignment.Center) {
                val bitmap = image
                if (bitmap != null && maxWidth.value > 0 && maxHeight.value > 0) {
                    val ratio = bitmap.width.toFloat() / bitmap.height
                    val wide = ratio >= maxWidth.value / maxHeight.value
                    val imageWidth = if (wide) maxWidth else maxHeight * ratio
                    val imageHeight = if (wide) maxWidth / ratio else maxHeight
                    Image(bitmap, contentDescription = "图片预览：${attachment.name}",
                        modifier = Modifier.size(imageWidth, imageHeight).clickable { }, contentScale = ContentScale.Fit)
                } else {
                    Text(if (loading) "正在载入图片…" else "图片无法加载", color = Color.White)
                }
            }
            Box(Modifier.align(Alignment.TopEnd).safeDrawingPadding().padding(14.dp).size(42.dp)
                .clip(CircleShape).background(Color(0xE8202124)).clickable(onClick = onDismiss)
                .semantics { contentDescription = "关闭图片预览" }, contentAlignment = Alignment.Center) {
                Text("×", color = Color.White, fontSize = 27.sp)
            }
        }
    }
}
