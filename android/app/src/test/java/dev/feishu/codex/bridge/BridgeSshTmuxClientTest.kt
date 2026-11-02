package dev.feishu.codex.bridge

import kotlinx.coroutines.runBlocking
import org.connectbot.sshlib.SessionExit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshTmuxClientTest {
    @Test
    fun buildsMachineReadableAndFutureSessionCommands() {
        val delimiter = BridgeSshTmuxCommandBuilder.SESSION_FIELD_DELIMITER

        val listCommand = BridgeSshTmuxCommandBuilder.listSessions().command
        assertTrue(listCommand.startsWith("/bin/zsh -lic "))
        assertTrue(listCommand.contains("tmux list-sessions"))
        assertTrue(listCommand.contains("#{session_id}${delimiter}"))

        val attachCommand = BridgeSshTmuxCommandBuilder.attach("\$0").command
        assertTrue(attachCommand.startsWith("/bin/zsh -lic "))
        assertTrue(attachCommand.contains("tmux attach-session"))
        assertTrue(attachCommand.contains("\$0"))

        val createCommand = BridgeSshTmuxCommandBuilder.create("work session", "/Users/me/project").command
        assertTrue(createCommand.startsWith("/bin/zsh -lic "))
        assertTrue(createCommand.contains("tmux new-session"))
        assertTrue(createCommand.contains("work session"))
        assertTrue(createCommand.contains("/Users/me/project"))

        val renameCommand = BridgeSshTmuxCommandBuilder.rename("work session", "new name").command
        assertTrue(renameCommand.startsWith("/bin/zsh -lic "))
        assertTrue(renameCommand.contains("tmux rename-session"))
        assertTrue(renameCommand.contains("new name"))

        val killCommand = BridgeSshTmuxCommandBuilder.kill("work session").command
        assertTrue(killCommand.startsWith("/bin/zsh -lic "))
        assertTrue(killCommand.contains("tmux kill-session"))

        val homeCommand = BridgeSshTmuxCommandBuilder.codexHome("\$0").command
        assertTrue(homeCommand.contains("tmux show-environment"))
        assertTrue(homeCommand.contains("CODEX_HOME"))
        assertTrue(runCatching { BridgeSshTmuxCommandBuilder.codexHome("\$(whoami)") }.isFailure)
    }

    @Test
    fun capturesOnlyTheSelectedPaneHistoryThroughABoundedReadOnlyCommand() = runBlocking {
        val calls = mutableListOf<Pair<String, Int>>()
        val client = BridgeSshTmuxClient(BridgeSshTmuxExecutor { command, limit ->
            calls += command to limit
            result("history\n")
        })
        assertEquals("history\n", client.captureHistory("\$7").toString(Charsets.UTF_8))
        assertEquals(1, calls.size)
        assertEquals(1024 * 1024, calls.single().second)
        assertTrue(calls.single().first.contains("tmux capture-pane -p -e -t"))
        assertTrue(calls.single().first.contains("-S -1000"))
        assertTrue(runCatching { BridgeSshTmuxCommandBuilder.captureHistory("\$(whoami)") }.isFailure)
    }

    @Test
    fun quotesApostrophesWithoutCreatingShellSyntax() {
        val command = BridgeSshTmuxCommandBuilder.rename("O'Brien", "next name").command

        assertTrue(command.startsWith("/bin/zsh -lic "))
        assertTrue(command.contains("O"))
        assertTrue(command.contains("Brien"))
        assertTrue(command.contains("next name"))
        assertTrue(command.none { it == '\\' || it == ';' || it == '|' })
    }

    @Test
    fun rejectsShellInjectionInIdentifiersAndPaths() {
        val rejected = listOf(
            "work; touch /tmp/pwned",
            "work && whoami",
            "\$(whoami)",
            "work\nnext",
            "/tmp/a|cat",
        )

        for (value in rejected) {
            val error = runCatching { BridgeSshTmuxCommandBuilder.attach(value) }.exceptionOrNull()
            assertTrue("expected rejection for $value", error is IllegalArgumentException)
        }

        val pathError = runCatching {
            BridgeSshTmuxCommandBuilder.create("safe", "/tmp/$(whoami)")
        }.exceptionOrNull()
        assertTrue(pathError is IllegalArgumentException)
    }

    @Test
    fun parsesValidRowsAndSkipsMalformedRowsInSourceOrder() {
        val d = BridgeSshTmuxCommandBuilder.SESSION_FIELD_DELIMITER
        val output = listOf(
            "\$0${d}main${d}2${d}1${d}/Users/me/project${d}1700000000",
            "not enough fields",
            "\$bad${d}bad windows${d}x${d}0${d}/tmp${d}1",
            "\$1${d}detached${d}1${d}0${d}/Users/me/other${d}1700000001",
            "\$2${d}negative${d}-1${d}0${d}/tmp${d}1700000002",
            "\$3${d}bad attached${d}1${d}yes${d}/tmp${d}1700000003",
            "\$4${d}bad created${d}1${d}0${d}/tmp${d}-1",
            "\$5${d}extra${d}1${d}0${d}/tmp${d}1${d}unexpected",
            "\$6${d}windows${d}3${d}2${d}/Users/me/third${d}1700000006\r",
        ).joinToString("\n")

        assertEquals(
            listOf(
                BridgeSshTmuxSession("\$0", "main", 2, true, "/Users/me/project", 1700000000),
                BridgeSshTmuxSession("\$1", "detached", 1, false, "/Users/me/other", 1700000001),
                BridgeSshTmuxSession("\$6", "windows", 3, true, "/Users/me/third", 1700000006),
            ),
            BridgeSshTmuxClient.parseSessions(output),
        )
    }

    @Test
    fun emptyOutputProducesNoSessions() {
        assertEquals(emptyList<BridgeSshTmuxSession>(), BridgeSshTmuxClient.parseSessions(""))
        assertEquals(emptyList<BridgeSshTmuxSession>(), BridgeSshTmuxClient.parseSessions("\n\r\n"))
    }

    @Test
    fun clientUsesTheBoundedExecBoundary() = runBlocking {
        val calls = mutableListOf<Pair<String, Int>>()
        val delimiter = BridgeSshTmuxCommandBuilder.SESSION_FIELD_DELIMITER
        val client = BridgeSshTmuxClient(
            BridgeSshTmuxExecutor { command, maxOutputBytes ->
                calls += command to maxOutputBytes
                result("\$0${delimiter}main${delimiter}1${delimiter}0${delimiter}/tmp${delimiter}42\n")
            },
            defaultMaxOutputBytes = 4096,
        )

        val sessions = client.listSessions()

        assertEquals(1, sessions.size)
        assertEquals("\$0", sessions.single().id)
        assertEquals(4096, calls.single().second)
        assertEquals(BridgeSshTmuxCommandBuilder.listSessions().command, calls.single().first)
    }

    @Test
    fun resumeDistinguishesAnAbsentTmuxServerFromOtherFailures() = runBlocking {
        val missing = BridgeSshTmuxClient(BridgeSshTmuxExecutor { _, _ ->
            BridgeCbSshExecResult(ByteArray(0), "no server running on /tmp/tmux-test/default".toByteArray(), SessionExit.Status(1))
        })
        assertEquals(null, missing.findResumeTarget(BridgeSshTmuxIdentity("\$1", 42)))
        val broken = BridgeSshTmuxClient(BridgeSshTmuxExecutor { _, _ ->
            BridgeCbSshExecResult(ByteArray(0), "permission denied".toByteArray(), SessionExit.Status(1))
        })
        assertTrue(runCatching { broken.findResumeTarget(BridgeSshTmuxIdentity("\$1", 42)) }.isFailure)
    }

    private fun result(stdout: String): BridgeCbSshExecResult =
        BridgeCbSshExecResult(
            stdout = stdout.toByteArray(Charsets.UTF_8),
            stderr = ByteArray(0),
            exitInfo = SessionExit.Status(0),
        )
}
