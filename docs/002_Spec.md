# 設計書: パーソナルRSSリーダー + AIキュレーション

対象読者: 実装エージェント（Claude Code / Codex）および本人。実装タスクの分割は `03_agent-tasks.md` を参照。

## 1. 決定事項と前提

| # | 決定 | 理由 |
|---|---|---|
| D1 | ランタイムは Node.js | 既存プロジェクト・本人のスタック |
| D2 | DBは **PostgreSQL**（MySQLから移行） | pgvector拡張の将来利用、過去の検討でもPostgreSQL+pgvectorを選定済み |
| D3 | 収集時に保存するのは **タイトル・URL・公開日時のみ**。本文はRSSに含まれていても保存しない | フィード利用規約・著作権リスクの回避。ただしスキーマ上は本文カラムを用意（将来の許可済みソース向け） |
| D4 | 本文のオンデマンド取得は `fulltext_allowed` フラグが立つソースのみ | 規約はソースごとに異なるため手動判断とする |
| D5 | AI連携はMCPサーバー経由。認証は Bearer → OAuth 2.1 | クライアント（Claude / ChatGPT等）が今後変わっても差し替え可能 |
| D6 | DBアクセスはリポジトリパターンで抽象化し、TDDで実装 | エンジン差し替え・テスト容易性 |
| D7 | 収集トリガーは外部（サーバーレス/CI cron）からのHTTP発火を基本とし、node-cron内蔵も可能にする | ホスティング先を選ばない・コスト最小 |

## 2. 全体構成

```
[外部cron]                      [MCPクライアント]
GitHub Actions schedule /        Claude / ChatGPT /
Lambda / Azure Functions timer   その他エージェント
        │ POST /internal/collect         │ Streamable HTTP
        │ (共有シークレット)              │ (Bearer / OAuth 2.1)
        ▼                                ▼
┌─────────────────────────────────────────────┐
│ Node.js アプリ（単一プロセス）                  │
│  ├ Collector      … フィード取得・パース・保存  │
│  ├ MCP Server     … 読み取りツール群を公開      │
│  ├ Admin UI (M4)  … フィード設定CRUD           │
│  └ Repository層   … DB抽象化（PG実装 / fake）   │
└──────────────┬──────────────────────────────┘
               ▼
        PostgreSQL (+ pgvector, M5)
```

- 単一アプリに同居させ、デプロイ単位を1つに保つ（コンパクト方針）。
- MCPサーバーはアプリ内のHTTPエンドポイント（Streamable HTTP transport、`@modelcontextprotocol/sdk`）。ステートレス動作を基本とし、スリープからの復帰に耐える構成にする。

## 3. 技術スタック（推奨・変更可）

- 言語: TypeScript（既存コードがJSなら段階移行でも可 → 未決 U4）
- DB接続: `pg` + マイグレーションは `node-pg-migrate`（ORM導入は未決 U4）
- RSSパース: `rss-parser`
- MCP: `@modelcontextprotocol/sdk`
- テスト: `vitest`（ユニット=リポジトリfake、結合=Dev Container内PostgreSQL）

## 4. データモデル

```sql
create table feeds (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  feed_url               text not null unique,
  site_url               text,
  fetch_interval_minutes int  not null default 60 check (fetch_interval_minutes >= 15),
  translate              boolean not null default true,   -- 日本語化の対象か
  fulltext_allowed       boolean not null default false,  -- 本文オンデマンド取得の許可（手動設定）
  enabled                boolean not null default true,
  tos_note               text,                            -- 規約確認メモ（いつ何を確認したか）
  etag                   text,
  last_modified          text,
  last_fetched_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table articles (
  id           uuid primary key default gen_random_uuid(),
  feed_id      uuid not null references feeds(id) on delete cascade,
  guid         text not null,          -- RSSのguid。無ければ sha256(url) で代替
  title        text not null,
  url          text not null,
  published_at timestamptz,
  lang         text,                   -- 任意: フィード宣言言語
  content      text,                   -- 方針: 収集時は常にNULL。許可ソースの明示操作でのみ格納可
  fetched_at   timestamptz not null default now(),
  unique (feed_id, guid)
);

-- M5（任意）: pgvector
-- create extension if not exists vector;
create table article_embeddings (
  article_id uuid primary key references articles(id) on delete cascade,
  model      text not null,
  embedding  vector(1536) not null,    -- 次元はモデル決定後にマイグレーションで確定
  created_at timestamptz not null default now()
);

-- M5（任意）: 2トラックスコアリングの枠（過去検討の引き継ぎ。詳細設計は別途）
create table article_scores (
  article_id uuid not null references articles(id) on delete cascade,
  track      text not null check (track in ('vulnerability','general')),
  score      numeric not null,
  model      text,
  created_at timestamptz not null default now(),
  primary key (article_id, track)
);

-- AIが生成したデイリーダイジェストの保存（任意）
create table digests (
  id          uuid primary key default gen_random_uuid(),
  digest_date date not null,
  model       text not null,
  content_md  text not null,
  created_at  timestamptz not null default now()
);
```

## 5. Collector 設計

1. `enabled = true` かつ `last_fetched_at + fetch_interval_minutes <= now()` のフィードを抽出
2. 条件付きGET（`If-None-Match` / `If-Modified-Since`）。304なら `last_fetched_at` のみ更新
3. パース後、**タイトル / URL / 公開日時 / guid のみ**をマッピング。`content:encoded`・`description` 等はマッピング層で明示的に破棄
4. `(feed_id, guid)` でUPSERT（重複スキップ）
5. 礼儀: タイムアウト10秒、同時実行数制限（例: 4）、UAは連絡先つき（例: `personal-rss-reader/0.1 (+運用者連絡先)`）、失敗はフィード単位で握りつぶさず記録

**不変条件（テストで固定する）**: RSSアイテムに本文が含まれていても、collectorが `articles.content` に非NULLを書き込むことはない。

## 6. コンプライアンス設計

- 本文取得は `fetch_article_content` ツール経由のオンデマンドのみ。実行時に `feeds.fulltext_allowed` を検査し、falseなら拒否
- 取得した本文はモデルに返すのみで**既定では永続化しない**（`CACHE_FULLTEXT=false`）。ペイウォール回避・認証突破は実装しない
- robots.txt / 利用規約の確認は手動運用とし、確認結果と日付を `feeds.tos_note` に残す
- レートリミット: 同一ホストへの本文取得は最小間隔を設ける（例: 10秒/ホスト）
- SSRF対策: 取得先はDB登録済み記事のURLに限定し、リダイレクトは同一ホスト系のみ・回数制限、プライベートIP帯への解決を拒否

## 7. MCPサーバー設計

Transport: Streamable HTTP（`/mcp`）。ツールは読み取り中心から始める。

| ツール | 入力 | 出力 | 備考 |
|---|---|---|---|
| `list_feeds` | – | フィード一覧（フラグ含む） | |
| `list_recent_articles` | since, feed_id?, limit | タイトル/URL/公開日時 | 既定 limit=50, 上限200 |
| `search_articles` | query, limit | 同上 | 初期は title ILIKE。M5でベクトル検索に拡張 |
| `get_daily_titles` | date | その日のタイトル一覧 | トレンド抽出はモデル側で実施 |
| `fetch_article_content` | article_id | 本文テキスト | `fulltext_allowed` 必須。§6の制約下 |
| `save_digest` | date, model, content_md | digest id | 書き込み系はこれのみ（任意） |

**認証**
- Phase A: 静的Bearerトークン（環境変数、タイミングセーフ比較、HTTPS必須）
- Phase B: MCP仕様のOAuth 2.1（PKCE、Protected Resource Metadata）。ChatGPT側コネクタ要件も踏まえPhase Bを本対応とする
  - **実装済み(2026-07-18, T4-2)**: アプリ内蔵の認可サーバー（U5確定）。`/authorize` `/token` `/register`（DCR）`/revoke` と `/.well-known/oauth-authorization-server` `/.well-known/oauth-protected-resource/mcp` を `OAUTH_ISSUER_URL` 設定時のみ公開。同意は Web UI ログインユーザーが `/oauth/consent` で明示承認。トークンは不透明ランダム値で DB には sha256 ハッシュのみ保存、リフレッシュはローテーション。Phase A の静的 Bearer は OAuth 非対応クライアント（Codex CLI 等）向けに共存させる
- `/internal/collect` は別系統の共有シークレット（`X-Collector-Token`）で保護し、MCP認証とは分離

## 8. 収集トリガー

- 基本: 外部から `POST /internal/collect` を叩く。冪等（due判定はサーバー側）なので多重発火しても安全
- トリガー源の選択肢: ①GitHub Actions schedule（無料・遅延あり得る）②Lambda / Azure Functions timer ③VPS運用なら node-cron 内蔵
- どれを使うかはデプロイ先で決める。アプリ側は関知しない（D7）

## 9. Dev Container 設計

### 9.1 PostgreSQL化

docker-compose構成に変更し、DBサービスは pgvector 同梱イメージを使う。

```yaml
# .devcontainer/docker-compose.yml（要旨）
services:
  app:
    build: .
    volumes: [ "..:/workspaces/rss-reader:cached" ]
    environment:
      DATABASE_URL: postgres://app:app@db:5432/rss
    command: sleep infinity
  db:
    image: pgvector/pgvector:pg17
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: rss }
    volumes: [ "pgdata:/var/lib/postgresql/data" ]
volumes:
  pgdata:
```

MySQL関連（イメージ・クライアント・環境変数・依存パッケージ）は削除する。

### 9.2 エージェント環境の永続化

Claude Code公式リファレンス構成に倣い、named volumeで永続化する（rebuild後も再ログイン不要になる）。

```jsonc
// .devcontainer/devcontainer.json（追記の要旨）
{
  "features": { "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {} },
  "mounts": [
    "source=claude-code-config-${devcontainerId},target=/home/node/.claude,type=volume",
    "source=claude-code-bashhistory-${devcontainerId},target=/commandhistory,type=volume",
    "source=codex-home-${devcontainerId},target=/home/node/.codex,type=volume"
  ],
  "containerEnv": { "CLAUDE_CONFIG_DIR": "/home/node/.claude" },
  "postCreateCommand": "sudo chown -R node:node /home/node/.claude /home/node/.codex /commandhistory || true"
}
```

注意:
- ユーザー名（`node` / `vscode` 等）はベースイメージに合わせて読み替える
- volumeマウント直後は所有者がrootになりインストールが失敗することがあるため、`chown` を必ず入れる
- `CLAUDE_CONFIG_DIR` を volume 側に向けることで `~/.claude.json` 相当の設定も volume 内に収まる（公式リポジトリと同じ方式）
- Codexのホームは既定 `~/.codex`（`CODEX_HOME` で変更可）。実装時に現行バージョンの仕様を確認すること

### 9.3 バックアップ

- `scripts/agent-home-backup.sh`: `~/.claude` `~/.codex` を `backups/agent-home-<timestamp>.tar.gz` に固め、直近N世代のみ保持
- `scripts/agent-home-restore.sh <tar.gz>`: 展開して復元
- **backupsには認証トークンが含まれる**。`backups/` を `.gitignore` に追加し、リポジトリ外へ持ち出す場合は暗号化する

## 10. デプロイ・コスト

| 案 | 目安 | 留意点 |
|---|---|---|
| 国内VPS（さくら等） | 月数百円〜 | 国内リージョン。運用は自前。node-cron内蔵でトリガー完結可 |
| Fly.io | 低負荷なら月数百円規模 | 東京リージョン(nrt)あり。自動停止/起動でMCP初回応答が遅れる場合あり |
| Render | 無料枠あり | 無料Webサービスはスリープ→MCP応答遅延。**東京リージョンなし（要確認）** |
| Supabase | 無料枠あり | 東京リージョン選択可。DBのみ利用しアプリは別ホストという分割も可。無料枠は放置で一時停止あり |

判断基準: データ主権方針（§13 U1）を先に決める。国内限定なら国内VPSが素直。

## 11. テスト戦略

- リポジトリ層: インターフェース + インメモリfakeでユニットテスト（TDDの主戦場）
- PostgreSQL実装: Dev Container内DBに対する結合テスト（マイグレーション適用込み）
- Collector: フィードのフィクスチャ（本文入りRSSを含む）でパース〜保存を検証。**本文非保存の不変条件テスト必須**
- MCPツール: 入出力スキーマの契約テスト。認証（正/誤トークン、タイミングセーフ）
- CI: lint + unit + migration up/down

## 12. 引き継ぎ事項（過去の検討との接続）

- **さくらのAI Engine**: 国内データ主権の観点で要約系に採用した経緯がある。本設計では「対話的キュレーション = MCP経由のフロンティアモデル」「定型の要約・翻訳・埋め込み生成 = 国内API（さくらのAI Engine等）」という住み分けが可能。どちらに寄せるかは U1 で判断
- **2トラックスコアリング**（脆弱性系 / 一般）: スキーマ枠のみ確保（§4 `article_scores`）。スコアリングロジック・実行主体（バッチかMCPクライアントか）は未設計

## 13. 未決事項

| # | 内容 | 影響 |
|---|---|---|
| U1 | データ主権方針の適用範囲: 公開RSSのタイトル/URLを海外API（Claude/ChatGPT）へ渡すことを許容するか。ホスティングは国内限定か | MCP設計・デプロイ先・AI住み分け（§12） |
| U2 | ベクトル検索の採否・埋め込みモデルと次元 | M5、`article_embeddings` の確定 |
| U3 | ~~管理UIの技術選定~~ → **確定(2026-07-16)**: Hono + HTMX。認証は users テーブル(scrypt) + セッションCookie、UIは `/` 直下(T4-1 実装済み) | M4 |
| U4 | TypeScript化の範囲、ORM導入の有無 | T1以降の書き方 |
| U5 | ~~OAuth 2.1の認可サーバーを自前実装するか外部IdPを使うか~~ → **確定(2026-07-18)**: アプリ内蔵の認可サーバー(MCP SDK 公式ハンドラ + `RssOAuthProvider`)。`OAUTH_ISSUER_URL` 設定時のみ有効。静的 Bearer は Codex 等 OAuth 非対応クライアント向けに恒久共存(T4-2 実装済み) | M4 |
| U6 | 翻訳結果・ダイジェストの保存方針（`digests` を使うか、クライアント側に置くか） | スキーマ運用 |

## 14. 為替レートウィジェット（T4-3、2026-07-21 追加）

ダッシュボードに為替レート（既定 USD/JPY・EUR/JPY）を表示する。データ源は Yahoo Finance chart API（`https://query1.finance.yahoo.com/v8/finance/chart/<PAIR>=X`、無認証・非公式）。

### 14.1 キャッシュ方針（lazy TTL）

- アクセスごとの取得はオーバースペックのため、**DB キャッシュ + TTL 20分**とする
- アプリ内に cron は無い（§8 の通り収集は外部トリガー）ため、**定期取得ではなく遅延取得**: ダッシュボード表示時に `exchange_rates` の `fetched_at` を確認し、TTL 超過時のみ Yahoo から取得して upsert。アクセス頻度（1〜3時間に一度）では定期実行より取得回数が少なく、外部 cron 設定にも依存しない
- 取得失敗時: キャッシュがあれば **stale 表示**（取得時刻を明示）、無ければウィジェット自体を出さない。失敗直後の連続アクセスで Yahoo を叩き続けないよう、プロセス内で失敗後 60 秒は再試行しない（クールダウン）
- 表示リクエストの応答時間を守るため取得タイムアウトは短め（3.5 秒）

### 14.2 データモデル

```sql
create table exchange_rates (
  pair        text primary key,          -- 'USDJPY' 形式（[A-Z]{6}）
  rate        double precision not null, -- 現在値（regularMarketPrice）
  prev_close  double precision,          -- 前日終値（chartPreviousClose）。前日比表示用
  market_time timestamptz,               -- 市場データの時刻（regularMarketTime）
  fetched_at  timestamptz not null       -- キャッシュ鮮度判定の基準
);
```

リポジトリは既存パターン（§3）: `ExchangeRateRepository`（`get` / `upsert`）を memory / pg 両実装 + 契約テスト。

### 14.3 取得経路のセキュリティ

- 宛先は固定ホスト `query1.finance.yahoo.com` のみ。pair は `[A-Z]{6}` に検証してから URL を組み立てる（URL 注入防止）
- 既存の egress 方針（§6）に従う: `trustEgressProxy` で `assertProxySafeHttpUrl` / `assertPublicHttpUrl` を分岐、`redirect: 'manual'`（リダイレクトは追わない）、応答バイト上限、`AbortSignal.timeout`
- レスポンスは防御的にパースし、`chart.result[0].meta.regularMarketPrice` が正の有限数であることのみを信頼する

### 14.4 設定

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `EXCHANGE_RATE_PAIRS` | `USDJPY,EURJPY` | カンマ区切りの通貨ペア。`off` で機能無効 |
| `EXCHANGE_RATE_TTL_MINUTES` | `20` | キャッシュ TTL（1〜1440） |

### 14.5 制約・受容リスク

- Yahoo Finance chart API は非公式・無保証。仕様変更で取得不能になっても閲覧機能に影響しない（ウィジェットが消えるだけ）よう分離する
- 個人利用・20分に1回程度のアクセスであり利用規約上の負荷問題は実質無い。再配布はしない（自分専用 UI 表示のみ）
- TTL 失効直後の同時アクセスではペア数×同時リクエスト数の並行取得が起き得るが、GET / は認証必須かつ個人利用のため in-flight 重複排除は実装しない（受容リスク）
- 開発コンテナの squid 許可リストに `query1.finance.yahoo.com` を追加済み（2026-07-22）。テストはフィクスチャで行い、ライブ疎通は開発・本番の両方で確認可能