#!/bin/sh
set -eu

SELF_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)
APP_DIR="$SELF_DIR/app"
RUNTIME_DIR="$SELF_DIR/runtime"

NODE_VERSION_REQUIRED="22.13.1"
NODE_VERSION_DOWNLOAD="22.13.1"
NODE_BIN=""
NODE_DOWNLOAD_DIR=""

host_node_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf '%s\n' "arm64" ;;
    x86_64|amd64) printf '%s\n' "x64" ;;
    *) return 1 ;;
  esac
}

version_at_least() {
  actual="$1"
  awk -v actual="$actual" -v required="$NODE_VERSION_REQUIRED" '
    BEGIN {
      split(actual, a, ".");
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

node_is_supported() {
  candidate="$1"
  [ -x "$candidate" ] || return 1
  candidate_version=$("$candidate" -p 'process.versions.node' 2>/dev/null) || return 1
  version_at_least "$candidate_version" || return 1
  "$candidate" -e 'require("node:sqlite")' >/dev/null 2>&1
}

download_node_runtime() {
  case "$(uname -s)" in
    Darwin) node_platform="darwin" ;;
    Linux) node_platform="linux" ;;
    *)
      echo "Portable Runtime Lite 暂不支持此系统：$(uname -s)" >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) node_arch="arm64" ;;
    x86_64|amd64) node_arch="x64" ;;
    *)
      echo "Portable Runtime Lite 暂不支持此 CPU 架构：$(uname -m)" >&2
      exit 1
      ;;
  esac

  node_prefix="node-v${NODE_VERSION_DOWNLOAD}-${node_platform}-${node_arch}"
  node_install_dir="$RUNTIME_DIR/$node_prefix"
  node_install_path="$node_install_dir/bin/node"
  if node_is_supported "$node_install_path"; then
    printf '%s\n' "$node_install_path"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || {
    echo "找不到 curl，无法下载 Node.js ${NODE_VERSION_DOWNLOAD}" >&2
    exit 1
  }
  command -v tar >/dev/null 2>&1 || {
    echo "找不到 tar，无法解压 Node.js ${NODE_VERSION_DOWNLOAD}" >&2
    exit 1
  }
  command -v shasum >/dev/null 2>&1 || {
    echo "找不到 shasum，无法校验 Node.js 下载包" >&2
    exit 1
  }
  command -v awk >/dev/null 2>&1 || {
    echo "找不到 awk，无法读取 Node.js 校验和" >&2
    exit 1
  }

  mkdir -p "$RUNTIME_DIR"
  NODE_DOWNLOAD_DIR=$(mktemp -d "$RUNTIME_DIR/.node-download.XXXXXX")
  cleanup_node_download() {
    if [ -n "$NODE_DOWNLOAD_DIR" ] && [ -d "$NODE_DOWNLOAD_DIR" ]; then
      rm -rf "$NODE_DOWNLOAD_DIR"
    fi
  }
  trap cleanup_node_download EXIT INT TERM

  node_archive="$node_prefix.tar.gz"
  node_base_url="https://nodejs.org/dist/v${NODE_VERSION_DOWNLOAD}"
  node_archive_path="$NODE_DOWNLOAD_DIR/$node_archive"
  node_checksums_path="$NODE_DOWNLOAD_DIR/SHASUMS256.txt"
  echo "未找到可用 Node.js，正在下载 ${NODE_VERSION_DOWNLOAD}（${node_platform}-${node_arch}）…" >&2
  curl --proto '=https' --tlsv1.2 -fsSL "$node_base_url/$node_archive" -o "$node_archive_path"
  curl --proto '=https' --tlsv1.2 -fsSL "$node_base_url/SHASUMS256.txt" -o "$node_checksums_path"
  expected_checksum=$(awk -v name="$node_archive" '$2 == name { print $1; exit }' "$node_checksums_path")
  actual_checksum=$(shasum -a 256 "$node_archive_path" | awk '{ print $1 }')
  if [ -z "$expected_checksum" ] || [ "$expected_checksum" != "$actual_checksum" ]; then
    echo "Node.js 下载校验失败：$node_archive" >&2
    exit 1
  fi
  tar -xzf "$node_archive_path" -C "$NODE_DOWNLOAD_DIR"
  if [ -e "$node_install_dir" ]; then
    rm -rf "$node_install_dir"
  fi
  mv "$NODE_DOWNLOAD_DIR/$node_prefix" "$node_install_dir"
  # The bridge only needs node/npm/npx at runtime. Drop headers, docs and
  # Corepack from the downloaded distribution so the local cache stays small;
  # npm itself remains available for the AAMP bootstrap.
  rm -rf "$node_install_dir/include" "$node_install_dir/share" "$node_install_dir/lib/node_modules/corepack"
  if [ -e "$node_install_dir/bin/corepack" ] || [ -L "$node_install_dir/bin/corepack" ]; then
    rm -f "$node_install_dir/bin/corepack"
  fi
  chmod 755 "$node_install_path"
  trap - EXIT INT TERM
  cleanup_node_download
  printf '%s\n' "$node_install_path"
}

resolve_node() {
  universal_archive="$RUNTIME_DIR/node-universal.tar.gz"
  universal_arch="$(host_node_arch 2>/dev/null || true)"
  universal_node="$RUNTIME_DIR/node-universal/$universal_arch/bin/node"
  if [ -n "$universal_arch" ] && [ -f "$universal_archive" ]; then
    if ! node_is_supported "$universal_node"; then
      command -v tar >/dev/null 2>&1 || {
        echo "找不到 tar，无法解压内置 Node.js 运行时" >&2
        exit 1
      }
      echo "正在解压内置 Node.js ${universal_arch} 运行时…" >&2
      tar -xzf "$universal_archive" -C "$RUNTIME_DIR"
    fi
    if node_is_supported "$universal_node"; then
      printf '%s\n' "$universal_node"
      return 0
    fi
  fi

  bundled_node="$RUNTIME_DIR/bin/node"
  if [ -f "$RUNTIME_DIR/.bundled-node" ] && node_is_supported "$bundled_node"; then
    printf '%s\n' "$bundled_node"
    return 0
  fi
  system_node=$(command -v node 2>/dev/null || true)
  if [ -n "$system_node" ] && node_is_supported "$system_node"; then
    printf '%s\n' "$system_node"
    return 0
  fi
  if node_is_supported "$bundled_node"; then
    printf '%s\n' "$bundled_node"
    return 0
  fi
  download_node_runtime
}

NODE_BIN=$(resolve_node)
NODE_BIN_DIR=$(CDPATH= cd -P -- "$(dirname -- "$NODE_BIN")" && pwd -P)

# AAMP's bootstrap and the generated LaunchAgent need node/npm to be
# discoverable even when the caller has no Node installation on PATH.
export PATH="$NODE_BIN_DIR:$RUNTIME_DIR/bin:$APP_DIR/node_modules/.bin:${PATH:-}"
export FEISHU_CODEX_BRIDGE_PORTABLE_ROOT="$SELF_DIR"

run_entry() {
  entry="$1"
  shift
  exec "$NODE_BIN" "$APP_DIR/dist/$entry.js" "$@"
}

usage() {
  cat <<'USAGE'
用法：
  feishu-codex-bridge install|init|doctor [选项]
  feishu-codex-bridge start [选项]
  feishu-codex-bridge update [选项]
  feishu-codex-bridge service <install|start|stop|restart|status|logs|uninstall>
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
    exec "$NODE_BIN" --input-type=module -e \
      'import { readFileSync } from "node:fs"; const manifest = JSON.parse(readFileSync(process.argv[1], "utf8")); console.log(manifest.version || "0.0.0");' \
      "$APP_DIR/package.json"
    ;;
  list|scripts)
    printf '%s\n' \
      install init doctor start update service \
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
    NODE_NO_WARNINGS=1 run_entry install-cli "$command" "$@"
    ;;
  start|start:all)
    shift
    run_entry main "$@"
    ;;
  update)
    shift
    # The updater downloads, validates and stages the package before stopping
    # the current LaunchAgent. It also restarts the service after a successful
    # swap and restores the old package if the new service cannot start.
    exec "$NODE_BIN" "$APP_DIR/scripts/update-portable-release.mjs" --root "$SELF_DIR" "$@"
    ;;
  bridge:install)
    shift
    run_entry install-cli install "$@"
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
