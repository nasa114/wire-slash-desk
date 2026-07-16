#!/bin/bash

# ⚠ バックアップには認証トークンが含まれる。リポジトリ外へ持ち出す場合は暗号化すること

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
readonly BACKUP_DIR="${PROJECT_ROOT}/backups"
readonly RETENTION_DAYS=7

# ディレクトリが存在しなければ作成
mkdir -p "$BACKUP_DIR"

# UTC タイムスタンプでバックアップファイル名を生成
readonly TIMESTAMP=$(date -u '+%Y%m%d-%H%M%S-utc')
readonly BACKUP_FILE="${BACKUP_DIR}/agent-home-${TIMESTAMP}.tar.gz"

# バックアップ対象のディレクトリ（存在するもののみ）
declare -a SOURCES_HOME
SOURCES_HOME=()

if [[ -d "$HOME/.claude" ]]; then
  SOURCES_HOME+=(".claude")
fi
if [[ -d "$HOME/.codex" ]]; then
  SOURCES_HOME+=(".codex")
fi

# /commandhistory を別途確認し、後で -C / で追加予定
SOURCES_ROOT=()
if [[ -d "/commandhistory" ]]; then
  SOURCES_ROOT+=("commandhistory")
fi

if [[ ${#SOURCES_HOME[@]} -eq 0 && ${#SOURCES_ROOT[@]} -eq 0 ]]; then
  echo "Info: バックアップ対象のディレクトリが見つかりません"
  exit 0
fi

echo "Backing up agent configuration..."
echo "  Source directories: ${SOURCES_HOME[*]:-none} ${SOURCES_ROOT[*]:-none}"
echo "  Output: $BACKUP_FILE"

# HOME 以下のファイルをバックアップ（相対パス保存）
if [[ ${#SOURCES_HOME[@]} -gt 0 ]]; then
  tar czf "$BACKUP_FILE" -C "$HOME" "${SOURCES_HOME[@]}"
fi

# /commandhistory があれば別途追加（-C / で絶対パスを相対に）
if [[ ${#SOURCES_ROOT[@]} -gt 0 ]]; then
  tar czf "$BACKUP_FILE" -C "/" "${SOURCES_ROOT[@]}" 2>/dev/null || true
fi

echo "Backup created: $BACKUP_FILE"

# 古いバックアップを削除（直近RETENTION_DAYS世代を保持）
echo "Cleaning old backups (keeping last $RETENTION_DAYS days)..."
find "$BACKUP_DIR" -name "agent-home-*.tar.gz" -type f -mtime +$RETENTION_DAYS -delete

# 残っているバックアップファイル数を表示
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "agent-home-*.tar.gz" -type f | wc -l)
echo "Current backups: $BACKUP_COUNT"
