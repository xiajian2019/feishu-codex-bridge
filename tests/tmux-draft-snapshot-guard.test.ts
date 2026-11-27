import { expect, it } from "bun:test";
import { shouldAcceptComposerDraftSnapshot } from "../web/src/tmux-draft-snapshot-guard.js";

it("does not persist a detached runtime that silently drops draft text or attachments", () => {
  const previous = { text: "已有草稿", attachments: [{ id: "local" }, { id: "remote" }] };
  expect(shouldAcceptComposerDraftSnapshot(previous, { text: "", attachments: [] }, false)).toBe(false);
  expect(shouldAcceptComposerDraftSnapshot(previous, { text: "已有草稿", attachments: [{ id: "local" }] }, false)).toBe(false);
  expect(shouldAcceptComposerDraftSnapshot(previous, { text: "", attachments: [] }, true)).toBe(true);
  expect(shouldAcceptComposerDraftSnapshot(previous, { text: "已有草稿", attachments: [{ id: "local" }] }, true)).toBe(true);
  expect(shouldAcceptComposerDraftSnapshot(previous, { text: "继续编辑", attachments: [...previous.attachments, { id: "new" }] }, false)).toBe(true);
});
