import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTenantSelection, selectionStorageKey } from './selection.ts';
import type { Location, TenantAccess } from './types.ts';
const accesses: TenantAccess[] = [
  { tenant: { id: 'tenant-a', name: 'A', slug: 'a', status: 'active', plan: 'starter' }, membership: { tenantId: 'tenant-a', userId: 'user', role: 'owner', status: 'active' } },
  { tenant: { id: 'tenant-b', name: 'B', slug: 'b', status: 'trial', plan: 'starter' }, membership: { tenantId: 'tenant-b', userId: 'user', role: 'warehouse', status: 'active' } },
];
const locations: Location[] = [
  { id: 'location-a', tenantId: 'tenant-a', name: 'Main', code: 'MAIN', isActive: true },
  { id: 'location-b', tenantId: 'tenant-b', name: 'Store', code: 'STORE', isActive: true },
];
test('selection is isolated by user', () => { assert.equal(selectionStorageKey('user'), 'tenant-selection:v1:user'); assert.throws(() => selectionStorageKey(' ')); });
test('restores a valid tenant and location', () => { assert.deepEqual(resolveTenantSelection(accesses, locations, { tenantId: 'tenant-b', locationId: 'location-b' }), { tenantId: 'tenant-b', locationId: 'location-b' }); });
test('falls back safely when stored access is stale', () => { assert.deepEqual(resolveTenantSelection(accesses, locations, { tenantId: 'removed', locationId: 'removed' }), { tenantId: 'tenant-a', locationId: 'location-a' }); assert.equal(resolveTenantSelection([], locations, null), null); });
