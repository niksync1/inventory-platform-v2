import assert from 'node:assert/strict';
import test from 'node:test';
import { canAcknowledgeAlerts, canManageInventory, canManageOrders, canOpenAdminDashboard } from './permissions.ts';

test('warehouse users can manage inventory and acknowledge alerts but not customer orders', () => {
  assert.equal(canManageInventory('warehouse'), true);
  assert.equal(canAcknowledgeAlerts('warehouse'), true);
  assert.equal(canManageOrders('warehouse'), false);
});

test('owners, admins, and managers can manage inventory, orders, and alerts', () => {
  for (const role of ['owner', 'admin', 'manager'] as const) {
    assert.equal(canManageInventory(role), true);
    assert.equal(canManageOrders(role), true);
    assert.equal(canAcknowledgeAlerts(role), true);
  }
});

test('viewers have read-only inventory and alert access', () => {
  assert.equal(canManageInventory('viewer'), false);
  assert.equal(canManageOrders('viewer'), false);
  assert.equal(canAcknowledgeAlerts('viewer'), false);
});

test('only tenant owners see the external admin dashboard link', () => {
  assert.equal(canOpenAdminDashboard('owner'), true);
  for (const role of ['admin', 'manager', 'warehouse', 'viewer'] as const) {
    assert.equal(canOpenAdminDashboard(role), false);
  }
});
