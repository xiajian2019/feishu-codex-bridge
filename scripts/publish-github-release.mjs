import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parsePublishArguments(argv, packageVersion = "0.1.0") {
  const options = {
    tag: `v${packageVersion}`,
    remote: "origin",
    branch: "main",
    commitMessage: undefined,
    skipBuild: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--tag" || arg.startsWith("--tag=")) {
      options.tag = readValue(argv, index, arg, "--tag");
      if (arg === "--tag") index += 1;
      continue;
    }
    if (arg === "--remote" || arg.startsWith("--remote=")) {
      options.remote = readValue(argv, index, arg, "--remote");
      if (arg === "--remote") index += 1;
      continue;
    }
    if (arg === "--branch" || arg.startsWith("--branch=")) {
      options.branch = readValue(argv, index, arg, "--branch");
      if (arg === "--branch") index += 1;
      continue;
    }
    if (arg === "--message" || arg.startsWith("--message=")) {
      options.commitMessage = readValue(argv, index, arg, "--message");
      if (arg === "--message") index += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!/^v\d+\.\d+\.\d+([-.].+)?$/.test(options.tag)) {
    throw new Error(`tag 必须类似 v0.1.0：${options.tag}`);
  }
  return options;
}

export async function publishGithubRelease(options = {}, runCommand = run) {
  const packageJson = JSON.parse(await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8"));
  const parsed = {
    ...parsePublishArguments([], packageJson.version),
    ...options,
  };
  const commitMessage = parsed.commitMessage || `Release ${parsed.tag}`;

  await runCommand("git", ["status", "--short", "--branch"], PROJECT_ROOT);
  const currentBranch = (await runCommand("git", ["branch", "--show-current"], PROJECT_ROOT)).trim();
  if (currentBranch !== parsed.branch) {
    throw new Error(`当前分支为 ${currentBranch || "(detached)"}，预期为 ${parsed.branch}`);
  }
  const existingTag = await runCommand("git", ["tag", "--list", parsed.tag], PROJECT_ROOT);
  if (existingTag.trim()) throw new Error(`tag 已存在：${parsed.tag}`);

  const bun = process.env.BUN_BIN || "bun";
  if (!parsed.skipBuild) await runCommand(bun, ["run", "build"], PROJECT_ROOT);
  await runCommand(bun, ["run", "release", "--skip-build", "--json"], PROJECT_ROOT);
  // Temporarily publish only the Bun single-binary package.
  // await runCommand(bun, ["run", "release:legacy", "--mode", "core", "--skip-build", "--json"], PROJECT_ROOT);
  // await runCommand(bun, ["run", "release:legacy", "--mode", "lite", "--skip-build", "--json"], PROJECT_ROOT);

  const commands = [
    ["git", ["add", "-A"]],
    ["git", ["commit", "-m", commitMessage]],
    ["git", ["push", parsed.remote, parsed.branch]],
    ["git", ["tag", "-a", parsed.tag, "-m", commitMessage]],
    ["git", ["push", parsed.remote, parsed.tag]],
  ];
  if (parsed.dryRun) {
    return { ...parsed, commitMessage, commands };
  }
  for (const [file, args] of commands) await runCommand(file, args, PROJECT_ROOT);
  console.log(`已推送 ${parsed.branch} 和 ${parsed.tag}；GitHub Actions 将生成并上传 release asset。`);
  return { ...parsed, commitMessage, commands };
}

function readValue(argv, index, arg, name) {
  const value = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return value;
}

function run(file, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, { cwd, env: process.env, stdio: ["inherit", "pipe", "pipe"], shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${file} ${args.join(" ")} 退出码：${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

if (pathToFileURL(resolve(process.argv[1] || "")).href === import.meta.url) {
  readFile(resolve(PROJECT_ROOT, "package.json"), "utf8")
    .then((content) => publishGithubRelease(parsePublishArguments(process.argv.slice(2), JSON.parse(content).version)))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
