export type TenantStatus = 'trial' | 'active' | 'suspended' | 'cancelled';
export type MembershipStatus = 'invited' | 'active' | 'suspended';
export type TenantRole = 'owner' | 'admin' | 'manager' | 'warehouse' | 'viewer';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: string;
}

export interface TenantMembership {
  tenantId: string;
  userId: string;
  role: TenantRole;
  status: MembershipStatus;
}

export interface TenantContext {
  tenant: Tenant;
  membership: TenantMembership;
  locationId: string;
}
