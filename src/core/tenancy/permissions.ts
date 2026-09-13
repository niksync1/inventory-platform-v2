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
