import { mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import webConfig from "./vite.config.js";

const config = mergeConfig(webConfig, {
  define: {
    "import.meta.env.VITE_BRIDGE_MOBILE": JSON.stringify("true"),
    "import.meta.env.VITE_BRIDGE_FRONTEND_VERSION": JSON.stringify(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version),
    "import.meta.env.VITE_BRIDGE_FRONTEND_BUILD": JSON.stringify(process.env.BRIDGE_FRONTEND_BUILD || new Date().toISOString()),
  },
  plugins: [{
    name: "bridge-mobile-viewport",
    transformIndexHtml(html) {
      return html.replace('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"');
    },
  }],
  build: { outDir: fileURLToPath(new URL("../dist/mobile", import.meta.url)), emptyOutDir: true },
});

// The normal Web build substitutes a browser-only runtime. The App uses the
// actual runtime while retaining the shared React/Vite configuration.
config.resolve = { ...config.resolve, alias: [] };
export default config;
