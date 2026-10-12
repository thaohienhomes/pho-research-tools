/**
 * Vercel entry. `scripts/build-vercel.mjs` bundles this file to
 * `dist/handler.mjs`, and `api/index.mjs` re-exports it as the one function
 * every path is rewritten to (see vercel.json).
 *
 * The app is built once per instance and reused across requests, so the
 * Postgres client and the in-process parts of the cache stay warm.
 */

import { createApp } from './app';
import { loadConfig } from './config';

const app = createApp({ config: loadConfig() });
const handler = (request: Request): Response | Promise<Response> => app.fetch(request);

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
