package dev.feishu.codex.bridge

import android.content.Context
import android.content.res.Configuration

/** Shared native theme preference for every Android Activity in the Bridge app. */
internal object BridgeNativeTheme {
    const val LIGHT = "light"
    const val DARK = "dark"

    private const val PREFERENCES = "bridge_native_settings"
    private const val KEY_RESOLVED_THEME = "resolved_theme"

    fun read(context: Context): String {
        val saved = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(KEY_RESOLVED_THEME, null)
        return normalize(saved) ?: systemTheme(context)
    }

    fun write(context: Context, theme: String) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RESOLVED_THEME, normalize(theme) ?: systemTheme(context))
            .apply()
    }

    private fun normalize(theme: String?): String? = when (theme?.lowercase()) {
        DARK -> DARK
        LIGHT -> LIGHT
        else -> null
    }

    private fun systemTheme(context: Context): String =
        if ((context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES
        ) DARK else LIGHT
}
