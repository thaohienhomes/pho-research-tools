/**
 * Node entry: `pnpm --filter @pho/mcp start` (or the Docker image).
 */

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const app = createApp({ config, socketIp: (c) => getConnInfo(c).remote.address });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const storage = config.databaseUrl ? 'postgres' : 'in-memory';
  console.log(`[mcp] Phở Research Tools listening on http://localhost:${info.port}/mcp (storage: ${storage})`);
});
