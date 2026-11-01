import { describe, expect, it } from "bun:test";
import {
  base64ToBytes,
  base64ToString,
  bytesToBase64,
  decodeBase64,
  encodeBase64,
  isBridgeSSHConnectionState,
  normalizeSshConnectRequest,
  normalizeSshDimensions,
  normalizeSshHost,
  normalizeSshPrivateKeyInfo,
  normalizeSshPort,
  SSH_MAX_PRIVATE_KEY_PASSPHRASE_BYTES,
} from "../web/src/ssh-protocol.js";
import { pickPrivateKey as pickBrowserPrivateKey } from "../web/src/ssh-native.browser.js";
import { openNativeSshWorkspace as openBrowserSshWorkspace } from "../web/src/ssh-connectbot-native.browser.js";
import { isStandaloneSshPath } from "../web/src/ssh-route.js";

describe("SSH protocol Base64 helpers", () => {
  it("round-trips UTF-8 text and arbitrary bytes", () => {
    expect(base64ToString(encodeBase64("你好，SSH 👋"))).toBe("你好，SSH 👋");
    const bytes = Uint8Array.from([0, 1, 2, 31, 32, 127, 128, 254, 255]);
    expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
    expect(bytesToBase64(bytes)).toBe(encodeBase64(bytes));
    expect([...base64ToBytes("AAECAf//")]).toEqual([0, 1, 2, 1, 255, 255]);
  });

  it("handles empty, unpadded, URL-safe, and whitespace-separated input", () => {
    expect(encodeBase64(new Uint8Array())).toBe("");
    expect(decodeBase64("")).toEqual(new Uint8Array());
    expect(base64ToString("aGVs bG8=\n")).toBe("hello");
    expect(base64ToString("aGVsbG8")).toBe("hello");
    expect([...decodeBase64("-_8")]).toEqual([251, 255]);
  });

  it("rejects malformed Base64 instead of silently producing bytes", () => {
    for (const value of ["A", "AA=A", "AA=", "AAAA=", "!!!!", "abcd$", "ab=c"]) {
      expect(() => decodeBase64(value)).toThrow();
    }
  });
});

describe("SSH protocol input normalization", () => {
  it("normalizes the form values into the native connect contract", () => {
    expect(normalizeSshConnectRequest({
      sessionId: " session-1 ", host: " mac.example ", port: "2222", username: " alice ",
      password: "secret", cols: "120", rows: 40, startupCommand: "  tmux attach  ",
    })).toEqual({
      sessionId: "session-1", host: "mac.example", port: 2222, username: "alice",
      password: "secret", cols: 120, rows: 40, startupCommand: "  tmux attach  ",
    });
  });

  it("normalizes opaque private-key metadata and connect handles", () => {
    expect(normalizeSshPrivateKeyInfo({
      keyId: " key-1 ", fileName: "id_ed25519", format: "OpenSSH", encrypted: true,
    })).toEqual({
      keyId: "key-1", fileName: "id_ed25519", format: "OpenSSH", encrypted: true,
    });
    expect(normalizeSshConnectRequest({
      sessionId: "session-1", host: "mac.example", port: 22, username: "alice",
      privateKeyId: " key-1 ", privateKeyPassphrase: " pass phrase ", cols: 80, rows: 24,
    })).toEqual({
      sessionId: "session-1", host: "mac.example", port: 22, username: "alice",
      privateKeyId: "key-1", privateKeyPassphrase: " pass phrase ", cols: 80, rows: 24,
    });
  });

  it("rejects raw private-key text, oversized passphrases, and invalid handles", () => {
    const baseRequest = { sessionId: "session-1", host: "mac.example", port: 22, username: "alice", cols: 80, rows: 24 };
    expect(() => normalizeSshConnectRequest({
      ...baseRequest, privateKey: "raw-private-key-text",
    })).toThrow(/not supported/);
    expect(() => normalizeSshConnectRequest({
      ...baseRequest, privateKeyId: "key\u0000id",
    })).toThrow(/NUL/);
    expect(() => normalizeSshConnectRequest({
      ...baseRequest, privateKeyId: "key id",
    })).toThrow(/whitespace/);
    expect(() => normalizeSshConnectRequest({
      ...baseRequest, privateKeyId: "key-1", privateKeyPassphrase: "x".repeat(SSH_MAX_PRIVATE_KEY_PASSPHRASE_BYTES + 1),
    })).toThrow(/privateKeyPassphrase/);
    expect(() => normalizeSshConnectRequest({
      ...baseRequest, privateKeyId: "key-1", privateKeyPassphrase: "bad\u0000passphrase",
    })).toThrow(/NUL/);
  });

  it("rejects a connect request without a password or private-key id", () => {
    const baseRequest = { sessionId: "session-1", host: "mac.example", port: 22, username: "alice", cols: 80, rows: 24 };
    expect(() => normalizeSshConnectRequest(baseRequest)).toThrow();
    expect(() => normalizeSshConnectRequest({ ...baseRequest, password: "", privateKeyId: "" })).toThrow();
  });

  it("validates hosts, ports, and terminal dimensions", () => {
    expect(normalizeSshHost(" 10.0.0.2 ")).toBe("10.0.0.2");
    expect(normalizeSshPort("22")).toBe(22);
    expect(normalizeSshDimensions(80, 24)).toEqual({ cols: 80, rows: 24 });
    for (const value of ["", "0", "65536", "22.5", "-1"]) expect(() => normalizeSshPort(value)).toThrow();
    expect(() => normalizeSshHost("host name")).toThrow();
    expect(() => normalizeSshDimensions(1, 24)).toThrow();
    expect(() => normalizeSshDimensions(80, 0)).toThrow();
  });

  it("recognizes only declared native connection states", () => {
    expect(isBridgeSSHConnectionState("connected")).toBe(true);
    expect(isBridgeSSHConnectionState("awaiting-host-key")).toBe(true);
    expect(isBridgeSSHConnectionState("secret")).toBe(false);
    expect(isBridgeSSHConnectionState(null)).toBe(false);
  });
});

describe("SSH route isolation", () => {
  it("recognizes the standalone SSH route without treating other pages as SSH", () => {
    expect(isStandaloneSshPath("/ssh")).toBe(true);
    expect(isStandaloneSshPath("/ssh/host-1")).toBe(true);
    expect(isStandaloneSshPath("/tmux-dashboard")).toBe(false);
    expect(isStandaloneSshPath("/system-management/settings")).toBe(false);
  });
});

describe("SSH browser isolation", () => {
  it("keeps the native private-key picker unavailable in a browser", async () => {
    await expect(pickBrowserPrivateKey()).rejects.toThrow("SSH 仅支持 Bridge 移动 App。");
  });

  it("does not open the native SSH workspace from a browser", async () => {
    await expect(openBrowserSshWorkspace()).rejects.toThrow("ConnectBot SSH 仅支持 Android App。");
  });
});
