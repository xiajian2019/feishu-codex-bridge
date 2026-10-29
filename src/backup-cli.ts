import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkBridgeBackupUpgradeCompatibility,
  createBridgeBackup,
  inspectBridgeBackupMetadata,
  listBridgeBackups,
  restoreBridgeBackup,
  verifyBridgeBackup,
} from "./bridge-backup.js";

export async function runBackupCli(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    db: { type: "string" }, out: { type: "string" }, backup: { type: "string" }, dir: { type: "string" },
    // Accepted for compatibility with existing scripts; SQLite backups ignore attachment roots.
    "data-root": { type: "string" }, "web-root": { type: "string" },
    "direct-root": { type: "string" }, "aamp-root": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals.length === 0) {
    console.log(`Bridge SQLite 数据备份（不启动任务或服务）
  backup create --db <bridge.db> --out <新目录>
  backup list --dir <备份父目录>
  backup inspect --backup <备份目录>
  backup verify --backup <备份目录>
  backup restore --backup <备份目录> --out <新目录>
  backup check-upgrade --backup <备份目录>
只备份 Bridge SQLite 数据库，保留一致性快照、SHA-256 和结构指纹校验。
恢复只写入全新目录，不切换服务；旧版备份也只恢复数据库，保留库内原有附件路径，不复制附件。
list/inspect 只读取清单元数据；verify 校验数据库文件；check-upgrade 在临时副本上运行当前版本迁移。`);
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
      result = await createBridgeBackup({ databasePath, outputDirectory: required("out") });
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
