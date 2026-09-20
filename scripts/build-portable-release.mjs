import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, cp, copyFile, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_VERSION = [22, 13, 1];
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, "release");
const LAUNCHER_SOURCE = join(PROJECT_ROOT, "scripts", "portable-launcher.sh");
const INSTALL_COMMAND_SOURCE = join(PROJECT_ROOT, "install.command");
const RELEASE_MODES = ["lite", "direct"];
const DEFAULT_RELEASE_MODE = "direct";

export function parsePortableReleaseArguments(argv, cwd = process.cwd()) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    nodePath: process.execPath,
    pnpmPath: process.env.PNPM_BIN || "pnpm",
    mode: DEFAULT_RELEASE_MODE,
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
    if (arg === "--direct") {
      args.mode = "direct";
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    const option = readOption(argv, index, arg, ["--output", "--node", "--pnpm", "--mode"]);
    if (!option) throw new Error(`未知参数：${arg}`);
    const [name, value, consumed] = option;
    if (name === "--output") args.outputDir = resolve(cwd, value);
    if (name === "--node") args.nodePath = resolve(cwd, value);
    if (name === "--pnpm") args.pnpmPath = resolve(cwd, value);
    if (name === "--mode") {
      if (!RELEASE_MODES.includes(value)) throw new Error(`未知 portable 发布模式：${value}`);
      args.mode = value;
    }
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

export function targetName(platform = process.platform, arch = process.arch, mode = DEFAULT_RELEASE_MODE) {
  const platformName = platform === "darwin" ? "darwin" : undefined;
  const archName = {
    arm64: "arm64",
    x64: "x64",
  }[arch];
  if (!platformName || !archName) {
    throw new Error(`Portable Runtime Lite 当前只支持 macOS arm64/x64：${platform}/${arch}`);
  }
  if (!RELEASE_MODES.includes(mode)) throw new Error(`未知 portable 发布模式：${mode}`);
  return mode === "direct"
    ? `feishu-codex-bridge-direct-${platformName}-${archName}`
    : `feishu-codex-bridge-${platformName}-${archName}`;
}

export function printPortableReleaseUsage() {
  console.log([
    "用法：pnpm run release [选项]",
    "",
    "构建接收方无需预装 Node/pnpm 的 Portable Runtime Lite 压缩包。",
    "",
    "选项：",
    "  --output path          输出目录（默认：./release）",
    "  --node path            要内置的 Node 可执行文件（默认：当前 Node）",
    "  --pnpm path            构建生产依赖使用的 pnpm（默认：pnpm）",
    "  --mode MODE            发布模式：lite 或 direct（默认：direct）",
    "  --direct               --mode direct 的别名；内置 lark-cli 和双架构 Node",
    "  --skip-build           复用现有 dist，不重新执行 pnpm run build",
    "  --keep-source-maps     保留 dist 中的 source map",
    "  --bundle-node          将当前 Node 一并放入发布包（默认按需下载）",
    "  --json                 以 JSON 输出产物信息",
  ].join("\n"));
}

export async function buildPortableRelease(options) {
  const packageName = targetName(process.platform, process.arch, options.mode || DEFAULT_RELEASE_MODE);
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
    if (options.mode === "direct" || options.bundleNode) {
      await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
    }
    await copyApplication(appDir, options.keepSourceMaps, options.mode || DEFAULT_RELEASE_MODE);
    await installProductionDependencies(appDir, options.pnpmPath, options.mode || DEFAULT_RELEASE_MODE);
    if (options.mode === "direct") {
      await copyUniversalNodeRuntime(runtimeDir, options.nodePath);
    } else if (options.bundleNode) {
      await copyNodeRuntime(runtimeDir, options.nodePath);
    }
    await copyFile(LAUNCHER_SOURCE, join(stageDir, "feishu-codex-bridge"));
    await chmod(join(stageDir, "feishu-codex-bridge"), 0o755);
    await copyFile(INSTALL_COMMAND_SOURCE, join(stageDir, "install.command"));
    await chmod(join(stageDir, "install.command"), 0o755);
    await writeReleaseManifest(stageDir, packageName, options.mode || DEFAULT_RELEASE_MODE);
    await writePortableReadme(stageDir, packageName);
    await runSmokeTests(stageDir, options.nodePath, options.mode || DEFAULT_RELEASE_MODE);

    await rm(archivePath, { force: true });
    await run("tar", ["-czf", archivePath, "-C", stageParent, packageName]);
    await rm(packageDir, { recursive: true, force: true });
    await cp(stageDir, packageDir, { recursive: true, verbatimSymlinks: true });
    const checksum = await sha256(archivePath);
    await writeFile(`${archivePath}.sha256`, `${checksum}  ${packageName}.tar.gz\n`, "utf8");
    const result = {
      packageName,
      mode: options.mode || DEFAULT_RELEASE_MODE,
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

async function copyApplication(appDir, keepSourceMaps, mode) {
  const distDir = join(PROJECT_ROOT, "dist");
  const scriptsDir = join(PROJECT_ROOT, "scripts");
  await copyFiltered(distDir, join(appDir, "dist"), keepSourceMaps ? undefined : (source) => !source.endsWith(".map"));
  await copyFiltered(scriptsDir, join(appDir, "scripts"), (source) => !source.endsWith(".test.mjs"));
  await writePortableConfigExample(appDir);
  await copyFile(join(PROJECT_ROOT, "package.json"), join(appDir, "package.json"));
}

async function writePortablePackageJson(appDir, mode) {
  const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
  if (mode === "direct") {
    delete packageJson.dependencies?.["@larktask/aamp-feishu-task-agent"];
  } else {
    delete packageJson.dependencies?.["@larksuite/cli"];
  }
  await writeFile(join(appDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function writeReleaseManifest(stageDir, packageName, mode) {
  const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
  await writeFile(join(stageDir, "release-manifest.json"), `${JSON.stringify({
    version: packageJson.version,
    packageName,
    mode,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
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

async function installProductionDependencies(appDir, pnpmPath, mode) {
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

  if (mode === "direct") {
    // Direct mode uses only the extracted Feishu registration/profile flow;
    // it must not carry the AAMP runtime or its service controller.
    await removePackage(nodeModules, "@larktask/aamp-feishu-task-agent");
    for (const entry of ["aamp-feishu-task-agent", "aamp-logs", "feishu-task-agent"]) {
      await rm(join(nodeModules, ".bin", entry), { force: true });
    }
  } else {
    // Lite/AAMP releases let the official AAMP bootstrap install lark-cli on
    // demand instead of shipping its large native binary.
    await removePackage(nodeModules, "@larksuite/cli");
  }

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
        || /^react(?:-dom)?@/.test(entry)
        || (mode === "direct" && /^@larktask\+aamp-feishu-task-agent@/.test(entry))
        || (mode !== "direct" && /^@larksuite\+cli@/.test(entry))) {
        await rm(join(pnpmRoot, entry), { recursive: true, force: true });
      }
    }
  }
  await rm(join(appDir, "pnpm-lock.yaml"), { force: true });
  await removeSourceMaps(nodeModules);

  if (!existsSync(join(nodeModules, "@openai", "codex-sdk"))) {
    throw new Error("生产依赖中缺少 @openai/codex-sdk");
  }
  if (mode === "direct") await ensureLarkCliBinary(appDir);
  await relativizeNodeModuleSymlinks(appDir);
  await writePortablePackageJson(appDir, mode);
}

async function relativizeNodeModuleSymlinks(appDir) {
  const root = resolve(appDir);
  let rewritten = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (!isAbsolute(target)) continue;
        const normalizedTarget = resolve(target);
        if (normalizedTarget !== root && !normalizedTarget.startsWith(`${root}/`)) {
          throw new Error(`生产依赖包含指向包外的 symlink：${path} -> ${target}`);
        }
        await unlink(path);
        await symlink(relative(dirname(path), normalizedTarget), path);
        rewritten += 1;
      } else if (entry.isDirectory()) {
        await visit(path);
      }
    }
  }
  await visit(join(root, "node_modules"));
  if (rewritten > 0) console.log(`已规范化生产依赖 symlink：${rewritten} 个`);
}

async function ensureLarkCliBinary(appDir) {
  const packageRoot = join(appDir, "node_modules", "@larksuite", "cli");
  const binary = join(packageRoot, "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
  if (!existsSync(binary)) {
    const installer = join(packageRoot, "scripts", "install.js");
    if (!existsSync(installer)) throw new Error(`lark-cli 安装脚本缺失：${installer}`);
    await run(process.execPath, [installer], { cwd: appDir, env: process.env });
  }
  if (!existsSync(binary)) throw new Error(`lark-cli 二进制未生成：${binary}`);
  const shim = join(appDir, "node_modules", ".bin", "lark-cli");
  await writeFile(
    shim,
    "#!/bin/sh\nset -eu\nSELF_DIR=$(CDPATH= cd -P -- \"$(dirname -- \"$0\")\" && pwd -P)\nexec node \"$SELF_DIR/../@larksuite/cli/scripts/run.js\" \"$@\"\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(shim, 0o755);
}

async function copyNodeRuntime(runtimeDir, requestedNodePath) {
  const nodePath = await realpath(requestedNodePath);
  const prefix = resolve(dirname(nodePath), "..");
  await copyNodeRuntimeTree(runtimeDir, prefix);
  await writeFile(join(runtimeDir, ".bundled-node"), `${nodePath}\n`, "utf8");
}

async function copyNodeRuntimeTree(runtimeDir, prefix) {
  const npmSource = join(prefix, "lib", "node_modules", "npm");
  if (!existsSync(npmSource)) {
    throw new Error(`Node 安装中缺少 npm：${npmSource}`);
  }
  const binDir = join(runtimeDir, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  await copyFile(join(prefix, "bin", "node"), join(binDir, "node"));
  await chmod(join(binDir, "node"), 0o755);
  await mkdir(join(runtimeDir, "lib", "node_modules"), { recursive: true, mode: 0o755 });
  await cp(npmSource, join(runtimeDir, "lib", "node_modules", "npm"), { recursive: true });
  await removeSourceMaps(join(runtimeDir, "lib", "node_modules", "npm"));
  await symlink("../lib/node_modules/npm/bin/npm-cli.js", join(binDir, "npm"));
  await symlink("../lib/node_modules/npm/bin/npx-cli.js", join(binDir, "npx"));

  for (const file of ["LICENSE", "README.md", "CHANGELOG.md"]) {
    if (existsSync(join(prefix, file))) await copyFile(join(prefix, file), join(runtimeDir, file));
  }
}

async function copyUniversalNodeRuntime(runtimeDir, requestedNodePath) {
  const nodePath = await realpath(requestedNodePath);
  const version = execFileSync(nodePath, ["-p", "process.versions.node"], { encoding: "utf8" }).trim().replace(/^v/, "");
  const currentArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!currentArch) throw new Error(`direct Portable 暂不支持当前 CPU：${process.arch}`);

  const stageParent = await mkdirTemp("feishu-codex-node-universal-");
  const universalRoot = join(stageParent, "node-universal");
  try {
    for (const arch of ["arm64", "x64"]) {
      const sourceRoot = arch === currentArch
        ? resolve(dirname(nodePath), "..")
        : await downloadNodeDistribution(version, arch, stageParent);
      await copyNodeRuntimeTree(join(universalRoot, arch), sourceRoot);
    }
    await run(
      "tar",
      ["-czf", join(runtimeDir, "node-universal.tar.gz"), "-C", stageParent, "node-universal"],
      { cwd: PROJECT_ROOT },
    );
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}

async function downloadNodeDistribution(version, arch, destination) {
  const prefix = `node-v${version}-darwin-${arch}`;
  const archive = `${prefix}.tar.gz`;
  const archivePath = join(destination, archive);
  const checksumsPath = join(destination, "SHASUMS256.txt");
  const baseUrl = `https://nodejs.org/dist/v${version}`;
  await run("curl", ["--proto", "=https", "--tlsv1.2", "-fsSL", `${baseUrl}/${archive}`, "-o", archivePath], {
    cwd: destination,
  });
  await run("curl", ["--proto", "=https", "--tlsv1.2", "-fsSL", `${baseUrl}/SHASUMS256.txt`, "-o", checksumsPath], {
    cwd: destination,
  });
  const checksums = await readFile(checksumsPath, "utf8");
  const expected = checksums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === archive)?.[0];
  const actual = execFileSync("shasum", ["-a", "256", archivePath], { encoding: "utf8" }).trim().split(/\s+/)[0];
  if (!expected || expected !== actual) throw new Error(`Node ${arch} 下载校验失败：${archive}`);
  await run("tar", ["-xzf", archivePath, "-C", destination], { cwd: destination });
  return join(destination, prefix);
}

async function runSmokeTests(stageDir, buildNodePath, mode) {
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
      mode === "direct"
        ? 'await import("./dist/direct-feishu-setup.js");'
        : 'await import("./dist/aamp-task-agent.js");',
      'console.log("portable runtime smoke test passed");',
    ].join("\n")],
    { cwd: app, env },
  );
}

async function writePortableReadme(stageDir, packageName) {
  const content = `# Feishu Codex Bridge Portable Runtime Lite\n\n` 
    + `目标平台：${packageName}\n\n`
    + "## 使用\n\n"
    + (packageName.includes("-direct-")
      ? "1. 双击 `install.command`，安装器会通过飞书二维码创建直连 Bot，并写入 lark-cli profile。\n"
      : "1. 双击 `install.command`，或在终端执行 `./feishu-codex-bridge install`。\n")
    + (packageName.includes("-direct-")
      ? "2. 直连包自带双架构 Node、lark-cli 和直连运行依赖，不启动 AAMP 服务。\n"
      : "2. 安装器会自动查找 ChatGPT App 内置的 Codex；如果电脑另有独立 Codex CLI，也会自动使用。\n")
    + "3. 按提示选择要处理的 Git 仓库并完成 Feishu 授权。\n\n"
    + "启动器会优先使用系统 Node >=22.13.1；如果找不到，会从 Node 官方发行目录下载固定版本到当前包的 runtime/ 目录。不会修改用户全局 Node、nvm 或 Homebrew。\n"
    + "使用 `--bundle-node` 构建时，也可以完全离线运行。\n"
    + "SQLite 使用 Node 22.13 内置的 node:sqlite，不包含原生 SQLite 扩展。\n"
    + (packageName.includes("-direct-")
      ? "内置 Node 会按当前 CPU 架构从 node-universal.tar.gz 解压使用；不会联网下载 Node。\n\n"
      : "如果没有找到 ChatGPT App 或独立 Codex CLI，安装器会明确提示原因；不需要手动填写 CLI 路径。\n\n")
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
