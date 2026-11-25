import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, accessSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MobileApkStore } from "./mobile-apk.js";
import type { StoredMobileApp, StoredMobileAndroidConfig } from "./types.js";

export type MobileAndroidBuildState = "idle" | "running" | "succeeded" | "failed";

interface PersistedBuild {
  state: MobileAndroidBuildState;
  configKey: string;
  ownerPid?: number;
  childPid?: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

export interface MobileAndroidBuildStatus {
  available: boolean;
  sourcePath: string | null;
  scriptPath: string | null;
  state: MobileAndroidBuildState;
  message?: string;
  unavailableReason?: string;
  startedAt?: string;
  finishedAt?: string;
  log?: string;
}

const DEFAULT_BUILD_SCRIPT = "scripts/build-apk.mjs";
const APK_SUFFIX = join("android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourcePath(config: StoredMobileAndroidConfig): string | null {
  if (config.source_path) return resolve(config.source_path);
  const suffix = sep + APK_SUFFIX;
  const apk = resolve(config.apk_path);
  return apk.endsWith(suffix) ? apk.slice(0, -suffix.length) || sep : null;
}

function resolveScript(config: StoredMobileAndroidConfig): { source: string; script: string } {
  const source = sourcePath(config);
  if (!source) throw new Error("请在 Android 配置中填写源码目录。");
  const scriptName = config.build_script || DEFAULT_BUILD_SCRIPT;
  if (isAbsolute(scriptName) || scriptName.split(/[\\/]/).includes("..") || !/\.(?:[cm]?js|ts)$/.test(scriptName)) {
    throw new Error("Android 构建脚本必须是源码目录内的 JavaScript 或 TypeScript 相对路径。");
  }
  let root: string;
  let script: string;
  try {
    root = realpathSync(source);
    script = realpathSync(resolve(root, scriptName));
    if (!statSync(root).isDirectory() || !statSync(script).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`找不到 Android 源码目录或构建脚本：${join(source, scriptName)}`);
  }
  const path = relative(root, script);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("Android 构建脚本必须位于源码目录内。");
  return { source: root, script };
}

function bunPath(): string | null {
  const configured = process.env.FEISHU_CODEX_BRIDGE_ANDROID_BUILD_BUN?.trim();
  const candidates = [configured, /^bun(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : null,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, "bun"))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try the next executable */ }
  }
  return null;
}

function isAlive(pid?: number): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function configKey(config: StoredMobileAndroidConfig): string {
  return digest(JSON.stringify([config.package_name, config.apk_path, config.snapshot_directory, config.source_path ?? "", config.build_script ?? ""]));
}

function statusPath(app: StoredMobileApp, suffix: string): string {
  return join(tmpdir(), "bridge-managed-android-builds", `${digest(app.id).slice(0, 24)}.${suffix}`);
}

function readBuild(app: StoredMobileApp): PersistedBuild | null {
  try {
    const value = JSON.parse(readFileSync(statusPath(app, "json"), "utf8")) as PersistedBuild;
    if (value.configKey !== configKey(app.android!) || !["running", "succeeded", "failed"].includes(value.state)) return null;
    return value;
  } catch { return null; }
}

function persist(app: StoredMobileApp, status: PersistedBuild): void {
  const file = statusPath(app, "json");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(status), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

function logTail(app: StoredMobileApp): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(statusPath(app, "log"), "r");
    const size = statSync(statusPath(app, "log")).size;
    const buffer = Buffer.alloc(Math.min(size, 12_000));
    const bytes = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, bytes).toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim() || undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

interface LockOwner { token: string; ownerPid: number; childPid?: number }

/** Lock the real checkout, even when multiple app records or Bridge processes use it. */
function lockDirectory(source: string): string {
  return join(tmpdir(), `bridge-managed-android-${digest(source).slice(0, 24)}.lock`);
}

function activeLock(source: string): boolean {
  const directory = lockDirectory(source);
  try {
    const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as LockOwner;
    return isAlive(owner.ownerPid) || isAlive(owner.childPid);
  } catch {
    try { return Date.now() - statSync(directory).mtimeMs < 30_000; } catch { return false; }
  }
}

function acquireLock(source: string): { setChild: (pid: number) => void; release: () => void } {
  const directory = lockDirectory(source);
  const ownerPath = join(directory, "owner.json");
  const token = randomUUID();
  const create = (): void => {
    mkdirSync(directory, { mode: 0o700 });
    try { writeFileSync(ownerPath, JSON.stringify({ token, ownerPid: process.pid }), { mode: 0o600, flag: "wx" }); }
    catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  };
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const guard = `${directory}.reclaim`;
    try { mkdirSync(guard, { mode: 0o700 }); }
    catch { throw new Error("该源码目录的 Android 构建正在进行中，请稍后重试。"); }
    try {
      let owner: LockOwner | null = null;
      try { owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner; } catch { /* owner may still be written */ }
      const recent = (() => { try { return Date.now() - statSync(directory).mtimeMs < 30_000; } catch { return true; } })();
      if ((owner && (isAlive(owner.ownerPid) || isAlive(owner.childPid))) || (!owner && recent)) {
        throw new Error("该源码目录的 Android 构建正在进行中，请稍后重试。");
      }
      rmSync(directory, { recursive: true, force: true });
      try { create(); } catch { throw new Error("该源码目录的 Android 构建正在进行中，请稍后重试。"); }
    } finally { rmSync(guard, { recursive: true, force: true }); }
  }
  return {
    setChild(pid) { writeFileSync(ownerPath, JSON.stringify({ token, ownerPid: process.pid, childPid: pid }), { mode: 0o600 }); },
    release() {
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
        if (owner.token === token) rmSync(directory, { recursive: true, force: true });
      } catch { /* never remove a lock owned by another build */ }
    },
  };
}

function fileIdentity(path: string): string | null {
  try { const file = statSync(path); return `${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`; }
  catch { return null; }
}

export class MobileAndroidBuild {
  private readonly children = new Map<string, ChildProcess>();

  status(app: StoredMobileApp): MobileAndroidBuildStatus {
    if (!app.android) return { available: false, sourcePath: null, scriptPath: null, state: "idle", unavailableReason: "该 App 未配置 Android。" };
    const config = app.android;
    let paths: { source: string; script: string } | null = null;
    let unavailableReason: string | undefined;
    try { paths = resolveScript(config); }
    catch (error) { unavailableReason = error instanceof Error ? error.message : "Android 构建配置不可用。"; }
    if (!app.enabled) unavailableReason = "该 App 已停用。";
    else if (!unavailableReason && !bunPath()) unavailableReason = "找不到 Bun，无法启动 Android 构建。";
    const saved = readBuild(app);
    let state = saved?.state ?? "idle";
    let message = saved?.message;
    const locked = paths ? activeLock(paths.source) : false;
    if (state === "running" && !this.children.has(app.id) && !locked) {
      state = "failed";
      message = "构建进程已结束，但 Bridge 未收到结果；请检查日志后重试。";
    }
    if (!unavailableReason && locked && state !== "running") unavailableReason = "该源码目录的 Android 构建正在进行中。";
    return {
      available: !unavailableReason && state !== "running", sourcePath: paths?.source ?? sourcePath(config),
      scriptPath: paths?.script ?? null, state, message, unavailableReason,
      startedAt: saved?.startedAt, finishedAt: saved?.finishedAt, log: saved ? logTail(app) : undefined,
    };
  }

  start(app: StoredMobileApp): MobileAndroidBuildStatus {
    if (!app.android) throw new Error("该 App 未配置 Android。");
    if (!app.enabled) throw new Error("该 App 已停用。");
    if (this.status(app).state === "running") throw new Error("该 App 的 Android 构建正在进行中，请稍后查看状态。");
    const config = app.android;
    const paths = resolveScript(config);
    const bun = bunPath();
    if (!bun) throw new Error("找不到 Bun，无法启动 Android 构建。");
    const lock = acquireLock(paths.source);
    let child: ChildProcess | undefined;
    let spawnError: string | undefined;
    const startedAt = new Date().toISOString();
    const key = configKey(config);
    const previous = fileIdentity(config.apk_path);
    try {
      mkdirSync(dirname(statusPath(app, "log")), { recursive: true, mode: 0o700 });
      const fd = openSync(statusPath(app, "log"), "w", 0o600);
      try { child = spawn(bun, [paths.script], { cwd: paths.source, env: process.env, stdio: ["ignore", fd, fd] }); }
      finally { closeSync(fd); }
      child.once("error", (error) => { spawnError = error.message; });
      if (!child.pid) throw new Error("Android 构建进程无法启动。");
      lock.setChild(child.pid);
      persist(app, { state: "running", configKey: key, ownerPid: process.pid, childPid: child.pid, startedAt, message: "正在构建 Android APK。" });
      this.children.set(app.id, child);
    } catch (error) {
      child?.kill("SIGTERM");
      lock.release();
      throw error;
    }
    const running = child;
    running.once("close", (code, signal) => {
      void (async () => {
        let state: MobileAndroidBuildState = "failed";
        let message: string;
        try {
          if (spawnError || code !== 0) throw new Error(spawnError || `构建脚本退出（${signal ?? code ?? "unknown"}）`);
          const artifact = await new MobileApkStore(config.apk_path, config.snapshot_directory, {
            expectedPackageName: config.package_name,
            downloadPath: `/api/mobile/apps/${encodeURIComponent(app.id)}/android/download`,
          }).latest();
          if (!artifact) throw new Error("构建结束后没有找到配置的 APK。");
          state = "succeeded";
          const reused = previous !== null && previous === fileIdentity(config.apk_path);
          message = reused ? "构建完成，APK 元数据已校验（构建脚本复用了已有 APK）。" : "构建完成，APK 元数据已校验并生成下载快照。";
        } catch (error) {
          message = `Android 构建失败：${error instanceof Error ? error.message : String(error)}`;
        }
        try { persist(app, { state, configKey: key, startedAt, finishedAt: new Date().toISOString(), message }); }
        finally { this.children.delete(app.id); lock.release(); }
      })().catch(() => { this.children.delete(app.id); lock.release(); });
    });
    return this.status(app);
  }
}
