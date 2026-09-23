import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, cp, copyFile, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_BUN_VERSION = [1, 4, 2];
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, "release");
const LAUNCHER_SOURCE = join(PROJECT_ROOT, "scripts", "portable-launcher.sh");
const INSTALL_COMMAND_SOURCE = join(PROJECT_ROOT, "install.command");
const INSTALL_DEFAULTS_SOURCE = join(PROJECT_ROOT, "install.defaults");
const RELEASE_MODES = ["core", "lite", "direct"];
const DEFAULT_RELEASE_MODE = "direct";

export function parsePortableReleaseArguments(argv, cwd = process.cwd()) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    bunPath: process.execPath,
    mode: DEFAULT_RELEASE_MODE,
    skipBuild: false,
    keepSourceMaps: false,
    bundleBun: false,
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
    if (arg === "--bundle-bun") {
      args.bundleBun = true;
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
    const option = readOption(argv, index, arg, ["--output", "--bun", "--mode"]);
    if (!option) throw new Error(`未知参数：${arg}`);
    const [name, value, consumed] = option;
    if (name === "--output") args.outputDir = resolve(cwd, value);
    if (name === "--bun") args.bunPath = resolve(cwd, value);
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

export function targetName(
  platform = process.platform,
  arch = process.arch,
  mode = DEFAULT_RELEASE_MODE,
  version,
) {
  const platformName = platform === "darwin" ? "darwin" : undefined;
  const archName = {
    arm64: "arm64",
    x64: "x64",
  }[arch];
  if (!platformName || !archName) {
    throw new Error(`Portable Runtime 当前只支持 macOS arm64/x64：${platform}/${arch}`);
  }
  if (!RELEASE_MODES.includes(mode)) throw new Error(`未知 portable 发布模式：${mode}`);
  const suffix = version ? "-v" + String(version).replace(/^v/, "") : "";
  if (mode === "direct") return "feishu-codex-bridge-direct-" + platformName + "-" + archName + suffix;
  if (mode === "core") return "feishu-codex-bridge-core-" + platformName + "-" + archName + suffix;
  return "feishu-codex-bridge-" + platformName + "-" + archName + suffix;
}

export function printPortableReleaseUsage() {
  console.log([
    "用法：bun run release:legacy [选项]",
    "",
    "构建接收方无需预装 Node.js、npm、pnpm 或 Bun 的 Portable Runtime 压缩包。",
    "",
    "选项：",
    "  --output path          输出目录（默认：./release）",
    "  --bun path             构建/内置的 Bun 可执行文件（默认：当前 Bun）",
    "  --mode MODE            发布模式：core、lite 或 direct（默认：direct）",
    "  --direct               --mode direct 的别名；内置 lark-cli 和单架构 Bun",
    "  --skip-build           复用现有 dist，不重新执行 bun run build",
    "  --keep-source-maps     保留 dist 中的 source map",
    "  --bundle-bun           将当前架构的 Bun 一并放入发布包（默认按需下载）",
    "  --json                 以 JSON 输出产物信息",
  ].join("\n"));
}

export async function buildPortableRelease(options) {
  const mode = options.mode || DEFAULT_RELEASE_MODE;
  const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
  const packageName = targetName(
    process.platform,
    process.arch,
    mode,
    options.versionedNames ? packageJson.version : undefined,
  );
  const outputDir = resolve(options.outputDir);
  const archivePath = join(outputDir, `${packageName}.tar.gz`);
  const packageDir = join(outputDir, packageName);
  const stageParent = await mkdirTemp("feishu-codex-bridge-portable-");
  const stageDir = join(stageParent, packageName);

  await validateBun(options.bunPath);
  await mkdir(outputDir, { recursive: true, mode: 0o755 });

  try {
    if (!options.skipBuild) {
      await run(options.bunPath, ["run", "build"], { cwd: PROJECT_ROOT });
    }
    await assertBuildOutput();
    await mkdir(stageDir, { recursive: true, mode: 0o755 });

    const appDir = join(stageDir, "app");
    const runtimeDir = join(stageDir, "runtime");
    await mkdir(appDir, { recursive: true, mode: 0o755 });
    if (mode !== "core" && mode !== "direct" && options.bundleBun) {
      await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
    }
    await copyApplication(appDir, options.keepSourceMaps, mode, { includePackageJson: mode !== "core" });
    if (mode !== "core") await installProductionDependencies(appDir, options.bunPath, mode);
    if (mode === "direct" || mode === "core") {
      await compilePortableBinary(join(appDir, "feishu-codex-bridge"));
    }
    if (mode === "direct") await trimSingleBinaryDirectPackage(appDir);
    if (mode !== "core" && mode !== "direct" && options.bundleBun) {
      await copyBunRuntime(runtimeDir, options.bunPath);
    }
    await copyFile(LAUNCHER_SOURCE, join(stageDir, "feishu-codex-bridge"));
    await chmod(join(stageDir, "feishu-codex-bridge"), 0o755);
    await copyFile(INSTALL_COMMAND_SOURCE, join(stageDir, "install.command"));
    await chmod(join(stageDir, "install.command"), 0o755);
    await copyFile(INSTALL_DEFAULTS_SOURCE, join(stageDir, "install.defaults"));
    const changelogSource = join(PROJECT_ROOT, "CHANGELOG.md");
    if (existsSync(changelogSource)) {
      await copyFile(changelogSource, join(stageDir, "CHANGELOG.md"));
    }
    await writeReleaseManifest(stageDir, packageName, mode, options.bunPath);
    await writePortableReadme(stageDir, packageName, mode);
    await runSmokeTests(stageDir, options.bunPath, mode);

    await rm(archivePath, { force: true });
    await run("tar", ["-czf", archivePath, "-C", stageParent, packageName]);
    await installGeneratedPackage(stageDir, packageDir, outputDir, packageName);
    const checksum = await sha256(archivePath);
    await writeFile(`${archivePath}.sha256`, `${checksum}  ${packageName}.tar.gz\n`, "utf8");
    const result = {
      packageName,
      mode,
      archivePath,
      packageDir,
      checksum,
      bunPath: resolve(options.bunPath),
      outputDir,
    };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Portable Runtime ${mode} 已生成：${archivePath}`);
      console.log(`SHA-256：${checksum}`);
      console.log(`校验文件：${archivePath}.sha256`);
      console.log(mode === "core"
        ? "已安装包执行：./feishu-codex-bridge update --file ./feishu-codex-bridge-core-*.tar.gz"
        : "接收方解压后执行：./feishu-codex-bridge install");
    }
    return result;
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}

async function copyApplication(appDir, keepSourceMaps, mode, { includePackageJson = true } = {}) {
  const distDir = join(PROJECT_ROOT, "dist");
  const scriptsDir = join(PROJECT_ROOT, "scripts");
  await copyFiltered(distDir, join(appDir, "dist"), keepSourceMaps ? undefined : (source) => !source.endsWith(".map"));
  await copyFiltered(scriptsDir, join(appDir, "scripts"), (source) => !source.endsWith(".test.mjs"));
  await writePortableConfigExample(appDir);
  if (includePackageJson) await copyFile(join(PROJECT_ROOT, "package.json"), join(appDir, "package.json"));
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

async function writeReleaseManifest(stageDir, packageName, mode, bunPath) {
  const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
  await writeFile(join(stageDir, "release-manifest.json"), `${JSON.stringify({
    version: packageJson.version,
    packageName,
    mode,
    runtimeFamily: "bun",
    runtimeGeneration: mode === "direct"
      ? `bun-${MIN_BUN_VERSION.join(".")}-single-binary`
      : `bun-${MIN_BUN_VERSION.join(".")}`,
    runtimeVersion: execFileSync(bunPath, ["--version"], { encoding: "utf8" }).trim(),
    runtimeArchitecture: process.arch,
    runtimePackaging: mode === "direct" ? "single-binary" : mode === "lite" ? "bun-script" : undefined,
    compatibleRuntimeGenerations: mode === "core"
      ? [`bun-${MIN_BUN_VERSION.join(".")}`, `bun-${MIN_BUN_VERSION.join(".")}-single-binary`]
      : undefined,
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

async function installProductionDependencies(appDir, bunPath, mode) {
  await copyFile(join(PROJECT_ROOT, "bun.lock"), join(appDir, "bun.lock"));
  await run(
    bunPath,
    ["install", "--production", "--no-optional", "--frozen-lockfile"],
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
  await rm(join(appDir, "bun.lock"), { force: true });
  await removeSourceMaps(nodeModules);

  if (!existsSync(join(nodeModules, "@openai", "codex-sdk"))) {
    throw new Error("生产依赖中缺少 @openai/codex-sdk");
  }
  if (mode === "direct") await ensureLarkCliBinary(appDir);
  await relativizeBunModuleSymlinks(appDir);
  await writePortablePackageJson(appDir, mode);
}

async function relativizeBunModuleSymlinks(appDir) {
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
  await rm(shim, { force: true });
  await writeFile(
    shim,
    "#!/bin/sh\nset -eu\nSELF_DIR=$(CDPATH= cd -P -- \"$(dirname -- \"$0\")\" && pwd -P)\nexec \"$SELF_DIR/../@larksuite/cli/bin/lark-cli\" \"$@\"\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(shim, 0o755);
}

async function compilePortableBinary(outputPath) {
  const result = await Bun.build({
    entrypoints: [join(PROJECT_ROOT, "scripts", "portable-entry.mjs")],
    compile: {
      target: `bun-${process.platform}-${process.arch}`,
      outfile: outputPath,
    },
    minify: true,
  });
  if (!result.success) {
    throw new Error(`Bun 单二进制编译失败：\n${result.logs.map((log) => log.message).join("\n")}`);
  }
  await chmod(outputPath, 0o755);
}

async function trimSingleBinaryDirectPackage(appDir) {
  const distDir = join(appDir, "dist");
  for (const entry of await readdir(distDir)) {
    if (entry !== "web") await rm(join(distDir, entry), { recursive: true, force: true });
  }
  await rm(join(appDir, "scripts"), { recursive: true, force: true });
  const modulesDir = join(appDir, "node_modules");
  for (const entry of await readdir(modulesDir)) {
    if (entry !== "@larksuite" && entry !== ".bin") {
      await rm(join(modulesDir, entry), { recursive: true, force: true });
    }
  }
  const binDir = join(modulesDir, ".bin");
  for (const entry of await readdir(binDir)) {
    if (entry !== "lark-cli") await rm(join(binDir, entry), { recursive: true, force: true });
  }
}

async function copyBunRuntime(runtimeDir, requestedBunPath) {
  const bunPath = await realpath(requestedBunPath);
  const runtime = execFileSync(bunPath, ["-e", "process.stdout.write(`${process.platform}/${process.arch}`)"], { encoding: "utf8" }).trim();
  if (runtime !== `${process.platform}/${process.arch}`) {
    throw new Error(`Bun 架构与发布目标不匹配：${runtime} != ${process.platform}/${process.arch}`);
  }
  const version = execFileSync(bunPath, ["--version"], { encoding: "utf8" }).trim();
  const numbers = version.replace(/[+-].*$/, "").split(".").map(Number);
  if (numbers.some((value) => !Number.isInteger(value)) || compareVersions(numbers, MIN_BUN_VERSION) < 0) {
    throw new Error(`Bun 版本过低：${version}，需要 >= ${MIN_BUN_VERSION.join(".")}`);
  }
  const binDir = join(runtimeDir, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  const bundledBunPath = join(binDir, "bun");
  await copyFile(bunPath, bundledBunPath);
  await chmod(bundledBunPath, 0o755);
  await writeFile(join(runtimeDir, ".bundled-bun"), `${version}\n`, "utf8");
  const licenseCandidates = [
    resolve(dirname(bunPath), "..", "LICENSE"),
    resolve(dirname(bunPath), "..", "..", "LICENSE"),
  ];
  const licensePath = licenseCandidates.find((candidate) => existsSync(candidate));
  if (licensePath) await copyFile(licensePath, join(runtimeDir, "BUN-LICENSE.txt"));
}

async function runSmokeTests(stageDir, buildBunPath, mode) {
  const bundledBun = join(stageDir, "runtime", "bin", "bun");
  const bun = existsSync(bundledBun) ? bundledBun : resolve(buildBunPath);
  const app = join(stageDir, "app");
  if (mode === "core") {
    await run("sh", ["-n", join(stageDir, "feishu-codex-bridge")], { cwd: stageDir });
    await run("sh", ["-n", join(stageDir, "install.command")], { cwd: stageDir });
    await run(join(app, "feishu-codex-bridge"), ["--bridge-version"], {
      cwd: stageDir,
      env: {
        ...process.env,
        FEISHU_CODEX_BRIDGE_SINGLE_BINARY: "1",
        FEISHU_CODEX_BRIDGE_APP_ROOT: app,
        FEISHU_CODEX_BRIDGE_PORTABLE_ROOT: stageDir,
      },
    });
    return;
  }
  if (mode === "direct") {
    await run("sh", ["-n", join(stageDir, "feishu-codex-bridge")], { cwd: stageDir });
    await run("sh", ["-n", join(stageDir, "install.command")], { cwd: stageDir });
    const env = {
      ...process.env,
      FEISHU_CODEX_BRIDGE_SINGLE_BINARY: "1",
      FEISHU_CODEX_BRIDGE_APP_ROOT: app,
      FEISHU_CODEX_BRIDGE_PORTABLE_ROOT: stageDir,
      PATH: "/usr/bin:/bin",
    };
    await run(join(stageDir, "feishu-codex-bridge"), ["--version"], { cwd: stageDir, env });
    await run(join(app, "feishu-codex-bridge"), ["--bridge-main", "--help"], { cwd: app, env });
    await run(join(app, "feishu-codex-bridge"), ["--bridge-codex", "--help"], { cwd: app, env });
    await run(join(app, "feishu-codex-bridge"), ["--bridge-install", "--help"], { cwd: app, env });
    await run(join(app, "feishu-codex-bridge"), ["--bridge-smoke"], { cwd: stageDir, env });
    if (existsSync(join(stageDir, "runtime", "bin", "bun"))) throw new Error("Direct 单二进制包不应附带独立 Bun runtime");
    if (existsSync(join(app, "dist", "main.js"))) throw new Error("Direct 单二进制包不应保留可执行 JS 运行产物");
    return;
  }
  const env = {
    ...process.env,
    PATH: `${join(stageDir, "runtime", "bin")}:${join(app, "node_modules", ".bin")}:${process.env.PATH || ""}`,
  };
  await run(bun, [join(app, "dist", "main.js"), "--help"], { cwd: app, env });
  await run(bun, [join(app, "dist", "codex-cli.js"), "--help"], { cwd: app, env });
  await run(
    bun,
    ["-e", [
      'import { Codex } from "@openai/codex-sdk";',
      'new Codex({ codexPathOverride: "codex" });',
      'import { Database } from "bun:sqlite";',
      'const sqlite = new Database(":memory:");',
      'sqlite.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT)");',
      'sqlite.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");',
      'if (sqlite.prepare("SELECT value FROM smoke").get().value !== "ok") throw new Error("bun:sqlite smoke test failed");',
      'sqlite.close();',
      mode === "direct"
        ? 'await import("./dist/direct-feishu-setup.js");'
        : 'await import("./dist/aamp-task-agent.js");',
      'console.log("portable Bun runtime smoke test passed");',
    ].join("\n")],
    { cwd: app, env },
  );
}

async function writePortableReadme(stageDir, packageName, mode) {
  if (mode === "core") {
    await writeFile(join(stageDir, "README.md"), [
      "# Feishu Codex Bridge Core Update Package",
      "",
      `目标平台：${packageName}`,
      "",
      "这是已安装 Portable 包使用的核心更新包，不是独立安装包。",
      "它包含 Bridge 单二进制更新产物、启动器和安装器，不包含 Bun、node_modules、lark-cli、config.json 或 runtime 数据。",
      "",
      "请在已安装包目录执行 `./feishu-codex-bridge update`，不要直接运行本包中的 install.command。",
      "",
    ].join("\n"), "utf8");
    return;
  }
  const bundled = existsSync(join(stageDir, "runtime", "bin", "bun"));
  const content = `# Feishu Codex Bridge Portable Runtime ${mode === "direct" ? "Direct" : "Lite"}\n\n`
    + `目标平台：${packageName}\n\n`
    + "## 使用\n\n"
    + (mode === "direct"
      ? "1. 双击 `install.command`，安装器会通过飞书二维码创建直连 Bot，并写入 lark-cli profile。\n"
      : "1. 双击 `install.command`，或在终端执行 `./feishu-codex-bridge install`。\n")
    + (mode === "direct"
      ? "2. 直连包将 Bun runtime 与 Bridge 主程序编译为单一二进制，并附带 lark-cli 原生组件与 Web 静态资源；不启动 AAMP 服务。\n"
      : "2. 安装器会自动查找 ChatGPT App 内置的 Codex；如果电脑另有独立 Codex CLI，也会自动使用。\n")
    + "3. 按提示选择要处理的 Git 仓库并完成 Feishu 授权。\n\n"
    + (mode === "direct"
      ? "Direct 单二进制启动不依赖系统 Node、Bun 或运行时下载。\n"
      : `启动器优先使用包内 Bun，其次使用系统 Bun >=${MIN_BUN_VERSION.join(".")}；如果找不到，会从官方发行页下载固定版本并验证 SHA-256 后缓存到 runtime/。${bundled ? "此包内置运行时，可离线启动。" : ""}\n`)
    + "SQLite 使用 Bun 内置的 bun:sqlite，不包含原生 SQLite 扩展。\n"
    + "Bun 运行时按发布包标记的 macOS CPU 架构提供，不假设 universal 二进制。\n\n"
    + (mode === "lite"
      ? "已有配置启用 AAMP 时，请使用 `./feishu-codex-bridge aamp:start --config <path>`；`service start` 仅启动原生直连 Codex。\n\n"
      : "Direct 模式不启动 AAMP；`service start` 启动原生直连 Codex。\n\n")
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

async function validateBun(bunPath) {
  if (!existsSync(bunPath)) throw new Error(`指定的 Bun 不存在：${bunPath}`);
  const runtime = execFileSync(bunPath, ["-e", "process.stdout.write(`${process.platform}/${process.arch}`)"], { encoding: "utf8" }).trim();
  if (runtime !== `${process.platform}/${process.arch}`) {
    throw new Error(`Bun 架构与发布目标不匹配：${runtime} != ${process.platform}/${process.arch}`);
  }
  const version = execFileSync(bunPath, ["--version"], { encoding: "utf8" }).trim();
  const numbers = version.replace(/[+-].*$/, "").split(".").slice(0, 3).map(Number);
  if (numbers.some((value) => !Number.isInteger(value)) || compareVersions(numbers, MIN_BUN_VERSION) < 0) {
    throw new Error(`Bun 版本过低：${version}，需要 >= ${MIN_BUN_VERSION.join(".")}`);
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

async function installGeneratedPackage(stageDir, packageDir, outputDir, packageName) {
  const stagingDir = join(outputDir, `.${packageName}.staging-${process.pid}-${Date.now()}`);
  const backupDir = join(outputDir, `.${packageName}.previous-${process.pid}-${Date.now()}`);
  let previousMoved = false;
  let stagedMoved = false;
  try {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
    await cp(stageDir, stagingDir, { recursive: true, verbatimSymlinks: true });
    if (existsSync(packageDir)) {
      await rename(packageDir, backupDir);
      previousMoved = true;
    }
    await rename(stagingDir, packageDir);
    stagedMoved = true;
    await rm(backupDir, { recursive: true, force: true });
    previousMoved = false;
  } catch (error) {
    if (stagedMoved) await rm(packageDir, { recursive: true, force: true });
    if (previousMoved && !existsSync(packageDir)) await rename(backupDir, packageDir);
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    if (!previousMoved) await rm(backupDir, { recursive: true, force: true });
  }
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
