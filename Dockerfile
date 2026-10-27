# memloom as a hosted server: the HTTP API plus MCP at /mcp, behind tokens and sign-in.
# Fly.io runs it from fly.toml, any Docker host from compose.yaml; see docs/guides/hosting.mdx.

FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
# Only what the server needs at runtime, with workspace packages copied in rather than linked.
RUN pnpm --filter @memloom/mcp deploy --legacy --prod /out

FROM node:22-slim
# ffmpeg cuts and converts uploaded recordings.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
# `memloom token create` and the other CLI commands work from `fly ssh console`.
# HOME is the volume fly.toml mounts, so the store, its snapshots and uploads all live there.
ENV NODE_ENV=production \
  HOME=/data \
  MEMLOOM_SYNC=off \
  PORT=8080 \
  PATH=/app/node_modules/.bin:$PATH
EXPOSE 8080
CMD ["node", "dist/bin.js", "--http"]
