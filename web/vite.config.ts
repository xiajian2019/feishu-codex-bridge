import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const apiTarget = process.env.BRIDGE_WEB_API_TARGET ?? "http://127.0.0.1:17310";
const tmuxApiTarget = process.env.BRIDGE_TMUX_API_TARGET ?? apiTarget;
const tmuxWebSocketTarget = tmuxApiTarget.replace(/^http/, "ws");

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
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

            const address = request.socket.remoteAddress;
            if (address) proxyRequest.setHeader("X-Forwarded-For", address);
          });
        },
      },
      "/tmux-dashboard/terminal": {
        target: tmuxWebSocketTarget,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyRequest, request) => {
            const address = request.socket.remoteAddress;
            if (address) proxyRequest.setHeader("X-Forwarded-For", address);
          });
        },
      },
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest, request) => {
            proxyRequest.setHeader("Origin", apiTarget);
            const address = request.socket.remoteAddress;
            if (address) proxyRequest.setHeader("X-Forwarded-For", address);
          });
        },
      },
    },
  },
});
