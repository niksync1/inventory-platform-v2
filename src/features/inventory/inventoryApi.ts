import { escapeLikePattern, mergeUniqueById, normalizeProductSearch } from '../../core/inventory/search';
import { supabase } from '../../shared/supabase';

export interface ProductInventory { id: string; name: string; barcode: string | null; category: string | null; price: number; isActive: boolean; totalQuantity: number; locationQuantity: number; }
export interface InventoryTransaction { id: string; type: string; quantity: number; previousStock: number | null; newStock: number | null; remarks: string | null; createdAt: string; }
export type BatchExpiryStatus = 'expired' | 'critical' | 'warning' | 'current' | 'untracked';
export interface InventoryBatch { id: string; batchNumber: string; expiryDate: string | null; quantity: number; receivedAt: string; expiryStatus: BatchExpiryStatus; daysToExpiry: number | null; }
export interface ProductDetail extends ProductInventory { description: string | null; transactions: InventoryTransaction[]; batches: InventoryBatch[]; }
export interface InventorySummary { products: number; unitsAtLocation: number; transactionsAtLocation: number; }
const PRODUCT_FIELDS = 'id,name,barcode,category,price,is_active,stock_quantity,description';
type ProductRow = { id: string; name: string; barcode: string | null; category: string | null; price: number; is_active: boolean; stock_quantity: number; description: string | null };

async function attachLocationQuantity(rows: ProductRow[], tenantId: string, locationId: string): Promise<ProductInventory[]> {
  if (!rows.length) return [];
  const levels = await supabase.from('inventory_levels').select('product_id,quantity').eq('tenant_id', tenantId).eq('location_id', locationId).in('product_id', rows.map(row => row.id));
  if (levels.error) throw levels.error;
  const quantities = new Map((levels.data ?? []).map(level => [level.product_id, level.quantity]));
  return rows.map(row => ({ id: row.id, name: row.name, barcode: row.barcode, category: row.category, price: Number(row.price), isActive: row.is_active, totalQuantity: row.stock_quantity, locationQuantity: quantities.get(row.id) ?? 0 }));
}

export async function listProducts(tenantId: string, locationId: string, search = ''): Promise<ProductInventory[]> {
  const query = normalizeProductSearch(search); let rows: ProductRow[];
  if (!query) {
    const result = await supabase.from('products').select(PRODUCT_FIELDS).eq('tenant_id', tenantId).eq('is_active', true).order('name').limit(100);
    if (result.error) throw result.error; rows = (result.data ?? []) as ProductRow[];
  } else {
    const escaped = escapeLikePattern(query);
    const [byName, byBarcode] = await Promise.all([
      supabase.from('products').select(PRODUCT_FIELDS).eq('tenant_id', tenantId).eq('is_active', true).ilike('name', `%${escaped}%`).order('name').limit(50),
      supabase.from('products').select(PRODUCT_FIELDS).eq('tenant_id', tenantId).eq('is_active', true).eq('barcode', query).limit(1),
    ]);
    const error = byName.error ?? byBarcode.error; if (error) throw error;
    rows = mergeUniqueById((byBarcode.data ?? []) as ProductRow[], (byName.data ?? []) as ProductRow[]);
  }
  return attachLocationQuantity(rows, tenantId, locationId);
}

export async function findProductByBarcode(tenantId: string, locationId: string, barcode: string): Promise<ProductInventory | null> {
  const normalized = normalizeProductSearch(barcode); if (!normalized) return null;
  const result = await supabase.from('products').select(PRODUCT_FIELDS).eq('tenant_id', tenantId).eq('barcode', normalized).eq('is_active', true).maybeSingle();
  if (result.error) throw result.error;
  const products = await attachLocationQuantity(result.data ? [result.data as ProductRow] : [], tenantId, locationId);
  return products[0] ?? null;
}

export async function loadProductDetail(tenantId: string, locationId: string, productId: string): Promise<ProductDetail> {
  const product = await supabase.from('products').select(PRODUCT_FIELDS).eq('tenant_id', tenantId).eq('id', productId).single();
  if (product.error) throw product.error;
  const [inventory] = await attachLocationQuantity([product.data as ProductRow], tenantId, locationId);
  const [transactions, batches] = await Promise.all([
    supabase.from('inventory_transactions').select('id,transaction_type,quantity,previous_stock,new_stock,remarks,created_at').eq('tenant_id', tenantId).eq('location_id', locationId).eq('product_id', productId).order('created_at', { ascending: false }).limit(20),
    supabase.from('inventory_expiry_report').select('batch_id,batch_number,expiry_date,quantity,received_at,expiry_status,days_to_expiry').eq('tenant_id', tenantId).eq('location_id', locationId).eq('product_id', productId).order('expiry_date', { ascending: true, nullsFirst: false }),
  ]);
  if (transactions.error) throw transactions.error;
  if (batches.error) throw batches.error;
  return {
    ...inventory,
    description: (product.data as ProductRow).description,
    transactions: (transactions.data ?? []).map(row => ({ id: row.id, type: row.transaction_type, quantity: row.quantity, previousStock: row.previous_stock, newStock: row.new_stock, remarks: row.remarks, createdAt: row.created_at })),
    batches: (batches.data ?? []).map(row => ({ id: row.batch_id, batchNumber: row.batch_number, expiryDate: row.expiry_date, quantity: row.quantity, receivedAt: row.received_at, expiryStatus: row.expiry_status as BatchExpiryStatus, daysToExpiry: row.days_to_expiry })),
  };
}

export async function loadInventorySummary(tenantId: string, locationId: string): Promise<InventorySummary> {
  const [products, levels, transactions] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    supabase.from('inventory_levels').select('quantity').eq('tenant_id', tenantId).eq('location_id', locationId),
    supabase.from('inventory_transactions').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('location_id', locationId),
  ]);
  const error = products.error ?? levels.error ?? transactions.error; if (error) throw error;
  return { products: products.count ?? 0, unitsAtLocation: (levels.data ?? []).reduce((sum, row) => sum + row.quantity, 0), transactionsAtLocation: transactions.count ?? 0 };
}

export async function stockIn(input: { tenantId: string; locationId: string; productId: string; quantity: number; batchNumber: string; expiryDate: string; remarks?: string; operationId: string }) { const { error } = await supabase.rpc('stock_in_batch', { p_tenant_id: input.tenantId, p_location_id: input.locationId, p_product_id: input.productId, p_quantity: input.quantity, p_batch_number: input.batchNumber, p_expiry_date: input.expiryDate, p_remarks: input.remarks ?? null, p_operation_id: input.operationId }); if (error) throw error; }
export async function stockOutSale(input: { tenantId: string; locationId: string; productId: string; quantity: number; remarks?: string; operationId: string }) { const { error } = await supabase.rpc('stock_out_sale_fefo', { p_tenant_id: input.tenantId, p_location_id: input.locationId, p_product_id: input.productId, p_quantity: input.quantity, p_remarks: input.remarks ?? null, p_operation_id: input.operationId }); if (error) throw error; }
export async function stockOutBatch(input: { tenantId: string; locationId: string; productId: string; batchId: string; quantity: number; transactionType: 'DAMAGE' | 'EXPIRED' | 'ADJUSTMENT'; remarks: string; operationId: string }) { const { error } = await supabase.rpc('stock_out_batch', { p_tenant_id: input.tenantId, p_location_id: input.locationId, p_product_id: input.productId, p_batch_id: input.batchId, p_quantity: input.quantity, p_transaction_type: input.transactionType, p_remarks: input.remarks, p_operation_id: input.operationId }); if (error) throw error; }
