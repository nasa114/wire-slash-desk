# プレイブック: Web フロー(リダイレクト・フォーム・認証/OAuth・Cookie)

`/root-cause-debug` の具体層。リダイレクトチェーン・フォーム送信・ログイン/OAuth・
Cookie が絡む症状で SKILL.md と併読する。

## チェーンの書き方(手順 2 の具体化)

例: OAuth 認可コードフロー。

```
client → GET /authorize → [302 /login?next=…] → GET /login → POST /login
      → [302 next] → GET /authorize(再) → 同意画面 → POST /authorize
      → [302 redirect_uri?code=…] → client のコールバック → POST /token
```

実測の取り方:

```bash
curl -si 'http://localhost:3000/oauth/authorize?...' | grep -i '^location\|^HTTP'
```

値の変換で見るもの: URL は絶対か相対か、encodeURIComponent の回数、hidden input で
何が再送されるか(空文字と未指定の区別)、`c.req.url` がプロキシ配下で何を返すか。

## 容疑者表(手順 4 の具体化)

| 機構 | 殺し方の例 |
|---|---|
| CSP `form-action` | **Chromium はフォーム POST 後の 302 のリダイレクト先にも強制適用**。外部への OAuth コールバックがブラウザ側で死ぬ(サーバログには 302 成功と残る) |
| オープンリダイレクト対策(`safeNext` 等) | 絶対 URL や `//` 始まりを `/` に落とし、`next` に積んだ情報を無言で捨てる |
| CSRF ミドルウェア | クロスオリジン form POST(OAuth /token 等)を 403 にする |
| Cookie `SameSite` / `Secure` | クロスサイト遷移後の初回リクエストで Cookie が付かず未ログイン扱い |
| CORS | ブラウザからの fetch だけ失敗(curl では成功する) |
| プロキシ / `x-forwarded-*` | `c.req.url` のホスト・スキームが外部 URL と食い違い、issuer やリダイレクト先がずれる |
| レートリミッタ | 再試行を重ねたテスト中だけ 429 になる |
| Service Worker / ブラウザキャッシュ | 古いレスポンス・古いリダイレクトを再生し続ける |

## 観測の死角(Web 特有)

「サーバは正しい 302 を返しているのに、その先が起きない」→ 死んでいるのはブラウザ内。
CSP 違反・mixed content・Cookie 拒否・SW の interception は**サーバログに一切出ない**。
devtools の console と Network タブを観測点に含める。ユーザーに要求するときは
「押した直後にブラウザはどこへ飛び、console に何が出ているか」まで具体的に指定する。

## 事例集

### 2026-07: Claude Desktop → リモート MCP (OAuth 2.1) に接続できない

真因は 2 つ(このスキルの出自となった事例):

1. 未ログイン時 `GET /oauth/authorize` → `/login?next=<絶対URL>` の 302。受け手の
   `safeNext()` は `/` 始まりしか許可せず `next` を `/` に落とす → ログイン後に OAuth
   パラメータ消失、同意画面に戻れない。**発見: 手順 3「受け手まで開く」**
2. CSP `form-action 'self'` が同意フォーム POST 後の 302(claude.ai への callback)を
   Chromium でブロック。サーバログは 302 成功、エラーはブラウザ console のみ。
   **発見: 手順 4「容疑者表」**

整合性チェックの好例: 「以前 claude.ai からは繋がった」のは**ブラウザでログイン済み
だったから**(経路 1 を踏まなかった)。真因が「なぜ今まで動いたか」まで説明できた。

なお同じ症状に対し、先行セッション(33 分・未解決)は「resource='' の 400」「iss 欠如」
という*発火しうる別のバグ*を真因と断定して修正を積んだ。どちらも症状の観測
(「POST /oauth/authorize は 302 を返している」)と矛盾していた — 反証チェックを
していれば即棄却できた。
