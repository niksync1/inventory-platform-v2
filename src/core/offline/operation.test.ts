import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueuedOperation, isRetryableNetworkError, offlineQueueKey } from './operation.ts';

test('isolates offline queue storage by user', () => {
  assert.equal(
    offlineQueueKey('user-a', 'tenant-a'),
    'offline:operations:v4:user-a:tenant-a',
  );
  assert.notEqual(
    offlineQueueKey('user-a', 'tenant-a'),
    offlineQueueKey('user-b', 'tenant-a'),
  );
});

test('does not permit an anonymous offline queue', () => {
  assert.throws(() => offlineQueueKey('  ', 'tenant-a'));
});

test('isolates offline queue storage by tenant', () => {
  assert.notEqual(
    offlineQueueKey('user-a', 'tenant-a'),
    offlineQueueKey('user-a', 'tenant-b'),
  );
  assert.throws(() => offlineQueueKey('user-a', '  '));
});

test('creates a pending operation without changing its idempotency key', () => {
  const operation = createQueuedOperation({ id: 'operation-1', userId: 'user-a', tenantId: 'tenant-a', locationId: 'location-a', productId: 'product-a', kind: 'stock_out_sale', payload: { quantity: 2, remarks: null } }, new Date('2026-09-22T12:00:00.000Z'));
  assert.equal(operation.id, 'operation-1');
  assert.equal(operation.status, 'pending');
  assert.equal(operation.attempts, 0);
});

test('distinguishes connectivity failures from validation failures', () => {
  assert.equal(isRetryableNetworkError(new Error('Network request failed')), true);
  assert.equal(isRetryableNetworkError({ message: 'TypeError: Failed to fetch' }), true);
  assert.equal(isRetryableNetworkError(new Error('Insufficient stock in selected batch')), false);
});
