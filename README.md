# パーソナルRSSリーダー + AIキュレーション

## 概要

海外の技術・セキュリティ・リリース情報を定期収集し、生成AIでキュレーションするプロジェクト。

**特徴**
- **タイトル・URL・公開日時のみ保存** — 著作権リスク・利用規約を最優先
- **本文はオンデマンド+許可制** — `fulltext_allowed` フラグが立つソースのみ
- **MCPサーバー経由でAIに公開** — Claude / ChatGPT 等のクライアント側でキュレーション実行
- **個人利用向け** — 商用・再配信なし

詳細は以下を参照:
- `docs/001_Brief.md` — 企画書・スコープ
- `docs/002_Spec.md` — 設計書・データモデル・セキュリティ
- `docs/003_AgentTasks.md` — 実装タスク定義

---

## 絶対条件（必ず守ること）

1. **Collector が `articles.content` に本文を書き込まない**  
   RSSに本文が含まれていても、保存時にフィールドを明示的に破棄する。テストで確認必須。

2. **`fulltext_allowed=false` のソースから本文を取得しない**  
   取得時に DB の `feeds.fulltext_allowed` フラグを必ず検査。違反は実装NG。

3. **認証情報・トークンをコード/ログ/コミットに含めない**  
   `.env` `.env.local` は `.gitignore` に。バックアップには認証情報が含まれるため、リポジトリ外持ち出し時は暗号化。

---

## セットアップ

### 1. Dev Container の起動

```bash
# VS Code で Reopen in Container（または devcontainer CLI）
devcontainer open .
```

コンテナ内で PostgreSQL (pgvector:pg17)、Squid プロキシが同時起動します。  
`db` サービスのヘルスチェック完了後（初回～30秒）、app コンテナで作業開始できます。

### 2. 依存パッケージのインストール

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

- `--frozen-lockfile`: ロックファイル厳密モード（再現性確保）
- `--ignore-scripts`: postinstall スクリプト無効化（セキュリティ）

### 3. マイグレーション実行

```bash
npm run migrate
```

PostgreSQL に `feeds`, `articles` テーブルを作成します。  
既に実行済みなら冪等なため再実行しても安全です。

### 4. 確認

```bash
# クイックテスト
npm test

# 型チェック
npm run lint
```

---

## 環境変数

Dev Container 内では `.devcontainer/compose.yml` で自動設定されます。  
本番デプロイ時は下記を設定してください。

| 変数 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `DATABASE_URL` | ○ | — | PostgreSQL 接続文字列 (`postgresql://user:pass@host:5432/dbname`) |
| `PORT` | | `3000` | アプリサーバーのポート |
| `NODE_ENV` | | `development` | 実行環境（`development` / `production`） |
| `MCP_BEARER_TOKEN` | ○ | — | MCP エンドポイント認証トークン（生成例: `openssl rand -hex 32`） |
| `COLLECTOR_TOKEN` | ○ | — | フィード収集トリガー認証（`POST /internal/collect` 用）。生成例: `openssl rand -hex 32` |
| `CACHE_FULLTEXT` | | `false` | `true` で本文取得後もDB保存。既定は保存しない |
| `COLLECTOR_CONTACT` | | — | RSS UA に含める連絡先（例: `admin@example.com` または GitHub Issue URL） |
| `TRUST_EGRESS_PROXY` | | `false` | egress プロキシ経由でローカル DNS が使えない環境(この Dev Container の squid 構成など)でのみ `true`。SSRF ガードの DNS 事前解決をスキップし、接続先制御をプロキシの許可リストに委譲する。**直接エグレス環境では必ず false** |
| `SESSION_COOKIE_SECURE` | | `NODE_ENV=production` なら `true` | Web UI のセッション Cookie に `Secure` 属性を付けるか(`true` / `false`)。HTTPS 終端がない検証環境で本番モード起動する場合のみ `false` を明示 |
| `TEST_DATABASE_URL` | | 導出 | 統合テスト用 DB。未設定なら `DATABASE_URL` の DB 名に `_test` を付けた DB を自動作成して使用（開発データを壊さないため） |

### 環境変数設定例

```bash
# .env ファイル（リポジトリ外に保存、.gitignore に記載）
DATABASE_URL=postgresql://app:app@db:5432/app
PORT=3000
MCP_BEARER_TOKEN=<長い32文字以上のランダムトークン>
COLLECTOR_TOKEN=<別の32文字以上のランダムトークン>
CACHE_FULLTEXT=false
COLLECTOR_CONTACT=your-email@example.com
```

トークン生成コマンド:
```bash
openssl rand -hex 32  # 64文字の16進数文字列
```

### Dev Container での起動と動作検証

この Dev Container は外向き通信が squid プロキシ経由(許可ドメインのみ)で、外部 DNS 解決ができません。実フィードを取得する場合は次のように起動します:

```bash
# .env に TRUST_EGRESS_PROXY=true を設定した上で
NODE_USE_ENV_PROXY=1 node --env-file=.env src/main.ts
```

- `NODE_USE_ENV_PROXY=1`: Node の fetch(undici)は既定で `HTTP(S)_PROXY` 環境変数を無視するため、これで squid 経由にする(Node 起動時に評価されるので `.env` ではなくシェルから渡す)
- 検証用フィードの投入: `node scripts/dev-seed-feeds.mjs`(GitHub Releases の Atom 2 本。既存データは削除されるので注意)

### ブラウザ UI(Web UI / 管理 UI)

`/` 直下でダッシュボード・記事閲覧・フィード管理(T4-1)ができる。技術構成は Hono + HTMX(U3 確定済み)。

1. マイグレーションを適用してサーバーを起動(`npm run migrate` → `npm start` 相当)
2. ブラウザで `http://localhost:3000/` を開く(Dev Container なら VS Code のポート転送経由)
3. 初回は `/setup` に誘導されるので管理ユーザー(ユーザー名 + パスワード8文字以上)を作成
4. 以後は `/login` のログイン画面から入る(セッション Cookie: HttpOnly / SameSite=Lax / 30日)

- `/` … ダッシュボード(直近24時間・トレンド枠・フィード状態)
- `/articles` … 記事一覧(タイトル検索・日付絞り込み・フィード絞り込み)
- `/feeds` … フィード管理(追加・編集・有効/無効・削除。`fulltext_allowed` と `tos_note` の編集含む)
- 旧 `/ui` 系パスは新パスへ 301 リダイレクトされる
- パスワードは scrypt ハッシュで `users` テーブルに保存。セッショントークンは sha256 ハッシュのみ DB 保存
- 認証系統は MCP(`MCP_BEARER_TOKEN`)・収集(`COLLECTOR_TOKEN`)と完全に分離されており、セッション Cookie で API は呼べない
- CSRF は Origin 検証(hono/csrf)+ SameSite=Lax の二重防御。フォームは POST → 303 の PRG、HTMX(`hx-boost`)は漸進的強化として動く

### デプロイ(Docker / compose.yaml)

デプロイ用の `Dockerfile` と `compose.yaml` がリポジトリ直下にある(開発用の `.devcontainer/compose.yml` とは独立)。イメージは Node 24 の native type stripping で TS を直接実行するためビルド工程はなく、本番依存のみを `--frozen-lockfile --ignore-scripts` で入れて非 root 実行する。

```bash
# 1. .env を用意(POSTGRES_PASSWORD / MCP_BEARER_TOKEN / COLLECTOR_TOKEN が必須)
cp .env.example .env && vi .env

# 2. 起動(db → migrate(1回実行) → app の順に立ち上がる)
docker compose up -d --build

# 3. 収集の定期トリガーも compose 内で完結させる場合(15分間隔、任意)
docker compose --profile cron up -d
```

- `app` のポートは既定で `127.0.0.1:3000` のみに束縛。**TLS 終端(リバースプロキシ)配下での公開が前提**(`docs/004_KnownLimitations.md` §2)。LAN へ直接開くなら `.env` で `APP_BIND=0.0.0.0` を明示
- `NODE_ENV=production` のためセッション Cookie は既定で `Secure`。HTTP のまま検証する場合のみ `SESSION_COOKIE_SECURE=false` を明示
- **初回はセットアップ完了前に公開網へ晒さないこと**(`/setup` が開いている間は誰でも管理ユーザーを作れる — `docs/004_KnownLimitations.md` §6)
- 収集トリガーを GitHub Actions schedule 等の外部に置く場合は `--profile cron` は不要(設計書 §8 D7)

---

## コマンド

```bash
# テスト実行
npm test

# 型チェック
npm run lint

# DB マイグレーション（up）
npm run migrate

# DB マイグレーション（down）
npm run migrate:down

# アプリケーション起動
npm start
```

---

## フィード収集トリガー

### 方法1: GitHub Actions（推奨・無料）

#### 前提条件
- GitHub リポジトリにシークレット・変数が設定されていること
- デプロイ先のアプリが HTTPS でアクセス可能

#### 設定手順

1. **GitHub Settings → Secrets and variables → Actions** で以下を追加:
   - `COLLECTOR_TOKEN`: シークレット値（`openssl rand -hex 32`）

2. **Settings → Variables** で以下を追加:
   - `APP_URL`: デプロイ先のアプリケーション URL（例: `https://rss-reader.example.com`）

3. ワークフロー有効化:
   - `.github/workflows/collect.yml` が自動で30分ごと実行
   - 手動実行は Actions タブから `Feed Collection` → `Run workflow`

#### 動作確認

```bash
# ローカルでテスト（curl を実行）
curl -X POST \
  -H "X-Collector-Token: <COLLECTOR_TOKEN>" \
  https://rss-reader.example.com/internal/collect
```

応答: `{ "status": "ok" }` (冪等・due判定はサーバー側)

### 方法2: 外部 Timer（Lambda / Azure Functions / VPS cron など）

アプリは HTTP 呼び出しで agnostic です。上記 curl コマンドを定期実行してください。

---

## MCP 接続

### Claude Code（CLI）での接続

```bash
claude mcp add --transport http rss \
  https://<デプロイ先>/mcp \
  --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

接続後、Claude Code 内で以下が使用可能:
- `list_feeds` — フィード一覧取得
- `list_recent_articles` — 最新記事取得
- `search_articles` — 記事検索
- `get_daily_titles` — 日付別タイトル一覧
- `fetch_article_content` — 本文取得（`fulltext_allowed=true` 時のみ）

> `save_digest`（ダイジェスト保存）は未実装です。保存先（DB かクライアント側か）を決める未決事項 U6（`docs/002_Spec.md` §13）が確定次第、将来機能として追加予定です。

### Claude.ai / ChatGPT（カスタムコネクタ）での接続

1. Claude.ai / ChatGPT の「Custom connections」から新規追加
2. **URL**: `https://<デプロイ先>/mcp`
3. **Authorization**: `Bearer <MCP_BEARER_TOKEN>`（ヘッダに設定）

詳細は各プラットフォームのドキュメント参照。

---

## エージェント環境の永続化

### 仕組み

Dev Container 起動時に以下の named volumes を自動マウント（`.devcontainer/compose.yml` の `app` サービス）:
- `cc-userdata` → `/home/node/.claude` — Claude Code 認証・設定
- `codex-userdata` → `/home/node/.codex` — Codex 認証・設定
- `commandhistory` → `/commandhistory` — コマンド履歴

あわせて `CLAUDE_CONFIG_DIR=/home/node/.claude` を設定し、Claude Code の設定ファイル一式を named volume 側に集約しています。

コンテナ再構築後も認証情報・コマンド履歴が保持され、再ログイン不要です。

> **注意**: これらは Dev Container の設定変更のため、**コンテナ再構築後（`devcontainer rebuild .`）に有効**になります。既存コンテナを起動したままでは反映されません。

### 確認方法

```bash
# コンテナを再構築
devcontainer rebuild .

# 再度開く
devcontainer open .

# Claude Code を起動
claude

# 既にログイン状態であることを確認
# (新規ログインプロンプトが表示されなければ成功)
```

### トラブルシューティング

**症状**: `~/.claude` が見つからない / 権限エラー

```bash
# 所有権を確認・修正
ls -la ~/.claude
sudo chown -R node:node ~/.claude ~/.codex /commandhistory
```

---

## バックアップ・リストア

### バックアップ作成

```bash
./scripts/agent-home-backup.sh
```

実行結果:
- `backups/agent-home-YYYYMMDD-HHMMSS-utc.tar.gz` 作成
- 新しい順に7世代（件数ベース）のみ保持（それより古いものは自動削除）

### リストア

```bash
# リストア前に確認
./scripts/agent-home-restore.sh backups/agent-home-20260716-120000-utc.tar.gz

# 確認を省略（-f フラグ）
./scripts/agent-home-restore.sh -f backups/agent-home-20260716-120000-utc.tar.gz
```

### 警告

**バックアップには Claude Code / Codex の認証トークンが含まれます。**
- リポジトリに保存しない（`.gitignore` に `backups/` を追加）
- リポジトリ外へ持ち出す場合は暗号化すること
- 他者と共有しないこと

```bash
# 例: GPG で暗号化
gpg --symmetric backups/agent-home-*.tar.gz

# リストア時に復号
gpg --decrypt agent-home-*.tar.gz.gpg | tar xzf - -C ~/
```

---

## ディレクトリ構成

```
src/
  domain/              # ドメイン層（インターフェース・型定義）
    repositories.ts    # FeedRepository / ArticleRepository インターフェース
    types.ts           # Feed / Article エンティティ型
    errors.ts          # ドメイン固有エラー
  repo/                # リポジトリ実装（DB アクセス）
    memory/            # メモリ実装（ユニットテスト用）
    pg/                # PostgreSQL 実装（本番用）
  collector/           # フィード収集ロジック
  mcp/                 # MCP サーバー実装
  server.ts            # メインサーバー（Express / Hono）

test/
  contract/            # 契約テスト（fake + PG 両実装が共有）
  integration/         # 統合テスト（DB 対象）
  fixtures/            # テストデータ

migrations/            # DBマイグレーション（node-pg-migrate）

docs/
  001_Brief.md         # 企画書
  002_Spec.md          # 設計書（最重要。矛盾があれば相談）
  003_AgentTasks.md    # 実装タスク定義
  004_KnownLimitations.md # 既知の限界（公開デプロイ前に確認）
  inventory.md         # T0-0 現状把握レポート

.devcontainer/         # Dev Container 設定
  compose.yml          # PostgreSQL + app + Squid
  devcontainer.json
  squid/               # HTTP プロキシ設定
```

---

## テスト

```bash
# すべてのテストを実行
npm test

# 特定ファイルのみ
node --test test/contract/feed-repository.contract.ts

# 監視モード（watchdog あれば）
npm test -- --watch
```

### テストフレームワーク

- **ランナー**: Node.js 24 ネイティブ `node:test`
- **アサーション**: `node:assert/strict`
- **ファイル形式**: TypeScript (`.ts`) — native type stripping で直実行

### TDD 戦略

1. **リポジトリ層**: インターフェース定義 → Memory fake 実装 → ユニットテスト → PostgreSQL 実装
2. **契約テスト** (`test/contract/`): 両実装が同一テストスイートを通す
3. **Collector**: 本文入り RSS フィクスチャでも `articles.content` がNULLのままであることを検証
4. **MCP**: ツール入出力スキーマ + 認証テスト

---

## 開発フロー（Claude Code）

このプロジェクトは Claude Code の `/goal` コマンド（v2.1.139以降）を前提とします。

```bash
# 現在のゴール状態を確認
/goal

# タスク T2-1 の受け入れ条件で自走
/goal docs/003_AgentTasks.md の T2-1 の受け入れ条件をすべて満たすまで。
証拠として、本文入りRSSフィクスチャでも articles.content がNULLのままであることを検証するテストを含む npm test の全緑ログを会話に貼ること。
各ターン末に git status --short を1行で報告すること。

# ゴールをクリア
/goal clear
```

詳細は `CLAUDE.md` / `AGENTS.md` / `docs/003_AgentTasks.md` を参照。

---

## トラブルシューティング

### `npm test` がタイムアウト

PostgreSQL が起動していない可能性があります。

```bash
# コンテナ再構築
devcontainer rebuild .

# 再度トライ
npm test
```

### `DATABASE_URL` が設定されていない

Dev Container 内では `.devcontainer/compose.yml` で自動設定されます。  
手動設定が必要な場合:

```bash
export DATABASE_URL=postgresql://app:app@localhost:5432/app
npm test
```

### MCP 接続時に 401 Unauthorized

`MCP_BEARER_TOKEN` が設定されているか、クライアントのヘッダが正しいか確認:

```bash
# サーバー側で確認
echo $MCP_BEARER_TOKEN

# クライアント側（Claude Code）
claude mcp ls  # 接続状態確認
```

---

## 設計・未決事項

以下は設計段階で残された判断項目です（`docs/002_Spec.md` §13）。

- **U1**: データ主権方針 — 公開RSS情報を海外APIに渡すか。ホスティング地域。
- **U2**: pgvector 採否 — 類似検索・トピッククラスタリングを実装するか。
- **U3**: ~~管理UI — 最小SSR / Hono+HTMX / Next.js 等の技術選定~~ → **確定(2026-07-16): Hono + HTMX、認証は users テーブル + セッション Cookie**。
- **U4**: TypeScript 化範囲・ORM導入 — 段階移行か全面採用か。
- **U5**: OAuth 2.1 認可サーバー — 自前 vs. 外部IdP。
- **U6**: ダイジェスト保存先 — DB か クライアント側か。

質問があれば、推測で進めず選択肢を提示して相談してください。

---

## コミット・PR 規約

- **形式**: Conventional Commits （`feat:` `fix:` `test:` `docs:` など）
- **1ブランチ = 1タスク** — `docs/003_AgentTasks.md` の T番号に対応
- **セキュリティレビュー**: PR 作成前に `/security-reviewer` を実行
- **テスト**: `npm test` `npm run lint` が全緑であることを確認
- **秘密情報**: トークン・パスワードをコミットに含めない

---

## 関連資料

- **企画書**: `docs/001_Brief.md`
- **設計書**: `docs/002_Spec.md`（最重要）
- **タスク定義**: `docs/003_AgentTasks.md`
- **現状把握**: `docs/inventory.md`
- **既知の限界**: `docs/004_KnownLimitations.md`（公開デプロイ前に確認）
- **規約**: `CLAUDE.md` （Claude Code用）/ `AGENTS.md` （Codex用）

---

## ライセンス

（未定）

---

## お問い合わせ

このプロジェクトは個人用です。  
質問がある場合は GitHub Issues で相談してください。
