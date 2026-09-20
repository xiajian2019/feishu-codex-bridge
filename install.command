#!/bin/sh

set -u

SELF_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)
cd "$SELF_DIR"

DEFAULT_INSTALL_DIR="$HOME/Applications/Feishu Codex Bridge"
if [ -f "$SELF_DIR/install.defaults" ]; then
  # This file is part of the package and is intentionally user-editable.
  . "$SELF_DIR/install.defaults"
fi
INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}

expand_install_dir() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~"/*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

if [ "${FEISHU_CODEX_BRIDGE_INSTALL_ROOT:-}" != "1" ]; then
  INSTALL_DIR=$(expand_install_dir "$INSTALL_DIR")
  if [ -t 0 ]; then
    printf '安装目录 [%s]（直接回车使用默认目录）：' "$INSTALL_DIR"
    read -r selected_install_dir || selected_install_dir=""
    if [ -n "$selected_install_dir" ]; then
      INSTALL_DIR=$(expand_install_dir "$selected_install_dir")
    fi
  fi

  mkdir -p "$INSTALL_DIR"
  INSTALL_DIR=$(CDPATH= cd -P -- "$INSTALL_DIR" && pwd -P)
  if [ "$INSTALL_DIR" != "$SELF_DIR" ]; then
    case "$INSTALL_DIR/" in
      "$SELF_DIR/"*)
        echo "安装目录不能位于当前发布包内部：$INSTALL_DIR" >&2
        exit 1
        ;;
    esac
    case "$SELF_DIR/" in
      "$INSTALL_DIR/"*)
        echo "安装目录不能包含当前发布包：$INSTALL_DIR" >&2
        exit 1
        ;;
    esac
    if ! command -v ditto >/dev/null 2>&1; then
      echo "找不到 macOS ditto，无法复制发布包到安装目录。" >&2
      exit 1
    fi
    echo "正在复制发布包到：$INSTALL_DIR"
    ditto "$SELF_DIR/." "$INSTALL_DIR/."
    FEISHU_CODEX_BRIDGE_INSTALL_ROOT=1 exec "$INSTALL_DIR/install.command" "$@"
  fi
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "这个安装包目前只支持 macOS。" >&2
  status=1
else
  if [ -x "$SELF_DIR/feishu-codex-bridge" ]; then
    "$SELF_DIR/feishu-codex-bridge" install "$@"
    status=$?
  elif [ -f "$SELF_DIR/bin/feishu-codex-bridge.mjs" ]; then
    node_path=$(command -v node 2>/dev/null || true)
    if [ -z "$node_path" ]; then
      echo "当前目录是源码版安装包，但没有 Node.js。请使用 Portable Runtime 发布包。" >&2
      status=1
    else
      NODE_NO_WARNINGS=1 "$node_path" "$SELF_DIR/bin/feishu-codex-bridge.mjs" install "$@"
      status=$?
    fi
  else
    echo "找不到安装器运行文件，请重新解压完整的发布包。" >&2
    status=1
  fi
fi

if [ "$status" -eq 0 ]; then
  echo
  echo "安装命令已完成。"
else
  echo
  echo "安装未完成，请保留此窗口中的错误信息。"
fi

if [ -t 0 ]; then
  printf '%s' "按回车关闭窗口…"
  read -r _ || true
fi

exit "$status"
