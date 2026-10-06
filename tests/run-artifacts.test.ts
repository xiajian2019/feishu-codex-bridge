import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitWorkspaceSnapshot } from "../src/run-artifacts.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTempDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "bridge-run-artifacts-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function initRepository(root: string): void {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Run artifact test"]);
  git(root, ["config", "user.email", "run-artifacts@example.invalid"]);
  git(root, ["config", "core.hooksPath", join(root, ".empty-hooks")]);
}

describe("captureGitWorkspaceSnapshot", () => {
  it("captures HEAD and bounded relative dirty/untracked paths without file contents", async () => {
    const root = makeTempDirectory();
    initRepository(root);
    writeFileSync(join(root, "tracked.txt"), "before change");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "--quiet", "-m", "initial"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "tracked.txt"), "private changed file content");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "new.txt"), "private untracked file content");

    const before = Date.now();
    const snapshot = await captureGitWorkspaceSnapshot(root);
    const after = Date.now();

    expect(snapshot.isGitRepository).toBe(true);
    expect(snapshot.headCommit).toBe(head);
    expect(snapshot.dirtyPaths).toEqual(["tracked.txt"]);
    expect(snapshot.untrackedPaths).toEqual(["nested/new.txt"]);
    expect(snapshot.truncated).toBe(false);
    expect(Date.parse(snapshot.capturedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(snapshot.capturedAt)).toBeLessThanOrEqual(after);
    expect(snapshot.taskAttribution).toBe("unattributed-shared-workspace");
    expect(snapshot.attributionNote).toContain("cannot be attributed to one task");
    expect(snapshot.dirtyPaths.concat(snapshot.untrackedPaths).every((path) => !path.startsWith("/") && !path.split("/").includes(".."))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private changed file content");
    expect(JSON.stringify(snapshot)).not.toContain("private untracked file content");
  });

  it("returns a null HEAD for a Git repository without a commit", async () => {
    const root = makeTempDirectory();
    initRepository(root);
    writeFileSync(join(root, "first.txt"), "untracked");

    const snapshot = await captureGitWorkspaceSnapshot(root);

    expect(snapshot).toMatchObject({
      isGitRepository: true,
      headCommit: null,
      dirtyPaths: [],
      untrackedPaths: ["first.txt"],
      truncated: false,
    });
  });

  it("handles a non-Git directory without throwing", async () => {
    const snapshot = await captureGitWorkspaceSnapshot(makeTempDirectory());

    expect(snapshot).toMatchObject({
      isGitRepository: false,
      headCommit: null,
      dirtyPaths: [],
      untrackedPaths: [],
      truncated: false,
    });
  });

  it("caps status output and the number of returned paths", async () => {
    const root = makeTempDirectory();
    initRepository(root);
    for (let index = 0; index < 40; index += 1) {
      const filename = `untracked-${String(index).padStart(2, "0")}-${"x".repeat(72)}.txt`;
      writeFileSync(join(root, filename), "content omitted");
    }

    const outputBounded = await captureGitWorkspaceSnapshot(root, {
      timeoutMs: 5_000,
      maxStatusOutputBytes: 1_024,
      maxPaths: 500,
    });

    expect(outputBounded.isGitRepository).toBe(true);
    expect(outputBounded.truncated).toBe(true);
    expect(outputBounded.untrackedPaths.length + outputBounded.dirtyPaths.length).toBeLessThan(40);

    const pathBounded = await captureGitWorkspaceSnapshot(root, { timeoutMs: 5_000, maxPaths: 3 });
    expect(pathBounded.truncated).toBe(true);
    expect(pathBounded.untrackedPaths.length + pathBounded.dirtyPaths.length).toBeLessThanOrEqual(3);
  });
});
