import assert from 'node:assert/strict';
import test from 'node:test';
import { offlineQueueKey } from './operation.ts';

test('isolates offline queue storage by user', () => {
  assert.equal(offlineQueueKey('user-a'), 'offline:operations:v2:user-a');
  assert.notEqual(offlineQueueKey('user-a'), offlineQueueKey('user-b'));
});

test('does not permit an anonymous offline queue', () => {
  assert.throws(() => offlineQueueKey('  '));
});
