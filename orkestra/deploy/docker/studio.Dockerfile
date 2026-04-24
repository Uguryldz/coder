FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/studio/package.json apps/studio/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @orkestra/studio...

FROM deps AS build
COPY . .
RUN pnpm --filter @orkestra/db generate
RUN pnpm --filter @orkestra/studio build

FROM node:22-bookworm-slim AS runtime
# node base image already provides UID 1000 (`node` user)
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
WORKDIR /app/apps/studio
CMD ["node", "--enable-source-maps", "node_modules/next/dist/bin/next", "start"]
