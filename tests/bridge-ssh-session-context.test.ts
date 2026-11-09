import { describe, expect, it } from "bun:test";
import {
  assertSameBridgeSshSessionContext,
  bridgeSshSessionContextKey,
  createBridgeSshSessionContext,
  createBridgeSshSessionSelection,
} from "../web/src/bridge-ssh-session-context.js";

const contextInput = {
  bridgeOrigin: "http://10.15.53.70:17310/path-ignored",
  sshHost: "MAC.LOCAL",
  sshPort: 22,
  sshUsername: "xiajian",
  sessionId: "$25",
  createdAt: 1_735_000_000,
  expectedSshHost: "mac.local",
  expectedSshPort: 22,
};

describe("Bridge SSH Session context", () => {
  it("normalizes the Bridge origin and SSH host while retaining the full binding", () => {
    const context = createBridgeSshSessionContext(contextInput);
    expect(context).toEqual({
      bridgeOrigin: "http://10.15.53.70:17310",
      sshHost: "mac.local",
      sshPort: 22,
      sshUsername: "xiajian",
      sessionId: "$25",
      createdAt: 1_735_000_000,
      expectedSshHost: "mac.local",
      expectedSshPort: 22,
    });
    expect(bridgeSshSessionContextKey(context)).toContain("$25");
  });

  it("rejects a changed SSH target or Session identity", () => {
    const expected = createBridgeSshSessionContext(contextInput);
    const changed = createBridgeSshSessionContext({ ...contextInput, sshHost: "other.local", expectedSshHost: "other.local" });
    expect(() => assertSameBridgeSshSessionContext(expected, changed)).toThrow("上下文不一致");
    expect(() => createBridgeSshSessionContext({ ...contextInput, createdAt: 1_735_000_001 })).not.toThrow();
  });

  it("keeps an incomplete selection separate from a complete API context", () => {
    const selection = createBridgeSshSessionSelection({
      bridgeOrigin: "http://10.15.53.70:17310",
      sessionId: "$25",
      createdAt: 1_735_000_000,
      expectedSshHost: "mac.local",
      expectedSshPort: 22,
    });
    expect(selection).toMatchObject({ bridgeOrigin: "http://10.15.53.70:17310", sessionId: "$25" });
    expect(() => createBridgeSshSessionContext(selection)).toThrow("SSH 主机无效");
  });
});
