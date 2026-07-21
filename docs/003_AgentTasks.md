# 実装指示書: Claude Code / Codex 向けタスク定義

前提資料: `01_project-brief.md`（目的・スコープ）、`02_design-doc.md`（設計。以下「設計書」）。
本書は docs/ に置き、リポジトリ規約は下記をもとに `CLAUDE.md`（Claude Code用）と `AGENTS.md`（Codex用）へ転記する。

## 0. 共通規約（CLAUDE.md / AGENTS.md に転記する内容）

```markdown
# プロジェクト規約
- 設計の一次情報は docs/02_design-doc.md。矛盾があれば実装せず質問すること
- 絶対条件（違反PRは不可）:
  1. collector が articles.content に本文を書き込まない（設計書 §5 の不変条件テストを壊さない）
  2. fulltext_allowed=false のソースから本文を取得するコードを書かない
  3. 認証情報・トークンをコード/ログ/コミットに含めない
- 進め方: TDD。リポジトリ層はインターフェース→fake→テスト→PostgreSQL実装の順
- 1ブランチ = 1タスク（本書のT番号）。コミットは Conventional Commits
- Definition of Done: 受け入れ条件を満たす / `npm test` `npm run lint` 緑 / 変更概要と確認手順を報告
- 不明点は推測で進めず、選択肢と推奨を添えて質問する
```

## 1. Claude Code 向け設定

### 1.1 `/goal` による自走運用

本プロジェクトはClaude Code内蔵の `/goal` コマンド（v2.1.139以降）を前提とする。完了条件を宣言すると、各ターン終了後に小型の評価モデル（既定: Haiku）が条件成立を判定し、未達なら自動で次ターンを継続、成立で自動クリアされる。

**運用ルール**
- 実装タスクは原則 `/goal` で自走させる。1ゴール = 1タスク（T番号）
- 評価モデルは**会話に出た情報しか見ない**（コマンド実行・ファイル読取はしない）。したがって完了条件は「受け入れ条件 + その証拠をClaude自身に出力させる指示」のセットで書く
- 逸脱検知のため「各ターン末に `git status --short` を1行で報告」を条件に含める
- 状態確認は引数なし `/goal`、中断は `/goal clear`。`--resume` で条件は復元される（ターン数・トークンのカウンタはリセット）

**条件テンプレート**
```
/goal docs/03_agent-tasks.md の <T番号> の受け入れ条件をすべて満たすまで。
証拠として npm test / npm run lint の全緑ログを会話に貼ること。
各ターン末に git status --short を1行で報告すること。
```

**注意**
- hooksを無効化する設定（`disableAllHooks`、managed設定の `allowManagedHooksOnly`）下では動作しない。この開発環境のmanaged設定に該当キーを入れないこと
- 評価はHaikuによる自動判定であり、人間レビューの代替ではない。§0の絶対条件はテストとレビューで担保する（goal条件だけに依存しない）
- T0-1のようにコンテナ再構築（人間側の操作）を要するタスクは自走完結できない。「ファイル変更完了 + 人間向け確認手順の提示」までを完了条件とする
- Codex側にも `/goal` は存在するがexperimental（config.tomlで有効化）かつ自己判定型で挙動が異なるため、本書ではClaude Code側の運用を標準とし、Codexへは §2 のテンプレートで明示的にタスクを渡す

### 1.2 サブエージェント（`.claude/agents/`）

最低限、以下の2つを用意する（T0-3）。

```markdown
---
name: security-reviewer
description: 差分のセキュリティレビュー。PR作成前に必ず使用。認証・SQL・SSRF・秘密情報の観点。
tools: Read, Grep, Glob
---
差分に対して以下を重大度つきで指摘する:
- SQLはプレースホルダを使っているか
- トークン比較はタイミングセーフか
- 本文取得のURL検証（SSRF: プライベートIP帯拒否・リダイレクト制限）は設計書 §6 通りか
- 秘密情報のログ出力・ハードコード・コミット混入がないか
- 「本文を保存しない」不変条件に抵触する変更がないか
```

```markdown
---
name: test-writer
description: 実装前にテストを先に書く（TDD）。受け入れ条件をテストコードへ翻訳する。
tools: Read, Grep, Glob, Write
---
タスクの受け入れ条件を vitest のテストに翻訳する。実装コードは書かない。
リポジトリ層のテストは fake 実装に対して書き、PostgreSQL結合テストは別ファイルに分離する。
```

## 2. Codex（GPT-5系）への指示テンプレート

GPT-5系は指示の曖昧さに弱いため、タスクを渡すときは必ず次の形式に落とす:

```
## タスク: <T番号> <名前>
参照: docs/02_design-doc.md §<該当節>
対象パス: <触ってよいディレクトリ/ファイルを列挙>
やること: <箇条書きで具体的に>
やらないこと: <スコープ外・禁止事項を明示。特に本文保存の禁止>
完了条件: <受け入れ条件をコピー>
検証コマンド: npm test / npm run lint / <タスク固有>
```

## 3. タスク一覧

### フェーズ0: 基盤

**T0-0 現状把握（最初に必ず実施）**
- やること: リポジトリを走査し、①MySQL依存箇所（接続・SQL方言・依存パッケージ・devcontainer/compose記述）②既存の永続化設定の有無 ③テスト基盤の有無、を一覧レポートにまとめ `docs/inventory.md` に出力
- 受け入れ条件: 一覧に「ファイルパス・内容・T番号との対応」が含まれ、人間がレビューできる

**T0-1 Dev Container の PostgreSQL 化**
- 参照: 設計書 §9.1
- やること: docker-compose化（app + db=pgvector/pgvector:pg17）、`DATABASE_URL` 導入、MySQL関連記述と依存の削除、README更新
- 受け入れ条件: コンテナ再構築後 `psql $DATABASE_URL -c 'select 1'` 成功、`create extension vector` 成功
- 注意: 既存devcontainerの他設定（拡張・feature）を壊さない。T0-0のレポートに基づき差分最小で

**T0-2 エージェント環境の永続化 + バックアップ**
- 参照: 設計書 §9.2–9.3
- やること: `~/.claude` `~/.codex` `/commandhistory` のnamed volume化、`CLAUDE_CONFIG_DIR` 設定、chown対応、`scripts/agent-home-backup.sh` / `agent-home-restore.sh` 作成、`backups/` をgitignore
- 受け入れ条件: rebuild後にClaude Codeが再ログイン不要（確認手順をREADMEに記載）、backupスクリプトがtar生成+直近7世代管理、restoreで復元できる
- 注意: バックアップに認証情報が含まれる旨をスクリプト冒頭コメントとREADMEに明記。ユーザー名はイメージ実物に合わせる。`CODEX_HOME` の現行仕様を確認してから配線する

**T0-3 エージェント設定ファイル整備**
- やること: `CLAUDE.md` / `AGENTS.md`（§0転記）、`.claude/agents/` に §1.2 の2エージェント。あわせて `claude --version` が v2.1.139 以上であることを確認（`/goal` の前提）
- 受け入れ条件: Claude Codeがサブエージェントを認識する（`/agents` で確認）

### フェーズ1: データ層

**T1-1 マイグレーション基盤 + 初期スキーマ**
- 参照: 設計書 §4（feeds / articles のみ。M5テーブルは作らない）
- やること: node-pg-migrate導入、up/down実装、`npm run migrate` 整備
- 受け入れ条件: up→down→up が冪等に通る。CIでmigrate実行

**T1-2 リポジトリ層（TDD）**
- 参照: 設計書 §3, §11
- やること: `FeedRepository` / `ArticleRepository` インターフェース定義 → インメモリfake → ユニットテスト → PostgreSQL実装 → 結合テスト
- 受け入れ条件: fakeとPG実装が同一のテストスイート（契約テスト）を通過。UPSERT重複スキップのテストあり

### フェーズ2: 収集

**T2-1 Collector**
- 参照: 設計書 §5
- やること: rss-parser導入、条件付きGET、due判定、マッピング層で本文フィールドを明示破棄、guid欠落時のsha256(url)代替、同時実行制限、UA設定
- 受け入れ条件: **本文入りRSSフィクスチャを食わせても `articles.content` がNULLのままであることのテスト**、304時の挙動テスト、重複スキップテスト
- やらないこと: 本文取得機能（T3-1のツールとして別途）

**T2-2 収集トリガーエンドポイント**
- 参照: 設計書 §7–8
- やること: `POST /internal/collect`（`X-Collector-Token` 検証・タイミングセーフ比較・冪等）、GitHub Actions scheduleのサンプルworkflow追加
- 受け入れ条件: 正/誤トークンのテスト、二重発火しても二重収集しないテスト

### フェーズ3: MCP

**T3-1 MCPサーバー（読み取りツール群）**
- 参照: 設計書 §7、§6
- やること: `@modelcontextprotocol/sdk` でStreamable HTTPサーバーを `/mcp` に実装。ツール: list_feeds / list_recent_articles / search_articles / get_daily_titles / fetch_article_content
- 受け入れ条件: 各ツールの契約テスト。`fetch_article_content` は fulltext_allowed=false で拒否・SSRF検証（プライベートIP拒否）のテストあり・既定で本文を永続化しない
- やらないこと: 書き込み系ツール（save_digestはU6確定後）

**T3-2 認証 Phase A（Bearer）**
- やること: `/mcp` に静的Bearer検証（環境変数、タイミングセーフ）。実クライアント（Claude / ChatGPT）からの接続手順をREADMEに記載
- 受け入れ条件: 認証なし/誤トークンが401、正トークンで疎通

### フェーズ4以降（未決事項の確定後に着手）

- T4-1 管理UI最小版（U3確定後）: feeds CRUD、フラグ・tos_note編集
- T4-2 OAuth 2.1（U5確定後）: MCP authorization仕様準拠 → **実装済み(2026-07-18)**: アプリ内蔵認可サーバー（設計書 §7 Phase B / §13 U5 参照）
- T4-3 為替レートウィジェット（設計書 §14）: `exchange_rates` テーブル + `ExchangeRateRepository`（memory/pg + 契約テスト）、Yahoo Finance chart API クライアント（fetchFn 注入・SSRF ガード再利用）、lazy TTL 20分キャッシュ、ダッシュボード stats への表示
  - 受け入れ条件: ①TTL 内はフェッチせずキャッシュを返す ②TTL 超過時のみ1回取得して upsert ③取得失敗時は stale 表示（キャッシュ無しならウィジェット非表示）で他機能に影響しない ④pair は `[A-Z]{6}` 検証 ⑤`EXCHANGE_RATE_PAIRS=off` で完全無効 ⑥契約テスト・web テスト・lint 全緑
- T5-1 pgvector（U2確定後）: embeddings生成バッチ + search_articlesのベクトル対応
- T5-2 2トラックスコアリング（設計書 §12。詳細設計を先に行う）

## 4. キックオフプロンプト例（Claude Codeへの最初の指示）

```
docs/01_project-brief.md、docs/02_design-doc.md、docs/03_agent-tasks.md を読んでください。
その後 T0-0（現状把握）を実施し、docs/inventory.md を作成して報告してください。
実装はまだ始めないでください。inventory のレビュー後に T0-1 から順に、1ブランチ1タスクで進めます。
絶対条件: 本文を保存しない / fulltext_allowed を尊重する / 秘密情報を残さない。
```

実装フェーズに入ったら、タスクごとに `/goal` で自走させる例:

```
/goal docs/03_agent-tasks.md の T2-1 の受け入れ条件をすべて満たすまで。
証拠として、本文入りRSSフィクスチャでも articles.content がNULLのままであることを
検証するテストを含む npm test の全緑ログを会話に貼ること。
各ターン末に git status --short を1行で報告すること。
```