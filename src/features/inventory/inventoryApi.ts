import { supabase } from '../../shared/supabase';
export interface InventorySummary { products: number; unitsAtLocation: number; transactionsAtLocation: number; }
export async function loadInventorySummary(tenantId: string, locationId: string): Promise<InventorySummary> {
  const [products, levels, transactions] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    supabase.from('inventory_levels').select('quantity').eq('tenant_id', tenantId).eq('location_id', locationId),
    supabase.from('inventory_transactions').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('location_id', locationId),
  ]);
  const error = products.error ?? levels.error ?? transactions.error; if (error) throw error;
  return { products: products.count ?? 0, unitsAtLocation: (levels.data ?? []).reduce((sum, row) => sum + row.quantity, 0), transactionsAtLocation: transactions.count ?? 0 };
}
export async function stockIn(input: { tenantId: string; locationId: string; productId: string; quantity: number; remarks?: string; operationId: string }) { const { error } = await supabase.rpc('stock_in', { p_tenant_id: input.tenantId, p_location_id: input.locationId, p_product_id: input.productId, p_quantity: input.quantity, p_remarks: input.remarks ?? null, p_operation_id: input.operationId }); if (error) throw error; }
export async function stockOut(input: { tenantId: string; locationId: string; productId: string; quantity: number; transactionType: 'DAMAGE' | 'EXPIRED' | 'ADJUSTMENT' | 'SALE'; remarks?: string; operationId: string }) { const { error } = await supabase.rpc('stock_out', { p_tenant_id: input.tenantId, p_location_id: input.locationId, p_product_id: input.productId, p_quantity: input.quantity, p_transaction_type: input.transactionType, p_remarks: input.remarks ?? null, p_operation_id: input.operationId }); if (error) throw error; }
