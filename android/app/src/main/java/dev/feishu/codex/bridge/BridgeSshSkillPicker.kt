package dev.feishu.codex.bridge

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONArray

internal data class BridgeSshSkill(val name: String, val description: String)

internal fun parseBridgeSshSkills(items: JSONArray): List<BridgeSshSkill> =
    (0 until items.length()).mapNotNull { index ->
        val item = items.optJSONObject(index) ?: return@mapNotNull null
        val name = item.optString("skillName").trim()
        if (!name.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}"))) return@mapNotNull null
        BridgeSshSkill(name, item.optString("descriptionZh", "").ifBlank { item.optString("descriptionEn", "") })
    }.distinctBy { it.name.lowercase() }

@Composable
internal fun BridgeSshSkillPicker(
    skills: List<BridgeSshSkill>,
    message: String?,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val manual = query.trim().removePrefix("$")
    val filtered = skills.filter {
        it.name.contains(manual, ignoreCase = true) || it.description.contains(manual, ignoreCase = true)
    }
    val canInsertManual = manual.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")) &&
        skills.none { it.name.equals(manual, ignoreCase = true) }
    val shape = RoundedCornerShape(16.dp)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).widthIn(max = 520.dp)
                .clip(shape).background(MaterialTheme.colorScheme.surface, shape)
                .border(1.dp, MaterialTheme.colorScheme.outline, shape).padding(7.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
                    .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(10.dp))
                    .padding(start = 10.dp, end = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.weight(1f).semantics { contentDescription = "搜索技能" },
                    singleLine = true,
                    textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    decorationBox = { inner ->
                        Box {
                            if (query.isEmpty()) Text("搜索技能", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 16.sp)
                            inner()
                        }
                    },
                )
                Box(
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(10.dp))
                        .clickable(onClick = onDismiss).semantics { contentDescription = "关闭技能选择" },
                    contentAlignment = Alignment.Center,
                ) { Text("×", fontSize = 20.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            message?.let {
                Text(it, modifier = Modifier.padding(horizontal = 5.dp, vertical = 4.dp), maxLines = 1,
                    overflow = TextOverflow.Ellipsis, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = 300.dp).padding(top = 4.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                items(filtered, key = { it.name }) { skill ->
                    Column(
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant).clickable { onSelect(skill.name) }
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                    ) {
                        Text(skill.name, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface)
                        if (skill.description.isNotBlank()) Text(
                            skill.description, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (canInsertManual) item(key = "manual-skill") {
                    Text(
                        "插入 \$$manual", modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant).clickable { onSelect(manual) }.padding(10.dp),
                        fontSize = 14.sp, color = MaterialTheme.colorScheme.primary,
                    )
                }
                if (filtered.isEmpty() && !canInsertManual) item(key = "empty-skills") {
                    Text("没有匹配的技能", modifier = Modifier.padding(10.dp),
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
