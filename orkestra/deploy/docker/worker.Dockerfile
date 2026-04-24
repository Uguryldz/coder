FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
# Worker needs docker client to spawn sandbox siblings.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @orkestra/worker...

FROM deps AS build
COPY . .
RUN pnpm --filter @orkestra/db generate

FROM build AS runtime
USER node
ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
