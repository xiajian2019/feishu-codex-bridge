import { clearAllCodexHistoryDrafts } from "./codex-history-draft-store.js";
import { clearAllPendingCodexHistorySubmissions } from "./codex-history-submission-store.js";
import { clearAllTaskCreateDrafts } from "./task-create-draft-store.js";
import { clearAllTmuxDrafts } from "./tmux-draft-store.js";
import { clearScopedClientStorage, getLocalDraftScope } from "./local-draft-scope.js";
import { clearSkillMemoryCache } from "./skill-cache.js";

export async function clearLocalDraftsAfterDeviceRevocation(): Promise<void> {
  const scope = getLocalDraftScope();
  const composer = import.meta.env.VITE_BRIDGE_MOBILE === "true"
    ? import("./composer-native-data.js").then((module) => module.clearNativeComposerScope(scope)).catch(() => {})
    : Promise.resolve();
  clearAllTaskCreateDrafts();
  clearAllPendingCodexHistorySubmissions();
  // Start both operations before any await: a logout may reset the active scope.
  const history = clearAllCodexHistoryDrafts();
  const tmux = clearAllTmuxDrafts();
  clearScopedClientStorage();
  clearSkillMemoryCache();
  await Promise.all([history, tmux, composer]);
}
