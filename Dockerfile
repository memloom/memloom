# memloom as a hosted server: the HTTP API plus MCP at /mcp, behind tokens and sign-in.
# Built for Fly.io (see fly.toml and docs/guides/hosting.mdx), but nothing in it is Fly-specific.

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
ENV NODE_ENV=production \
  MEMLOOM_HOME=/data \
  MEMLOOM_SYNC=off \
  PORT=8080 \
  PATH=/app/node_modules/.bin:$PATH
EXPOSE 8080
CMD ["node", "dist/bin.js", "--http"]
