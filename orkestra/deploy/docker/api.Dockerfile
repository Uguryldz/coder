FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @orkestra/api...

FROM deps AS build
COPY . .
RUN pnpm --filter @orkestra/db generate

FROM build AS runtime
# Runtime: tsx ile çalıştırıyoruz — workspace TS paketleri on-the-fly transpile edilir.
USER node
ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
