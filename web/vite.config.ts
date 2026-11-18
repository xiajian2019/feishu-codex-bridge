import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import { noVncCompatibility } from "./novnc-compat.js";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const apiTarget = process.env.BRIDGE_WEB_API_TARGET ?? "http://127.0.0.1:17310";
const tmuxApiTarget = process.env.BRIDGE_TMUX_API_TARGET ?? apiTarget;
const tmuxWebSocketTarget = tmuxApiTarget.replace(/^http/, "ws");
const dualProxy = process.env.BRIDGE_DEV_PROXY_INTERNAL === "1";
function readIosOtaProxyTarget(): string | undefined {
  const configured = process.env.BRIDGE_IOS_OTA_PROXY_TARGET?.trim();
  if (configured) return configured;
  try {
    const file = fileURLToPath(new URL("../ios/App/build/ios-ota/service.json", import.meta.url));
    const settings = JSON.parse(readFileSync(file, "utf8")) as { port?: unknown; direct?: { ip?: unknown } | null };
    if (!Number.isInteger(settings.port) || Number(settings.port) < 1 || Number(settings.port) > 65535) return undefined;
    const ip = typeof settings.direct?.ip === "string" && settings.direct.ip ? settings.direct.ip : null;
    return `${ip ? `https://${ip}` : "http://127.0.0.1"}:${settings.port}`;
  } catch {
    return undefined;
  }
}
const iosOtaProxyTarget = readIosOtaProxyTarget();
const clientAddress = (request: import("node:http").IncomingMessage): string | undefined => {
  const forwarded = request.headers["x-bridge-dev-peer"];
  return dualProxy && typeof forwarded === "string" ? forwarded : request.socket.remoteAddress;
};

export default defineConfig({
  root: webRoot,
  // Separate Vite processes must not replace each other's optimized files while
  // a long-lived browser still references them. The OS can clean up old caches.
  cacheDir: join(tmpdir(), `feishu-codex-bridge-vite-${process.pid}`),
  // These are loaded lazily by the photo/live scanner and must be available
  // before a phone opens the pairing screen.
  optimizeDeps: { include: ["jsqr", "qr-scanner"], exclude: ["@novnc/novnc"] },
  plugins: [noVncCompatibility(), react()],
  resolve: {
    alias: [
      { find: /^\.\/mobile-runtime\.js$/, replacement: fileURLToPath(new URL("./src/mobile-runtime.browser.ts", import.meta.url)) },
      { find: /^\.\/ssh-connectbot-native\.js$/, replacement: fileURLToPath(new URL("./src/ssh-connectbot-native.browser.ts", import.meta.url)) },
      { find: /^\.\/native-theme\.js$/, replacement: fileURLToPath(new URL("./src/native-theme.browser.ts", import.meta.url)) },
    ],
  },
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    ...(dualProxy ? { hmr: { clientPort: Number(process.env.BRIDGE_DEV_PUBLIC_PORT) || 5173 } } : {}),
    cors: {
      origin: ["capacitor://localhost", "http://localhost", "https://localhost"],
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Accept", "Authorization", "Content-Type", "X-Bridge-Action-Token"],
    },
    watch: {
      // Native projects and generated assets must not invalidate the Web dev server.
      // Keep shared web/src modules watched, even when they also serve the App.
      ignored: ["../android/**", "../ios/**", "../dist/**"].map((path) =>
        normalizePath(fileURLToPath(new URL(path, import.meta.url))),
      ),
    },
    proxy: {
      ...(iosOtaProxyTarget ? {
        "/ios-ota": {
          target: iosOtaProxyTarget,
          secure: false,
          rewrite: (path: string) => {
            const rewritten = path.replace(/^\/ios-ota(?=\/|\?|$)/, "");
            return rewritten || "/";
          },
        },
      } : {}),
      "/tmux-dashboard/api": {
        target: tmuxApiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest, request) => {
            const forwardedHostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
            const forwardedHost = Array.isArray(forwardedHostHeader) ? forwardedHostHeader[0] : forwardedHostHeader;
            if (forwardedHost) proxyRequest.setHeader("X-Forwarded-Host", forwardedHost.split(",", 1)[0]!.trim());

            const forwardedProtoHeader = request.headers["x-forwarded-proto"];
            const forwardedProto = (Array.isArray(forwardedProtoHeader) ? forwardedProtoHeader[0] : forwardedProtoHeader)
              ?.split(",", 1)[0]
              ?.trim();
            proxyRequest.setHeader("X-Forwarded-Proto", forwardedProto || "http");

            const forwardedPortHeader = request.headers["x-forwarded-port"];
            const forwardedPort = Array.isArray(forwardedPortHeader) ? forwardedPortHeader[0] : forwardedPortHeader;
            if (forwardedPort) proxyRequest.setHeader("X-Forwarded-Port", forwardedPort.split(",", 1)[0]!.trim());

            const address = clientAddress(request);
            if (address) proxyRequest.setHeader("X-Forwarded-For", address);
          });
        },
      },
      "/remote-desktop/stream": {
        target: apiTarget.replace(/^http/, "ws"),
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyRequest, request) => {
            const host = request.headers.host;
            if (host) proxyRequest.setHeader("X-Forwarded-Host", host);
            const forwarded = request.headers["x-forwarded-proto"];
            const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",", 1)[0]?.trim();
            const secure = Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
            proxyRequest.setHeader("X-Forwarded-Proto", proto || (secure ? "https" : "http"));
            const address = clientAddress(request);
            if (address) proxyRequest.setHeader("X-Forwarded-For", address);
          });
        },
      },
      "/tmux-dashboard/terminal": {
        target: tmuxWebSocketTarget,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyRequest, request) => {
            const address = clientAddress(request);
            if (address) proxyRequest.setHeader("X-Forwarded-For", address);
          });
        },
      },
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest, request) => {
            // Preserve the browser's public Origin as well as native WebView
            // origins. The Bridge validates mutating browser requests against
            // the forwarded public host/protocol; replacing a browser Origin
            // with the internal API target makes an otherwise same-origin
            // request look cross-origin and returns 403.
            const origin = request.headers.origin;
            proxyRequest.setHeader("Origin", origin || apiTarget);
            proxyRequest.removeHeader("X-Bridge-Public-Origin");
            const forwardedHostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
            const forwardedHost = Array.isArray(forwardedHostHeader) ? forwardedHostHeader[0] : forwardedHostHeader;
            if (forwardedHost) proxyRequest.setHeader("X-Forwarded-Host", forwardedHost.split(",", 1)[0]!.trim());
            const forwardedProtoHeader = request.headers["x-forwarded-proto"];
            const forwardedProto = (Array.isArray(forwardedProtoHeader) ? forwardedProtoHeader[0] : forwardedProtoHeader)
              ?.split(",", 1)[0]
              ?.trim();
            const protocol = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted || forwardedProto === "https" ? "https" : "http";
            proxyRequest.setHeader("X-Forwarded-Proto", forwardedProto || protocol);
            const host = forwardedHost?.split(",", 1)[0]?.trim() || request.headers.host;
            if (host) {
              try { proxyRequest.setHeader("X-Bridge-Public-Origin", new URL(`${protocol}://${host}`).origin); }
              catch { /* Invalid hosts are not recorded as access metadata. */ }
            }
            const address = clientAddress(request);
            if (address) proxyRequest.setHeader("X-Forwarded-For", address);
          });
        },
      },
    },
  },
});
