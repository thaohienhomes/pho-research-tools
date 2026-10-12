/**
 * Prove the Vercel bundle works on its own, the way the function will run it.
 *
 * Copies dist/ and assets/ into an empty temporary directory (no node_modules
 * anywhere above it), imports dist/handler.mjs exactly as api/index.mjs does,
 * and drives it over HTTP: health, MCP initialize, tools/list, and a
 * prisma_flow_diagram call, which needs the bundled native PNG renderer and
 * the copied fonts. Makes no network calls. Exits non-zero on any failure.
 *
 * Runs as the second half of `pnpm build`.
 */

import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'pho-mcp-bundle-'));

function fail(msg) {
  console.error(`[check-bundle] FAIL: ${msg}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
cpSync(join(root, 'assets'), join(dir, 'assets'), { recursive: true });
const pngCapable = readdirSync(join(dir, 'dist')).some((f) => f.endsWith('.node'));
const onVercel = process.env.VERCEL === '1';

// Same environment as a deployment, so loadConfig's production guards run.
process.env.VERCEL = '1';
process.env.QUOTA_SALT ||= 'check-bundle-'.padEnd(64, 'x');
process.env.PUBLIC_URL ||= 'https://tools.example';
delete process.env.DATABASE_URL;

const mod = await import(pathToFileURL(join(dir, 'dist', 'handler.mjs')).href);
for (const name of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
  if (typeof mod[name] !== 'function') fail(`dist/handler.mjs does not export ${name}`);
}

const health = await mod.GET(new Request('https://tools.example/health'));
if (health.status !== 200) fail(`/health answered ${health.status}`);

let id = 0;
async function rpc(method, params) {
  const res = await mod.POST(
    new Request('https://tools.example/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'x-forwarded-for': '203.0.113.7',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }),
  );
  const text = await res.text();
  if (res.status !== 200) fail(`${method} answered ${res.status}: ${text.slice(0, 300)}`);
  // The transport may answer as JSON or as a one-event SSE stream.
  const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))?.slice(5);
  const body = JSON.parse(json ?? 'null');
  if (!body || body.error) fail(`${method} returned ${JSON.stringify(body?.error ?? body)}`);
  return body.result;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-bundle', version: '1' } });
const { tools } = await rpc('tools/list', {});
if (tools.length !== 5) fail(`expected 5 tools, got ${tools.map((t) => t.name).join(', ')}`);

if (pngCapable) {
  const r = await rpc('tools/call', {
    name: 'prisma_flow_diagram',
    arguments: {
      counts: {
        databases: 100,
        duplicatesRemoved: 10,
        recordsScreened: 90,
        recordsExcluded: 60,
        reportsSought: 30,
        reportsNotRetrieved: 2,
        reportsAssessed: 28,
        reportsExcludedReasons: [{ name: 'Wrong population', n: 18 }],
        studiesIncluded: 10,
      },
    },
  });
  const image = r.content?.find((c) => c.type === 'image');
  if (r.isError || !image) fail(`prisma_flow_diagram did not return an image: ${JSON.stringify(r).slice(0, 300)}`);
  if (!Buffer.from(image.data, 'base64').subarray(1, 4).equals(Buffer.from('PNG'))) fail('the image is not a PNG');
  console.log('[check-bundle] prisma_flow_diagram rendered a PNG from the bundle alone');
} else if (onVercel) {
  fail('no native PNG binary in dist/');
} else {
  console.warn('[check-bundle] no native binary for this platform in dist/; skipped the PNG check');
}

rmSync(dir, { recursive: true, force: true });
console.log(`[check-bundle] OK: the bundle loads without node_modules and serves ${tools.length} tools`);
process.exit(0);
