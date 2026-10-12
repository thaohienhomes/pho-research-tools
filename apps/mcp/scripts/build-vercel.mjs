/**
 * Bundle the server for Vercel.
 *
 * Vercel runs plain JavaScript, while @pho/scholar-core ships TypeScript
 * source, so the whole server is bundled into one ESM file. The function then
 * needs nothing from node_modules: everything it loads at runtime sits next
 * to the bundle and is shipped by vercel.json's includeFiles.
 *
 *   - @resvg/resvg-js is bundled too, but its native binary cannot be. The
 *     loader first looks for `resvgjs.<platform>.node` beside itself, so the
 *     binary for the build machine is copied into dist/. Vercel builds and runs
 *     on the same Linux x64 (glibc), so that is the one the function loads.
 *   - The PRISMA diagram fonts. scholar-core loads them from `../assets/fonts/`
 *     relative to the running file, so they are copied to `assets/fonts/`
 *     next to `dist/`.
 *
 * `scripts/check-bundle.mjs` then loads the result from an empty directory to
 * prove it, and `pnpm build` runs both, so a broken bundle fails the build
 * instead of the first request after a deploy.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(root, '..', '..', 'packages', 'scholar-core');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
rmSync(join(root, 'assets'), { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src', 'vercel.ts')],
  outfile: join(dist, 'handler.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // The per-platform binary packages hold only a .node file; the loader falls
  // back to them when no binary sits beside it. Never bundled.
  external: ['@resvg/resvg-js-*'],
  // CommonJS dependencies call require() and read __dirname; give the ESM bundle both.
  banner: {
    js: [
      "import { createRequire as __pho_cr } from 'node:module';",
      "import { fileURLToPath as __pho_fu } from 'node:url';",
      "import { dirname as __pho_dn } from 'node:path';",
      'const require = __pho_cr(import.meta.url);',
      'const __pho_dirname = __pho_dn(__pho_fu(import.meta.url));',
    ].join(' '),
  },
  define: { __dirname: '__pho_dirname' },
  // resvg's loader tries every platform's binary inside try/catch; only one exists.
  logOverride: { 'require-resolve-not-external': 'silent' },
  logLevel: 'warning',
});

// Copy the native binary the loader will look for beside the bundle.
const binding = `@resvg/resvg-js-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
const requireFromCore = createRequire(join(core, 'package.json'));
const resvgDir = dirname(requireFromCore.resolve('@resvg/resvg-js/package.json'));
let copied = false;
try {
  const pkgPath = createRequire(join(resvgDir, 'package.json')).resolve(`${binding}/package.json`);
  const main = JSON.parse(readFileSync(pkgPath, 'utf8')).main;
  const source = join(dirname(pkgPath), main);
  if (existsSync(source)) {
    copyFileSync(source, join(dist, main));
    console.log(`[build] copied ${binding} (${main}) into dist/`);
    copied = true;
  }
} catch {
  // Not installed for this platform; handled below.
}
if (!copied) {
  const msg = `[build] ${binding} is not installed, so PRISMA PNGs cannot render from this bundle.`;
  if (process.env.VERCEL === '1') throw new Error(msg);
  console.warn(`${msg} Fine for a local build on another platform; Vercel builds on linux-x64.`);
}

mkdirSync(join(root, 'assets'), { recursive: true });
cpSync(join(core, 'assets', 'fonts'), join(root, 'assets', 'fonts'), { recursive: true });
console.log('[build] copied PRISMA fonts to assets/fonts');
