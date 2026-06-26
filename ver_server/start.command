#!/bin/zsh

cd "$(dirname "$0")" || exit 1
PORT="${SEATING_PORT:-8000}"
PYTHON_BIN="${SEATING_PYTHON_BIN:-python3.10}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3.10 が見つかりません。"
  echo "Python 3.10 以降をインストールするか、SEATING_PYTHON_BIN で実行ファイルを指定してください。"
  read -k 1 "?何かキーを押して閉じます。"
  exit 1
fi

if ! "$PYTHON_BIN" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  echo "Python 3.10 以降が必要です。"
  "$PYTHON_BIN" --version
  read -k 1 "?Python 3.10 以降をインストールしてから、何かキーを押して閉じます。"
  exit 1
fi

echo "席替えアプリを起動します。"
echo "このPCの管理画面: http://localhost:${PORT}/admin"
echo "参加者用のアドレスは、起動後に表示されます。"
echo "停止するには、この画面で Control + C を押します。"
echo

SEATING_PORT="$PORT" SEATING_ADMIN_PASSWORD="${SEATING_ADMIN_PASSWORD:-admin}" "$PYTHON_BIN" app.py
