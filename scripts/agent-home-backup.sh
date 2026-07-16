#!/bin/bash

# ⚠ バックアップには認証トークンが含まれる。リポジトリ外へ持ち出す場合は暗号化すること

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
readonly BACKUP_DIR="${PROJECT_ROOT}/backups"
# 保持する世代数(ファイル名の時刻順で新しいものからこの件数だけ残す)
readonly RETENTION_COUNT=7

# ディレクトリが存在しなければ作成
mkdir -p "$BACKUP_DIR"

# UTC タイムスタンプでバックアップファイル名を生成
readonly TIMESTAMP=$(date -u '+%Y%m%d-%H%M%S-utc')
readonly BACKUP_FILE="${BACKUP_DIR}/agent-home-${TIMESTAMP}.tar.gz"

# tar 引数を組み立てる。存在する対象だけを 1 回の tar 呼び出しに積む
#   -C "$HOME" .claude .codex  … HOME 以下は相対パスで保存
#   -C /       commandhistory  … 絶対パスの対象を相対に切り替えて保存
declare -a TAR_ARGS
TAR_ARGS=()

if [[ -d "$HOME/.claude" ]]; then
  TAR_ARGS+=(-C "$HOME" .claude)
fi
if [[ -d "$HOME/.codex" ]]; then
  TAR_ARGS+=(-C "$HOME" .codex)
fi
if [[ -d "/commandhistory" ]]; then
  TAR_ARGS+=(-C / commandhistory)
fi

if [[ ${#TAR_ARGS[@]} -eq 0 ]]; then
  echo "Info: バックアップ対象のディレクトリが見つかりません"
  exit 0
fi

echo "Backing up agent configuration..."
echo "  Output: $BACKUP_FILE"

# 全対象を 1 回の tar 呼び出しで格納する(複数回呼ぶと後勝ちで上書きされ先の対象が消えるため)。
# set -euo pipefail 下なので失敗は即エラー終了する(|| true で握りつぶさない)。
tar czf "$BACKUP_FILE" "${TAR_ARGS[@]}"

echo "Backup created: $BACKUP_FILE"

# 世代管理: ファイル名(= UTC タイムスタンプ)の降順で新しい RETENTION_COUNT 件だけ残す。
echo "Cleaning old backups (keeping newest $RETENTION_COUNT)..."
declare -a BACKUPS
BACKUPS=()
while IFS= read -r f; do
  BACKUPS+=("$f")
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'agent-home-*.tar.gz' -type f | sort -r)

for ((i = RETENTION_COUNT; i < ${#BACKUPS[@]}; i++)); do
  echo "  Removing old backup: ${BACKUPS[$i]}"
  rm -f "${BACKUPS[$i]}"
done

# 残っているバックアップファイル数を表示
BACKUP_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name 'agent-home-*.tar.gz' -type f | wc -l)
echo "Current backups: $BACKUP_COUNT"
