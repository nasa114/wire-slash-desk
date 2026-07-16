#!/usr/bin/env bash
# guard-cmd.sh — 単一真実源のブロック判定スクリプト
# Claude Code と Codex の両方の PreToolUse hook から呼ばれる。
# 入力取得の優先順位:
#   1. 第1引数にコマンド文字列が渡された場合 (直接テスト用)
#   2. CLAUDE_TOOL_INPUT 環境変数 (Claude Code が設定)
#   3. 標準入力 JSON (Codex が hook stdin 経由で渡す)
# ブロック対象 -> exit 2 + 日本語メッセージ(stderr)
# 先頭に SECURE_NPM_INSTALL=1 -> exit 0
# その他 -> exit 0

set -eu

# ---------- コマンド文字列の取得 ----------
cmd=""
if [ $# -ge 1 ]; then
  # 引数で直接渡された場合 (テスト用)
  cmd="$1"
elif [ -n "${CLAUDE_TOOL_INPUT:-}" ]; then
  # Claude Code 経由: CLAUDE_TOOL_INPUT 環境変数から JSON を読む
  cmd=$(printf '%s' "$CLAUDE_TOOL_INPUT" | jq -r '.command // ""' 2>/dev/null || true)
else
  # Codex 経由: stdin から JSON を読む (タイムアウトなし・ブロックなし前提)
  stdin_data=$(cat 2>/dev/null || true)
  if [ -n "$stdin_data" ]; then
    cmd=$(printf '%s' "$stdin_data" | jq -r '.tool_input.command // .command // ""' 2>/dev/null || true)
  fi
fi

# コマンド文字列が空なら許可
if [ -z "$cmd" ]; then
  exit 0
fi

# ---------- Co-Authored-By / 帰属トレーラーのブロック ----------
if printf '%s' "$cmd" | grep -qE 'Co-Authored-By|Co-Author:|Generated with Claude|🤖 Generated'; then
  printf 'BLOCKED: Co-Authored-By / Generated with Claude などの帰属トレーラーは禁止です。\n' >&2
  exit 2
fi

# ---------- SECURE_NPM_INSTALL=1 先頭 bypass の検査 ----------
# "SECURE_NPM_INSTALL=1 " が先頭にある場合のみ bypass を許可する。
# 中間・末尾への挿入では回避不可。
if [ "${cmd#SECURE_NPM_INSTALL=1 }" != "$cmd" ]; then
  exit 0
fi

# ---------- パッケージ変更コマンドのブロック ----------
# 現行 settings.json の regex と完全一致。
# eval は一切使わず grep -E で判定する。
BLOCK_PATTERN='(^|[;&|`(] *|sudo +|(env +)?([A-Z_][A-Z0-9_]*=[^ ]+ +)+)(npm +(i|install|ci|update|upgrade|dedupe|link|exec)( |$)|npm +audit +fix|npx +[^ ]|pnpm +(add|install|update|upgrade|dlx)|yarn +(add|upgrade|create))'

if printf '%s' "$cmd" | grep -qE "$BLOCK_PATTERN"; then
  printf 'BLOCKED: パッケージ変更コマンドは /secure-npm-install を経由してください。スキル全工程の完了後、コマンド先頭に SECURE_NPM_INSTALL=1 を付けて再実行してください。\n' >&2
  exit 2
fi

exit 0
