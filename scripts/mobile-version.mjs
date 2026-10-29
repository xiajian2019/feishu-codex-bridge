import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function allocateMobileVersion(root, now = Date.now(), suppliedCode) {
  const statePath = join(root, "android", ".bridge-version.json");
  const lockPath = statePath + ".lock";
  const lock = openSync(lockPath, "wx", 0o600);
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    let previous = 0;
    try { previous = Number(JSON.parse(readFileSync(statePath, "utf8")).versionCode) || 0; } catch { /* First build. */ }
    try {
      const output = JSON.parse(readFileSync(join(root, "android/app/build/outputs/apk/debug/output-metadata.json"), "utf8"));
      previous = Math.max(previous, ...output.elements.map((entry) => Number(entry.versionCode) || 0));
    } catch { /* No previous APK. */ }
    const versionCode = suppliedCode === undefined
      ? Math.max(previous + 1, 30_000_000 + Math.floor((now - Date.UTC(2025, 0, 1)) / 1000)) : Number(suppliedCode);
    if (!Number.isSafeInteger(versionCode) || versionCode <= previous || versionCode > 2_100_000_000) {
      throw new Error("Android versionCode 必须大于此前构建且不超过 2100000000。");
    }
    const result = { versionName: pkg.version, versionCode, buildId: `${pkg.version}-${versionCode}` };
    writeFileSync(statePath, JSON.stringify(result), { mode: 0o600 });
    return result;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  console.log(JSON.stringify(allocateMobileVersion(root, Date.now(), process.argv[2])));
}
