---
name: acl-stack-notes
description: Affiliate Content Lab の TypeScript スタック（Hono + Hono JSX SSR + Drizzle/MySQL/TiDB + pnpm workspace + MCP SDK）で開発・デバッグするときの規約と既知の落とし穴。tsx で JSX が "React is not defined" になる / MCP が zod で起動失敗 / Drizzle 集計が only_full_group_by で落ちる / pnpm の overrides が効かない、などの症状が出たら必ず参照する。
---

# acl-stack-notes — Hono + MySQL + JSX スタックの規約と落とし穴

> 対象リポジトリ: Affiliate Content Lab（`packages/shared|db|core`, `apps/api|mcp`）。
> 2026-06 の Python→TS 移行で確定した知見。新しい外部接面のバージョンを上げたら本ファイルを更新する。

## アーキテクチャ規約

- monorepo は pnpm workspace。依存方向は `apps/* → core → db / shared`、`core → db / shared`。
- ドメインロジックは `packages/core` に集約し、各関数は第1引数で `db: Database` を受け取る（DI）。API/MCP/Worker/テストで共有・差し替え可能にするため。グローバル接続に依存させない。
- 入力検証は `packages/shared` の Zod スキーマを単一真実源にし、API は `safeParse`→400、core 関数も内部で `parse` して既定値を適用する。
- 日時カラムは Drizzle `datetime({ mode: "string" })`、値は UTC の `"YYYY-MM-DD HH:MM:SS"`（`packages/core/src/datetime.ts` の `toMysqlDateTime`/`nowIso`）。`mysql2` は `dateStrings: true`。
- ESM。相対 import は必ず `.js` 拡張子（`.tsx` も import 時は `.js`）。tsconfig は `verbatimModuleSyntax` + `moduleResolution: Bundler`。

## 落とし穴 1: tsx + Hono JSX が "React is not defined"

**症状**: `tsx apps/api/src/server.ts` で SSR ページが `ReferenceError: React is not defined`（古典 JSX 変換になっている）。`tsc -b` は通る。

**原因**: tsx(esbuild) は tsconfig を **cwd ベース**で解決する（エントリファイル基準ではない）。リポジトリルートから実行するとルートの solution-style tsconfig（`files: []` + `references`）が使われ、`jsx: react-jsx` / `jsxImportSource: hono/jsx` が適用されない。ルート tsconfig に jsx を書いても効かない。

**対処（確定）**: 実行時に `TSX_TSCONFIG_PATH=apps/api/tsconfig.json` を渡す。`tsx watch` でも有効。package.json の script に組み込む:

```jsonc
"dev:api":   "TSX_TSCONFIG_PATH=apps/api/tsconfig.json tsx watch apps/api/src/server.ts",
"start:api": "TSX_TSCONFIG_PATH=apps/api/tsconfig.json tsx apps/api/src/server.ts"
```

- 検証: `esbuild.transform(code,{loader:"tsx",jsx:"automatic",jsxImportSource:"hono/jsx"})` は正しく `import { jsx } from "hono/jsx/jsx-runtime"` を出す。問題は tsx→esbuild への tsconfig 受け渡しだけ。
- 代替: アプリディレクトリを cwd にして実行しても直る（`cd apps/api && tsx src/server.ts`）が、CLI の相対パス引数が壊れるのでルート実行＋env が無難。
- JSX 設定は `apps/api/tsconfig.json`（extends 経由で `tsconfig.base.json`）に置く。tsc 型チェックはこれで通る。

## 落とし穴 2: MCP SDK が zod で起動失敗

**症状**: `@modelcontextprotocol/sdk` 起動時に `ERR_PACKAGE_PATH_NOT_EXPORTED: './v3' is not defined by exports in zod`。

**原因**: SDK（1.29 系）は内部の zod-compat が `import 'zod/v3'` する。`zod/v3` サブパスは **zod 3.25 以降 / 4.x** のみ提供。peer は `^3.25 || ^4.0`。zod 3.24 以下を pin すると実行時に落ちる（型チェックは通ってしまう）。

**対処**: zod は `>=3.25` を使う（破壊的変更を避けるなら 3.25.x で十分）。MCP を使うパッケージに `zod` を**正式な dependency として宣言**する（tsconfig paths で `.pnpm` 内部パスを指すハックは実行時に解決できないので不可）。

## 落とし穴 3: Drizzle 集計が only_full_group_by で落ちる

**症状**: `ORDER BY revenue DESC` 等が `Expression #N of ORDER BY ... nonaggregated column ... only_full_group_by` で失敗（MySQL 8 / TiDB の既定）。

**原因**: ORDER BY のエイリアスが SELECT エイリアスでなく生カラムに解決される。

**対処**: GROUP BY クエリの ORDER BY は集約式そのもので並べる:

```ts
.orderBy(
  sql`COALESCE(SUM(${metrics.revenue}), 0) DESC`,
  sql`COALESCE(SUM(${metrics.conversions}), 0) DESC`,
)
```

## 落とし穴 4: pnpm 11 の overrides / onlyBuiltDependencies の場所

- pnpm 11 では `package.json` の `pnpm.overrides` は**無視される**（警告が出る）。`pnpm-workspace.yaml` の `overrides:` に書く。
- `onlyBuiltDependencies`（postinstall を許可するパッケージのホワイトリスト）も `pnpm-workspace.yaml`。tsx/drizzle-kit が使う `esbuild` はここに入れておく（ただし `--ignore-scripts` でも prebuilt バイナリで動くので必須ではない）。
- overrides を変えても node_modules が残ると再解決されないことがある。効かないときは `rm -rf node_modules pnpm-lock.yaml && pnpm install --ignore-scripts`。

## secure-npm-install: 本スタック依存で出る既知の誤検出

`inspect.sh`（L3）は本スタックでも RED を出すが、以下は**説明可能な誤検出**で skill L4.1 の中止条件（*unexplained* RED）には当たらない。判断は「**本番中核依存の dangerous-API RED がゼロか**」を軸にする。

- dangerous-API(RED): `zod` の `atob(`（`z.string().jwt()` の base64 復号）、`vite`/`vitest` の `eval`/`new Function`（バンドラ/テストランナ・dev のみ）。
- prompt-injection / unicode-bidi(RED): `@types/node` / `debug` / `expect-type` / `es-module-lexer` / `fresh` / `iconv-lite` 等の README/CHANGELOG/型定義/エンコード表への偶発一致（`iconv-lite` の sbcs-data は全バイト値を含むため確実に誤検出）。
- 中核（hono / @hono/node-server / drizzle-orm / mysql2 / @modelcontextprotocol/sdk）は dangerous-API RED ゼロを確認済み。
- 進め方: 最初は新しめの安定版で pin する（古い版を pin すると CVE が大量に出る）。dev-only transitive（esbuild/vite）の CVE は `pnpm-workspace.yaml` の overrides で修正版へ寄せる。
- trust-tier 等のセキュリティ設定ファイルへの追記はエージェントの自己改変としてブロックされる。設定は変えず L1.1 メタデータ確認で代替する。

## 動作確認の最短手順

```sh
pnpm typecheck                 # tsc -b（全プロジェクト）
pnpm test                      # vitest（純粋ロジック）
# 実 DB があるなら（devcontainer の MySQL は host=db で到達可能）
DATABASE_URL=mysql://app:app@db:3306/app pnpm db:migrate
DATABASE_URL=mysql://app:app@db:3306/app pnpm db:import-csv
DATABASE_URL=... BASIC_AUTH_USER=admin BASIC_AUTH_PASSWORD=x PORT=8790 pnpm start:api
# MCP は stdin に initialize→tools/list を流して 8 ツール返ることを確認（stdout は JSON-RPC 専用、ログは stderr）
```
