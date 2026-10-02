import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '../src/model.ts';
import { START_NESTED } from '../src/text-coder.ts';
import { toyModel } from './helpers.ts';

test('emit walks into a B64TEXT blob, so the trainer counts what the encoder writes', () => {
  const m = new Model(toyModel());
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const rest = `/register?token=${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'abc', iat: 1755204800 })}.sig`;
  const contexts: string[] = [];
  m.text.emit(rest, '\x80', { symbol: (ctx2) => contexts.push(ctx2), run: () => {} });
  assert.ok(m.text.explain(rest, '\x80').some((u) => u.run === 'B64TEXT'), 'the toy model should pick B64TEXT here');
  assert.ok(contexts.some((c) => c[0] === START_NESTED), 'no symbol reported in a nested context');
  assert.ok(contexts.some((c) => c.includes('"')), 'the JSON inside the token was not walked');
});
