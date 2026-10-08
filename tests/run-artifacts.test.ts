import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(snapshot.fileFingerprints).toEqual([
      {
        path: "tracked.txt",
        status: "hashed",
        sizeBytes: Buffer.byteLength("private changed file content"),
        sha256: createHash("sha256").update("private changed file content").digest("hex"),
      },
      {
        path: "nested/new.txt",
        status: "hashed",
        sizeBytes: Buffer.byteLength("private untracked file content"),
        sha256: createHash("sha256").update("private untracked file content").digest("hex"),
      },
    ]);
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

  it("reports bounded fingerprint omissions for file size, total bytes, and file count", async () => {
    const root = makeTempDirectory();
    initRepository(root);
    writeFileSync(join(root, "a.txt"), "1234");
    writeFileSync(join(root, "b.txt"), "12345");
    writeFileSync(join(root, "c.txt"), "12");
    writeFileSync(join(root, "d.txt"), "1");

    const snapshot = await captureGitWorkspaceSnapshot(root, {
      timeoutMs: 5_000,
      maxFingerprintFiles: 3,
      maxFingerprintFileBytes: 4,
      maxFingerprintTotalBytes: 4,
    });

    expect(snapshot.fileFingerprints).toEqual([
      { path: "a.txt", status: "hashed", sizeBytes: 4, sha256: createHash("sha256").update("1234").digest("hex") },
      { path: "b.txt", status: "omitted", sizeBytes: 5, reason: "file-too-large" },
      { path: "c.txt", status: "omitted", sizeBytes: 2, reason: "byte-budget-exceeded" },
      { path: "d.txt", status: "omitted", sizeBytes: null, reason: "file-limit-reached" },
    ]);
  });

  it("never fingerprints a symlink that points outside the repository", async () => {
    const root = makeTempDirectory();
    const outside = makeTempDirectory();
    initRepository(root);
    const outsideFile = join(outside, "private.txt");
    writeFileSync(outsideFile, "private outside content");
    symlinkSync(outsideFile, join(root, "outside-link.txt"));
    symlinkSync(outside, join(root, "outside-dir"), "dir");

    const snapshot = await captureGitWorkspaceSnapshot(root);

    expect(snapshot.untrackedPaths).toEqual(["outside-dir", "outside-link.txt"]);
    expect(snapshot.fileFingerprints).toEqual([
      { path: "outside-dir", status: "unsafe", sizeBytes: null, reason: "symlink" },
      { path: "outside-link.txt", status: "unsafe", sizeBytes: null, reason: "symlink" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private outside content");
  });
});
