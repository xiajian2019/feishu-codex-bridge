import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StateDatabase } from "../src/db.js";
import { PairingRateLimitError, WebPairingAuth } from "../src/web-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WebPairingAuth", () => {
  it("pairs a non-local device and restores its session after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-web-auth-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "bridge.db");
    const firstDb = new StateDatabase(statePath);
    const first = new WebPairingAuth({ db: firstDb });
    const remote = fakeRequest("203.0.113.20");
    const pairing = first.startPairing();
    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(first.status(remote)).toMatchObject({
      authenticated: false,
      local: false,
      pairingAvailable: true,
    });

    const secondDb = new StateDatabase(statePath);
    const second = new WebPairingAuth({ db: secondDb });
    const response = fakeResponse();
    const token = second.claimPairing(remote, pairing.code.toLowerCase().replaceAll("-", " "));
    first.setSessionCookie(remote, response as unknown as ServerResponse, token);
    const cookie = response.headers["set-cookie"];
    expect(cookie).toContain("bridge_session=");

    const authenticatedRequest = fakeRequest("203.0.113.20", cookie);
    expect(first.isAuthorized(authenticatedRequest)).toBe(true);

    expect(second.isAuthorized(authenticatedRequest)).toBe(true);
    expect(second.listDevices(authenticatedRequest)).toHaveLength(1);
    firstDb.close();
    secondDb.close();
  });

  it("consumes a pairing code once and rate-limits bad guesses", () => {
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db });
    const remote = fakeRequest("203.0.113.21");
    const pairing = auth.startPairing();
    expect(() => auth.claimPairing(remote, "AAAA-AAAA-AAAA")).toThrow("invalid pairing code");
    for (let index = 0; index < 7; index += 1) {
      expect(() => auth.claimPairing(remote, "BBBB-BBBB-BBBB")).toThrow("invalid pairing code");
    }
    expect(() => auth.claimPairing(remote, "CCCC-CCCC-CCCC")).toThrow(PairingRateLimitError);
    const validRemote = fakeRequest("203.0.113.22");
    const token = auth.claimPairing(validRemote, pairing.code);
    expect(token).toBeTruthy();
    expect(() => auth.claimPairing(validRemote, pairing.code)).toThrow("pairing code expired or unavailable");
    db.close();
  });

  it("allows an authenticated admin to rename a device", () => {
    const db = new StateDatabase(":memory:");
    const auth = new WebPairingAuth({ db });
    const remote = fakeRequest("203.0.113.23");
    const pairing = auth.startPairing();
    const response = fakeResponse();
    const token = auth.claimPairing(remote, pairing.code);
    auth.setSessionCookie(remote, response as unknown as ServerResponse, token);

    const authenticatedRequest = fakeRequest("203.0.113.23", response.headers["set-cookie"]);
    const device = auth.listDevices(authenticatedRequest)?.[0];
    expect(device?.deviceName).toBe("Browser device");
    expect(auth.renameDevice(authenticatedRequest, device!.sessionId, "办公室 iPhone")).toBe(true);
    expect(auth.listDevices(authenticatedRequest)?.[0]?.deviceName).toBe("办公室 iPhone");
    expect(auth.renameDevice(authenticatedRequest, device!.sessionId, "")).toBe(false);
    db.close();
  });
});

function fakeRequest(address: string, cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: address },
  } as unknown as IncomingMessage;
}

function fakeResponse(): { headers: Record<string, string> } & Pick<ServerResponse, "setHeader"> {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: number | string | readonly string[]): ServerResponse {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join("; ") : String(value);
      return undefined as never;
    },
  };
}
