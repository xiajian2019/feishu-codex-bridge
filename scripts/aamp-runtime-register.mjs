import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { load as patchAampModule } from "./aamp-runtime-loader.mjs";

const bun = globalThis.Bun;
if (!bun) throw new Error("AAMP runtime compatibility requires Bun");

bun.plugin({
  name: "feishu-codex-bridge-aamp-runtime",
  setup(build) {
    build.onLoad(
      {
        filter: /(?:aamp-feishu-bridge\/dist\/runtime\.js|aamp-feishu-task-agent\/bin\/feishu-task-agent-controller\.mjs|aamp-acp-bridge\/dist\/(?:acpx-client|agent-bridge)\.js)$/,
      },
      async ({ path }) => {
        const source = await readFile(path, "utf8");
        const result = await patchAampModule(
          pathToFileURL(path).href,
          {},
          async () => ({ format: "module", source }),
        );
        if (result.source === source) return null;
        return { contents: result.source, loader: "js" };
      },
    );
  },
});
