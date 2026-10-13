import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCustomReportRange, resolveRelativeReportRange, resolveReportRange } from './reportRange.ts';

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

test('relative ranges resolve days, weeks, and months from now', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');
  assert.equal(resolveRelativeReportRange(7, 'days', now).from, resolveReportRange('7d', now).from);
  assert.equal(resolveRelativeReportRange(7, 'days', now).toExclusive, now.toISOString());
  assert.equal(resolveRelativeReportRange(2, 'weeks', now).from, new Date('2026-09-06T12:00:00.000Z').toISOString());
  assert.equal(resolveRelativeReportRange(1, 'months', now).from, new Date('2026-08-20T12:00:00.000Z').toISOString());
});

test('month ranges clamp to the target month end', () => {
  assert.equal(
    resolveRelativeReportRange(1, 'months', new Date(2026, 2, 31, 12)).from,
    new Date(2026, 1, 28, 12).toISOString(),
  );
  assert.equal(
    resolveRelativeReportRange(1, 'months', new Date(2024, 2, 31, 12)).from,
    new Date(2024, 1, 29, 12).toISOString(),
  );
});

test('relative ranges reject invalid amounts and enforce caps', () => {
  const now = new Date(2026, 8, 20, 12);
  assert.throws(() => resolveRelativeReportRange(0, 'days', now), /whole number/);
  assert.throws(() => resolveRelativeReportRange(1.5, 'days', now), /whole number/);
  assert.throws(() => resolveRelativeReportRange(367, 'days', now), /at most 366 days/);
  assert.throws(() => resolveRelativeReportRange(53, 'weeks', now), /at most 52 weeks/);
  assert.throws(() => resolveRelativeReportRange(13, 'months', now), /at most 12 months/);
  assert.doesNotThrow(() => resolveRelativeReportRange(366, 'days', now));
  assert.doesNotThrow(() => resolveRelativeReportRange(12, 'months', now));
});
