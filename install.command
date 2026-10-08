#!/bin/sh

set -eu

SELF_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)

DEFAULT_INSTALL_DIR="$HOME/Applications/Feishu Codex Bridge"
if [ -f "$SELF_DIR/install.defaults" ]; then
  . "$SELF_DIR/install.defaults"
fi
INSTALL_DIR=${FEISHU_CODEX_BRIDGE_INSTALL_ROOT:-${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}}

expand_install_dir() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~"/*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

plist_argument() {
  option="$1"
  [ -f "$launch_agent_plist" ] || return 0
  /usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$launch_agent_plist" 2>/dev/null | awk -v option="$option" '
    { value = $0; sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value) }
    pending { print value; exit }
    value == option { pending = 1 }
  '
}

plist_environment() {
  key="$1"
  [ -f "$launch_agent_plist" ] || return 0
  /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$launch_agent_plist" 2>/dev/null || true
}

preserve_file() {
  source_path="$1"
  destination_path="$2"
  if [ -f "$source_path" ] && [ ! -e "$destination_path" ] && [ "$source_path" != "$destination_path" ]; then
    mkdir -p "$(dirname -- "$destination_path")"
    temporary_path="$destination_path.migrate.$$"
    if ! cp -p "$source_path" "$temporary_path"; then
      rm -f "$temporary_path"
      return 1
    fi
    if ! mv "$temporary_path" "$destination_path"; then
      rm -f "$temporary_path"
      return 1
    fi
  fi
}

INSTALL_DIR=$(expand_install_dir "$INSTALL_DIR")
if [ -t 0 ] && [ -z "${FEISHU_CODEX_BRIDGE_INSTALL_ROOT:-}" ]; then
  printf '固定安装目录 [%s]（直接回车使用默认目录）：' "$INSTALL_DIR"
  read -r selected_install_dir || selected_install_dir=""
  if [ -n "$selected_install_dir" ]; then
    INSTALL_DIR=$(expand_install_dir "$selected_install_dir")
  fi
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "这个安装包目前只支持 macOS。" >&2
  exit 1
fi
if [ ! -x "$SELF_DIR/feishu-codex-bridge" ] || [ ! -f "$SELF_DIR/release-manifest.json" ]; then
  echo "找不到完整的 Portable Runtime 发布包，请重新解压。" >&2
  exit 1
fi
if ! command -v ditto >/dev/null 2>&1 || ! command -v shasum >/dev/null 2>&1; then
  echo "安装需要 macOS ditto 和 shasum。" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR/releases" "$INSTALL_DIR/runtime/logs"
INSTALL_DIR=$(CDPATH= cd -P -- "$INSTALL_DIR" && pwd -P)
case "$INSTALL_DIR/" in
  "$SELF_DIR/"*)
    echo "固定安装目录不能位于当前发布包内部：$INSTALL_DIR" >&2
    exit 1
    ;;
esac

manifest_version=$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$SELF_DIR/release-manifest.json")
manifest_hash=$(shasum -a 256 "$SELF_DIR/release-manifest.json" | awk '{ print $1 }' | cut -c 1-10)
if [ -x "$SELF_DIR/app/feishu-codex-bridge" ]; then
  executable_hash=$(shasum -a 256 "$SELF_DIR/app/feishu-codex-bridge" | awk '{ print $1 }' | cut -c 1-10)
else
  executable_hash=$(shasum -a 256 "$SELF_DIR/feishu-codex-bridge" | awk '{ print $1 }' | cut -c 1-10)
fi
if [ -z "$manifest_version" ] || [ -z "$manifest_hash" ] || [ -z "$executable_hash" ]; then
  echo "无法从发布包读取有效版本信息。" >&2
  exit 1
fi
release_id=$(printf '%s' "$manifest_version" | tr -c 'A-Za-z0-9._-' '-')-"$manifest_hash-$executable_hash"
release_dir="$INSTALL_DIR/releases/$release_id"
staging_dir=$(mktemp -d "$INSTALL_DIR/releases/.staging.XXXXXX")
launch_agent_plist="$HOME/Library/LaunchAgents/com.local.feishu-codex-bridge.plist"
launch_agent_backup="$INSTALL_DIR/.launch-agent-backup-$$.plist"
old_config_path=""
old_db_path=""
old_portable_root=""
old_app_root=""
previous_target=""
service_was_loaded=0

cleanup() {
  if [ -n "$staging_dir" ] && [ -d "$staging_dir" ]; then rm -rf "$staging_dir"; fi
  rm -f "$INSTALL_DIR/.current-next-$$" "$launch_agent_backup"
}
finish() {
  result=$?
  cleanup
  if [ -t 0 ]; then
    printf '%s' "按回车关闭窗口…"
    read -r _ || true
  fi
  return "$result"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

if [ -e "$INSTALL_DIR/current" ] && [ ! -L "$INSTALL_DIR/current" ]; then
  echo "current 已存在且不是符号链接，拒绝覆盖：$INSTALL_DIR/current" >&2
  exit 1
fi
if [ -L "$INSTALL_DIR/current" ]; then
  previous_target=$(readlink "$INSTALL_DIR/current")
fi

echo "正在将版本 $manifest_version 安装到固定根目录：$INSTALL_DIR"
ditto "$SELF_DIR/." "$staging_dir/."
if [ ! -x "$staging_dir/feishu-codex-bridge" ] || [ ! -f "$staging_dir/release-manifest.json" ]; then
  echo "发布包暂存验证失败。" >&2
  exit 1
fi
if [ -e "$release_dir" ]; then
  rm -rf "$staging_dir"
  staging_dir=""
else
  mv "$staging_dir" "$release_dir"
  staging_dir=""
fi

if [ -f "$launch_agent_plist" ]; then
  cp -p "$launch_agent_plist" "$launch_agent_backup"
  old_config_path=$(plist_argument "--config" || true)
  old_db_path=$(plist_argument "--db" || true)
  old_portable_root=$(plist_environment "FEISHU_CODEX_BRIDGE_PORTABLE_ROOT")
  old_app_root=$(plist_environment "FEISHU_CODEX_BRIDGE_APP_ROOT")
  if [ -z "$old_app_root" ] && [ -n "$old_portable_root" ]; then old_app_root="$old_portable_root/app"; fi
  if [ -z "$old_portable_root" ] && [ -n "$old_app_root" ]; then old_portable_root=$(dirname -- "$old_app_root"); fi
fi
if /bin/launchctl print "gui/$(id -u)/com.local.feishu-codex-bridge" >/dev/null 2>&1; then
  service_was_loaded=1
  active_launcher="$INSTALL_DIR/current/feishu-codex-bridge"
  if [ ! -x "$active_launcher" ]; then active_launcher="$INSTALL_DIR/feishu-codex-bridge"; fi
  if [ -x "$active_launcher" ]; then
    "$active_launcher" service stop || {
      echo "旧服务未能优雅停止；保留当前版本并中止安装。" >&2
      exit 1
    }
  else
    "$release_dir/feishu-codex-bridge" service stop || exit 1
  fi
fi

replace_current_link() {
  next_path="$INSTALL_DIR/.current-next-$$"
  rm -f "$next_path"
  ln -s "$1" "$next_path" || return 1
  if ! mv -fh "$next_path" "$INSTALL_DIR/current"; then
    rm -f "$next_path"
    return 1
  fi
}

activate_release() {
  replace_current_link "releases/$release_id"
}

rollback_release() {
  "$INSTALL_DIR/current/feishu-codex-bridge" service stop >/dev/null 2>&1 || true
  if [ -n "$previous_target" ]; then
    replace_current_link "$previous_target" || true
  else
    rm -f "$INSTALL_DIR/current"
  fi
  if [ "$service_was_loaded" -eq 1 ]; then
    if [ -f "$launch_agent_backup" ]; then
      cp -p "$launch_agent_backup" "$launch_agent_plist" || true
    fi
    if [ -x "$INSTALL_DIR/current/feishu-codex-bridge" ]; then
      "$INSTALL_DIR/current/feishu-codex-bridge" service start >/dev/null 2>&1 || true
    elif [ -x "$INSTALL_DIR/feishu-codex-bridge" ]; then
      "$INSTALL_DIR/feishu-codex-bridge" service start >/dev/null 2>&1 || true
    elif [ -f "$launch_agent_backup" ]; then
      cp -p "$launch_agent_backup" "$launch_agent_plist"
      /bin/launchctl bootstrap "gui/$(id -u)" "$launch_agent_plist" >/dev/null 2>&1 || true
    fi
  fi
}

preserve_user_state() {
  preserve_file "$old_config_path" "$INSTALL_DIR/config.json" || return 1
  preserve_file "$old_db_path" "$INSTALL_DIR/runtime/bridge.db" || return 1
  if [ -f "$old_db_path-wal" ]; then preserve_file "$old_db_path-wal" "$INSTALL_DIR/runtime/bridge.db-wal" || return 1; fi
  if [ -f "$old_db_path-shm" ]; then preserve_file "$old_db_path-shm" "$INSTALL_DIR/runtime/bridge.db-shm" || return 1; fi
  if [ -n "$old_app_root" ] && [ -d "$old_app_root/runtime/direct/attachments" ] && [ ! -e "$INSTALL_DIR/runtime/direct/attachments" ]; then
    mkdir -p "$INSTALL_DIR/runtime/direct" || return 1
    ditto "$old_app_root/runtime/direct/attachments" "$INSTALL_DIR/runtime/direct/attachments" || return 1
  fi
  return 0
}

if ! preserve_user_state; then
  echo "无法安全迁移现有配置或运行数据；正在恢复旧服务。" >&2
  rollback_release
  exit 1
fi
if ! activate_release; then
  echo "无法切换 current 版本入口；正在恢复旧服务。" >&2
  rollback_release
  exit 1
fi
export FEISHU_CODEX_BRIDGE_INSTALL_ROOT="$INSTALL_DIR"
export FEISHU_CODEX_BRIDGE_ENTRYPOINT="$INSTALL_DIR/current/app/feishu-codex-bridge"
export FEISHU_CODEX_BRIDGE_APP_ROOT="$INSTALL_DIR/current/app"
export FEISHU_CODEX_BRIDGE_PORTABLE_ROOT="$INSTALL_DIR/current"
if "$INSTALL_DIR/current/feishu-codex-bridge" install \
  --config "$INSTALL_DIR/config.json" \
  --db "$INSTALL_DIR/runtime/bridge.db" \
  "$@"; then
  echo "已激活不可变版本目录：$release_dir"
  echo "活动版本入口：$INSTALL_DIR/current"
  exit 0
else
  status=$?
  echo "新版本启动失败，正在恢复上一个版本…" >&2
  rollback_release
  exit "$status"
fi
