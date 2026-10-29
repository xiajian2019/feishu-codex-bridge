import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/mobile-native-download.ts", import.meta.url));
const scenarios = [
  ["android-restored", "restores OS download tracking after native lifecycle startup and opens the completed file by native ID"],
  ["android-cancel", "cancels one active system download and ignores its delayed completion callback"],
  ["android-export-limit", "rejects oversized native Blob exports before whole-file Base64 conversion"],
  ["android-motion-permission", "keeps the manual environment entry usable when motion permission is denied"],
  ["android-apk-success", "verifies an APK before handing it to the installer and does not claim installation succeeded"],
  ["android-apk-invalid", "rejects a damaged APK before installation or saving and removes the failed download"],
  ["android-apk-cancel", "retains a verified APK after installer permission refusal so the user can retry"],
  ["android-apk-save", "validates a manually downloaded APK before saving it to Downloads"],
  ["android", "waits for Android system completion and refreshes real progress on resume"],
  ["android-invalid-id", "rejects an invalid Android enqueue result without claiming completion"],
  ["ios-completion", "shows iOS transfer byte progress and waits for the system share handoff"],
  ["ios-cancel", "distinguishes an iOS share cancellation from a successful handoff"],
  ["ios-share-failure", "reports an iOS share error as a failure"],
  ["ios-serial", "serializes identical URLs and removes failed transfer listeners before the next download"],
] as const;

for (const [scenario, title] of scenarios) {
  it(title, async () => {
    // Capacitor module mocks live only in this process, never in the Bun test worker.
    const child = Bun.spawn([process.execPath, fixture, scenario], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 8_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally { clearTimeout(timeout); }
  }, 10_000);
}
