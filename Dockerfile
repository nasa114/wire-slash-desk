# syntax=docker/dockerfile:1
# デプロイ用イメージ(Node 24 native type stripping で TS を直接実行、ビルド工程なし)。
# 開発は .devcontainer/ を使う — このファイルはデプロイ専用。

FROM node:24-slim AS deps
WORKDIR /app
# packageManager フィールド(pnpm@11.7.0)を corepack が読んで正確なバージョンを使う
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# 本番依存のみ・lockfile 厳守・ライフサイクルスクリプト無効(サプライチェーン対策、.npmrc とも整合)
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src
# 非 root で実行(node ユーザーは base image 同梱)
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
