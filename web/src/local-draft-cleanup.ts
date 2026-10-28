import { clearAllCodexHistoryDrafts } from "./codex-history-draft-store.js";
import { clearAllPendingCodexHistorySubmissions } from "./codex-history-submission-store.js";
import { clearAllTaskCreateDrafts } from "./task-create-draft-store.js";
import { clearAllTmuxDrafts } from "./tmux-draft-store.js";
import { clearScopedClientStorage } from "./local-draft-scope.js";
import { clearSkillMemoryCache } from "./skill-cache.js";

export async function clearLocalDraftsAfterDeviceRevocation(): Promise<void> {
  clearAllTaskCreateDrafts();
  clearAllPendingCodexHistorySubmissions();
  // Start both operations before any await: a logout may reset the active scope.
  const history = clearAllCodexHistoryDrafts();
  const tmux = clearAllTmuxDrafts();
  clearScopedClientStorage();
  clearSkillMemoryCache();
  await Promise.all([history, tmux]);
}
