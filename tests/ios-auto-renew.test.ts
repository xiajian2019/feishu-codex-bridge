import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertInstalledMatches, effectiveExpiry, launchAgentPlist, renewalDue, renewalPaths, renewOne,
  restoreProfileBackups, selectFreshProfiles, validateRenewal, withFreshProfileRequest,
} from "../scripts/ios-auto-renew.mjs";
import { parseOptions } from "../scripts/ios-device.mjs";

const now = Date.parse("2026-11-15T12:00:00Z");
const device = { udid: "phone", name: "iPhone" };
const appId = "dev.feishu.codex.bridge";
const installed = { bundleIdentifier: appId, bundleContainerPath: "/device/bundle/old", bundleVersion: "1" };

function signing(expiry: number) {
  const profiles = [appId, `${appId}.share`].map((id) => ({
    name: `iOS Team Provisioning Profile: ${id}`, uuid: id, team: "TEAM",
    applicationIdentifier: `TEAM.${id}`, bundleId: id, devices: [device.udid],
    expiresAt: new Date(expiry).toISOString(), certificateExpiresAt: "2027-11-01T00:00:00Z",
    entitlementsHash: `hash-${id}`,
  }));
  return { team: "TEAM", profiles, effectiveExpiry: effectiveExpiry(profiles) };
}

function testRecord() {
  return { version: 1, ...device, archive: "snapshot-1234.xcarchive", wirelessOnly: false,
    bundleContainerPath: installed.bundleContainerPath, bundleVersion: installed.bundleVersion,
    signing: signing(now + 12 * 60 * 60 * 1000) };
}

function adapter(record: ReturnType<typeof testRecord>) {
  const calls: string[] = [];
  let installedCalls = 0;
  const api = {
    inspect: () => { calls.push("inspect"); return record.signing; },
    device: () => { calls.push("device"); return device; },
    installed: () => { calls.push("installed"); installedCalls++; return installedCalls < 3 ? installed : { ...installed, bundleContainerPath: "/device/bundle/new" }; },
    renew: () => { calls.push("renew"); return { app: "/tmp/renewed.app", signing: signing(now + 7 * 24 * 60 * 60 * 1000) }; },
    install: () => { calls.push("install"); },
    remember: (_device: unknown, _app: unknown, saved: typeof installed) => { calls.push(`remember:${saved.bundleContainerPath}`); },
  };
  return { calls, api };
}

describe("iOS automatic signing renewal", () => {
  test("uses the earliest extension profile or signing certificate and enters the window at 24 hours", () => {
    const state = signing(now + 3 * 24 * 60 * 60 * 1000);
    state.profiles[1].expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    state.profiles[0].certificateExpiresAt = new Date(now + 25 * 60 * 60 * 1000).toISOString();
    state.effectiveExpiry = effectiveExpiry(state.profiles);
    expect(renewalDue(state, now)).toBe(true);
    expect(renewalDue(state, now - 1)).toBe(false);
    expect(() => renewalDue({ effectiveExpiry: "bad" }, now)).toThrow();
  });

  test("requires a longer valid signing for the same team, device, App, extension and entitlements", () => {
    const before = signing(now + 12 * 60 * 60 * 1000);
    const after = signing(now + 7 * 24 * 60 * 60 * 1000);
    expect(() => validateRenewal(before, after, "phone", now)).not.toThrow();
    expect(() => validateRenewal(before, before, "phone", now)).toThrow("有效期更长");
    expect(() => validateRenewal(before, { ...after, team: "OTHER" }, "phone", now)).toThrow("团队");
    expect(() => validateRenewal(before, { ...after, profiles: after.profiles.slice(0, 1) }, "phone", now)).toThrow("扩展");
    expect(() => validateRenewal(before, after, "another-phone", now)).toThrow("目标设备");
    const changed = signing(now + 7 * 24 * 60 * 60 * 1000);
    changed.profiles[1].entitlementsHash = "changed";
    expect(() => validateRenewal(before, changed, "phone", now)).toThrow("身份或权限");
  });

  test("only installs a renewed snapshot after checking the device before and after signing", () => {
    const record = testRecord();
    const { calls, api } = adapter(record);
    expect(renewOne("/tmp/device-state", record, api, { now })).toBe(true);
    expect(calls).toEqual(["inspect", "device", "installed", "renew", "installed", "install", "installed", "remember:/device/bundle/new"]);
  });

  test("does nothing before the window and never records a failed install", () => {
    const record = testRecord();
    const { calls, api } = adapter(record);
    expect(renewOne("/tmp/device-state", record, api, { now: now - 24 * 60 * 60 * 1000 })).toBe(false);
    expect(calls).toEqual([]);
    api.install = () => { calls.push("install"); throw new Error("disconnected"); };
    expect(() => renewOne("/tmp/device-state", record, api, { now })).toThrow("disconnected");
    expect(calls.some((call) => call.startsWith("remember"))).toBe(false);
  });

  test("does not overwrite an App replaced while the renewal was running", () => {
    const record = testRecord();
    const { calls, api } = adapter(record);
    let queries = 0;
    api.installed = () => { calls.push("installed"); return ++queries === 1 ? installed : { ...installed, bundleContainerPath: "/another/install" }; };
    expect(() => renewOne("/tmp/device-state", record, api, { now })).toThrow("其他方式更换");
    expect(calls).not.toContain("install");
    expect(() => assertInstalledMatches(record, null)).toThrow("已被移除");
  });

  test("rejects a stale signing result before touching the device", () => {
    const record = testRecord();
    const { calls, api } = adapter(record);
    api.renew = () => { calls.push("renew"); return { app: "/tmp/old.app", signing: record.signing }; };
    expect(() => renewOne("/tmp/device-state", record, api, { now })).toThrow("有效期更长");
    expect(calls).not.toContain("install");
  });

  test("temporarily hides only exact automatic profiles and restores them on failure", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-profile-test-"));
    const directory = join(root, "profiles");
    mkdirSync(directory);
    try {
      const before = signing(now + 12 * 60 * 60 * 1000);
      const target = join(directory, "target.mobileprovision");
      const manual = join(directory, "manual.mobileprovision");
      const other = join(directory, "other.mobileprovision");
      writeFileSync(target, JSON.stringify(before.profiles[0]));
      writeFileSync(manual, JSON.stringify({ ...before.profiles[0], name: "Manual" }));
      writeFileSync(other, JSON.stringify({ ...before.profiles[0], applicationIdentifier: "TEAM.other" }));
      const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
      expect(() => withFreshProfileRequest(before, () => {
        expect(existsSync(target)).toBe(false);
        expect(existsSync(manual)).toBe(true);
        expect(existsSync(other)).toBe(true);
        throw new Error("export failed");
      }, [directory], read)).toThrow("export failed");
      expect(existsSync(target)).toBe(true);
      expect(readdirSync(directory).sort()).toEqual(["manual.mobileprovision", "other.mobileprovision", "target.mobileprovision"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("does not overwrite a profile recreated by Xcode while the previous one is backed up", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-profile-test-"));
    const directory = join(root, "profiles");
    mkdirSync(directory);
    try {
      const before = signing(now + 12 * 60 * 60 * 1000);
      const target = join(directory, "target.mobileprovision");
      writeFileSync(target, JSON.stringify(before.profiles[0]));
      withFreshProfileRequest(before, () => { writeFileSync(target, "new profile"); }, [directory],
        (path: string) => JSON.parse(readFileSync(path, "utf8")));
      expect(readFileSync(target, "utf8")).toBe("new profile");
      const backupRoot = join(root, ".bridge-ios-renew-profile-backups");
      const backupDirectory = join(backupRoot, readdirSync(backupRoot)[0]);
      expect(readdirSync(backupDirectory).some((name) => name.endsWith(".backup"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("restores a profile left in the external backup directory after an interruption", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-profile-test-"));
    const directory = join(root, "profiles");
    const id = createHash("sha256").update(directory).digest("hex").slice(0, 16);
    const backups = join(root, ".bridge-ios-renew-profile-backups", id);
    mkdirSync(directory);
    mkdirSync(backups, { recursive: true });
    try {
      writeFileSync(join(backups, "target.mobileprovision.bridge-ios-renew-1234.backup"), "original");
      restoreProfileBackups([directory]);
      expect(readFileSync(join(directory, "target.mobileprovision"), "utf8")).toBe("original");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("requires fresh profiles for all bundles sharing an available signing identity", () => {
    const before = signing(now + 12 * 60 * 60 * 1000);
    const after = signing(now + 7 * 24 * 60 * 60 * 1000);
    const profiles = after.profiles.map((profile) => ({ ...profile, certificates: [{ fingerprint: "KEY", expiresAt: "2027-11-01T00:00:00Z" }] }));
    expect(selectFreshProfiles(before, "phone", profiles, ["KEY"], now)?.profiles).toHaveLength(2);
    expect(selectFreshProfiles(before, "phone", profiles, ["OTHER"], now)).toBeNull();
    expect(selectFreshProfiles(before, "other-device", profiles, ["KEY"], now)).toBeNull();
    expect(selectFreshProfiles(before, "phone", profiles.slice(0, 1), ["KEY"], now)).toBeNull();
    profiles[1].expiresAt = before.effectiveExpiry;
    expect(selectFreshProfiles(before, "phone", profiles, ["KEY"], now)).toBeNull();
  });

  test("produces a valid hourly launchd job with escaped absolute paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-launchd-test-"));
    try {
      const root = join(directory, "project & space");
      const paths = renewalPaths(root, directory);
      const file = join(directory, "agent.plist");
      writeFileSync(file, launchAgentPlist(paths, root, "/path to/bun"));
      expect(spawnSync("/usr/bin/plutil", ["-lint", file]).status).toBe(0);
      const json = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
      const agent = JSON.parse(json.stdout);
      expect(agent.ProgramArguments).toEqual(["/path to/bun", join(root, "scripts/ios-device.mjs"), "--renew-run"]);
      expect(agent.StartCalendarInterval).toEqual({ Minute: 0 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("runs scheduled checks under the shared OS signing lock without contacting a device when none is registered", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-cli-renew-test-"));
    try {
      const scripts = join(root, "scripts");
      const home = join(root, "home");
      mkdirSync(scripts);
      mkdirSync(home);
      copyFileSync(new URL("../scripts/ios-device.mjs", import.meta.url), join(scripts, "ios-device.mjs"));
      copyFileSync(new URL("../scripts/ios-auto-renew.mjs", import.meta.url), join(scripts, "ios-auto-renew.mjs"));
      copyFileSync(new URL("../scripts/ios-signing-config.mjs", import.meta.url), join(scripts, "ios-signing-config.mjs"));
      const env = { ...process.env, HOME: home };
      delete env.BRIDGE_IOS_SIGNING_LOCK_HELD;
      const result = spawnSync(process.execPath, [join(scripts, "ios-device.mjs"), "--renew-run"], { encoding: "utf8", env });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("没有已登记的 iOS 安装");
      expect(existsSync(join(home, "Library/Application Support/Feishu Codex Bridge/ios-renew/signing.lock"))).toBe(true);
      expect(existsSync(join(root, "ios/App/build/.bridge-ios-device-build.lock"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("separates status and automatic renewal options from installation", () => {
    expect(parseOptions(["--renew-status"]).renewalMode).toBe("--renew-status");
    expect(parseOptions(["--renew-now"]).renewalMode).toBe("--renew-now");
    expect(() => parseOptions(["--renew-now", "--device", "phone"])).toThrow("不能与设备");
    expect(() => parseOptions(["--renew-now", "--renew-status"])).toThrow("不能同时");
  });
});
