package dev.feishu.codex.bridge

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * The native SSH Activity is outside the WebView, so it cannot see the Web
 * CSS variables. Keep its palette aligned with web/src/styles.css instead of
 * falling back to Material 3's purple default scheme.
 */
@Composable
internal fun BridgeSshTheme(
    theme: String,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = bridgeSshColorScheme(theme),
        content = content,
    )
}

internal fun bridgeSshColorScheme(theme: String): ColorScheme =
    if (theme.equals("dark", ignoreCase = true)) {
        darkColorScheme(
            primary = Color(0xFF89D2A8),
            onPrimary = Color(0xFF102018),
            primaryContainer = Color(0xFF1A2824),
            onPrimaryContainer = Color(0xFFC5F3D8),
            secondary = Color(0xFFB8E5C9),
            onSecondary = Color(0xFF173023),
            secondaryContainer = Color(0xFF24533F),
            onSecondaryContainer = Color(0xFFD7EEE3),
            background = Color(0xFF10141A),
            onBackground = Color(0xFFD8DEE9),
            surface = Color(0xFF141A22),
            onSurface = Color(0xFFD8DEE9),
            surfaceVariant = Color(0xFF202832),
            onSurfaceVariant = Color(0xFFA8B3C0),
            outline = Color(0xFF303B48),
            error = Color(0xFFF08C91),
            onError = Color(0xFF3A2026),
            errorContainer = Color(0xFF3A2026),
            onErrorContainer = Color(0xFFF0C9C9),
        )
    } else {
        lightColorScheme(
            primary = Color(0xFF166534),
            onPrimary = Color.White,
            primaryContainer = Color(0xFFDCFCE7),
            onPrimaryContainer = Color(0xFF14532D),
            secondary = Color(0xFF4B6352),
            onSecondary = Color.White,
            secondaryContainer = Color(0xFFD7E8DA),
            onSecondaryContainer = Color(0xFF102016),
            background = Color(0xFFF6F8F5),
            onBackground = Color(0xFF17211B),
            surface = Color.White,
            onSurface = Color(0xFF17211B),
            surfaceVariant = Color(0xFFE7EEE9),
            onSurfaceVariant = Color(0xFF68726C),
            outline = Color(0xFFCAD4CC),
            error = Color(0xFF9F1239),
            onError = Color.White,
            errorContainer = Color(0xFFFFE4E6),
            onErrorContainer = Color(0xFF881337),
        )
    }
