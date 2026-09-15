import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { resolveTenantSelection, selectionStorageKey, type StoredTenantSelection } from '../../core/tenancy/selection';
import type { Location, Tenant, TenantAccess, TenantContext, TenantMembership } from '../../core/tenancy/types';
import { supabase } from '../../shared/supabase';
import { useAuth } from '../auth/AuthProvider';
interface TenantValue { accesses: TenantAccess[]; locations: Location[]; context: TenantContext | null; loading: boolean; error: string | null; choose: (tenantId: string, locationId: string) => Promise<void>; createTenant: (name: string, slug: string) => Promise<void>; reload: () => Promise<void>; }
const State = createContext<TenantValue | null>(null);
export function TenantProvider({ children }: PropsWithChildren) {
  const { session } = useAuth(); const userId = session?.user.id ?? '';
  const [accesses, setAccesses] = useState<TenantAccess[]>([]); const [locations, setLocations] = useState<Location[]>([]); const [selection, setSelection] = useState<StoredTenantSelection | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!userId) return; setLoading(true); setError(null);
    try {
      const memberships = await supabase.from('tenant_memberships').select('tenant_id,user_id,role,status,tenants!inner(id,name,slug,status,plan)').eq('user_id', userId).eq('status', 'active');
      if (memberships.error) throw memberships.error;
      const nextAccesses = (memberships.data ?? []).map(raw => {
        const row = raw as unknown as { tenant_id: string; user_id: string; role: TenantMembership['role']; status: TenantMembership['status']; tenants: Tenant | Tenant[] };
        const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
        return { tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, plan: tenant.plan }, membership: { tenantId: row.tenant_id, userId: row.user_id, role: row.role, status: row.status } } satisfies TenantAccess;
      });
      const ids = nextAccesses.map(({ tenant }) => tenant.id);
      const result = ids.length ? await supabase.from('locations').select('id,tenant_id,name,code,is_active').in('tenant_id', ids).eq('is_active', true).order('name') : { data: [], error: null };
      if (result.error) throw result.error;
      const nextLocations = (result.data ?? []).map(row => ({ id: row.id, tenantId: row.tenant_id, name: row.name, code: row.code, isActive: row.is_active })) satisfies Location[];
      const raw = await AsyncStorage.getItem(selectionStorageKey(userId));
      let stored: StoredTenantSelection | null = null;
      if (raw) { try { stored = JSON.parse(raw) as StoredTenantSelection; } catch { await AsyncStorage.removeItem(selectionStorageKey(userId)); } }
      const next = resolveTenantSelection(nextAccesses, nextLocations, stored);
      setAccesses(nextAccesses); setLocations(nextLocations); setSelection(next);
      if (next) await AsyncStorage.setItem(selectionStorageKey(userId), JSON.stringify(next));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load business access.'); }
    finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { void reload(); }, [reload]);
  const choose = useCallback(async (tenantId: string, locationId: string) => {
    const next = resolveTenantSelection(accesses, locations, { tenantId, locationId });
    if (!next || next.tenantId !== tenantId || next.locationId !== locationId) throw new Error('That business or location is not available.');
    setSelection(next); await AsyncStorage.setItem(selectionStorageKey(userId), JSON.stringify(next));
  }, [accesses, locations, userId]);
  const createTenant = useCallback(async (name: string, slug: string) => { const result = await supabase.rpc('create_tenant', { p_name: name, p_slug: slug }); if (result.error) throw result.error; await reload(); }, [reload]);
  const context = useMemo<TenantContext | null>(() => { if (!selection) return null; const access = accesses.find(({ tenant }) => tenant.id === selection.tenantId); return access ? { ...access, locationId: selection.locationId } : null; }, [accesses, selection]);
  return <State.Provider value={{ accesses, locations, context, loading, error, choose, createTenant, reload }}>{children}</State.Provider>;
}
export function useTenant(): TenantValue { const value = useContext(State); if (!value) throw new Error('useTenant must be used inside TenantProvider.'); return value; }
