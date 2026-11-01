package dev.feishu.codex.bridge

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/** adjustResize already reserves space for the IME in both SSH Activity hosts. */
@Composable
internal fun Modifier.bridgeSshWorkspaceInsets(): Modifier =
    windowInsetsPadding(WindowInsets.safeDrawing.exclude(WindowInsets.ime))
