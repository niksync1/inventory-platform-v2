import assert from 'node:assert/strict';
import test from 'node:test';
import { validateQuantity } from './quantity.ts';

test('accepts positive whole numbers', () => {
  assert.deepEqual(validateQuantity('10'), { valid: true, quantity: 10 });
  assert.deepEqual(validateQuantity(' 1 '), { valid: true, quantity: 1 });
});

test('rejects malformed and non-positive quantities', () => {
  for (const value of ['', '0', '-1', '1.5', '10abc']) {
    assert.equal(validateQuantity(value).valid, false, value);
  }
});

test('rejects quantities outside the safe integer range', () => {
  assert.equal(validateQuantity('999999999999999999999').valid, false);
});
