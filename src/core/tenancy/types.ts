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

export interface Location {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  isActive: boolean;
}

export interface TenantAccess {
  tenant: Tenant;
  membership: TenantMembership;
}

export interface TenantContext {
  tenant: Tenant;
  membership: TenantMembership;
  locationId: string;
}
