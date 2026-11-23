import { describe, expect, test } from "bun:test";
import { StateDatabase } from "../src/db.js";

const input = {
  name: "Bridge",
  app_store_name: "bjump",
  source_path: "/tmp/bridge-source",
  project_path: "/tmp/bridge-source/ios/App/App.xcodeproj",
  build_directory: "/tmp/bridge-source/ios/App/build/testflight",
  public_directory: "/tmp/bridge-source/ios/App/App/public",
  bundle_id: "dev.example.bridge",
  team_id: "AAAAAAAAAA",
  scheme: "App",
  configuration: "PersonalRelease",
  target_name: "App",
  info_plist_path: "App/Info.plist",
  enabled: true,
  internal_only: true,
};

describe("iOS TestFlight app configuration", () => {
  test("persists multiple independent app records", () => {
    const db = new StateDatabase(":memory:");
    const first = db.createIosTestflightApp(input);
    const second = db.createIosTestflightApp({ ...input, name: "Second", app_store_name: "Second", bundle_id: "dev.example.second" });
    expect(db.listIosTestflightApps().map((app) => app.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(db.getIosTestflightApp(first.id)?.bundle_id).toBe("dev.example.bridge");
    const updated = db.updateIosTestflightApp(first.id, {
      ...input,
      name: "Bridge Updated",
      internal_only: false,
      team_id: "BBBBBBBBBB",
      project_path: "/tmp/changed/App.xcodeproj",
    });
    expect(updated?.internal_only).toBe(false);
    expect(updated?.team_id).toBe("AAAAAAAAAA");
    expect(updated?.project_path).toBe(input.project_path);
  });

  test("rejects invalid team and non-absolute paths", () => {
    const db = new StateDatabase(":memory:");
    expect(() => db.createIosTestflightApp({ ...input, team_id: "bad" })).toThrow("team_id");
    expect(() => db.createIosTestflightApp({ ...input, source_path: "relative" })).toThrow("source_path");
  });
});
