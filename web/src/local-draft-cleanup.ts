import { clearAllCodexHistoryDrafts } from "./codex-history-draft-store.js";
import { clearAllPendingCodexHistorySubmissions } from "./codex-history-submission-store.js";
import { clearAllTaskCreateDrafts } from "./task-create-draft-store.js";

export async function clearLocalDraftsAfterDeviceRevocation(): Promise<void> {
  clearAllTaskCreateDrafts();
  clearAllPendingCodexHistorySubmissions();
  await clearAllCodexHistoryDrafts();
}
