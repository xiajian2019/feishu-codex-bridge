import { dirname } from "node:path";

const applicationRoot = process.env.FEISHU_CODEX_BRIDGE_APP_ROOT;
if (!applicationRoot) throw new Error("请通过包内 feishu-codex-bridge 启动器运行单二进制包。");
const portableRoot = process.env.FEISHU_CODEX_BRIDGE_PORTABLE_ROOT || dirname(applicationRoot);
process.env.FEISHU_CODEX_BRIDGE_SINGLE_BINARY = "1";

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "--bridge-main": {
      const { main } = await import("../dist/main.js");
      await main(args);
      break;
    }
    case "--bridge-worker": {
      const { runWorkerCli } = await import("../dist/codex-worker.js");
      await runWorkerCli(args);
      break;
    }
    case "--bridge-codex": {
      const { runCodexCli } = await import("../dist/codex-cli.js");
      await runCodexCli(args);
      break;
    }
    case "--bridge-install": {
      const { runInstallCli } = await import("../dist/install-cli.js");
      await runInstallCli(args);
      break;
    }
    case "--bridge-web-pair": {
      const { runWebPair } = await import("../dist/web-pair-cli.js");
      await runWebPair(args);
      break;
    }
    case "--bridge-update": {
      const updater = await import("./update-portable-release.mjs");
      const options = updater.parsePortableUpdateArguments(args, portableRoot);
      await updater.updatePortableRelease(options);
      break;
    }
    case "--bridge-version": {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const manifest = JSON.parse(await readFile(join(portableRoot, "release-manifest.json"), "utf8"));
      console.log(manifest.version || "0.0.0");
      break;
    }
    case "--bridge-smoke": {
      const { StateDatabase } = await import("../dist/db.js");
      const db = new StateDatabase(":memory:");
      db.close();
      break;
    }
    default:
      throw new Error("缺少内部命令；请通过 feishu-codex-bridge 启动器运行。");
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
