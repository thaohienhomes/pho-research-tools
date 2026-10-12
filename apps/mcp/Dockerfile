# Phở Research Tools MCP server, for any container host.
# Build from the REPOSITORY ROOT (Dockerfile.dockerignore trims the context):
#   docker build -f apps/mcp/Dockerfile -t pho-mcp .
#   docker run -p 8787:8787 -e QUOTA_SALT="$(openssl rand -hex 32)" pho-mcp
# NODE_ENV=production below means the server refuses to start without QUOTA_SALT.
FROM node:22-slim
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Only what @pho/mcp needs: its own package, scholar-core and their workspace deps.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY tsconfig.json ./
COPY packages/citation-engine packages/citation-engine
COPY packages/scholar-core packages/scholar-core
COPY apps/mcp apps/mcp
RUN pnpm install --frozen-lockfile --filter @pho/mcp...

ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
WORKDIR /repo/apps/mcp
CMD ["node_modules/.bin/tsx", "src/main.ts"]
