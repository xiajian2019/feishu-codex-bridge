import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

let missing = false;
function report(label, okay, detail) {
  console.log(`${okay ? "OK" : "MISSING"} ${label}: ${detail}`);
  if (!okay) missing = true;
}
function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
}

const xcode = process.platform === "darwin" ? output("xcode-select", ["-p"]) : "";
const xcodeVersion = process.platform === "darwin" ? output("xcodebuild", ["-version"]) : "";
report("Xcode", Boolean(xcodeVersion), xcodeVersion || xcode || "Requires macOS and full Xcode (not Command Line Tools only)");

const javaHome = process.env.JAVA_HOME;
const java = output(javaHome ? `${javaHome}/bin/java` : "java", ["-version"]);
report("Java", /version "(?:2[1-9]|[3-9]\d)/.test(java), java.split("\n")[0] || "Set JAVA_HOME to JDK 21 or newer");

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || `${homedir()}/Library/Android/sdk`;
const sdkExists = existsSync(`${sdk}/platforms/android-36`) && existsSync(`${sdk}/platform-tools`);
report("Android SDK", sdkExists, sdkExists ? sdk : `Install SDK Platform 36 and platform-tools; checked ${sdk}`);
report("Android Studio", process.platform === "darwin" && existsSync("/Applications/Android Studio.app"), "Used by mobile:open:android; CLI builds can use an SDK directly");

console.log("\nThis checks tooling only. Run bun run mobile:build to build and sync the packaged frontend.");
process.exitCode = missing ? 1 : 0;
