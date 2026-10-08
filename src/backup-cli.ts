import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkBridgeBackupUpgradeCompatibility,
  createBridgeBackup,
  defaultBridgeAttachmentRoots,
  inspectBridgeBackupMetadata,
  listBridgeBackups,
  restoreBridgeBackup,
  verifyBridgeBackup,
} from "./bridge-backup.js";
import { resolveBridgeDataRoot } from "./portable-runtime.js";

export async function runBackupCli(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    db: { type: "string" }, out: { type: "string" }, backup: { type: "string" }, dir: { type: "string" },
    "data-root": { type: "string" }, "web-root": { type: "string" },
    "direct-root": { type: "string" }, "aamp-root": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals.length === 0) {
    console.log(`Bridge 数据备份（不启动任务或服务）
  backup create --db <bridge.db> --out <新目录> [--data-root <安装根目录>]
                [--web-root <附件目录>] [--direct-root <附件目录>] [--aamp-root <附件目录>]
  backup list --dir <备份父目录>
  backup inspect --backup <备份目录>
  backup verify --backup <备份目录>
  backup restore --backup <备份目录> --out <新目录>
  backup check-upgrade --backup <备份目录>
恢复只写入全新目录，不切换服务。备份包含 Bridge 数据库及其引用的 Web/Direct/AAMP/tmux 附件。
list/inspect 只读取清单元数据，不校验附件哈希；恢复或使用前请先 verify。check-upgrade 在临时副本上运行当前版本迁移。
自定义 Web/Direct/AAMP 附件目录需显式传入；tmux 使用 Bridge 管理的固定目录。不包含 config.json、项目仓库、Codex 账号数据或未关联的历史附件。`);
    return;
  }
  if (positionals.length !== 1) throw new Error("只允许一个备份操作：create、list、inspect、verify、restore 或 check-upgrade。");
  const required = (name: "db" | "out" | "backup" | "dir"): string => {
    const value = values[name];
    if (!value?.trim()) throw new Error(`缺少 --${name}`);
    return resolve(value);
  };
  let result: unknown;
  switch (positionals[0]) {
    case "create": {
      const databasePath = required("db");
      const roots = defaultBridgeAttachmentRoots(databasePath, values["data-root"] || resolveBridgeDataRoot(import.meta.url));
      for (const kind of ["web", "direct", "aamp"] as const) {
        const custom = values[`${kind}-root`];
        if (custom) roots[kind].push(resolve(custom));
      }
      result = await createBridgeBackup({ databasePath, outputDirectory: required("out"), attachmentRoots: roots });
      break;
    }
    case "list": result = await listBridgeBackups(required("dir")); break;
    case "inspect": result = await inspectBridgeBackupMetadata(required("backup")); break;
    case "verify": result = await verifyBridgeBackup(required("backup")); break;
    case "restore": result = await restoreBridgeBackup({ backupDirectory: required("backup"), outputDirectory: required("out") }); break;
    case "check-upgrade": result = await checkBridgeBackupUpgradeCompatibility(required("backup")); break;
    default: throw new Error("未知备份操作；使用 backup --help 查看帮助。");
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBackupCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
