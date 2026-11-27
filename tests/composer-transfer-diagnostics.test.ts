import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { formatTransferDiagnosticError } from "../web/src/composer-transfer-diagnostics.js";

describe("Composer transfer diagnostics", () => {
  it("keeps useful network errors while removing transfer credentials and user content", () => {
    const code = "ABC2345678";
    const token = "secret-transfer-token";
    const body = "private text";
    const filename = "private-image.png";
    const error = new Error(`Load failed: https://bridge.test/composer-transfer?code=${code} token=${token} ${body} ${filename} /Users/me/private.log`);
    const result = formatTransferDiagnosticError(error, [code, token, body, filename]);
    expect(result).toContain("Load failed");
    for (const sensitive of [code, token, body, filename, "/Users/me/private.log", "bridge.test"]) {
      expect(result).not.toContain(sensitive);
    }
  });
});

it("allows the transfer token in native App preflight through the Vite dev server", async () => {
  const server = await createServer({
    configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not expose an HTTP port");
    const endpoint = `http://127.0.0.1:${address.port}/api/composer-transfers/test/text`;
    for (const origin of ["capacitor://localhost", "http://localhost", "https://localhost"]) {
      for (const method of ["POST", "PUT"]) {
        const response = await fetch(endpoint, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,content-type,x-bridge-transfer-token,x-bridge-session-created-at",
          },
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
        expect(response.headers.get("access-control-allow-methods")?.split(",")).toContain(method);
        expect(response.headers.get("access-control-allow-headers")?.toLowerCase().split(",")).toContain("x-bridge-transfer-token");
        expect(response.headers.get("access-control-allow-headers")?.toLowerCase().split(",")).toContain("x-bridge-session-created-at");
      }
    }
  } finally {
    await server.close();
  }
}, 20_000);
