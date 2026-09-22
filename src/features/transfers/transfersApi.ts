import { supabase } from '../../shared/supabase';

export type TransferStatus = 'draft' | 'dispatched' | 'partially_received' | 'received' | 'cancelled';
export interface TransferDestination { id: string; name: string; code: string; }
export interface InventoryTransfer {
  id: string;
  reference: string;
  status: TransferStatus;
  sourceLocationId: string;
  sourceLocationName: string;
  destinationLocationId: string;
  destinationLocationName: string;
  productId: string;
  productName: string;
  sourceBatchId: string;
  batchNumber: string;
  expiryDate: string | null;
  quantityRequested: number;
  quantityDispatched: number;
  quantityReceived: number;
  quantityOutstanding: number;
  remarks: string | null;
  creatorName: string;
  createdAt: string;
  updatedAt: string;
}

export async function listTransferDestinations(tenantId: string, sourceLocationId: string): Promise<TransferDestination[]> {
  const result = await supabase.rpc('get_inventory_transfer_destinations', { p_tenant_id: tenantId, p_source_location_id: sourceLocationId });
  if (result.error) throw result.error;
  return (result.data ?? []).map((row: { id: string; name: string; code: string }) => ({ id: row.id, name: row.name, code: row.code }));
}

export async function listTransfers(tenantId: string, locationId: string): Promise<InventoryTransfer[]> {
  const result = await supabase.from('inventory_transfer_report')
    .select('id,reference,status,source_location_id,source_location_name,destination_location_id,destination_location_name,product_id,product_name,source_batch_id,batch_number,expiry_date,quantity_requested,quantity_dispatched,quantity_received,quantity_outstanding,remarks,creator_name,created_at,updated_at')
    .eq('tenant_id', tenantId)
    .or(`source_location_id.eq.${locationId},destination_location_id.eq.${locationId}`)
    .order('updated_at', { ascending: false }).limit(100);
  if (result.error) throw result.error;
  return (result.data ?? []).map(row => ({
    id: row.id, reference: row.reference, status: row.status as TransferStatus,
    sourceLocationId: row.source_location_id, sourceLocationName: row.source_location_name,
    destinationLocationId: row.destination_location_id, destinationLocationName: row.destination_location_name,
    productId: row.product_id, productName: row.product_name, sourceBatchId: row.source_batch_id,
    batchNumber: row.batch_number, expiryDate: row.expiry_date,
    quantityRequested: row.quantity_requested, quantityDispatched: row.quantity_dispatched,
    quantityReceived: row.quantity_received, quantityOutstanding: row.quantity_outstanding,
    remarks: row.remarks, creatorName: row.creator_name, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export async function createTransfer(input: { tenantId: string; sourceLocationId: string; destinationLocationId: string; batchId: string; quantity: number; remarks?: string; operationId: string }): Promise<string> {
  const result = await supabase.rpc('create_inventory_transfer', {
    p_tenant_id: input.tenantId, p_source_location_id: input.sourceLocationId,
    p_destination_location_id: input.destinationLocationId, p_batch_id: input.batchId,
    p_quantity: input.quantity, p_remarks: input.remarks ?? null, p_operation_id: input.operationId,
  });
  if (result.error) throw result.error;
  return result.data as string;
}

export async function dispatchTransfer(transferId: string, operationId: string): Promise<void> {
  const result = await supabase.rpc('dispatch_inventory_transfer', { p_transfer_id: transferId, p_operation_id: operationId });
  if (result.error) throw result.error;
}

export async function receiveTransfer(transferId: string, quantity: number, operationId: string): Promise<void> {
  const result = await supabase.rpc('receive_inventory_transfer', { p_transfer_id: transferId, p_quantity: quantity, p_operation_id: operationId });
  if (result.error) throw result.error;
}

export async function cancelTransfer(transferId: string, reason: string, operationId: string): Promise<void> {
  const result = await supabase.rpc('cancel_inventory_transfer', { p_transfer_id: transferId, p_operation_id: operationId, p_reason: reason });
  if (result.error) throw result.error;
}
