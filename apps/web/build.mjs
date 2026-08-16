// Bundles src/app.ts (with the model JSON inlined) into public/app.js.
// `--serve` starts esbuild's dev server on http://localhost:8787 serving public/.
import * as esbuild from 'esbuild';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const opts = {
  entryPoints: [join(here, 'src/app.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  outfile: join(here, 'public/app.js'),
  logLevel: 'info',
};
if (process.argv.includes('--serve')) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  const { hosts, port } = await ctx.serve({ servedir: join(here, 'public'), port: 8787, fallback: join(here, 'public/index.html') });
  console.log(`serving http://localhost:${port} (fallback to index.html for /code paths)`);
} else {
  await esbuild.build(opts);
  // Static hosts (GitHub Pages) serve 404.html for unknown paths: same app, redirect mode.
  copyFileSync(join(here, 'public/index.html'), join(here, 'public/404.html'));
}
