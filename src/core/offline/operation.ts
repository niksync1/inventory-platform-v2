export type OperationStatus = 'pending' | 'syncing' | 'failed';
export type OfflineOperationKind = 'stock_in' | 'stock_out_sale' | 'stock_out_batch' | 'transfer_create' | 'transfer_dispatch' | 'transfer_receive' | 'transfer_cancel';
interface OperationBase {
  id: string;
  userId: string;
  tenantId: string;
  locationId: string;
  productId: string | null;
  kind: OfflineOperationKind;
  status: OperationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}
export type OfflineOperation = OperationBase & (
  { kind: 'stock_in'; payload: { quantity: number; batchNumber: string; expiryDate: string; remarks: string | null } }
  | { kind: 'stock_out_sale'; payload: { quantity: number; remarks: string | null } }
  | { kind: 'stock_out_batch'; payload: { batchId: string; quantity: number; transactionType: 'DAMAGE' | 'EXPIRED' | 'ADJUSTMENT'; remarks: string } }
  | { kind: 'transfer_create'; payload: { destinationLocationId: string; batchId: string; quantity: number; remarks: string | null } }
  | { kind: 'transfer_dispatch'; payload: { transferId: string } }
  | { kind: 'transfer_receive'; payload: { transferId: string; quantity: number } }
  | { kind: 'transfer_cancel'; payload: { transferId: string; reason: string } }
);
export type NewOfflineOperation = Omit<OfflineOperation, 'status' | 'attempts' | 'createdAt' | 'updatedAt' | 'lastError'>;

export function offlineQueueKey(userId: string, tenantId: string): string {
  if (!userId.trim()) throw new Error('A user ID is required for offline queue isolation.');
  if (!tenantId.trim()) throw new Error('A tenant ID is required for offline queue isolation.');
  return `offline:operations:v4:${userId}:${tenantId}`;
}

export function createQueuedOperation(input: NewOfflineOperation, now = new Date()): OfflineOperation {
  const timestamp = now.toISOString();
  return { ...input, status: 'pending', attempts: 0, createdAt: timestamp, updatedAt: timestamp, lastError: null } as OfflineOperation;
}
export function operationLabel(kind: OfflineOperationKind): string {
  return ({ stock_in: 'Stock in', stock_out_sale: 'Sale', stock_out_batch: 'Batch stock out', transfer_create: 'Create transfer', transfer_dispatch: 'Dispatch transfer', transfer_receive: 'Receive transfer', transfer_cancel: 'Cancel transfer' })[kind];
}
export function isRetryableNetworkError(error: unknown): boolean {
  const message = operationErrorMessage(error);
  return /network request failed|failed to fetch|network.*(offline|unavailable|timeout)|timed out|connection.*(lost|refused)|fetch failed/i.test(message);
}
export function operationErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error ?? 'Operation failed');
}
