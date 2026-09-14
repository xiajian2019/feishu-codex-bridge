import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_VERSION = [22, 13, 1];
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, "release");
const LAUNCHER_SOURCE = join(PROJECT_ROOT, "scripts", "portable-launcher.sh");

export function parsePortableReleaseArguments(argv, cwd = process.cwd()) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    nodePath: process.execPath,
    pnpmPath: process.env.PNPM_BIN || "pnpm",
    skipBuild: false,
    keepSourceMaps: false,
    bundleNode: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      args.skipBuild = true;
      continue;
    }
    if (arg === "--keep-source-maps") {
      args.keepSourceMaps = true;
      continue;
    }
    if (arg === "--bundle-node") {
      args.bundleNode = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    const option = readOption(argv, index, arg, ["--output", "--node", "--pnpm"]);
    if (!option) throw new Error(`未知参数：${arg}`);
    const [name, value, consumed] = option;
    if (name === "--output") args.outputDir = resolve(cwd, value);
    if (name === "--node") args.nodePath = resolve(cwd, value);
    if (name === "--pnpm") args.pnpmPath = resolve(cwd, value);
    index += consumed;
  }
  return args;
}

function readOption(argv, index, arg, names) {
  const name = names.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
  if (!name) return undefined;
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    if (!value) throw new Error(`${name} 需要一个值`);
    return [name, value, 0];
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return [name, value, 1];
}

export function targetName(platform = process.platform, arch = process.arch) {
  const platformName = platform === "darwin" ? "darwin" : undefined;
  const archName = {
    arm64: "arm64",
    x64: "x64",
  }[arch];
  if (!platformName || !archName) {
    throw new Error(`Portable Runtime Lite 当前只支持 macOS arm64/x64：${platform}/${arch}`);
  }
  return `feishu-codex-bridge-${platformName}-${archName}`;
}

export function printPortableReleaseUsage() {
  console.log([
    "用法：pnpm run portable:release [选项]",
    "",
    "构建接收方无需预装 Node/pnpm 的 Portable Runtime Lite 压缩包。",
    "",
    "选项：",
    "  --output path          输出目录（默认：./release）",
    "  --node path            要内置的 Node 可执行文件（默认：当前 Node）",
    "  --pnpm path            构建生产依赖使用的 pnpm（默认：pnpm）",
    "  --skip-build           复用现有 dist，不重新执行 pnpm run build",
    "  --keep-source-maps     保留 dist 中的 source map",
    "  --bundle-node          将当前 Node 一并放入发布包（默认按需下载）",
    "  --json                 以 JSON 输出产物信息",
  ].join("\n"));
}

export async function buildPortableRelease(options) {
  const packageName = targetName();
  const outputDir = resolve(options.outputDir);
  const archivePath = join(outputDir, `${packageName}.tar.gz`);
  const packageDir = join(outputDir, packageName);
  const stageParent = await mkdirTemp("feishu-codex-bridge-portable-");
  const stageDir = join(stageParent, packageName);

  await validateNode(options.nodePath);
  await mkdir(outputDir, { recursive: true, mode: 0o755 });

  try {
    if (!options.skipBuild) {
      await run(options.pnpmPath, ["run", "build"], { cwd: PROJECT_ROOT });
    }
    await assertBuildOutput();
    await mkdir(stageDir, { recursive: true, mode: 0o755 });

    const appDir = join(stageDir, "app");
    const runtimeDir = join(stageDir, "runtime");
    await mkdir(appDir, { recursive: true, mode: 0o755 });
    await copyApplication(appDir, options.keepSourceMaps);
    await installProductionDependencies(appDir, options.pnpmPath);
    if (options.bundleNode) await copyNodeRuntime(runtimeDir, options.nodePath);
    await copyFile(LAUNCHER_SOURCE, join(stageDir, "feishu-codex-bridge"));
    await chmod(join(stageDir, "feishu-codex-bridge"), 0o755);
    await writePortableReadme(stageDir, packageName);
    await runSmokeTests(stageDir, options.nodePath);

    await rm(archivePath, { force: true });
    await run("tar", ["-czf", archivePath, "-C", stageParent, packageName]);
    await rm(packageDir, { recursive: true, force: true });
    await cp(stageDir, packageDir, { recursive: true });
    const checksum = await sha256(archivePath);
    await writeFile(`${archivePath}.sha256`, `${checksum}  ${packageName}.tar.gz\n`, "utf8");
    const result = {
      packageName,
      archivePath,
      packageDir,
      checksum,
      nodePath: resolve(options.nodePath),
      outputDir,
    };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Portable Runtime Lite 已生成：${archivePath}`);
      console.log(`SHA-256：${checksum}`);
      console.log(`校验文件：${archivePath}.sha256`);
      console.log("接收方解压后执行：./feishu-codex-bridge install");
    }
    return result;
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}

async function copyApplication(appDir, keepSourceMaps) {
  const distDir = join(PROJECT_ROOT, "dist");
  const scriptsDir = join(PROJECT_ROOT, "scripts");
  await copyFiltered(distDir, join(appDir, "dist"), keepSourceMaps ? undefined : (source) => !source.endsWith(".map"));
  await copyFiltered(scriptsDir, join(appDir, "scripts"), (source) => !source.endsWith(".test.mjs"));
  await writePortableConfigExample(appDir);
  await copyFile(join(PROJECT_ROOT, "package.json"), join(appDir, "package.json"));
}

async function writePortableConfigExample(appDir) {
  const config = {
    execution: { mode: "feishu-sqlite-codex" },
    direct: {
      projectKey: "default",
      mode: "implement",
      retry: {
        maxAttempts: 3,
        initialDelaySeconds: 5,
        maxDelaySeconds: 120,
      },
      feishu: {
        appIdEnv: "FEISHU_APP_ID",
        appSecretEnv: "FEISHU_APP_SECRET",
        groupAllowlist: [],
        dmMode: "open",
        dmAllowlist: [],
        allowedSenderOpenIds: [],
        requireMention: true,
        replyInThread: false,
      },
      permissions: {
        defaultAllow: true,
        allowAttachments: true,
        allowCancel: true,
        rules: [],
      },
    },
    web: { enabled: true, host: "127.0.0.1", port: 7310 },
    lark: {
      profile: "direct",
      tasklistGuid: "replace-with-tasklist-guid",
      projectFieldGuid: "replace-with-project-field-guid",
      modeFieldGuid: "replace-with-mode-field-guid",
    },
    codex: {
      cliPath: "/absolute/path/to/codex",
      env: {},
    },
    projects: {
      default: {
        optionGuid: "default-project",
        repo: "/absolute/path/to/git-repository",
      },
    },
    modes: {
      implement: {
        optionGuid: "implement",
        sandboxMode: "workspace-write",
      },
    },
  };
  await writeFile(join(appDir, "config.example.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function installProductionDependencies(appDir, pnpmPath) {
  await copyFile(join(PROJECT_ROOT, "pnpm-lock.yaml"), join(appDir, "pnpm-lock.yaml"));
  await run(
    pnpmPath,
    ["install", "--prod", "--no-optional", "--frozen-lockfile"],
    { cwd: appDir },
  );

  const nodeModules = join(appDir, "node_modules");
  // React is already bundled into dist/web and is not imported by the server.
  // Removing it from the portable runtime saves several megabytes without
  // changing the source package's development workflow.
  await removePackage(nodeModules, "react");
  await removePackage(nodeModules, "react-dom");

  // @openai/codex-sdk is configured to use the recipient's standalone/system
  // Codex CLI through codexPathOverride. The optional platform packages contain
  // a second Codex executable and are intentionally omitted from Lite releases.
  const openaiRoot = join(nodeModules, "@openai");
  if (existsSync(openaiRoot)) {
    for (const entry of await readdir(openaiRoot)) {
      if (/^codex-(darwin|linux|win32)-/.test(entry)) {
        await rm(join(openaiRoot, entry), { recursive: true, force: true });
      }
    }
  }
  const pnpmRoot = join(nodeModules, ".pnpm");
  if (existsSync(pnpmRoot)) {
    for (const entry of await readdir(pnpmRoot)) {
      if (/^@openai\+codex@.*-(darwin|linux|win32)-/.test(entry)
        || /^react(?:-dom)?@/.test(entry)) {
        await rm(join(pnpmRoot, entry), { recursive: true, force: true });
      }
    }
  }
  await rm(join(appDir, "pnpm-lock.yaml"), { force: true });
  await removeSourceMaps(nodeModules);

  if (!existsSync(join(nodeModules, "@openai", "codex-sdk"))) {
    throw new Error("生产依赖中缺少 @openai/codex-sdk");
  }
}

async function copyNodeRuntime(runtimeDir, requestedNodePath) {
  const nodePath = await realpath(requestedNodePath);
  const prefix = resolve(dirname(nodePath), "..");
  const npmSource = join(prefix, "lib", "node_modules", "npm");
  if (!existsSync(npmSource)) {
    throw new Error(`Node 安装中缺少 npm：${npmSource}`);
  }
  const binDir = join(runtimeDir, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  await copyFile(nodePath, join(binDir, "node"));
  await chmod(join(binDir, "node"), 0o755);
  await writeFile(join(runtimeDir, ".bundled-node"), `${nodePath}\n`, "utf8");
  await mkdir(join(runtimeDir, "lib", "node_modules"), { recursive: true, mode: 0o755 });
  await cp(npmSource, join(runtimeDir, "lib", "node_modules", "npm"), { recursive: true });
  await removeSourceMaps(join(runtimeDir, "lib", "node_modules", "npm"));
  await symlink("../lib/node_modules/npm/bin/npm-cli.js", join(binDir, "npm"));
  await symlink("../lib/node_modules/npm/bin/npx-cli.js", join(binDir, "npx"));

  for (const file of ["LICENSE", "README.md", "CHANGELOG.md"]) {
    if (existsSync(join(prefix, file))) await copyFile(join(prefix, file), join(runtimeDir, file));
  }
}

async function runSmokeTests(stageDir, buildNodePath) {
  const bundledNode = join(stageDir, "runtime", "bin", "node");
  const node = existsSync(bundledNode) ? bundledNode : resolve(buildNodePath);
  const app = join(stageDir, "app");
  const env = {
    ...process.env,
    PATH: `${join(stageDir, "runtime", "bin")}:${join(app, "node_modules", ".bin")}:${process.env.PATH || ""}`,
  };
  await run(node, [join(app, "dist", "main.js"), "--help"], { cwd: app, env });
  await run(node, [join(app, "dist", "codex-cli.js"), "--help"], { cwd: app, env });
  await run(
    node,
    ["--input-type=module", "-e", [
      'import { Codex } from "@openai/codex-sdk";',
      'new Codex({ codexPathOverride: "codex" });',
      'const { DatabaseSync } = await import("node:sqlite");',
      'const sqlite = new DatabaseSync(":memory:");',
      'sqlite.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT)");',
      'sqlite.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");',
      'if (sqlite.prepare("SELECT value FROM smoke").get().value !== "ok") throw new Error("node:sqlite smoke test failed");',
      'sqlite.close();',
      'await import("./dist/aamp-task-agent.js");',
      'console.log("portable runtime smoke test passed");',
    ].join("\n")],
    { cwd: app, env },
  );
}

async function writePortableReadme(stageDir, packageName) {
  const content = `# Feishu Codex Bridge Portable Runtime Lite\n\n` 
    + `目标平台：${packageName}\n\n`
    + "## 使用\n\n"
    + "1. 确认本机已安装并登录 Codex CLI。\n"
    + "2. 确认要处理的 Git 仓库路径可访问。\n"
    + "3. 执行 `./feishu-codex-bridge install`，按提示填写 Feishu 凭据。\n\n"
    + "启动器会优先使用系统 Node >=22.13.1；如果找不到，会从 Node 官方发行目录下载固定版本到当前包的 runtime/ 目录。不会修改用户全局 Node、nvm 或 Homebrew。\n"
    + "使用 `--bundle-node` 构建时，也可以完全离线运行。\n"
    + "SQLite 使用 Node 22.13 内置的 node:sqlite，不包含原生 SQLite 扩展。\n"
    + "Codex CLI 不包含在 Lite 包中；可使用官方独立安装程序安装。\n\n"
    + "已有配置启用 AAMP 时，请使用 `./feishu-codex-bridge aamp:start --config <path>`；`service start` 仅启动原生直连 Codex。\n\n"
    + "## 常用命令\n\n"
    + "```text\n"
    + "./feishu-codex-bridge install\n"
    + "./feishu-codex-bridge service status\n"
    + "./feishu-codex-bridge codex:recent -- --limit 10\n"
    + "./feishu-codex-bridge codex:logs\n"
    + "./feishu-codex-bridge service stop\n"
    + "```\n\n"
    + "不要把 config.json、runtime/、Feishu Secret 或 Codex 登录目录打包分享。\n";
  await writeFile(join(stageDir, "README.md"), content, "utf8");
}

async function assertBuildOutput() {
  const required = [
    join(PROJECT_ROOT, "dist", "main.js"),
    join(PROJECT_ROOT, "dist", "codex-cli.js"),
    join(PROJECT_ROOT, "dist", "install-cli.js"),
    join(PROJECT_ROOT, "dist", "web", "index.html"),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) throw new Error(`构建产物缺失：${missing.join(", ")}`);
}

async function validateNode(nodePath) {
  if (!existsSync(nodePath)) throw new Error(`指定的 Node 不存在：${nodePath}`);
  const version = execFileSync(nodePath, ["-p", "process.versions.node"], { encoding: "utf8" }).trim();
  const numbers = version.replace(/^v/, "").split(".").slice(0, 3).map(Number);
  if (numbers.some((value) => !Number.isInteger(value)) || compareVersions(numbers, MIN_NODE_VERSION) < 0) {
    throw new Error(`Node 版本过低：${version}，需要 >= ${MIN_NODE_VERSION.join(".")}`);
  }
}

async function copyFiltered(source, destination, filter) {
  await cp(source, destination, {
    recursive: true,
    filter: filter ? (path) => filter(path) : undefined,
  });
}

async function removePackage(nodeModules, name) {
  await rm(join(nodeModules, name), { recursive: true, force: true });
}

async function removeSourceMaps(root) {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await removeSourceMaps(path);
    } else if (entry.name.endsWith(".map")) {
      await rm(path, { force: true });
    }
  }
}

async function mkdirTemp(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio || "inherit",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${file} ${args.join(" ")} 退出码：${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  const args = parsePortableReleaseArguments(process.argv.slice(2));
  if (args.help) {
    printPortableReleaseUsage();
  } else {
    buildPortableRelease(args).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
