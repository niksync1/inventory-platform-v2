import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCustomReportRange, resolveReportRange } from './reportRange.ts';

test('rolling report ranges resolve deterministically', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');
  assert.equal(resolveReportRange('7d', now).from, '2026-09-13T12:00:00.000Z');
  assert.equal(resolveReportRange('30d', now).from, '2026-08-21T12:00:00.000Z');
  assert.equal(resolveReportRange('7d', now).toExclusive, now.toISOString());
});

test('custom ranges include both selected calendar dates', () => {
  const range = resolveCustomReportRange(
    new Date(2026, 8, 1, 14),
    new Date(2026, 8, 20, 9),
    new Date(2026, 8, 20, 12),
  );
  const expectedFrom = new Date(2026, 8, 1);
  const expectedToExclusive = new Date(2026, 8, 21);
  assert.equal(range.from, expectedFrom.toISOString());
  assert.equal(range.toExclusive, expectedToExclusive.toISOString());
});

test('custom ranges reject reversed, future, and longer than 366-day selections', () => {
  const now = new Date(2026, 8, 20, 12);
  assert.throws(
    () => resolveCustomReportRange(new Date(2026, 8, 20), new Date(2026, 8, 19), now),
    /on or after/,
  );
  assert.throws(
    () => resolveCustomReportRange(new Date(2026, 8, 20), new Date(2026, 8, 21), now),
    /future/,
  );
  assert.throws(
    () => resolveCustomReportRange(new Date(2025, 8, 19), new Date(2026, 8, 20), now),
    /366 days/,
  );
});

test('custom ranges allow exactly 366 inclusive calendar days', () => {
  const now = new Date(2026, 8, 20, 12);
  assert.doesNotThrow(() => resolveCustomReportRange(
    new Date(2025, 8, 20),
    new Date(2026, 8, 20),
    now,
  ));
});
