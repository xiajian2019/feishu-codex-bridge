#!/bin/sh

set -u

SELF_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)
cd "$SELF_DIR"

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
      "$node_path" "$SELF_DIR/bin/feishu-codex-bridge.mjs" install "$@"
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
