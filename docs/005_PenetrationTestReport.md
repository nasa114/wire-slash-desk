# ペネトレーションテスト報告書

- 実施日: 2026-07-19 (UTC)
- 対象: `/workspaces` の現行ソースおよびローカル `127.0.0.1:3000`
- 実施形態: ホワイトボックス、認証情報を使用しない非破壊テスト
- 本番環境: 対象外（本番は別環境）
- 結果: Critical 0件、High 1件、Medium 3件
- 修正状況（2026-07-19 追記）: PT-001〜PT-004 すべて対応済み（TDD、ブランチ `fix/pentest-005-hardening`）。詳細は各項の「状態」および §11 を参照。

## 1. エグゼクティブサマリー

現行ソースへ再起動したローカル環境では、認証回避、秘密ファイルの取得、パストラバーサル、危険なHTTPメソッド、明らかなSQLインジェクションおよびXSSは再現しなかった。

一方、初回セットアップを公開状態で行った場合の管理者奪取をHigh、OAuth Dynamic Client Registration (DCR) の登録枯渇、直接egress構成のDNS rebinding、Squidイメージの可変タグをMediumと評価した。

本報告書は侵入テストの結果であり、脆弱性の修正は含まない。

## 2. スコープと制約

### 対象

- Web UIおよびセッション認証
- MCP Bearer/OAuth認証境界
- Collector共有トークン認証
- CSRF、XSS、SQLインジェクション
- SSRFおよびリダイレクト制御
- 秘密情報・依存パッケージ
- Collectorの本文非保存不変条件
- HTTPセキュリティヘッダー

### 対象外

- 本番環境およびインターネット公開ホスト
- 実トークンを利用した権限付き攻撃
- 負荷試験、DoSの実発生、大量DCR登録
- 外部フィードや第三者サイトへの攻撃通信
- データ破壊を伴う検証

## 3. 実施手順

1. `docs/002_Spec.md` と現行実装を照合した。
2. `.claude/agents/security-reviewer.md` の観点で静的レビューを実施した。
3. `npm test`、`npm run lint`、`pnpm audit --audit-level low` を実行した。
4. 旧プロセスを正常終了し、次の方法で現行ソースを起動した。

   ```sh
   NODE_USE_ENV_PROXY=1 node --env-file=.env src/main.ts
   ```

5. `127.0.0.1:3000` に対し、未認証アクセス、異常なAuthorizationヘッダー、HTTPメソッド、パストラバーサル、セキュリティヘッダーを確認した。

## 4. 検出事項

### PT-001: 初回セットアップ時の管理者奪取

- 重大度: **High**
- CWE候補: CWE-306 (Missing Authentication for Critical Function)、CWE-367 (TOCTOU Race Condition)
- 状態: **対応済み(2026-07-19)**
- 根拠:
  - `src/server/web.ts` の初回 `/setup` 処理
  - `migrations/1784205934231_users-sessions.js` のusersテーブル
  - `docs/004_KnownLimitations.md` §6

ユーザーが0件の間、`/setup` は無認証で利用できる。公開直後に第三者が先にアクセスした場合、その第三者が管理ユーザーを作成できる。また、ユーザー数の確認と作成が単一の原子的DB操作ではないため、並行POSTにより複数ユーザーが作られる可能性がある。

テスト時の環境はセットアップ済みであり、`GET /setup` は `302 /login` となった。このため、稼働中の検証環境で直ちに悪用できる状態ではなかった。

推奨対応:

1. 初回セットアップ専用のワンタイムトークンを必須にする。
2. `INSERT ... WHERE NOT EXISTS`、advisory lock、またはDB制約で初回作成を原子的にする。
3. 修正まで、セットアップ完了前のサービスを公開ネットワークへ接続しない。

### PT-002: OAuth DCR登録枠の永続的枯渇

- 重大度: **Medium**
- CWE候補: CWE-400 (Uncontrolled Resource Consumption)
- 状態: **対応済み(2026-07-19)**（OAuth有効時のみ成立）
- 根拠: `src/server/oauth-provider.ts` の `MAX_CLIENTS` と `registerClient()`

OAuth有効時、無認証の `/register` からクライアントを上限100件まで登録できる。未使用クライアントのTTLや管理削除がないため、攻撃者が登録枠を埋めると、正規クライアントの新規登録を継続的に妨害できる。

テスト環境では `OAUTH_ISSUER_URL` が未設定であり、OAuthエンドポイントは公開されていなかった。DoSを避けるため、大量登録による実証は行っていない。

推奨対応:

1. `/register` にIP単位および全体のレート制限を設ける。
2. 未使用クライアントの有効期限と削除処理を追加する。
3. 管理者による登録クライアントの確認・失効機能を追加する。

### PT-003: 直接egress構成のDNS rebinding TOCTOU

- 重大度: **Medium**
- CWE候補: CWE-918 (Server-Side Request Forgery)
- 状態: **緩和済み(2026-07-19、本番のfail-closed化)**。恒久対策（検証済みIPピン留め）は docs/004 §1 で継続受容
- 根拠:
  - `src/server/ssrf.ts` の `assertPublicHttpUrl()`
  - `src/mcp/fetch-content.ts` のURL検査後のfetch
  - `src/collector/collector.ts` のURL検査後のfetch

直接egress構成では、公開IPかどうかを検査するDNS解決と、実際のfetch接続時のDNS解決が分離している。攻撃者がDNS応答を制御できる場合、検査時には公開IP、接続時には内部IPを返すDNS rebindingの余地がある。

本番composeのSquid構成は、名前解決と接続をプロキシ側に集約し、内部・予約IP帯を拒否するため、このリスクを軽減する。

推奨対応:

1. 本番環境ではegress proxyを必須とし、設定不備時はfail closedにする。
2. 直接egressを残す場合、検証済みIPへ接続を固定しながらTLSのホスト名検証を維持する。
3. egress proxy経由を保証する結合テストを追加する。

### PT-004: Squidイメージの可変タグ

- 重大度: **Medium**
- 分類: Supply Chain / Configuration
- 状態: **対応済み(2026-07-19)**
- 根拠: `compose.yaml` の `ubuntu/squid:latest`

SSRF防御の主要層であるSquidが可変タグで指定されている。再デプロイ時に取得される内容が変わり、動作の再現性低下や未レビュー更新の混入につながる。

推奨対応:

1. 検証済みイメージをdigest (`image@sha256:...`) で固定する。
2. digest更新を明示的なセキュリティレビュー対象にする。
3. 更新後にSquid設定検査とSSRF結合テストを実施する。

## 5. 再起動後の動的テスト結果

現行ソースで再起動後、以下を確認した。

| テスト | 結果 |
|---|---|
| `GET /healthz` | `200` |
| 未ログインで `/`, `/feeds`, `/articles` | `302 /login` |
| セットアップ済み状態の `GET /setup` | `302 /login` |
| 未認証・不正Bearerで `POST /mcp` | `401` |
| Bearerの大文字小文字、欠損、空白異常 | すべて `401` |
| トークンなし・不正値で `POST /internal/collect` | `401` |
| `GET /mcp` | `405` |
| `GET`, `OPTIONS /internal/collect` | `405` |
| `TRACE /` | `403` |
| `/.env`, `/../.env`, `/assets/../web.ts` | `404` |
| OAuth無効時のwell-known endpoint | `404` |
| OAuth無効時の `POST /register` | 利用不可 (`403`) |

主要なレスポンスヘッダー:

- `Content-Security-Policy`: inline script/styleを許可せず、`default-src 'self'`
- `frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`
- `Cache-Control: no-store`（HTML）

## 6. 再現しなかった攻撃

- MCP、Collector、管理UIの認証回避
- セッションCookieによるMCP/Collector認証の混同
- SQLインジェクション（確認範囲のSQLはプレースホルダ使用）
- 反射型・保存型XSS（HTMLエスケープ、URLスキーム制限、CSPあり）
- Originなし・異なるOriginからのフォームPOST（CSRF拒否）
- private/reserved IPおよび異ホストリダイレクトを使った基本的SSRF
- `fulltext_allowed=false` の記事本文取得
- Collectorによる `articles.content` への本文保存
- `.env`、秘密鍵、実トークンのGit追跡
- エラーレスポンスからの内部例外・トークン漏えい

## 7. 自動テストと依存関係

- `npm test`: 259件成功、失敗0件
- `npm run lint`: 成功
- `pnpm audit --audit-level low`: 既知の脆弱性なし
- 直接依存パッケージ: 明白なtyposquatなし
- 秘密情報パターン検査: 実トークン・秘密鍵を検出せず
- `.env` と `backups/`: Git除外を確認

## 8. 修正優先順位

1. **PT-001**: 初回セットアップのトークン化と原子性保証
2. **PT-002**: DCRのレート制限・期限切れ・管理失効
3. **PT-003**: 本番egress proxyの必須化とfail-closed検証
4. **PT-004**: Squidイメージのdigest固定

## 9. 修正後の再テスト条件

- PT-001: 同時に複数の初回セットアップPOSTを送り、管理者が1件だけ作成されること。トークンなしでは作成できないこと。
- PT-002: DCRレート制限がIP・全体の両方で働き、期限切れまたは管理失効後に枠が回復すること。
- PT-003: 悪意あるDNS応答でも内部IPへのTCP接続が発生しないこと。proxy設定欠落時にアプリが起動を拒否すること。
- PT-004: composeがdigest固定され、更新後もSquid設定検査とSSRFテストが成功すること。

## 10. Claude Code向け引き継ぎ

修正を行う際は、必ず `docs/002_Spec.md` とルートの `AGENTS.md` を優先すること。特に次の不変条件を維持する。

1. Collectorは `articles.content` に本文を書き込まない。
2. `fulltext_allowed=false` のソースから本文を取得しない。
3. 認証情報・トークンをコード、ログ、コミットへ含めない。
4. パッケージ追加は `.claude/skills/secure-npm-install` 経由で行う。
5. テストには `node:test` と `node:assert/strict` を使用する。

## 11. 修正記録（2026-07-19、ブランチ `fix/pentest-005-hardening`）

TDD（テスト先行）で対応。`npm test` / `npm run lint` は全緑。

### PT-001（High）→ 対応済み

- **原子性**: `UserRepository.createInitial()` を追加（`src/domain/repositories.ts`）。
  - PostgreSQL（`src/repo/pg/user-repository.ts`）: トランザクション内で
    `pg_advisory_xact_lock` を取得したうえで `insert ... select ... where not exists (select 1 from users)`。
    READ COMMITTED でも並行 first-run で作成されるのは1件のみ。
  - メモリ（`src/repo/memory/user-repository.ts`）: 関数内に await がなく判定と作成が不可分。
  - `/setup` ハンドラ（`src/server/web.ts`）は `count()` ではなく `createInitial()` の戻り値で判定し、
    null なら 403。
- **トークン保護**: 任意の `SETUP_TOKEN`（`src/config.ts`）。設定時は `/setup` フォームに
  トークン入力を要求し、`timingSafeEqualStr` で一致検証。未設定なら従来どおり（公開前運用が前提）。
- テスト: 並行8件POSTで1件のみ作成、トークン必須時の可否（`test/server/web.test.ts`）、
  `createInitial` 契約テスト（`test/contract/user-repository.contract.ts`、pg で並行競合を実検証）。

### PT-002（Medium）→ 対応済み

- `deleteUnusedBefore(cutoff)`（24h TTL の未使用クライアント一括掃除）に加え、敵対的
  レビューで判明した「新鮮な未使用クライアントを低レートで循環させて枠を維持する」
  バイパスを封じるため、`deleteOldestUnused()` による**追い出し**を導入
  （`src/server/oauth-provider.ts`、`src/repo/{memory,pg}/oauth-repositories.ts`）。
  registerClient は満杯時に「最古の未使用（トークン未発行）クライアント」を1件追い出して
  枠を空けるため、正規クライアントの登録は常に成功する。使用中（トークン発行済み）
  クライアントは決して追い出さない。追い出せる未使用が皆無（全て使用中）のときだけ
  `full` で拒否する。SDK 既定のレート制限（20/時/IP）と `MAX_CLIENTS=100` も維持。
- テスト: 新鮮な未使用100件で満杯にされても正規登録は最古未使用の追い出しで成功、
  全件使用中なら拒否、24h TTL 一括掃除、契約テスト（`deleteOldestUnused` は最古の未使用
  1件のみ削除・使用中は残す）。
- **残存（Low、docs/004 §9）**: 回収基準が created_at ベースのため、長期アイドルで
  トークンが全失効した正規クライアントが再登録を要する場合がある。`prune→count→create`
  は非トランザクションで、並行登録時に上限を軽微超過し得る（枠枯渇の本質は変えない）。

### PT-003（Medium）→ 緩和済み

- `validateDirectEgressInProduction()`（`src/config.ts`）: `NODE_ENV=production` かつ
  `TRUST_EGRESS_PROXY!=true` かつ `ALLOW_DIRECT_EGRESS!=true` なら起動を拒否（fail-closed）。
  本番でSSRFガードをDNS rebindingに晒す直接egress構成を、明示的なオプトアウトなしには起動させない。
- 恒久対策（検証済みIPへの接続ピン留め）は大きな変更のため、docs/004 §1 の受容リスクとして継続。
- テスト: 本番×直接egressの拒否、`ALLOW_DIRECT_EGRESS=true` での許可、proxy構成での許可、開発環境での非拒否。

### PT-004（Medium）→ 対応済み

- `compose.yaml` の squid を
  `ubuntu/squid:6.6-24.04_beta@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029`
  に固定（multi-arch、arm64=OCI ARM VM 対応）。tag+digest 併記で、タグ改変時も digest が優先される。
  更新手順（imagetools inspect → squid.conf 検査 → SSRF結合テスト）を compose のコメントに明記。

> 注: Dev Container では docker/compose のビルド検証は不可のため、PT-004 は digest 解決と
> compose 構文・目視の範囲で確認。実デプロイ先での pull・SSRF結合テストは要実機確認。
