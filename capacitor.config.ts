import type { CapacitorConfig } from "@capacitor/cli";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const version = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")).version as string;

const config: CapacitorConfig = {
  appId: "dev.feishu.codex.bridge",
  appName: "Bridge",
  webDir: "dist/mobile",
  // Plugin calls can contain pairing credentials, including in debug builds.
  loggingBehavior: "none",
  // Packaged assets only. A remote server.url would replace the trusted app UI.
  server: {
    hostname: "localhost",
    iosScheme: "capacitor",
    // A local HTTP origin permits self-hosted LAN HTTP without mixed content.
    // The connection screen limits HTTP destinations to private/local addresses.
    androidScheme: "http",
  },
  ios: {
    contentInset: "never",
    allowsLinkPreview: false,
    appendUserAgent: `BridgeApp/${version} (iOS)`,
  },
  android: {
    allowMixedContent: false,
    appendUserAgent: `BridgeApp/${version} (Android)`,
  },
};

export default config;
