import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const home = homedir();
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const dryRun = args.has("--dry-run");
const update = args.has("--update");
const pluginRoot = resolve(process.env.TMUX_PLUGIN_MANAGER_PATH?.trim() || join(home, ".tmux", "plugins"));
const configPath = chooseConfigPath();
const fragmentPath = join(dirname(configPath), "feishu-codex-bridge-resurrect.conf");
const repositories = [
  { name: "tpm", url: "https://github.com/tmux-plugins/tpm.git", required: "tpm" },
  { name: "tmux-resurrect", url: "https://github.com/tmux-plugins/tmux-resurrect.git", required: "scripts/save.sh" },
  { name: "tmux-continuum", url: "https://github.com/tmux-plugins/tmux-continuum.git", required: "continuum.tmux" },
];

function chooseConfigPath() {
  const explicit = process.env.TMUX_CONFIG_PATH?.trim();
  if (explicit) return expandPath(explicit);
  const xdg = process.env.XDG_CONFIG_HOME ? expandPath(process.env.XDG_CONFIG_HOME) : join(home, ".config");
  const xdgConfig = join(xdg, "tmux", "tmux.conf");
  if (existsSync(xdgConfig)) return xdgConfig;
  const legacy = join(home, ".tmux.conf");
  if (existsSync(legacy)) return legacy;
  return xdgConfig;
}

function expandPath(value) {
  return resolve(value.replace(/^~(?=\/|$)/, home));
}

function snapshotDirectory() {
  const traditionalDirectory = join(home, ".tmux", "resurrect");
  if (existsSync(traditionalDirectory)) return traditionalDirectory;
  const dataHome = process.env.XDG_DATA_HOME?.trim() ? expandPath(process.env.XDG_DATA_HOME) : join(home, ".local", "share");
  return join(dataHome, "tmux", "resurrect");
}

function tmuxQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result.stdout ?? "";
}

function repositoryReady(repository) {
  return existsSync(join(pluginRoot, repository.name, repository.required));
}

function managedConfigBlock() {
  const tpmPath = join(pluginRoot, "tpm", "tpm");
  return [
    "# BEGIN FEISHU_CODEX_BRIDGE_TMUX_RESURRECT",
    "# Managed by `bun run tmux:setup`; edit the setup script or remove this block to disable it.",
    "set -g @plugin 'tmux-plugins/tpm'",
    "set -g @plugin 'tmux-plugins/tmux-resurrect'",
    "set -g @plugin 'tmux-plugins/tmux-continuum'",
    `set -g @resurrect-dir ${tmuxQuote(snapshotDirectory())}`,
    "set -g @continuum-save-interval '15'",
    "# Continuum keeps the global save cadence; Bridge restores individual Sessions.",
    "set -g @continuum-restore 'off'",
    "set -g @continuum-boot 'on'",
    "# Restore Codex itself; add other programs deliberately after reviewing their commands.",
    "set -g @resurrect-processes 'codex'",
    `set-environment -g TMUX_PLUGIN_MANAGER_PATH ${tmuxQuote(`${pluginRoot}/`)}`,
    `run-shell ${tmuxQuote(tpmPath)}`,
    "unbind-key -T prefix C-s",
    "unbind-key -T prefix C-r",
    "# END FEISHU_CODEX_BRIDGE_TMUX_RESURRECT",
    "",
  ].join("\n");
}

function installSourceLine() {
  const marker = "FEISHU_CODEX_BRIDGE_TMUX_RESURRECT";
  const sourceLine = `source-file ${tmuxQuote(fragmentPath)}`;
  const block = [
    `# BEGIN ${marker}`,
    sourceLine,
    `# END ${marker}`,
  ].join("\n");
  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const markerPattern = new RegExp(`\\n?# BEGIN ${marker}\\n[\\s\\S]*?# END ${marker}\\n?`, "g");
  const withoutOld = original.replace(markerPattern, "\n").replace(/\n{3,}$/g, "\n\n");
  return `${withoutOld.replace(/\s*$/, "")}\n\n${block}\n`;
}

function describe() {
  return {
    configPath,
    fragmentPath,
    pluginRoot,
    installed: repositories.every(repositoryReady),
    snapshotDirectory: snapshotDirectory(),
    lastSnapshotAt: (() => {
      try { return statSync(join(snapshotDirectory(), "last")).mtime.toISOString(); } catch { return null; }
    })(),
  };
}

function main() {
  if (checkOnly) {
    console.log(JSON.stringify(describe(), null, 2));
    return;
  }
  if (dryRun) {
    console.log(JSON.stringify({ ...describe(), wouldWrite: true, update }, null, 2));
    return;
  }
  if (!existsSync(configPath)) mkdirSync(dirname(configPath), { recursive: true });
  run("tmux", ["-V"], { stdio: "ignore" });
  run("git", ["--version"], { stdio: "ignore" });
  mkdirSync(pluginRoot, { recursive: true });
  for (const repository of repositories) {
    const destination = join(pluginRoot, repository.name);
    if (!existsSync(destination)) {
      run("git", ["clone", "--depth", "1", repository.url, destination], { stdio: "inherit" });
    } else if (update) {
      run("git", ["-C", destination, "pull", "--ff-only"], { stdio: "inherit" });
    }
    if (!repositoryReady(repository)) throw new Error(`Plugin ${repository.name} is incomplete: ${destination}`);
  }
  writeFileSync(fragmentPath, managedConfigBlock(), { encoding: "utf8", mode: 0o600 });
  writeFileSync(configPath, installSourceLine(), { encoding: "utf8" });
  const running = spawnSync("tmux", ["has-session"], { stdio: "ignore" }).status === 0;
  if (running) run("tmux", ["source-file", configPath], { stdio: "inherit" });
  console.log("tmux-resurrect + tmux-continuum 已安装并接入 tmux 配置。Dashboard 会按具体 Session 保存/恢复；continuum 负责定时保存，Bridge 负责按 Session 恢复。");
  console.log(JSON.stringify(describe(), null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
