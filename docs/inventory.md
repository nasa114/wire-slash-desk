# T0-0 現状把握レポート（2026-07-16）

## 概要
リポジトリの走査結果として、MySQL依存箇所、永続化設定、テスト基盤の確認結果を記載。

---

## 1. MySQL依存箇所

| 項目 | 検索結果 | 備考 |
|---|---|---|
| 接続文字列 | **なし** | `DATABASE_URL` は既に PostgreSQL 形式（`postgresql://`） |
| SQL方言 | **なし** | マイグレーションは node-pg-migrate 標準形式 |
| 依存パッケージ | **なし** | `mysql2` `mysql` 等なし。`pg` 8.22.0 のみ |
| docker-compose | **なし** | `db` サービスは `pgvector/pgvector:pg17` に統一済み |
| 環境変数 | **POSTGRES_*** | MySQL関連（MYSQL_HOST等）はなし |
| devcontainer.json | **PostgreSQL** | `services: app` の `DATABASE_URL` は PostgreSQL 接続文字列 |
| .env / .env.example | 確認待機 | 本タスクで作成予定 |

**結論**: MySQL時代の痕跡なし。DB層は PostgreSQL 構成に完全移行済み。✓ **T0-1完了**

---

## 2. 永続化設定（エージェント環境）

| 項目 | 設定箇所 | 状態 | T番号対応 |
|---|---|---|---|
| Claude Code ホームディレクトリ | `.devcontainer/compose.yml` line 35 | named volume `cc-userdata:/home/node/.claude` | ✓ T0-2 |
| Codex ホームディレクトリ | `.devcontainer/compose.yml` line 36 | named volume `codex-userdata:/home/node/.codex` | ✓ T0-2 |
| コマンド履歴 | `.devcontainer/devcontainer.json` | 記載なし（追加予定） | T0-2 |
| 所有権設定 | `.devcontainer/devcontainer.json` line 32 | `postCreateCommand: sudo chown node:node -R ...` | ✓ T0-2 |
| バックアップスクリプト | `scripts/agent-home-backup.sh` / `restore.sh` | 本タスクで作成 | T0-2 |

**結論**: 
- named volumes による永続化は既に実装済み（rebuild後も再ログイン不要）
- `/commandhistory` のvolume化は devcontainer.json に追加予定
- バックアップスクリプト（T0-2 §9.3）は本タスクで新規作成

✓ **T0-2の volume 部分は完了済み、バックアップスクリプト・コマンド履歴のvolume化は本タスクで補完**

---

## 3. テスト基盤

| 項目 | 設定 | 備考 |
|---|---|---|
| テストランナー | **node:test** | `package.json` "test" script で `node --test "test/**/*.test.ts"` |
| アサーション | **node:assert** | package.json には記載（`node:` prefix でネイティブ使用） |
| テストファイル | `test/**/*.test.ts` | 拡張子 `.ts` のまま native type stripping で実行 |
| TypeScript | 5.9.3 | native type stripping 対応版 |
| リポジトリテスト | `test/unit/`, `test/contract/` | fake実装 + PostgreSQL実装の両対応 |
| フィクスチャ | `test/fixtures/` | RSS本文含むサンプルデータあり（T2-1確認用） |
| 統合テスト | `test/integration/` | Dev Container内DB対象の契約テスト |

**テスト実行例**:
```bash
npm test                                  # すべてのテスト
node --test test/contract/*.contract.ts  # 契約テストのみ
```

**結論**: 
- **vitest は使用していない**。Node 24 ネイティブの `node:test` を採用
- テスト基盤は整備済み（リポジトリ層の fake・contract テスト構造あり）

✓ **T0-3で CLAUDE.md / AGENTS.md の「テストフレームワーク」セクションに node:test + node:assert を明記**

---

## 4. マイグレーション・スキーマ

| 項目 | パス | 状態 |
|---|---|---|
| ツール | `node-pg-migrate` 8.0.4 | `package.json` 依存 |
| 初期スキーマ | `migrations/1784172242000_init-schema.js` | feeds / articles テーブルのみ（M5テーブルなし） |
| migrate コマンド | `npm run migrate` | up実装済み |
| migrate:down | `npm run migrate:down` | down実装済み |

**結論**: マイグレーション基盤（T1-1）は実装済み。スキーマは設計書 §4 の初期構成。

---

## 5. コレクター実装

| 項目 | パス | 状態 | T番号 |
|---|---|---|---|
| フレームワーク | `src/collector/` | 実装中 | T2-1 |
| RSS パーサー | `rss-parser` 3.13.0 | `package.json` 依存 | T2-1 |
| 本文フィールド処理 | テスト中（予定） | **本文を保存しない不変条件テスト必須** | T2-1 |
| 条件付きGET | 実装予定 | ETag / If-Modified-Since | T2-1 |
| トリガーエンドポイント | `src/server/` | 実装予定（`POST /internal/collect`） | T2-2 |

**結論**: コレクター層は T2-1 / T2-2 で実装予定。設計書 §5 を参照。

---

## 6. ドメイン層・リポジトリパターン

| 項目 | パス | 状態 |
|---|---|---|
| インターフェース定義 | `src/domain/repositories.ts` | `FeedRepository` / `ArticleRepository` インターフェース実装済み |
| ドメイン型 | `src/domain/types.ts` | `Feed` / `Article` 型定義済み |
| エラー定義 | `src/domain/errors.ts` | ドメイン固有エラー実装済み |
| Memory実装 | `src/repo/memory/` | fake実装完成（ユニットテスト対象） |
| PostgreSQL実装 | `src/repo/pg/` | 実装予定（T1-2） |

**結論**: 
- インターフェース + fake は完成
- PostgreSQL実装は T1-2 で予定
- 契約テスト（`test/contract/`）で両実装を統一テスト

---

## 7. MCP・サーバー実装

| 項目 | パス | 状態 | T番号 |
|---|---|---|---|
| MCPサーバー | `src/mcp/` | 実装予定 | T3-1 |
| MCP SDK | `@modelcontextprotocol/sdk` 1.29.0 | 依存済み | T3-1 |
| 認証（Bearer） | 実装予定 | 環境変数 `MCP_BEARER_TOKEN` | T3-2 |
| 読み取りツール | 設計書 §7 参照 | 6ツール予定 | T3-1 |

**結論**: MCP層は T3-1 / T3-2 で実装予定。設計書 §7 を参照。

---

## 8. DevContainer設定

| 項目 | ファイル | 状態 | 備考 |
|---|---|---|---|
| ベースイメージ | `devcontainer.json` line 9 | `typescript-node:4.0.10-24-bullseye` | Node 24 同梱 |
| Docker Compose | `compose.yml` | PostgreSQL + pgvector 構成 | ✓ T0-1 |
| named volumes | `compose.yml` | `cc-userdata`, `codex-userdata`, `pg-data` | ✓ T0-2 |
| Claude Code feature | `devcontainer.json` line 25 | `ghcr.io/anthropics/devcontainer-features/claude-code:1.0.5` | ✓ T0-3 |
| ポストコマンド | `devcontainer.json` line 32 | `sudo chown node:node ...` | ✓ T0-2 |

**結論**: 基盤設定は完全。本タスク（T0-3）で `/commandhistory` volume化、CLAUDE.md/AGENTS.md、バックアップスクリプト補完。

---

## 9. ファイル・ディレクトリ構成

```
/workspaces/
├── migrations/              # DBマイグレーション（node-pg-migrate）
│   └── 1784172242000_init-schema.js
├── src/
│   ├── domain/             # ドメインインターフェース・型定義
│   │   ├── types.ts
│   │   ├── repositories.ts
│   │   └── errors.ts
│   ├── repo/               # リポジトリ実装
│   │   ├── memory/         # fake実装（ユニットテスト用）
│   │   └── pg/             # PostgreSQL実装（T1-2予定）
│   ├── collector/          # フィード収集ロジック（T2-1予定）
│   ├── mcp/                # MCPサーバー（T3-1予定）
│   └── server.ts           # Express / Hono等メインサーバー
├── test/
│   ├── unit/               # ユニットテスト（fake対象）
│   ├── contract/           # 契約テスト（fake + PG両方式通す）
│   ├── integration/        # 統合テスト（PG実装対象）
│   ├── fixtures/           # テスト用フィクスチャ
│   └── *.test.ts           # テストファイル
├── docs/
│   ├── 001_Brief.md        # 企画書
│   ├── 002_Spec.md         # 設計書
│   ├── 003_AgentTasks.md   # 実装タスク定義
│   └── inventory.md        # 本レポート（T0-0）
├── .devcontainer/
│   ├── devcontainer.json
│   ├── compose.yml         # PostgreSQL + app + squid
│   └── squid/              # プロキシ設定
├── .github/
│   └── workflows/          # GitHub Actions
│       └── collect.yml     # フィード収集スケジュール（T0-3予定）
├── .claude/
│   ├── settings.json
│   ├── agents/             # サブエージェント定義（T0-3新規）
│   │   ├── security-reviewer.md
│   │   └── test-writer.md
│   └── skills/             # スキル定義（既存）
├── scripts/
│   ├── agent-home-backup.sh     # バックアップスクリプト（T0-3新規）
│   └── agent-home-restore.sh    # リストアスクリプト（T0-3新規）
├── package.json            # Node依存・スクリプト定義
├── tsconfig.json
├── pnpm-workspace.yaml
├── CLAUDE.md               # Claude Code規約（T0-3新規）
├── AGENTS.md               # Codex規約（T0-3新規）
├── README.md               # プロジェクト説明（T0-3新規）
├── .env.example            # 環境変数テンプレート（T0-3新規）
└── .gitignore              # Git除外設定
```

---

## 10. 環境変数・設定

| 変数 | 現状 | 設定場所 | 備考 |
|---|---|---|---|
| `DATABASE_URL` | 設定済み | `.devcontainer/compose.yml` | dev環境は app サービスで自動設定 |
| `NODE_ENV` | `development` | compose.yml | 既定値あり |
| `MCP_BEARER_TOKEN` | 未設定 | 環境変数 / `.env` | T3-2で導入予定 |
| `COLLECTOR_TOKEN` | 未設定 | 環境変数 / `.env` | T2-2 / GitHub secrets で使用 |
| `PORT` | 未設定（設計書未決） | 環境変数 | 既定3000推奨 |
| `CACHE_FULLTEXT` | 未設定 | 環境変数 | 既定false（本文保存しない） |
| `COLLECTOR_CONTACT` | 未設定 | 環境変数 | User-Agentに含める連絡先 |

**結論**: 本タスク（T0-3）で `.env.example` を作成、README に環境変数表を記載。

---

## 11. セッション開始時の確認項目（本タスク T0-3）

以下を確認・作成:
- [ ] CLAUDE.md / AGENTS.md に§0共通規約を転記（node:test / node:assert 指定）
- [ ] .claude/agents/ に security-reviewer.md / test-writer.md を作成
- [ ] scripts/agent-home-backup.sh / agent-home-restore.sh を chmod +x で実行化
- [ ] .github/workflows/collect.yml を作成（schedule + workflow_dispatch）
- [ ] docs/inventory.md に本レポートを記載
- [ ] README.md を作成（セットアップ・環境変数・使用法）
- [ ] .env.example を作成（プレースホルダ）
- [ ] .gitignore に `backups/` `.env` `.env.local` 確認
- [ ] Claude Code version 確認（`claude --version >= v2.1.139`、`/goal` 前提）

---

## 12. 次フェーズへの引き継ぎ

### T1（データ層）の前提条件
- ✓ PostgreSQL 化完了（pgvector/pgvector:pg17）
- ✓ リポジトリ層インターフェース定義済み
- ✓ Memory実装（fake）完成
- ✓ テスト基盤（node:test + 契約テスト）整備済み
- → T1-1 マイグレーション基盤確認 → T1-2 PostgreSQL実装 へ

### T2（コレクター）の前提条件
- ✓ RSS パーサー依存（`rss-parser` 3.13.0）
- → T2-1 フィード収集・本文破棄 → T2-2 トリガーエンドポイント へ

### T3（MCP）の前提条件
- ✓ MCP SDK依存（`@modelcontextprotocol/sdk` 1.29.0）
- → T3-1 読み取りツール群 → T3-2 Bearer認証 へ

---

## まとめ

| タスク | 項目 | 状態 |
|---|---|---|
| **T0-0** | 現状把握 | ✓ **本レポート作成完了** |
| **T0-1** | PostgreSQL化 | ✓ **完了済み（pgvector/pgvector:pg17）** |
| **T0-2** | エージェント永続化 | **部分完了**（named volumes あり、バックアップスクリプト・commandhistory volume化 は本タスク） |
| **T0-3** | エージェント設定 | **本タスク（進行中）** |
| T1–T3 | 実装フェーズ | 待機中 |

**本レポート作成日**: 2026-07-16 / **対象コミット**: `HEAD` 時点
