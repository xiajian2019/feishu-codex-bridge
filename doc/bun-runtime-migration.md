# Bun Runtime Migration Plan

## Goal

Move the complete Feishu Codex Bridge application and its portable macOS runtime from Node.js to a pinned Bun runtime. A normal install, service start, update, AAMP integration, Codex worker, CLI command, and tmux terminal must not require a Node.js installation. Bun is also the project package manager and script runner; no Node.js runtime is used in CI or the portable package.

## Baseline Findings (Before Migration)

- The application opens SQLite through `node:sqlite`; the Bun runtime must use `bun:sqlite` and retain the existing schema, WAL mode, foreign-key enforcement, busy timeout, and transaction behavior.
- `node-pty` loads under Node but does not deliver a functioning PTY under Bun 1.4.2. A local disposable probe confirmed Bun's `Bun.Terminal` supports terminal data, input, resize, raw-mode control bytes, process exit, and close on POSIX. The tmux adapter will use this API.
- AAMP patches currently rely on Node's `node:module.register` loader and `NODE_OPTIONS=--import`. The Bun runtime integration will use a Bun preload/plugin, propagated to child Bun processes using `BUN_OPTIONS`.
- Portable packages currently select, download, validate, bundle, and update Node. Runtime packaging and compatibility metadata must be switched to architecture-specific Bun binaries. Core overlays must continue to preserve user configuration and runtime data.
- The project currently has both pnpm and npm lockfiles. Bun's lockfile becomes the sole dependency lock after dependency resolution and install tests succeed.

## Scope

Included: app server, worker subprocesses, SQLite, AAMP runtime patches and shims, PTY, package scripts, dependency installation, CLI/installer, LaunchAgent generation, portable release build, runtime downloader, update/rollback logic, GitHub release workflow, tests, user documentation, and the explicitly requested Node-to-Bun replacement of the active macOS Direct LaunchAgent with a retained rollback package/plist.

Excluded: changing the SQLite schema or user data format, changing Feishu/Codex behavior, publishing a release, or removing the user's existing Node installation. Node may remain installed on a developer machine, but no project command may depend on it.

## Work Plan

### 1. Pin Bun and migrate project commands

- Pin Bun 1.4.2 consistently in package metadata, a version file, CI, and portable runtime validation.
- Move package scripts, direct CLI entrypoints, build/test/type-check/release commands, and install documentation to Bun. Use Bun’s built-in test runner so CI does not launch Vitest through Node.
- Replace pnpm/npm lockfiles with a reproducible `bun.lock` and verify production dependency installation for both Lite and Direct packages.

### 2. Migrate runtime APIs

- Put the database behind the existing project adapter and implement its production driver with `bun:sqlite`.
- Launch the service, Codex worker, CLI, and child scripts with the pinned Bun executable.
- Replace `node-pty` with a Bun terminal adapter that preserves attach/detach, input/output, resize, process exit, and cleanup behavior.
- Replace the Node module loader with a Bun preload plugin. Ensure spawned Bun children inherit the AAMP patch, while unrelated environments do not.

### 3. Migrate install, service, and portable release paths

- Make the launcher discover the bundled Bun first, then an acceptable system Bun, and otherwise download the pinned official Bun archive for the host OS/architecture after SHA-256 verification.
- Compile the Bun runtime and Bridge application into one platform-specific Direct executable; keep platform-native `lark-cli` and static web assets as package sidecars. Lite remains script-based and resolves its Bun runtime separately. Do not assume a universal binary.
- Replace Node/npm/npx shims required by the packaged app with Bun-backed shims or Bun package-manager commands.
- Update runtime manifests, installer behavior, LaunchAgent generation, Core/Lite/Direct update paths, and rollback coverage. A runtime-generation change must use a full runtime package before Core-only updates resume.
- Preserve `config.json`, SQLite files, Feishu credentials, Codex state, and AAMP state throughout upgrade and rollback.

### 4. Validate and roll out

- Run unit tests, type checks, build checks, SQLite parity tests, Bun PTY integration tests, AAMP preload tests, and package smoke tests.
- Build and inspect macOS arm64 and x64 Lite/Direct packages. Confirm the Direct executable starts with `PATH=/usr/bin:/bin` and without Node, pnpm, npm, or a globally installed Bun; verify Lite's separately packaged/runtime-resolved Bun behavior.
- Verify clean install, in-place Node-to-Bun upgrade, Core overlay, full runtime update, failed-start rollback, and preservation of user data.
- Keep the prior runtime package and a tested rollback path until the Bun package passes a complete representative Feishu/Codex workload.

## Acceptance Criteria

- The production service, Codex workers, all project CLIs, and packaged AAMP processes execute under the pinned Bun runtime.
- A Direct install starts without Node.js, npm, npx, pnpm, or a globally installed Bun; any downloaded Lite runtime is checksum-verified.
- Existing SQLite databases open without schema/data conversion, pass integrity checks, and retain WAL/foreign-key/timeout semantics.
- Tmux terminal attach, input/output, resize, detach, cancellation, and cleanup pass under Bun on supported macOS architectures.
- AAMP patches are active under Bun and through child-process restarts; no behavior depends on `NODE_OPTIONS` or `node:module.register`.
- Lite/Direct installation and all update modes preserve user data; incompatible runtime/application pairs are rejected and rollback restores a runnable package.
- CI installs, tests, builds, and packages with Bun only.

## Progress

### Implemented

- [x] Create and work on `feature/bun-runtime-migration`; no commit, push, or public release publication.
- [x] Pin Bun 1.4.2 in `.bun-version`, package metadata, CI, version checks, and portable runtime validation.
- [x] Move the application database to Bun’s `bun:sqlite` driver while retaining a Node adapter fallback for optional compatibility use.
- [x] Move service/worker/CLI process execution to Bun and replace `node-pty` with `Bun.Terminal` PTY support.
- [x] Replace the AAMP Node module loader with a Bun preload/plugin; add Bun-backed `node`, `npm`, and `npx` shims, including local `npm install --prefix` behavior.
- [x] Replace Vitest imports and scripts with Bun’s native test runner; use only `bun.lock` and remove npm/pnpm lockfiles.
- [x] Migrate the portable launcher, checksum-verified Bun download, runtime manifest, direct/Lite/Core packaging, updater compatibility gate, and legacy Node-runtime cleanup.
- [x] Add Direct single-binary packaging: Bun and Bridge code are compiled into an architecture-specific executable, while native `lark-cli` and web static assets remain sidecars.
- [x] Update README install, test, release, and AAMP-runtime instructions.

### Verified

- Bun 1.4.2 `bun test`: 205 tests across 39 files passed (817 assertions); the HTTP listener test passed outside the sandbox.
- `bun run build`: web bundle, emitted app JavaScript, and both TypeScript checks passed.
- macOS arm64 Direct package compiled and passed packaged main/Codex/install/database smoke tests; launcher `--version` passed with `PATH=/usr/bin:/bin`. The package contains no standalone Bun or Node runtime.
- Updater tests cover Core overlay and Node-to-single-binary Direct replacement, including config, database, and app log preservation; `git diff --check` passed.
- On 2026-09-22, the active `com.local.feishu-codex-bridge` LaunchAgent was replaced; `launchctl` reports `running` and executes `app/feishu-codex-bridge --bridge-main`. `config.json` and `runtime/bridge.db` paths are unchanged; Codex status exited successfully.
- The previous Node package and LaunchAgent plist are retained at `release/rollback-node-direct-20260922-120007/` for rollback.

### Remaining Rollout Gates

- [ ] Build and inspect macOS x64 Direct and Lite packages; verify checksum/download behavior and architecture-specific outputs.
- [ ] Exercise the Bun PTY adapter against a live tmux session, including resize, detach, cancellation, and cleanup.
- [ ] Observe representative live Feishu task, Codex child-worker, and attachment workflows under the compiled runtime; test service rollback in a disposable installed fixture before public release.
