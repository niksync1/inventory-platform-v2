import type { TenantRole } from './types';

const INVENTORY_MANAGERS = new Set<TenantRole>([
  'owner',
  'admin',
  'manager',
  'warehouse',
]);
const ORDER_MANAGERS = new Set<TenantRole>(['owner', 'admin', 'manager']);
const PURCHASE_ORDER_READERS = new Set<TenantRole>(['owner', 'admin', 'manager', 'warehouse']);
const TRANSFER_MANAGERS = new Set<TenantRole>(['owner', 'admin', 'manager']);

export function canManageInventory(role: TenantRole): boolean {
  return INVENTORY_MANAGERS.has(role);
}

export function canManageOrders(role: TenantRole): boolean {
  return ORDER_MANAGERS.has(role);
}

/** Viewers cannot access the purchasing area; warehouse users retain read access for receiving. */
export function canAccessPurchasing(role: TenantRole): boolean {
  return PURCHASE_ORDER_READERS.has(role);
}

/** Viewers have no access to purchase orders; warehouse users may view orders to receive stock. */
export function canViewPurchaseOrders(role: TenantRole): boolean {
  return PURCHASE_ORDER_READERS.has(role);
}

export function canManageTransfers(role: TenantRole): boolean {
  return TRANSFER_MANAGERS.has(role);
}

export function canReceiveTransfers(role: TenantRole): boolean {
  return INVENTORY_MANAGERS.has(role);
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
