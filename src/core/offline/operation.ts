export type OperationStatus = 'pending' | 'syncing' | 'failed';
export type StockMovementType = 'stock_in' | 'stock_out';

export interface OfflineOperation {
  id: string;
  userId: string;
  tenantId: string;
  locationId: string;
  productId: string;
  type: StockMovementType;
  quantity: number;
  remarks: string | null;
  status: OperationStatus;
  attempts: number;
  createdAt: string;
  lastError: string | null;
}

export function offlineQueueKey(userId: string, tenantId: string): string {
  if (!userId.trim()) throw new Error('A user ID is required for offline queue isolation.');
  if (!tenantId.trim()) throw new Error('A tenant ID is required for offline queue isolation.');
  return `offline:operations:v3:${userId}:${tenantId}`;
}
