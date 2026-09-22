import AsyncStorage from '@react-native-async-storage/async-storage';
import { offlineQueueKey, type OfflineOperation } from './operation';
export async function loadOfflineQueue(userId: string, tenantId: string): Promise<OfflineOperation[]> {
  const raw = await AsyncStorage.getItem(offlineQueueKey(userId, tenantId)); if (!raw) return [];
  try { return (JSON.parse(raw) as OfflineOperation[]).map(item => item.status === 'syncing' ? { ...item, status: 'pending' } : item); }
  catch { await AsyncStorage.removeItem(offlineQueueKey(userId, tenantId)); return []; }
}
export async function saveOfflineQueue(userId: string, tenantId: string, operations: OfflineOperation[]): Promise<void> {
  await AsyncStorage.setItem(offlineQueueKey(userId, tenantId), JSON.stringify(operations));
}
