import assert from 'node:assert/strict';
import test from 'node:test';
import { offlineQueueKey } from './operation.ts';

test('isolates offline queue storage by user', () => {
  assert.equal(
    offlineQueueKey('user-a', 'tenant-a'),
    'offline:operations:v3:user-a:tenant-a',
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
