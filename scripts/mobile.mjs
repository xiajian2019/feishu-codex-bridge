import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const command = process.argv[2] ?? "build";
const platform = process.argv[3];

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === "build") {
  run(["run", "--bun", "vite", "build", "--config", "web/vite.mobile.config.ts"]);
  run(["run", "--bun", "cap", "sync"]);
} else if (command === "sync") {
  if (!existsSync(new URL("../dist/mobile/index.html", import.meta.url))) {
    console.error("手机前端尚未构建。请先运行 bun run mobile:build。");
    process.exit(1);
  }
  run(["run", "--bun", "cap", "sync"]);
} else if (command === "open" && ["ios", "android"].includes(platform)) {
  run(["run", "--bun", "cap", "open", platform]);
} else {
  console.error("Usage: bun scripts/mobile.mjs build|sync|open ios|android");
  process.exit(1);
}
