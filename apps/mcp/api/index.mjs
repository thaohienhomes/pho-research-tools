// The single Vercel function. Source lives in src/vercel.ts; this file only
// re-exports the bundle that `pnpm build` writes to dist/.
export { GET, POST, DELETE, OPTIONS } from '../dist/handler.mjs';
