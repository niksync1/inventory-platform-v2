import NetInfo from '@react-native-community/netinfo';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { createQueuedOperation, isRetryableNetworkError, operationErrorMessage, type NewOfflineOperation, type OfflineOperation } from '../../core/offline/operation';
import { loadOfflineQueue, saveOfflineQueue } from '../../core/offline/storage';
import { useAuth } from '../auth/AuthProvider';
import { useTenant } from '../tenancy/TenantProvider';
import { executeOfflineOperation } from './offlineExecutor';
import { reportSyncFailure } from '../notifications/notificationsApi';
type SubmitResult = 'completed' | 'queued';
interface OfflineSyncValue { operations: OfflineOperation[]; pendingCount: number; failedCount: number; syncing: boolean; submit: (input: NewOfflineOperation) => Promise<SubmitResult>; retry: (id?: string) => Promise<void>; remove: (id: string) => Promise<void>; }
const State = createContext<OfflineSyncValue | null>(null);
const MAX_AUTOMATIC_ATTEMPTS = 5;
export function OfflineSyncProvider({ children }: PropsWithChildren) {
  const { session } = useAuth(); const { context } = useTenant();
  const userId = session?.user.id ?? ''; const tenantId = context?.tenant.id ?? '';
  const [operations, setOperations] = useState<OfflineOperation[]>([]); const [syncing, setSyncing] = useState(false);
  const queueRef = useRef<OfflineOperation[]>([]); const syncingRef = useRef(false);
  const persist = useCallback(async (next: OfflineOperation[]) => { queueRef.current = next; setOperations(next); if (userId && tenantId) await saveOfflineQueue(userId, tenantId, next); }, [tenantId, userId]);
  useEffect(() => { let active = true; if (!userId || !tenantId) { queueRef.current = []; setOperations([]); return; } void loadOfflineQueue(userId, tenantId).then(next => { if (active) { queueRef.current = next; setOperations(next); } }); return () => { active = false; }; }, [tenantId, userId]);
  const replay = useCallback(async (onlyId?: string, includeFailed = false) => {
    if (!userId || !tenantId || syncingRef.current) return;
    const network = await NetInfo.fetch(); if (network.isConnected === false || network.isInternetReachable === false) return;
    syncingRef.current = true; setSyncing(true);
    try {
      for (const queued of [...queueRef.current]) {
        if ((onlyId && queued.id !== onlyId) || (queued.status === 'failed' && !includeFailed)) continue;
        let current = { ...queued, status: 'syncing', updatedAt: new Date().toISOString() } as OfflineOperation;
        await persist(queueRef.current.map(item => item.id === current.id ? current : item));
        try { await executeOfflineOperation(current); await persist(queueRef.current.filter(item => item.id !== current.id)); }
        catch (error) {
          const attempts = current.attempts + 1; const retryable = isRetryableNetworkError(error);
          current = { ...current, attempts, status: retryable && attempts < MAX_AUTOMATIC_ATTEMPTS ? 'pending' : 'failed', lastError: operationErrorMessage(error), updatedAt: new Date().toISOString() } as OfflineOperation;
          await persist(queueRef.current.map(item => item.id === current.id ? current : item)); if (retryable) break;
          if (current.productId) void reportSyncFailure({ tenantId: current.tenantId, locationId: current.locationId, productId: current.productId, operationId: current.id, message: current.lastError ?? 'Synchronization failed' }).catch(() => undefined);
        }
      }
    } finally { syncingRef.current = false; setSyncing(false); }
  }, [persist, tenantId, userId]);
  useEffect(() => { const unsubscribe = NetInfo.addEventListener(state => { if (state.isConnected && state.isInternetReachable !== false) void replay(); }); const appState = AppState.addEventListener('change', state => { if (state === 'active') void replay(); }); return () => { unsubscribe(); appState.remove(); }; }, [replay]);
  const submit = useCallback(async (input: NewOfflineOperation): Promise<SubmitResult> => {
    if (input.userId !== userId || input.tenantId !== tenantId) throw new Error('Offline operation context does not match the active account and tenant.');
    const operation = createQueuedOperation(input); const network = await NetInfo.fetch();
    if (network.isConnected !== false && network.isInternetReachable !== false) { try { await executeOfflineOperation(operation); return 'completed'; } catch (error) { if (!isRetryableNetworkError(error)) throw error; } }
    await persist([...queueRef.current.filter(item => item.id !== operation.id), operation]); return 'queued';
  }, [persist, tenantId, userId]);
  const retry = useCallback(async (id?: string) => { await persist(queueRef.current.map(item => (!id || item.id === id) && item.status === 'failed' ? { ...item, status: 'pending', lastError: null, updatedAt: new Date().toISOString() } as OfflineOperation : item)); await replay(id, true); }, [persist, replay]);
  const remove = useCallback(async (id: string) => persist(queueRef.current.filter(item => item.id !== id)), [persist]);
  const value = useMemo(() => ({ operations, pendingCount: operations.filter(item => item.status !== 'failed').length, failedCount: operations.filter(item => item.status === 'failed').length, syncing, submit, retry, remove }), [operations, remove, retry, submit, syncing]);
  return <State.Provider value={value}>{children}</State.Provider>;
}
export function useOfflineSync(): OfflineSyncValue { const value = useContext(State); if (!value) throw new Error('useOfflineSync must be used inside OfflineSyncProvider.'); return value; }
