# syntax=docker/dockerfile:1
# デプロイ用イメージ(Node 24 native type stripping で TS を直接実行、ビルド工程なし)。
# 開発は .devcontainer/ を使う — このファイルはデプロイ専用。
#
# Node.js の更新はこの ARG 1箇所を変更する(base を介して全ステージが共有)。
# 更新時は package.json の engines と .devcontainer/compose.yml の image も合わせること。
# 新バージョンの試験ビルドはファイルを変更せずに行える:
#   docker compose build --build-arg NODE_IMAGE=node:26-slim
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS deps
# packageManager フィールド(pnpm@11.7.0)を corepack が読んで正確なバージョンを使う
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# 本番依存のみ・lockfile 厳守・ライフサイクルスクリプト無効(サプライチェーン対策、.npmrc とも整合)
# cache mount により lockfile が変わっても既ダウンロード分の再取得を避ける
# (pnpm store: 取得済みパッケージの content-addressable store / corepack: pnpm 本体のキャッシュ)。
# キャッシュはイメージには含まれず、ビルドホストの BuildKit に残って次回ビルドで再利用される。
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=corepack,target=/root/.cache/node/corepack \
    pnpm install --store-dir=/pnpm/store --frozen-lockfile --ignore-scripts --prod

# バージョン情報の生成: .git からコミットハッシュを読み(loadBuildInfo の .git
# フォールバックを流用)、build-info.json だけを最終イメージへ渡す。
# .git 本体は最終イメージに含めない。build args なしの素の
# `docker compose build` でもコミットハッシュが自動で焼き込まれる。
FROM base AS gitinfo
WORKDIR /repo
COPY . .
RUN node --input-type=module -e "import { writeFileSync } from 'node:fs'; const { loadBuildInfo } = await import('/repo/src/server/build-info.ts'); const { commit } = loadBuildInfo({}, '/repo'); writeFileSync('/repo/build-info.json', JSON.stringify({ commit, builtAt: new Date().toISOString() }));"

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src
# gitinfo ステージが生成した build-info.json を渡す(.git 本体は含めない)。
# 認証済み UI のフッターと GET /internal/version(X-Collector-Token 必須)で確認できる。
COPY --from=gitinfo /repo/build-info.json ./build-info.json
# 任意のオーバーライド(.git の無いコンテキストでのビルド用)。env は
# build-info.json より優先される(src/server/build-info.ts の解決順参照)。
# ARG は値が変わるとこの行以降のキャッシュだけを無効化するので最後に置く。
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ENV GIT_COMMIT=${GIT_COMMIT} BUILD_TIME=${BUILD_TIME}
# 非 root で実行(node ユーザーは base image 同梱)
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
