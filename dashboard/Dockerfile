# Two images from one build (see deploy/compose.yaml):
#   --target server  Node playback server; prepared data is mounted at runtime, not baked in
#   --target web     Caddy with the built frontend; Caddyfile is mounted at runtime
FROM node:24-slim AS base
RUN npm install -g pnpm@11.1.1
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
# Empty = same origin: the page reaches the server through Caddy on the same host.
RUN VITE_SERVER_URL= pnpm --filter @grandtour/web build

FROM base AS server
RUN pnpm install --frozen-lockfile --filter @grandtour/server...
COPY packages/protocol packages/protocol
COPY apps/server apps/server
WORKDIR /app/apps/server
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

FROM caddy:2.10-alpine AS web
COPY --from=build /app/apps/web/dist /srv
