package dev.feishu.codex.bridge

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

@Composable
internal fun BridgeSshRemotePreview(file: File?, pdf: Boolean, text: String?) {
    var page by remember(file) { mutableIntStateOf(0) }
    var pageCount by remember(file) { mutableIntStateOf(0) }
    var image by remember(file, page) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(file, page) { mutableStateOf(false) }
    LaunchedEffect(file, page) {
        if (file == null) return@LaunchedEffect
        val result = withContext(Dispatchers.IO) {
            runCatching {
                if (pdf) {
                    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                        PdfRenderer(descriptor).use { renderer ->
                            val count = renderer.pageCount
                            require(count > 0)
                            renderer.openPage(page.coerceIn(0, count - 1)).use { current ->
                                val scale = minOf(2f, 1600f / maxOf(current.width, current.height))
                                val bitmap = Bitmap.createBitmap(maxOf(1, (current.width * scale).toInt()),
                                    maxOf(1, (current.height * scale).toInt()), Bitmap.Config.ARGB_8888)
                                bitmap.eraseColor(Color.WHITE)
                                current.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                bitmap.asImageBitmap() to count
                            }
                        }
                    }
                } else {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.path, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0)
                    var sample = 1
                    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
                    checkNotNull(BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })).asImageBitmap() to 0
                }
            }.getOrNull()
        }
        image = result?.first
        pageCount = result?.second ?: 0
        failed = result == null
    }
    Column {
        val bitmap = image
        if (file == null) {
            Text(text ?: "正在读取…", Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                fontFamily = FontFamily.Monospace, fontSize = 13.sp)
        } else if (bitmap != null) {
            Image(bitmap, contentDescription = if (pdf) "PDF 第 ${page + 1} 页" else "图片预览",
                modifier = Modifier.fillMaxWidth().heightIn(max = 390.dp), contentScale = ContentScale.Fit)
        } else Text(if (failed) "无法预览，请下载后打开。" else "正在读取…")
        if (pdf && pageCount > 1) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            TextButton(onClick = { page -= 1 }, enabled = page > 0) { Text("上一页") }
            TextButton(onClick = {}, enabled = false) { Text("${page + 1} / $pageCount") }
            TextButton(onClick = { page += 1 }, enabled = page + 1 < pageCount) { Text("下一页") }
        }
    }
}
