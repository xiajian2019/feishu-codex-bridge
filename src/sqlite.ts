import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const isBunRuntime = typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== "undefined";
const sqliteModule = require(isBunRuntime ? "bun:sqlite" : "node:sqlite");

export const DatabaseSync = (
  isBunRuntime ? sqliteModule.Database : sqliteModule.DatabaseSync
) as typeof import("node:sqlite").DatabaseSync;
export type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
