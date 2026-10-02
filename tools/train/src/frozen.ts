import { join, relative, isAbsolute, sep, basename, dirname } from 'node:path';

/**
 * Exit before any work if `out` would overwrite a released model or its golden
 * vectors. Both are frozen, so the tools never write under packages/codec/models/
 * or to packages/codec/test/golden-v<n>.json, not even for a new version:
 * releasing one is a deliberate copy from scratch plus a version entry.
 * ponytail: plain path compare, a symlink or a differently cased Windows path
 * gets past it; CI's frozen-model diff is the backstop. Use realpath if that bites.
 */
export function refuseFrozen(root: string, out: string, scratch: string): void {
  const rel = relative(join(root, 'packages', 'codec', 'models'), out);
  const model = rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  const golden = dirname(out) === join(root, 'packages', 'codec', 'test') && /^golden-v\d+\.json$/.test(basename(out));
  if (!model && !golden) return;
  console.error(`refusing to write ${out}: released models and their golden vectors never change.`);
  console.error(`Write to a scratch path (the default is ${scratch}) and copy a new version in by hand.`);
  process.exit(1);
}
