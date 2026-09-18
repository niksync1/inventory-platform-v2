import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantRequestId } from './requestId.ts';

test('creates a stable safe tenant request id', () => {
  assert.equal(createTenantRequestId(1_000, 0.5), 'tenant-rs-i');
  assert.match(createTenantRequestId(), /^[A-Za-z0-9_-]+$/);
});
