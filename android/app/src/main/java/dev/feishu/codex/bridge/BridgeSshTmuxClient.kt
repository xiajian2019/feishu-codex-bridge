package dev.feishu.codex.bridge

import org.connectbot.sshlib.SessionExit

/**
 * The small, typed subset of tmux commands used by the native session list.
 *
 * Commands are rendered only at the SSH exec boundary.  Values are validated
 * before they are quoted as one shell word, so a session name cannot turn a
 * tmux operation into an additional shell command.
 */
sealed interface BridgeSshTmuxCommand {
    val command: String

    fun render(): String = command
}

/** The fields returned by tmux's machine-readable session listing. */
data class BridgeSshTmuxSession(
    val id: String,
    val name: String,
    val windows: Int,
    val attached: Boolean,
    val cwd: String,
    val createdAt: Long,
)

/**
 * A validated tmux target/name.  The value is still quoted when rendered;
 * validation is an additional guard against accidentally accepting shell
 * syntax as an identifier.
 */
@JvmInline
value class BridgeSshTmuxIdentifier(val value: String) {
    init {
        BridgeSshTmuxCommandBuilder.requireIdentifier(value)
    }
}

/**
 * Command builders.  Returning a command object keeps callers from assembling
 * arbitrary tmux command strings while leaving room for more commands later.
 */
object BridgeSshTmuxCommandBuilder {
    /** Printable, shell-safe delimiter; it avoids tmux format escaping. */
    const val SESSION_FIELD_DELIMITER = "__FEISHU_CODEX_BRIDGE_TMUX_FIELD__"

    /** Keep this format in sync with [BridgeSshTmuxClient.parseSessions]. */
    const val SESSION_FORMAT =
        "#{session_id}${SESSION_FIELD_DELIMITER}#{session_name}${SESSION_FIELD_DELIMITER}" +
            "#{session_windows}${SESSION_FIELD_DELIMITER}#{session_attached}${SESSION_FIELD_DELIMITER}" +
            "#{pane_current_path}${SESSION_FIELD_DELIMITER}#{session_created}"

    const val DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

    object ListSessions : BridgeSshTmuxCommand {
        override val command: String = loginShell("tmux list-sessions -F ${shellQuote(SESSION_FORMAT)}")
    }

    data class Attach(
        val target: BridgeSshTmuxIdentifier,
    ) : BridgeSshTmuxCommand {
        override val command: String = loginShell(
            "tmux attach-session -t ${shellQuote(target.value)}",
        )
    }

    data class Create(
        val name: BridgeSshTmuxIdentifier,
        val cwd: String?,
    ) : BridgeSshTmuxCommand {
        override val command: String = loginShell(buildString {
            append("tmux new-session -d -s ")
            append(shellQuote(name.value))
            if (cwd != null) {
                append(" -c ")
                append(shellQuote(cwd))
            }
        })
    }

    data class Rename(
        val target: BridgeSshTmuxIdentifier,
        val name: BridgeSshTmuxIdentifier,
    ) : BridgeSshTmuxCommand {
        override val command: String = loginShell(
            "tmux rename-session -t ${shellQuote(target.value)} ${shellQuote(name.value)}",
        )
    }

    data class Kill(
        val target: BridgeSshTmuxIdentifier,
    ) : BridgeSshTmuxCommand {
        override val command: String = loginShell(
            "tmux kill-session -t ${shellQuote(target.value)}",
        )
    }

    /** Read only the selected session's Codex home, without exposing the whole environment. */
    data class CodexHome(val target: BridgeSshTmuxIdentifier) : BridgeSshTmuxCommand {
        override val command: String = loginShell(
            "tmux show-environment -t ${shellQuote(target.value)} CODEX_HOME",
        )
    }

    /** Read the active pane and its retained history without entering copy mode. */
    data class CaptureHistory(val target: BridgeSshTmuxIdentifier) : BridgeSshTmuxCommand {
        override val command: String = loginShell(
            "tmux capture-pane -p -e -t ${shellQuote(target.value)} -S -1000",
        )
    }

    fun listSessions(): BridgeSshTmuxCommand = ListSessions

    fun captureHistory(target: String): BridgeSshTmuxCommand = CaptureHistory(BridgeSshTmuxIdentifier(target))

    fun attach(target: BridgeSshTmuxIdentifier): BridgeSshTmuxCommand = Attach(target)

    fun attach(target: String): BridgeSshTmuxCommand = attach(BridgeSshTmuxIdentifier(target))

    fun create(name: BridgeSshTmuxIdentifier, cwd: String? = null): BridgeSshTmuxCommand =
        Create(name, cwd?.also(::requirePath))

    fun create(name: String, cwd: String? = null): BridgeSshTmuxCommand =
        create(BridgeSshTmuxIdentifier(name), cwd)

    fun rename(
        target: BridgeSshTmuxIdentifier,
        name: BridgeSshTmuxIdentifier,
    ): BridgeSshTmuxCommand = Rename(target, name)

    fun rename(target: String, name: String): BridgeSshTmuxCommand =
        rename(BridgeSshTmuxIdentifier(target), BridgeSshTmuxIdentifier(name))

    fun kill(target: BridgeSshTmuxIdentifier): BridgeSshTmuxCommand = Kill(target)

    fun kill(target: String): BridgeSshTmuxCommand = kill(BridgeSshTmuxIdentifier(target))

    fun codexHome(target: String): BridgeSshTmuxCommand = CodexHome(BridgeSshTmuxIdentifier(target))

    /** String convenience methods for code that only needs to hand off SSH text. */
    fun listSessionsCommand(): String = listSessions().command

    fun attachCommand(target: String): String = attach(target).command

    /** Attach from an already-open interactive shell; do not start another zsh. */
    fun attachInCurrentShellCommand(target: String): String {
        val identifier = BridgeSshTmuxIdentifier(target)
        return "tmux attach-session -t ${shellQuote(identifier.value)}"
    }

    fun createCommand(name: String, cwd: String? = null): String = create(name, cwd).command

    fun renameCommand(target: String, name: String): String = rename(target, name).command

    fun killCommand(target: String): String = kill(target).command

    internal fun requireIdentifier(value: String) {
        requireSafeValue(value, "identifier", allowTmuxSessionId = true)
    }

    private fun requirePath(value: String) {
        requireSafeValue(value, "path", allowTmuxSessionId = false)
    }

    private fun requireSafeValue(
        value: String,
        label: String,
        allowTmuxSessionId: Boolean,
    ) {
        require(value.isNotEmpty()) { "$label must not be empty" }
        require(value.toByteArray(Charsets.UTF_8).size <= MAX_ARGUMENT_BYTES) {
            "$label exceeds $MAX_ARGUMENT_BYTES UTF-8 bytes"
        }
        require(value.none(Char::isISOControl)) {
            "$label must not contain control characters"
        }

        for (character in value) {
            if (character == '$' && allowTmuxSessionId && isTmuxSessionId(value)) continue
            require(character !in SHELL_INJECTION_CHARACTERS) {
                "$label contains shell control or injection characters"
            }
        }
    }

    private fun isTmuxSessionId(value: String): Boolean =
        value.length > 1 && value[0] == '$' && value.drop(1).all(Char::isDigit)

    /** POSIX shell single-quote escaping without introducing a backslash. */
    private fun shellQuote(value: String): String =
        "'" + value.replace("'", "'\"'\"'") + "'"

    /** SSH exec starts a non-login shell; load zsh profile and aliases on macOS. */
    private fun loginShell(command: String): String = "/bin/zsh -lic ${shellQuote(command)}"

    private const val MAX_ARGUMENT_BYTES = 4 * 1024

    private val SHELL_INJECTION_CHARACTERS = setOf(
        ';',
        '&',
        '|',
        '`',
        '$',
        '<',
        '>',
        '(',
        ')',
        '\\',
    )
}

/**
 * String-only facade for callers that do not need to keep the typed command.
 * The typed builder above remains the single implementation of quoting.
 */
object BridgeSshTmuxCommands {
    const val SESSION_FIELD_DELIMITER = BridgeSshTmuxCommandBuilder.SESSION_FIELD_DELIMITER
    const val SESSION_FORMAT = BridgeSshTmuxCommandBuilder.SESSION_FORMAT

    fun listSessions(): String = BridgeSshTmuxCommandBuilder.listSessionsCommand()

    fun attach(target: String): String = BridgeSshTmuxCommandBuilder.attachCommand(target)

    fun create(name: String, cwd: String? = null): String =
        BridgeSshTmuxCommandBuilder.createCommand(name, cwd)

    fun rename(target: String, name: String): String =
        BridgeSshTmuxCommandBuilder.renameCommand(target, name)

    fun kill(target: String): String = BridgeSshTmuxCommandBuilder.killCommand(target)
}

/** Testable command boundary; production construction wraps the cbssh client. */
fun interface BridgeSshTmuxExecutor {
    suspend fun exec(
        command: String,
        maxOutputBytes: Int,
    ): BridgeCbSshExecResult
}

/**
 * Native tmux session client.  It does not open a PTY: every operation uses
 * the transport's bounded, non-PTY exec channel.
 */
class BridgeSshTmuxClient(
    private val executor: BridgeSshTmuxExecutor,
    defaultMaxOutputBytes: Int = BridgeSshTmuxCommandBuilder.DEFAULT_MAX_OUTPUT_BYTES,
) {
    private val defaultMaxOutputBytes = requireMaxOutputBytes(defaultMaxOutputBytes)

    constructor(
        transport: BridgeCbSshTransport,
        defaultMaxOutputBytes: Int = BridgeSshTmuxCommandBuilder.DEFAULT_MAX_OUTPUT_BYTES,
    ) : this(
        BridgeSshTmuxExecutor { command, maxOutputBytes ->
            transport.exec(command, maxOutputBytes)
        },
        defaultMaxOutputBytes,
    )

    suspend fun execute(
        command: BridgeSshTmuxCommand,
        maxOutputBytes: Int = defaultMaxOutputBytes,
    ): BridgeCbSshExecResult {
        requireMaxOutputBytes(maxOutputBytes)
        return executor.exec(command.command, maxOutputBytes)
    }

    suspend fun captureHistory(target: String): ByteArray {
        val result = execute(BridgeSshTmuxCommandBuilder.captureHistory(target), MAX_CLIENT_OUTPUT_BYTES)
        when (val exit = result.exitInfo) {
            is SessionExit.Status -> require(exit.code == 0L) {
                result.stderr.toString(Charsets.UTF_8).ifBlank { "tmux capture-pane exited with code ${exit.code}" }
            }
            is SessionExit.Signal -> error(
                result.stderr.toString(Charsets.UTF_8).ifBlank { "tmux capture-pane terminated by ${exit.signalName}" },
            )
        }
        return result.stdout
    }

    suspend fun listSessions(
        maxOutputBytes: Int = defaultMaxOutputBytes,
    ): List<BridgeSshTmuxSession> {
        val result = execute(BridgeSshTmuxCommandBuilder.listSessions(), maxOutputBytes)
        when (val exit = result.exitInfo) {
            is SessionExit.Status -> if (exit.code != 0L) {
                val stderr = result.stderr.toString(Charsets.UTF_8)
                val noServer = exit.code == 1L && stderr.lineSequence().any { line ->
                    val text = line.trim().lowercase()
                    text.startsWith("no server running") || text == "no sessions" ||
                        (text.startsWith("error connecting to ") && text.contains("no such file or directory"))
                }
                if (noServer) return emptyList()
                error(stderr.ifBlank { "tmux list-sessions exited with code ${exit.code}" })
            }
            is SessionExit.Signal -> error(
                result.stderr.toString(Charsets.UTF_8).ifBlank {
                    "tmux list-sessions terminated by ${exit.signalName}"
                },
            )
        }
        return parseSessions(result.stdout)
    }

    companion object {
        fun parseSessions(stdout: ByteArray): List<BridgeSshTmuxSession> =
            parseSessions(stdout.toString(Charsets.UTF_8))

        /**
         * Parse in source order.  A row is all-or-nothing; malformed rows do
         * not shift fields in a later row or make the whole listing unusable.
         */
        fun parseSessions(stdout: String): List<BridgeSshTmuxSession> {
            if (stdout.isEmpty()) return emptyList()

            return stdout.lineSequence().mapNotNull { rawLine ->
                parseSessionRow(rawLine.removeSuffix("\r"))
            }.toList()
        }

        private fun parseSessionRow(line: String): BridgeSshTmuxSession? {
            if (line.isEmpty()) return null

            // A positive limit preserves empty trailing fields and also makes
            // a delimiter appearing in a value an unambiguously bad row.
            val fields = line.split(
                BridgeSshTmuxCommandBuilder.SESSION_FIELD_DELIMITER,
                ignoreCase = false,
                limit = 7,
            )
            if (fields.size != 6) return null

            val id = fields[0]
            val name = fields[1]
            val windows = fields[2].toIntOrNull() ?: return null
            val attachedCount = fields[3].toIntOrNull() ?: return null
            val cwd = fields[4]
            val createdAt = fields[5].toLongOrNull() ?: return null

            if (id.isBlank() || name.isBlank() || cwd.isBlank()) return null
            if (windows <= 0 || attachedCount < 0 || createdAt < 0) return null

            return BridgeSshTmuxSession(
                id = id,
                name = name,
                windows = windows,
                attached = attachedCount > 0,
                cwd = cwd,
                createdAt = createdAt,
            )
        }

        private fun requireMaxOutputBytes(value: Int): Int {
            require(value in 1..MAX_CLIENT_OUTPUT_BYTES) {
                "maxOutputBytes must be between 1 and $MAX_CLIENT_OUTPUT_BYTES"
            }
            return value
        }

        private const val MAX_CLIENT_OUTPUT_BYTES = 1 * 1024 * 1024
    }
}
