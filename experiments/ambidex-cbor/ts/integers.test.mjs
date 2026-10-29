import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exact, checked } from './integers.mjs';
test('baseline loses precision; lossless mapping preserves it', () => {
  assert.equal(JSON.parse('9007199254740993'), 9007199254740992);
  assert.equal(exact('9007199254740993'), 9007199254740993n);
  assert.equal(exact('18446744073709551615', false), 18446744073709551615n);
  assert.equal(checked('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const s of ['9007199254740992', '9007199254740993']) assert.throws(() => checked(s));
});
test('reject noncanonical and out-of-range values', () => {
  for (const s of ['-0', '+1', '01', '1e0', '1.0', '9223372036854775808']) assert.throws(() => exact(s));
  assert.throws(() => exact('-1', false));
});
