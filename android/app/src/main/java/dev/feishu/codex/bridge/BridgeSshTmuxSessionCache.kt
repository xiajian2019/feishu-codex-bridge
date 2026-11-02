package dev.feishu.codex.bridge

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException

internal sealed interface BridgeSshTmuxLoadResult {
    data object Loaded : BridgeSshTmuxLoadResult
    data object Skipped : BridgeSshTmuxLoadResult
    data class Failed(val error: Exception) : BridgeSshTmuxLoadResult
}

/** Screen-owned cache; resetting it also invalidates requests from an old SSH connection. */
internal class BridgeSshTmuxSessionCache {
    var sessions by mutableStateOf<List<BridgeSshTmuxSession>?>(null)
        private set
    var refreshing by mutableStateOf(false)
        private set
    private var generation = 0L

    suspend fun load(force: Boolean, fetch: suspend () -> List<BridgeSshTmuxSession>): BridgeSshTmuxLoadResult {
        if (refreshing || (!force && sessions != null)) return BridgeSshTmuxLoadResult.Skipped
        val requestGeneration = ++generation
        refreshing = true
        return try {
            val result = fetch()
            if (generation != requestGeneration) BridgeSshTmuxLoadResult.Skipped
            else {
                sessions = result
                BridgeSshTmuxLoadResult.Loaded
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (generation == requestGeneration) BridgeSshTmuxLoadResult.Failed(error)
            else BridgeSshTmuxLoadResult.Skipped
        } finally {
            if (generation == requestGeneration) refreshing = false
        }
    }

    fun reset() {
        generation += 1
        sessions = null
        refreshing = false
    }
}
