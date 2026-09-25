#!/bin/sh
set -eu

if [ -z "${FEISHU_CODEX_BRIDGE_INSTALL_ROOT:-}" ]; then
  case "$0" in
    */current/feishu-codex-bridge)
      FEISHU_CODEX_BRIDGE_INSTALL_ROOT=${0%/current/feishu-codex-bridge}
      ;;
  esac
fi
SELF_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)
APP_DIR="$SELF_DIR/app"
RUNTIME_DIR="$SELF_DIR/runtime"
if [ -n "${FEISHU_CODEX_BRIDGE_INSTALL_ROOT:-}" ]; then
  export FEISHU_CODEX_BRIDGE_INSTALL_ROOT
  export FEISHU_CODEX_BRIDGE_ENTRYPOINT="$FEISHU_CODEX_BRIDGE_INSTALL_ROOT/current/app/feishu-codex-bridge"
  SHARED_RUNTIME_DIR="$FEISHU_CODEX_BRIDGE_INSTALL_ROOT/runtime"
else
  SHARED_RUNTIME_DIR="$RUNTIME_DIR"
fi
export FEISHU_CODEX_BRIDGE_LAN_BIND=1

BUN_VERSION_REQUIRED="1.4.2"
BUN_VERSION_DOWNLOAD="1.4.2"
BUN_BIN=""
BUN_DOWNLOAD_DIR=""

host_bun_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf '%s\n' "arm64" ;;
    x86_64|amd64) printf '%s\n' "x64" ;;
    *) return 1 ;;
  esac
}

version_at_least() {
  actual="$1"
  awk -v actual="$actual" -v required="$BUN_VERSION_REQUIRED" '
    BEGIN {
      split(actual, full, /[-+]/);
      split(full[1], a, ".");
      split(required, r, ".");
      for (i = 1; i <= 3; i += 1) {
        av = a[i] + 0;
        rv = r[i] + 0;
        if (av > rv) exit 0;
        if (av < rv) exit 1;
      }
      exit 0;
    }
  '
}

bun_is_supported() {
  candidate="$1"
  [ -x "$candidate" ] || return 1
  candidate_version=$("$candidate" --version 2>/dev/null) || return 1
  version_at_least "$candidate_version" || return 1
  "$candidate" -e 'const { Database } = require("bun:sqlite"); const db = new Database(":memory:"); db.exec("CREATE TABLE smoke (value TEXT)"); db.prepare("INSERT INTO smoke VALUES (?)").run("ok"); if (db.prepare("SELECT value FROM smoke").get().value !== "ok") process.exit(1); db.close();' >/dev/null 2>&1
}

download_bun_runtime() {
  case "$(uname -s)" in
    Darwin) bun_platform="darwin" ;;
    *)
      echo "Portable Runtime 当前只支持 macOS：$(uname -s)" >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64)
      bun_arch="aarch64"
      bun_runtime_arch="arm64"
      bun_asset="bun-darwin-aarch64.zip"
      bun_checksum="90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f"
      ;;
    x86_64|amd64)
      bun_arch="x64-baseline"
      bun_runtime_arch="x64"
      bun_asset="bun-darwin-x64-baseline.zip"
      bun_checksum="bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0"
      ;;
    *)
      echo "Portable Runtime 暂不支持此 CPU 架构：$(uname -m)" >&2
      exit 1
      ;;
  esac

  bun_install_dir="$SHARED_RUNTIME_DIR/bun-v${BUN_VERSION_DOWNLOAD}-darwin-${bun_runtime_arch}"
  bun_install_path="$bun_install_dir/bun"
  if bun_is_supported "$bun_install_path"; then
    printf '%s\n' "$bun_install_path"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || {
    echo "找不到 curl，无法下载 Bun ${BUN_VERSION_DOWNLOAD}" >&2
    exit 1
  }
  command -v unzip >/dev/null 2>&1 || {
    echo "找不到 unzip，无法解压 Bun ${BUN_VERSION_DOWNLOAD}" >&2
    exit 1
  }
  command -v shasum >/dev/null 2>&1 || {
    echo "找不到 shasum，无法校验 Bun 下载包" >&2
    exit 1
  }

  mkdir -p "$SHARED_RUNTIME_DIR"
  BUN_DOWNLOAD_DIR=$(mktemp -d "$SHARED_RUNTIME_DIR/.bun-download.XXXXXX")
  cleanup_bun_download() {
    if [ -n "$BUN_DOWNLOAD_DIR" ] && [ -d "$BUN_DOWNLOAD_DIR" ]; then
      rm -rf "$BUN_DOWNLOAD_DIR"
    fi
  }
  trap cleanup_bun_download EXIT INT TERM

  bun_archive_path="$BUN_DOWNLOAD_DIR/$bun_asset"
  bun_url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION_DOWNLOAD}/$bun_asset"
  echo "未找到可用 Bun，正在下载 ${BUN_VERSION_DOWNLOAD}（darwin-${bun_arch}）…" >&2
  curl --proto '=https' --tlsv1.2 -fsSL "$bun_url" -o "$bun_archive_path"
  actual_checksum=$(shasum -a 256 "$bun_archive_path" | awk '{ print $1 }')
  if [ "$bun_checksum" != "$actual_checksum" ]; then
    echo "Bun 下载校验失败：$bun_asset" >&2
    exit 1
  fi
  unzip -q "$bun_archive_path" -d "$BUN_DOWNLOAD_DIR/unpacked"
  bun_source=$(find "$BUN_DOWNLOAD_DIR/unpacked" -type f -name bun -perm -u+x | head -n 1)
  if [ -z "$bun_source" ]; then
    echo "Bun 下载包中未找到可执行文件：$bun_asset" >&2
    exit 1
  fi
  mkdir -p "$bun_install_dir"
  rm -f "$bun_install_path"
  mv "$bun_source" "$bun_install_path"
  chmod 755 "$bun_install_path"
  if ! bun_is_supported "$bun_install_path"; then
    echo "下载的 Bun 运行时无法启动或版本不匹配：$bun_install_path" >&2
    exit 1
  fi
  trap - EXIT INT TERM
  cleanup_bun_download
  printf '%s\n' "$bun_install_path"
}

resolve_bun() {
  bundled_bun="$RUNTIME_DIR/bin/bun"
  if [ -f "$RUNTIME_DIR/.bundled-bun" ] && bun_is_supported "$bundled_bun"; then
    printf '%s\n' "$bundled_bun"
    return 0
  fi
  if bun_is_supported "$bundled_bun"; then
    printf '%s\n' "$bundled_bun"
    return 0
  fi
  shared_bun="$SHARED_RUNTIME_DIR/bin/bun"
  if bun_is_supported "$shared_bun"; then
    printf '%s\n' "$shared_bun"
    return 0
  fi
  system_bun=$(command -v bun 2>/dev/null || true)
  if [ -n "$system_bun" ] && bun_is_supported "$system_bun"; then
    printf '%s\n' "$system_bun"
    return 0
  fi
  download_bun_runtime
}

SINGLE_BINARY=0
runtime_packaging=$(awk -F'"' '/"runtimePackaging"[[:space:]]*:/ { print $4; exit }' "$SELF_DIR/release-manifest.json" 2>/dev/null || true)
if [ "$runtime_packaging" = "single-binary" ] && [ -x "$APP_DIR/feishu-codex-bridge" ]; then
  SINGLE_BINARY=1
  export FEISHU_CODEX_BRIDGE_SINGLE_BINARY=1
  export FEISHU_CODEX_BRIDGE_APP_ROOT="$APP_DIR"
  export FEISHU_CODEX_BRIDGE_PORTABLE_ROOT="$SELF_DIR"
  export PATH="$APP_DIR/node_modules/@larksuite/cli/bin:$APP_DIR/node_modules/.bin:${PATH:-}"
else
  BUN_BIN=$(resolve_bun)
  BUN_BIN_DIR=$(CDPATH= cd -P -- "$(dirname -- "$BUN_BIN")" && pwd -P)
  export PATH="$BUN_BIN_DIR:$RUNTIME_DIR/bin:$APP_DIR/node_modules/.bin:${PATH:-}"
  export FEISHU_CODEX_BRIDGE_PORTABLE_ROOT="$SELF_DIR"
fi

run_entry() {
  entry="$1"
  shift
  if [ "$SINGLE_BINARY" -eq 1 ]; then
    case "$entry" in
      main) internal_command="--bridge-main" ;;
      codex-cli) internal_command="--bridge-codex" ;;
      install-cli) internal_command="--bridge-install" ;;
      web-pair-cli) internal_command="--bridge-web-pair" ;;
      aamp-cli)
        echo "Direct 单二进制包不提供 AAMP 管理命令。" >&2
        exit 2
        ;;
      *)
        echo "未知单二进制入口：$entry" >&2
        exit 2
        ;;
    esac
    exec "$APP_DIR/feishu-codex-bridge" "$internal_command" "$@"
  fi
  exec "$BUN_BIN" "$APP_DIR/dist/$entry.js" "$@"
}

usage() {
  cat <<'USAGE'
用法：
  feishu-codex-bridge install|init|doctor [选项]
  feishu-codex-bridge start [选项]
  feishu-codex-bridge update [选项]
  feishu-codex-bridge service <install|start|stop|restart|status|logs|uninstall>
  feishu-codex-bridge web:pair
  feishu-codex-bridge aamp:<命令> [参数...]
  feishu-codex-bridge codex:<命令> [参数...]
  feishu-codex-bridge --version

首次使用：feishu-codex-bridge install
USAGE
}

if [ "$#" -eq 0 ]; then
  usage
  exit 0
fi

case "$1" in
  -h|--help)
    usage
    exit 0
    ;;
  -v|--version)
    if [ "$SINGLE_BINARY" -eq 1 ]; then exec "$APP_DIR/feishu-codex-bridge" --bridge-version; fi
    exec "$BUN_BIN" -e 'import { readFileSync } from "node:fs"; const manifest = JSON.parse(readFileSync(process.argv[1], "utf8")); console.log(manifest.version || "0.0.0");' "$APP_DIR/package.json"
    ;;
  list|scripts)
    printf '%s\n' \
      install init doctor start update service \
      web:pair \
      aamp aamp:install aamp:start aamp:stop aamp:restart aamp:status aamp:logs aamp:update aamp:add aamp:remove \
      aamp:recent aamp:task aamp:inspect aamp:worktrees \
      codex codex:install codex:setup codex:start codex:stop codex:restart codex:status codex:logs \
      codex:recent codex:list codex:threads codex:thread codex:task codex:inspect codex:attachments codex:outbox \
      codex:notify-install codex:notify-hook \
      codex:cancel codex:retry codex:recover codex:worktrees codex:doctor codex:update \
      codex:uninstall codex:remove
    exit 0
    ;;
  run)
    shift
    if [ "$#" -eq 0 ]; then
      echo "run 需要一个命令。" >&2
      exit 2
    fi
    exec "$SELF_DIR/feishu-codex-bridge" "$@"
    ;;
  install|init|doctor)
    command="$1"
    shift
    run_entry install-cli "$command" "$@"
    ;;
  start|start:all)
    shift
    run_entry main "$@"
    ;;
  update)
    shift
    update_root=${FEISHU_CODEX_BRIDGE_INSTALL_ROOT:-$SELF_DIR}
    if [ "$SINGLE_BINARY" -eq 1 ]; then exec "$APP_DIR/feishu-codex-bridge" --bridge-update --root "$update_root" "$@"; fi
    exec "$BUN_BIN" "$APP_DIR/scripts/update-portable-release.mjs" --root "$update_root" "$@"
    ;;
  bridge:install)
    shift
    run_entry install-cli install "$@"
    ;;
  web:pair)
    shift
    run_entry web-pair-cli "$@"
    ;;
  aamp)
    shift
    run_entry aamp-cli "$@"
    ;;
  aamp:*)
    command=${1#*:}
    shift
    run_entry aamp-cli "$command" "$@"
    ;;
  codex)
    shift
    run_entry codex-cli "$@"
    ;;
  codex:*)
    command=${1#*:}
    shift
    run_entry codex-cli "$command" "$@"
    ;;
  service)
    shift
    if [ "$#" -eq 0 ]; then
      echo "service 需要一个命令。" >&2
      exit 2
    fi
    command="$1"
    shift
    case "$command" in
      install|start|stop|restart|status|logs|uninstall|remove)
        run_entry codex-cli "$command" "$@"
        ;;
      *)
        echo "未知 service 命令：$command" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "未知命令：$1。使用 --help 查看帮助。" >&2
    exit 2
    ;;
esac
