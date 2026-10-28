import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const assets = (platform) => readdirSync(resolve(root, "dist", platform, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, code: readFileSync(resolve(root, "dist", platform, "assets", name), "utf8") }));
  const webAssets = assets("web");
  const appAssets = assets("mobile");
  const leaked = webAssets.filter(({ code }) => /BridgeCredentials|CapacitorHttp|bridge\.mobile\.server/.test(code));
  if (leaked.length) throw new Error("浏览器产物包含 App 运行时：" + leaked.map(({ name }) => name).join(", "));
  if (!appAssets.some(({ code }) => code.includes("BridgeCredentials"))) throw new Error("App 产物缺少原生凭据插件。");
  const webHtml = readFileSync(resolve(root, "dist/web/index.html"), "utf8");
  const appHtml = readFileSync(resolve(root, "dist/mobile/index.html"), "utf8");
  if (webHtml.includes("viewport-fit=cover") || !appHtml.includes("viewport-fit=cover")) throw new Error("Web 与 App 的 viewport 配置未隔离。");
  console.log("PASS: Web 产物不含原生插件或 App 凭据逻辑；App 构建与安全区配置独立。");
} catch (error) {
  console.error(error.message);
  console.error("请先运行 bun run build:web 和 bun run mobile:build，再运行 bun run mobile:verify。");
  process.exitCode = 1;
}
