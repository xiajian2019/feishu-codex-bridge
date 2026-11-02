import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import webConfig from "../web/vite.config.js";
import appConfig from "../web/vite.mobile.config.js";

const repositoryRoot = normalizePath(fileURLToPath(new URL("..", import.meta.url))).replace(/\/$/, "");

function ignoredDirectories(config: typeof webConfig): string[] {
  const watch = config.server?.watch;
  if (!watch || !Array.isArray(watch.ignored) || watch.ignored.some((pattern) => typeof pattern !== "string")) {
    throw new Error("Expected explicit directory globs in Vite server.watch.ignored.");
  }
  return watch.ignored as string[];
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await Bun.sleep(20);
  }
}

it("shares native/build directory exclusions between Web and App without excluding web source", () => {
  const expected = ["android", "ios", "dist"].map((directory) => `${repositoryRoot}/${directory}/**`);
  expect(ignoredDirectories(webConfig)).toEqual(expected);
  expect(ignoredDirectories(appConfig)).toEqual(expected);
});

for (const [name, config] of [["Web", webConfig], ["App", appConfig]] as const) {
  it(`${name} Vite watcher ignores native/build files and observes shared Web TS/CSS`, async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "bridge-vite-watch-"));
    const ignoredFiles = [
      "android/app/src/main/java/BridgeNative.java",
      "ios/App/App/BridgeNative.swift",
      "dist/mobile/app.js",
      "dist/web/app.js",
    ];
    const sharedFiles = ["web/src/shared.ts", "web/src/shared.css", "web/src/mobile-native.ts"];
    const files = [...ignoredFiles, ...sharedFiles];
    let server: ViteDevServer | undefined;
    try {
      await Promise.all(files.map(async (file) => {
        const target = join(fixtureRoot, file);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "initial\n");
      }));
      const ignored = ignoredDirectories(config).map((pattern) =>
        normalizePath(fixtureRoot) + pattern.slice(repositoryRoot.length),
      );
      server = await createServer({
        configFile: false,
        // Deliberately watch the whole fixture: exclusions must work even if a
        // plugin adds native/build paths outside the normal web-only root.
        root: fixtureRoot,
        cacheDir: join(fixtureRoot, ".vite"),
        publicDir: false,
        logLevel: "silent",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          middlewareMode: true,
          ws: false,
          watch: { ignored, usePolling: true, interval: 20, binaryInterval: 20 },
        },
      });
      const watcher = server.watcher;
      const changes: string[] = [];
      watcher.on("change", (file) => changes.push(normalizePath(relative(fixtureRoot, file))));
      await waitFor(() => {
        const watched = watcher.getWatched();
        return sharedFiles.every((file) => {
          const target = join(fixtureRoot, file);
          return watched[dirname(target)]?.includes(file.slice(file.lastIndexOf("/") + 1));
        });
      }, "Vite to watch all shared files");

      await Promise.all(files.map((file) => writeFile(join(fixtureRoot, file), "changed contents\n")));
      await waitFor(() => sharedFiles.every((file) => changes.includes(file)), "shared TS/CSS change events");
      // Allow multiple polling rounds for any incorrectly watched native files.
      await Bun.sleep(200);
      expect(changes.filter((file) => ignoredFiles.includes(file))).toEqual([]);
      expect([...new Set(changes)].sort()).toEqual([...sharedFiles].sort());
    } finally {
      await server?.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 10_000);
}
