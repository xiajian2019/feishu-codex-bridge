import { describe, expect, it } from "bun:test";
import { appendComposerTransferText } from "../web/src/composer-transfer-text.js";

describe("Composer transfer text", () => {
  it("appends without changing existing draft whitespace or incoming content", () => {
    expect(appendComposerTransferText("原有草稿  ", "  新文字\n")).toBe("原有草稿  \n\n  新文字\n");
    expect(appendComposerTransferText("原有草稿\n", "新文字")).toBe("原有草稿\n\n新文字");
    expect(appendComposerTransferText("原有草稿\n\n", "新文字")).toBe("原有草稿\n\n新文字");
    expect(appendComposerTransferText("", "  新文字 ")).toBe("  新文字 ");
    expect(appendComposerTransferText("原有草稿 ", " \n ")).toBe("原有草稿 ");
  });
});
