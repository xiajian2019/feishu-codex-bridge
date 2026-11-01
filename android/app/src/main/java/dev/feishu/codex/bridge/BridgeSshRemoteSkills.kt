package dev.feishu.codex.bridge

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.SessionExit
import org.connectbot.sshlib.SftpAttributes
import org.connectbot.sshlib.SftpClient
import org.connectbot.sshlib.SftpOpenFlag
import org.connectbot.sshlib.getOrThrow
import java.io.ByteArrayOutputStream

/** Discover skill metadata on the SSH target, without reading Bridge-host paths. */
internal class BridgeSshRemoteSkills(
    private val exec: suspend (String, Int) -> BridgeCbSshExecResult,
    private val openSftp: suspend () -> SftpClient,
    private val target: BridgeSshTmuxSession?,
    private val tmux: BridgeSshTmuxClient?,
    private val systemSkillRoot: String? = "/etc/codex/skills",
) {
    constructor(transport: BridgeCbSshTransport, target: BridgeSshTmuxSession?, tmux: BridgeSshTmuxClient?) :
        this(transport::exec, transport::openSftp, target, tmux)

    suspend fun discover(): List<BridgeSshSkill> = withContext(Dispatchers.IO) {
        withTimeout(20_000) {
            val homeResult = exec("printenv HOME", 16 * 1024)
            check((homeResult.exitInfo as? SessionExit.Status)?.code == 0L) { "无法读取 SSH 主目录。" }
            val home = validAbsolute(homeResult.stdout.toString(Charsets.UTF_8).trimEnd('\r', '\n'))
            val current = target?.let { selected ->
                checkNotNull(tmux).listSessions().firstOrNull { it.id == selected.id && it.createdAt == selected.createdAt }
                    ?: error("tmux Session 已失效。")
            }
            val sessionHome = current?.let { session -> attempt {
                val result = checkNotNull(tmux).execute(BridgeSshTmuxCommandBuilder.codexHome(session.id), 16 * 1024)
                val value = result.stdout.toString(Charsets.UTF_8).trimEnd('\r', '\n')
                if ((result.exitInfo as? SessionExit.Status)?.code == 0L && value.startsWith("CODEX_HOME="))
                    validAbsolute(value.removePrefix("CODEX_HOME=")) else null
            } }
            val configuredHome = sessionHome ?: attempt {
                val result = exec("printenv CODEX_HOME", 16 * 1024)
                if ((result.exitInfo as? SessionExit.Status)?.code == 0L) validAbsolute(result.stdout.toString(Charsets.UTF_8).trimEnd('\r', '\n')) else null
            } ?: "$home/.codex"
            openSftp().use { sftp ->
                val roots = mutableListOf<String>()
                if (current != null) roots.addAll(projectRoots(sftp, validAbsolute(current.cwd)))
                roots.add("$configuredHome/skills")
                roots.add("$configuredHome/plugins/cache")
                if (configuredHome != "$home/.codex") {
                    roots.add("$home/.codex/skills")
                    roots.add("$home/.codex/plugins/cache")
                }
                roots.add("$home/.agents/skills")
                systemSkillRoot?.let(roots::add)
                val visited = mutableSetOf<String>()
                val skills = linkedMapOf<String, BridgeSshSkill>()
                var remaining = MAX_DIRECTORIES
                for (root in roots.distinct()) {
                    val queue = ArrayDeque<Pair<String, Int>>()
                    queue.add(root to 0)
                    while (queue.isNotEmpty() && remaining > 0 && skills.size < MAX_SKILLS) {
                        val (path, depth) = queue.removeFirst()
                        val canonical = attempt { sftp.realpath(path).getOrThrow() } ?: continue
                        if (!visited.add(canonical)) continue
                        remaining -= 1
                        val entries = attempt { sftp.listdir(canonical).getOrThrow() } ?: continue
                        for (entry in entries) {
                            val name = entry.filename
                            if (!BridgeSshRemoteFiles.validName(name)) continue
                            val child = canonical.trimEnd('/') + "/" + name
                            if (name == "SKILL.md") {
                                val text = attempt { readMetadata(sftp, child) } ?: continue
                                val skill = parseSkill(text) ?: continue
                                skills.putIfAbsent(skill.name.lowercase(), skill)
                            } else if (depth < MAX_DEPTH && name !in SKIPPED) {
                                val mode = entry.attrs.permissions ?: continue
                                val type = mode and 0xF000
                                if (type == 0x4000 || type == 0xA000) queue.add(child to depth + 1)
                            }
                        }
                    }
                    if (remaining <= 0 || skills.size >= MAX_SKILLS) break
                }
                skills.values.toList()
            }
        }
    }

    private suspend fun projectRoots(sftp: SftpClient, cwd: String): List<String> {
        val parents = mutableListOf<String>()
        var current = cwd.trimEnd('/').ifEmpty { "/" }
        var gitFound = false
        while (true) {
            parents.add(current)
            if (attempt { sftp.lstat(current.trimEnd('/') + "/.git").getOrThrow() } != null) {
                gitFound = true
                break
            }
            if (current == "/") break
            current = current.substringBeforeLast('/').ifEmpty { "/" }
        }
        return (if (gitFound) parents else parents.take(1)).map { it.trimEnd('/') + "/.agents/skills" }
    }

    private suspend fun readMetadata(sftp: SftpClient, path: String): String {
        val size = sftp.stat(path).getOrThrow().size ?: error("Skill size missing")
        require(size in 0..MAX_FILE_BYTES) { "Skill metadata too large" }
        val handle = sftp.open(path, setOf(SftpOpenFlag.READ), SftpAttributes()).getOrThrow()
        try {
            val result = ByteArrayOutputStream()
            var offset = 0L
            while (offset < size) {
                val chunk = sftp.read(handle, offset, minOf(32 * 1024L, size - offset).toInt()).getOrThrow() ?: break
                if (chunk.isEmpty()) break
                result.write(chunk)
                offset += chunk.size
            }
            return result.toString(Charsets.UTF_8.name())
        } finally { sftp.close(handle).getOrThrow() }
    }

    private suspend fun <T> attempt(block: suspend () -> T): T? = try { block() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { null }

    companion object {
        private const val MAX_DIRECTORIES = 4_000
        private const val MAX_DEPTH = 12
        private const val MAX_SKILLS = 1_000
        private const val MAX_FILE_BYTES = 256L * 1024
        private val SKIPPED = setOf(".git", "node_modules", ".cache", "__pycache__", "vendor", "dist", "build")

        private fun validAbsolute(path: String): String {
            require(path.startsWith('/') && path.none(Char::isISOControl) && path.split('/').none { it == ".." })
            return path.trimEnd('/').ifEmpty { "/" }
        }

        internal fun parseSkill(markdown: String): BridgeSshSkill? {
            val lines = markdown.removePrefix("\uFEFF").lines()
            if (lines.firstOrNull()?.trim() != "---") return null
            val end = lines.indices.firstOrNull { it > 0 && lines[it].trim() == "---" } ?: -1
            if (end <= 0) return null
            val values = mutableMapOf<String, String>()
            var index = 1
            while (index < end) {
                val match = Regex("^([A-Za-z0-9_-]+):\\s*(.*)$").matchEntire(lines[index])
                if (match == null) { index += 1; continue }
                val key = match.groupValues[1].lowercase()
                var value = match.groupValues[2].trim()
                if (value.matches(Regex("[|>][+-]?"))) {
                    val block = mutableListOf<String>()
                    index += 1
                    while (index < end && (lines[index].startsWith(' ') || lines[index].startsWith('\t') || lines[index].isBlank())) {
                        block.add(lines[index].trim())
                        index += 1
                    }
                    value = block.joinToString(" ").trim()
                } else {
                    if (value.length >= 2 && value.first() in listOf('\'', '"') && value.last() == value.first()) value = value.substring(1, value.length - 1)
                    index += 1
                }
                values[key] = value
            }
            val name = values["name"] ?: return null
            if (!name.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}"))) return null
            val description = (values["description_zh"] ?: values["description"] ?: values["description_en"]).orEmpty().take(240)
            return BridgeSshSkill(name, description)
        }
    }
}
