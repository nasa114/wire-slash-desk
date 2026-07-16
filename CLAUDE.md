# プロジェクト規約

## 基本方針
- 設計の一次情報は `docs/002_Spec.md`。矛盾があれば実装せず質問すること
- 参照ドキュメント: `docs/001_Brief.md`（概要）、`docs/003_AgentTasks.md`（実装タスク）

## 絶対条件（違反PRは不可）
1. **collector が articles.content に本文を書き込まない**（設計書 §5 の不変条件テストを壊さない）
2. **fulltext_allowed=false のソースから本文を取得するコードを書かない**
3. **認証情報・トークンをコード/ログ/コミットに含めない**

## 実行環境
- **Node.js 24** 必須（TS native type stripping実行、相対import は `.ts` 拡張子必須）
- TypeScript 5.9.3（native type stripping対応）
- データベース: PostgreSQL 17 + pgvector拡張（Dev Container内 pgvector/pgvector:pg17）

## テストフレームワーク
- **node:test + node:assert/strict**（vitest は使用しない）
- 実行コマンド: `npm test`
- リポジトリ層: インメモリfakeに対するユニットテスト（TDD）
- 結合テスト: Dev Container内PostgreSQLに対する契約テスト（`test/contract/` で両実装が共有）

## パッケージ管理
- **パッケージ追加は `.claude/skills/secure-npm-install` スキル経由で必須**
- pnpm@11.7.0、frozen-lockfile を原則とする
- postinstall スクリプトは `--ignore-scripts` で実行しない

## 進め方
1. TDD原則: リポジトリ層はインターフェース → fake → テスト → PostgreSQL実装の順序
2. 1ブランチ = 1タスク（docs/003_AgentTasks.md の T番号に対応）
3. コミット形式: Conventional Commits（`feat:` `fix:` `test:` `docs:` など）
4. 各ターン末に `git status --short` を1行報告

## Definition of Done
- 受け入れ条件（docs/003_AgentTasks.md の該当T番号）をすべて満たす
- `npm test` `npm run lint` が全緑
- 変更概要と確認手順を報告
- セキュリティレビュー（`.claude/agents/security-reviewer`）を事前実施
- 秘密情報・トークンがコミットに混入していないことを確認

## 不明点の対応
- 推測で進めず、選択肢と推奨を添えて質問する
- 設計書と矛盾する場合は実装前に確認

## 開発フロー
- `/goal` で受け入れ条件の自動評価を活用
- サブエージェント（`security-reviewer` / `test-writer`）を事前活用

## 実行環境の既知の癖(全エージェント向け・2026-07-16 実証)
- **docker / psql は無い**: DB直接操作は `node -e` + pg クライアント。Dockerfile/compose はこのコンテナではビルド検証不可(構文検証まで)
- **画面確認**: Playwright MCP は不可(chrome channel 未導入)。スクリーンショットは `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell --headless --disable-gpu --no-sandbox --screenshot=<out.png> <URL>`。認証必須ページは curl(Cookie jar)で保存した HTML を `file://` で開く
- **アプリ起動**: `NODE_USE_ENV_PROXY=1 node --env-file=.env src/main.ts`(NODE_USE_ENV_PROXY はシェルから渡す)。ポート3000に前セッションのプロセスが残っていることがあるため、検証前に「どのコードが動いているか」を確認する
- **外部API**: squid 許可リスト外は 403(例: api.osv.dev → 脆弱性照会は `pnpm audit` で代替)
- **Codex CLI**: 内蔵サンドボックス(bwrap)はコンテナ内で動かない。環境全体が Dev Container で隔離されているため **`--sandbox danger-full-access` での実行をオーナーが承認済み(2026-07-16)**: `codex exec --skip-git-repo-check --sandbox danger-full-access -C <dir> "<プロンプト>" < /dev/null`(stdin を閉じないとハングする)。テキストだけ欲しい場合は `--sandbox read-only` + 回答本文出力でも可(その場合、出力にプロンプトのエコーが混ざるため成果物は最後の出現位置から抽出する)
