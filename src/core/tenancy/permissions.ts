import type { TenantRole } from './types';

const INVENTORY_MANAGERS = new Set<TenantRole>([
  'owner',
  'admin',
  'manager',
  'warehouse',
]);
const ORDER_MANAGERS = new Set<TenantRole>(['owner', 'admin', 'manager']);

export function canManageInventory(role: TenantRole): boolean {
  return INVENTORY_MANAGERS.has(role);
}

export function canManageOrders(role: TenantRole): boolean {
  return ORDER_MANAGERS.has(role);
}

export function canAcknowledgeAlerts(role: TenantRole): boolean {
  return INVENTORY_MANAGERS.has(role);
}

/**
 * Mobile navigation may reveal the external administration link only to tenant owners.
 * The dashboard independently enforces its own membership authorization.
 */
export function canOpenAdminDashboard(role: TenantRole): boolean {
  return role === 'owner';
}
