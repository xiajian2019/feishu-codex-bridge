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
