#!/bin/bash

# ⚠ リストア前に必ずバックアップファイルの完全性を確認してください
# ⚠ バックアップには Claude Code / Codex の認証トークンが含まれています

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

# 作業用の一時ファイル/ディレクトリ。終了時に必ず後始末する。
LIST_NAMES="$(mktemp)"
LIST_VERBOSE="$(mktemp)"
STAGE_DIR=""
cleanup() {
  rm -f "$LIST_NAMES" "$LIST_VERBOSE"
  [[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

echo "Restoring agent configuration from: $BACKUP_FILE"
echo ""

# 一覧は一時ファイルへ全出力してから先頭を表示する。
# (set -o pipefail 下で `tar tzf | head` は SIGPIPE により正常アーカイブでも失敗し得るため)
tar tzf "$BACKUP_FILE" > "$LIST_NAMES"
tar tvzf "$BACKUP_FILE" > "$LIST_VERBOSE"

echo "Contents preview:"
head -20 "$LIST_NAMES"
if [[ "$(wc -l < "$LIST_NAMES")" -gt 20 ]]; then
  echo "..."
fi
echo ""

# --- エントリ検証(危険なアーカイブは復元前に拒否) ---------------------------
# 許可するトップレベル: .claude / .codex / commandhistory のみ。
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue

  # 絶対パスを拒否
  if [[ "$entry" == /* ]]; then
    echo "Error: 絶対パスのエントリを検出しました: $entry" >&2
    exit 1
  fi

  # '..' をコンポーネントとして含むパスを拒否(パストラバーサル対策)
  if [[ "$entry" == ".." || "$entry" == "../"* || "$entry" == *"/../"* || "$entry" == *"/.." ]]; then
    echo "Error: '..' を含むエントリを検出しました: $entry" >&2
    exit 1
  fi

  # 先頭コンポーネントが許可対象かを検証
  top="${entry%%/*}"
  case "$top" in
    .claude|.codex|commandhistory) ;;
    *)
      echo "Error: 想定外のトップレベルエントリを検出しました: $entry" >&2
      exit 1
      ;;
  esac
done < "$LIST_NAMES"

# symlink('l') / hardlink('h') エントリを拒否(tar tvzf の行頭が種別文字)
if grep -qE '^[lh]' "$LIST_VERBOSE"; then
  echo "Error: symlink/hardlink エントリを検出しました。安全のため復元を中止します。" >&2
  grep -E '^[lh]' "$LIST_VERBOSE" >&2
  exit 1
fi

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

# 検証済みアーカイブを安全な一時ディレクトリへ展開してから所定位置へコピーする。
STAGE_DIR="$(mktemp -d)"
tar xzf "$BACKUP_FILE" -C "$STAGE_DIR"

# ステージ上の <name> ディレクトリの中身を <dest_parent>/<name> へ反映する。
restore_dir() {
  local name="$1" dest_parent="$2"
  local src="$STAGE_DIR/$name"
  [[ -d "$src" ]] || return 0
  mkdir -p "$dest_parent/$name"
  cp -a "$src/." "$dest_parent/$name/"
  echo "  Restored: $dest_parent/$name"
}

restore_dir ".claude" "$HOME"
restore_dir ".codex" "$HOME"
restore_dir "commandhistory" "/"

echo "Restore completed."
echo ""
echo "Next steps:"
echo "  1. Verify file ownership: ls -la ~/.claude ~/.codex"
echo "  2. If ownership is wrong, run: sudo chown -R \$USER:\$USER ~/.claude ~/.codex"
echo "  3. Restart Claude Code or your shell to verify login state"
