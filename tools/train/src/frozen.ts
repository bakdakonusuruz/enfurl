import { join, relative, isAbsolute, sep, basename, dirname } from 'node:path';

/**
 * Exit before any work if `out` would overwrite a released model or its golden
 * vectors. Both are frozen, so the tools never write under packages/codec/models/
 * or to packages/codec/test/golden-v<n>.json, not even for a new version:
 * releasing one is a deliberate copy from scratch plus a version entry.
 * Case is handled on Windows: path.relative ignores it there and the name match
 * uses /i. Trailing dots and spaces are stripped from every name first, because
 * Windows drops them, so `golden-v1.json.` is golden-v1.json.
 * ponytail: plain path compare, a symlink, a junction or a case-insensitive macOS
 * volume gets past it; CI's frozen-model diff is the backstop. Use realpath if that bites.
 */
export function refuseFrozen(root: string, out: string, scratch: string): void {
  const p = out.replace(/[. ]+(?=[\\/]|$)/g, '');
  const rel = relative(join(root, 'packages', 'codec', 'models'), p);
  const model = rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  const golden =
    relative(join(root, 'packages', 'codec', 'test'), dirname(p)) === '' && /^golden-v\d+\.json$/i.test(basename(p));
  if (!model && !golden) return;
  console.error(`refusing to write ${out}: released models and their golden vectors never change.`);
  console.error(`Write to a scratch path (the default is ${scratch}) and copy a new version in by hand.`);
  process.exit(1);
}
