package dev.feishu.codex.bridge

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

internal data class BridgeAppUpdateBannerState(
    val detail: String,
    val status: String,
    val error: String,
    val busy: Boolean,
    val downloaded: Boolean,
)

/** Uses the same update and download operations as the Web connection center. */
@Composable
internal fun BridgeAppUpdateBanner(state: BridgeAppUpdateBannerState, onAction: (String) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Text("发现新的 Bridge App", style = MaterialTheme.typography.titleSmall)
            Text(state.detail, style = MaterialTheme.typography.bodySmall)
            if (state.status.isNotBlank()) Text(state.status, style = MaterialTheme.typography.bodySmall)
            if (state.error.isNotBlank()) Text(state.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { onAction("dismiss") }, enabled = !state.busy) { Text("稍后") }
                TextButton(onClick = { onAction("download") }, enabled = !state.busy) { Text("下载 APK") }
                Button(onClick = { onAction("install") }, enabled = !state.busy) {
                    Text(if (state.busy) "处理中…" else if (state.downloaded) "继续安装" else "更新")
                }
            }
        }
    }
}
