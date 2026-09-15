import type { Location, TenantAccess } from './types';
export interface StoredTenantSelection { tenantId: string; locationId: string; }
export function selectionStorageKey(userId: string): string {
  if (!userId.trim()) throw new Error('A user ID is required for tenant selection.');
  return `tenant-selection:v1:${userId}`;
}
export function resolveTenantSelection(accesses: TenantAccess[], locations: Location[], stored: StoredTenantSelection | null): StoredTenantSelection | null {
  if (!accesses.length) return null;
  const tenantId = accesses.some(({ tenant }) => tenant.id === stored?.tenantId) ? stored!.tenantId : accesses[0].tenant.id;
  const available = locations.filter(location => location.tenantId === tenantId && location.isActive);
  if (!available.length) return null;
  const locationId = available.some(({ id }) => id === stored?.locationId) ? stored!.locationId : available[0].id;
  return { tenantId, locationId };
}
