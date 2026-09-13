import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageInventory, canManageOrders } from './permissions.ts';

test('warehouse users can manage inventory but not customer orders', () => {
  assert.equal(canManageInventory('warehouse'), true);
  assert.equal(canManageOrders('warehouse'), false);
});

test('owners, admins, and managers can manage inventory and orders', () => {
  for (const role of ['owner', 'admin', 'manager'] as const) {
    assert.equal(canManageInventory(role), true);
    assert.equal(canManageOrders(role), true);
  }
});

test('viewers cannot mutate inventory or manage orders', () => {
  assert.equal(canManageInventory('viewer'), false);
  assert.equal(canManageOrders('viewer'), false);
});
