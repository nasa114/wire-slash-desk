#!/bin/bash

# ⚠ リストア前に必ずバックアップファイルの完全性を確認してください

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

usage() {
  cat << 'EOF'
Usage: ./agent-home-restore.sh [OPTIONS] <backup-file>

Options:
  -f, --force   上書き前の確認を省略
  -h, --help    このヘルプを表示

Example:
  ./agent-home-restore.sh backups/agent-home-20260716-120000-utc.tar.gz
  ./agent-home-restore.sh -f backups/agent-home-20260716-120000-utc.tar.gz

Note:
  バックアップにはClaude Code/Codexの認証トークンが含まれています。
  リストア後、ホームディレクトリ内のファイル所有権が正しいことを確認してください。
EOF
}

FORCE=false
BACKUP_FILE=""

# オプション解析
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force)
      FORCE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Error: Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      BACKUP_FILE="$1"
      shift
      ;;
  esac
done

# 引数チェック
if [[ -z "$BACKUP_FILE" ]]; then
  echo "Error: backup file not specified" >&2
  usage
  exit 1
fi

# ファイルの存在確認
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Error: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

# 絶対パスに変換
if [[ "$BACKUP_FILE" != /* ]]; then
  BACKUP_FILE="$(cd "$(dirname "$BACKUP_FILE")" && pwd)/$(basename "$BACKUP_FILE")"
fi

echo "Restoring agent configuration from: $BACKUP_FILE"
echo ""

# tar の内容を確認（dry-run）
echo "Contents preview:"
tar tzf "$BACKUP_FILE" | head -20
echo "..."
echo ""

# 確認プロンプト（-f で省略）
if [[ "$FORCE" != true ]]; then
  echo "⚠ This will extract to your home directory and /commandhistory."
  echo "Make sure you have a backup of your current configuration."
  read -p "Continue? (yes/no): " -r CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "Restoring..."

# HOME 以下へ展開（相対パスが保存されているので .claude .codex が復元される）
tar xzf "$BACKUP_FILE" -C "$HOME" 2>/dev/null || true

# /commandhistory があれば / 以下へ展開
tar xzf "$BACKUP_FILE" -C "/" commandhistory 2>/dev/null || true

echo "Restore completed."
echo ""
echo "Next steps:"
echo "  1. Verify file ownership: ls -la ~/.claude ~/.codex"
echo "  2. If ownership is wrong, run: sudo chown -R \$USER:\$USER ~/.claude ~/.codex"
echo "  3. Restart Claude Code or your shell to verify login state"
