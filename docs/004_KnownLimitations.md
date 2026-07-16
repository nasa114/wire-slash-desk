# 既知の限界（公開デプロイ前チェックリスト）

対象読者: 実装エージェント（Claude Code / Codex）および本人。

このドキュメントは、現状のコードベースで意図的に許容している既知の限界を記録する。
Dev Container（squid プロキシ経由・インターネットから隔離）での個人利用を前提に
「今は許容できるが、公開デプロイ（インターネットから到達可能な環境への配置）の
前には対応を検討すべき」項目を集める。各項目は 現状 / リスク / 対応案 / トリガー条件
の形式で記す。

---

## 1. DNS rebinding（TOCTOU: SSRF 検査と実接続のあいだの名前解決不一致）

- **現状**: `assertPublicHttpUrl`（`src/server/ssrf.ts`）は URL のホスト名を DNS で
  解決し、全アドレスが公開 IP であることを確認してから処理を進める。しかし実際の
  HTTP 接続（`fetchFn` 経由の `fetch`）はその後、undici が**独自に再度名前解決**を
  行う。この2回の名前解決の間に DNS レコードが書き換えられれば（DNS rebinding）、
  検査時は公開 IP、接続時はプライベート IP という状況が作れる（Time-of-check to
  time-of-use）。
- **リスク**: 悪意あるフィード/リダイレクト先が、SSRF ガードをすり抜けて内部
  ネットワーク（DB・squid管理画面等）へのアクセスに使われる可能性。
- **対応案**: 検査で確定した IP アドレスへ実際に接続を固定するカスタム
  `dispatcher`（undici の `Agent`/`connect` オプションで解決済み IP を直接使う）を
  実装し、ホスト名の再解決を発生させない。
- **トリガー条件**: アプリをインターネットから到達可能な環境（本番デプロイ）に
  置く場合。Dev Container 内（`internal` ネットワークで DB 等が隔離済み）では
  優先度低。

## 2. `/mcp` エンドポイントに HTTPS 強制なし

- **現状**: 設計書（`docs/002_Spec.md` §7）は「Phase A: 静的Bearerトークン
  …HTTPS必須」としているが、アプリ側コード（`src/server/app.ts` /
  `src/mcp/server.ts`）には HTTPS を強制するロジック・`X-Forwarded-Proto` 等の
  検証は実装されていない。TLS 終端はデプロイ層（リバースプロキシ / PaaS）の
  責務という前提で、アプリはそれを検証しない。
- **リスク**: リバースプロキシの設定漏れ等で平文 HTTP のまま `MCP_BEARER_TOKEN`
  が露出する経路が生まれても、アプリ側では検知できない。
- **対応案**: デプロイ手順書に「TLS終端必須・平文 HTTP でのアプリ直接公開禁止」を
  明記する運用でカバーしつつ、必要であれば `Forwarded` / `X-Forwarded-Proto`
  ヘッダを検証して非 HTTPS リクエストを拒否するミドルウェアを追加する。
- **トリガー条件**: インターネットに公開デプロイする時点で、デプロイ手順書に
  明記（必須）。アプリ側検証の実装は、複数デプロイ環境でリバースプロキシ設定の
  信頼性にばらつきが出る場合に検討。

## 3. SSRF 拒否帯が IANA special-purpose レジストリを完全網羅していない

- **現状**: `PRIVATE_V4_RANGES`（`src/server/ssrf.ts`）は主要な private/loopback/
  link-local/CGNAT 帯のみを拒否している。以下は現状「公開」として扱われ、
  ブロックされない:
  - `192.0.0.0/24`（IETF Protocol Assignments）
  - `198.18.0.0/15`（Benchmarking）
  - マルチキャスト（`224.0.0.0/4`）
  - `240.0.0.0/4`（Reserved）
  - `255.255.255.255/32`（Limited broadcast）
  - その他 IANA IPv4 Special-Purpose Address Registry の小規模な予約帯
- **リスク**: これらの帯域への接続がクラウド環境のメタデータ的な用途や特殊な
  ネットワーク機器に使われている場合、限定的な SSRF 経路になり得る（一般的な
  クラウドメタデータエンドポイント `169.254.169.254` は link-local として
  既にブロック済み）。
- **対応案**: IANA レジストリの全帯域をテーブルに追加する。優先度は低いが、
  公開デプロイ前に一度レビューする。
- **トリガー条件**: インターネットに公開デプロイする前。

## 4. 本文切り詰めが UTF-8 バイト基準でなく文字数（UTF-16コード単位）基準

- **現状**: `fetchArticleContent`（`src/mcp/fetch-content.ts`）の
  `MAX_TEXT_CHARS`（10万）による切り詰めは `text.length`（JS 文字列の UTF-16
  コード単位数）で判定・`slice` している。UTF-8 バイト数ではない。マルチバイト
  文字（絵文字・サロゲートペア等）を含む本文では、切り詰め位置がサロゲート
  ペアの境目に来て不正な文字列になる可能性、および実際のバイト数が想定より
  大きくなる可能性がある。
- **リスク**: 実害は限定的（表示崩れ・わずかなサイズ超過程度）だが、
  MCP クライアント側でのレンダリング崩れの原因になり得る。
- **対応案**: サロゲートペア境界を考慮した切り詰め（`Array.from(text)` で
  コードポイント単位に分割してから `slice`）、または UTF-8 バイト長基準へ
  変更する。
- **トリガー条件**: 絵文字・特殊文字を含むフィードでの実害報告があった場合、
  または公開デプロイ前の品質レビュー時。

## 5. `TRUST_EGRESS_PROXY=true` はプロキシ側 allowlist 運用が前提

- **現状**: `TRUST_EGRESS_PROXY=true` は SSRF ガードの DNS 事前解決チェックを
  スキップし、接続先制御をプロキシ（この Dev Container では squid の
  `allowed-domains.txt`）の許可リストに完全に委譲する（`src/server/ssrf.ts`
  の `assertProxySafeHttpUrl`、IP リテラル直指定のみアプリ側で拒否）。
  起動時検証（`src/config.ts` の `validateEgressProxyTrust`）により
  `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY=1` の設定漏れは検出するが、
  **プロキシの allowlist 自体が正しく運用されているか（プライベート IP 帯への
  プロキシ越しアクセスを許可していないか等）はアプリの管理外**であり、
  検証できない。
- **リスク**: プロキシ側の allowlist 設定ミス（例: 内部ホスト名を誤って許可、
  ワイルドカードが広すぎる）があれば、アプリ側の SSRF 防御は実質的に
  プロキシの設定品質に依存してしまう。
- **対応案**: プロキシ設定（`squid.conf` / `allowed-domains.txt` 等）の
  レビューをデプロイ手順・変更管理に組み込む。可能であればプロキシ側でも
  RFC1918 等の内部アドレスへの CONNECT を明示的に拒否する設定を入れる。
- **トリガー条件**: `TRUST_EGRESS_PROXY=true` を使う環境（この Dev Container を
  含む）でプロキシ設定を変更するたび。インターネット公開デプロイ時は、
  可能であれば直接エグレス + DNS 検査（`TRUST_EGRESS_PROXY=false`）の構成を
  優先検討する。

---

## 関連

- `docs/002_Spec.md` §6（コンプライアンス設計・SSRF対策）、§13（未決事項）
- `src/server/ssrf.ts`, `src/mcp/fetch-content.ts`, `src/config.ts`
- README.md の「関連資料」セクション
