import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReportRange } from './reportRange.ts';

test('rolling report ranges resolve deterministically', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');
  assert.equal(resolveReportRange('7d', now).from, '2026-09-13T12:00:00.000Z');
  assert.equal(resolveReportRange('30d', now).from, '2026-08-21T12:00:00.000Z');
  assert.equal(resolveReportRange('7d', now).toExclusive, now.toISOString());
});
