package dev.feishu.codex.bridge

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun BridgeSshCompactSearch(value: String, onValueChange: (String) -> Unit, hint: String, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth().border(1.dp, colors.outline, MaterialTheme.shapes.small).padding(horizontal = 10.dp),
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface, fontSize = 16.sp),
        cursorBrush = SolidColor(colors.primary),
        decorationBox = { innerTextField ->
            Row(Modifier.heightIn(min = 42.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("⌕", color = colors.onSurfaceVariant, fontSize = 20.sp, modifier = Modifier.padding(end = 8.dp))
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(hint, color = colors.onSurfaceVariant, fontSize = 16.sp, maxLines = 1)
                    innerTextField()
                }
            }
        },
    )
}
