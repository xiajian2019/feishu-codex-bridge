import { describe, expect, it } from "bun:test";

import { parseTmuxVerifierArguments } from "../src/tmux-verifier-cli.js";

describe("parseTmuxVerifierArguments", () => {
  it("uses the existing tmux server and Bridge dashboard by default", () => {
    const options = parseTmuxVerifierArguments([], "/tmp/project");

    expect(options.socket).toBe("");
    expect(options.bridgeDashboardUrl).toBe("http://127.0.0.1:7310/");
  });

  it("allows an explicit named socket and dashboard URL", () => {
    const options = parseTmuxVerifierArguments([
      "--socket",
      "isolated",
      "--bridge-url",
      "http://127.0.0.1:7410",
    ]);

    expect(options.socket).toBe("isolated");
    expect(options.bridgeDashboardUrl).toBe("http://127.0.0.1:7410/");
  });

  it("rejects non-HTTP dashboard URLs", () => {
    expect(() => parseTmuxVerifierArguments(["--bridge-url", "javascript:alert(1)"]))
      .toThrow("--bridge-url must be an absolute HTTP(S) URL");
  });
});
