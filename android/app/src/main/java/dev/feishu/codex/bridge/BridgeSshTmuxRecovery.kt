package dev.feishu.codex.bridge

import org.connectbot.sshlib.SessionExit

/** Resolve a persisted target by both id and creation time; ids can be reused. */
internal suspend fun BridgeSshTmuxClient.findResumeTarget(identity: BridgeSshTmuxIdentity): BridgeSshTmuxSession? {
    val result = execute(BridgeSshTmuxCommandBuilder.listSessions())
    when (val exit = result.exitInfo) {
        is SessionExit.Status -> {
            if (exit.code == 0L) return BridgeSshTmuxClient.parseSessions(result.stdout).firstOrNull(identity::matches)
            val stderr = result.stderr.toString(Charsets.UTF_8)
            val noServer = exit.code == 1L && stderr.lineSequence().any { line ->
                val text = line.trim().lowercase()
                text.startsWith("no server running") || text == "no sessions" ||
                    (text.startsWith("error connecting to ") && text.contains("no such file or directory"))
            }
            if (noServer) return null
            error(stderr.ifBlank { "tmux list-sessions exited with code ${exit.code}" })
        }
        is SessionExit.Signal -> error("tmux list-sessions terminated by ${exit.signalName}")
    }
}

/** Attach only the tmux session itself; never replay the user's composer or terminal input. */
internal suspend fun BridgeSshAppTerminalTransport.attachResumeTarget(target: BridgeSshTmuxSession): BridgeSshCommandSendResult {
    val bytes = BridgeSshCommandEncoding.bracketedPaste(BridgeSshTmuxCommandBuilder.attachInCurrentShellCommand(target.id))
    return try { writeComposerPaste(bytes) } finally { bytes.fill(0) }
}
