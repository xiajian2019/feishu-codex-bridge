import { createRequire } from "node:module";

// Vite/Vitest versions used by this project predate node:sqlite in their
// builtin-module list and otherwise try to resolve it as an npm package named
// `sqlite`. Resolve it through Node itself while keeping the Node 22 types.
const require = createRequire(import.meta.url);
const SQLITE_MODULE = "node:" + "sqlite";

export const { DatabaseSync } = require(SQLITE_MODULE) as typeof import("node:sqlite");
export type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
