import { supabase } from '../../shared/supabase';
import type { ReportRange } from './reportRange';

export type ReportTransactionType = 'ALL' | 'RECEIPT' | 'SALE' | 'DAMAGE' | 'EXPIRED' | 'ADJUSTMENT' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'TRANSFER_RETURN';
export interface ReportSummary { currentUnits: number; productsAtLocation: number; stockReceived: number; stockIssued: number; totalTransactions: number; }
export interface ReportTransaction { id: string; productName: string; category: string | null; type: string; quantity: number; previousStock: number | null; newStock: number | null; remarks: string | null; performerName: string; performerEmail: string | null; createdAt: string; }
export interface ExpiryBatch { id: string; productName: string; category: string | null; batchNumber: string; expiryDate: string | null; status: string; daysToExpiry: number | null; quantity: number; }
export interface ExpirySettings { warningDays: number; criticalDays: number; }
export interface ReportData { summary: ReportSummary; transactions: ReportTransaction[]; expiryBatches: ExpiryBatch[]; fetchedAt: string; }

export async function loadReport(tenantId: string, locationId: string, range: ReportRange, type: ReportTransactionType): Promise<ReportData> {
  const summaryResult = await supabase.rpc('get_inventory_report_summary', {
    p_tenant_id: tenantId, p_location_id: locationId, p_from: range.from, p_to_exclusive: range.toExclusive,
  });
  if (summaryResult.error) throw summaryResult.error;
  let query = supabase.from('inventory_transaction_report')
    .select('id,product_name,category,transaction_type,quantity,previous_stock,new_stock,remarks,performer_name,performer_email,created_at')
    .eq('tenant_id', tenantId).eq('location_id', locationId)
    .gte('created_at', range.from).lt('created_at', range.toExclusive)
    .order('created_at', { ascending: false }).limit(100);
  if (type !== 'ALL') query = query.eq('transaction_type', type);
  const [transactionResult, expiryResult] = await Promise.all([
    query,
    supabase.from('inventory_expiry_report')
      .select('batch_id,product_name,category,batch_number,expiry_date,expiry_status,days_to_expiry,quantity')
      .eq('tenant_id', tenantId).eq('location_id', locationId)
      .order('expiry_date', { ascending: true, nullsFirst: false }).limit(500),
  ]);
  if (transactionResult.error) throw transactionResult.error;
  if (expiryResult.error) throw expiryResult.error;
  const raw = (summaryResult.data?.[0] ?? {}) as Record<string, unknown>;
  return {
    summary: {
      currentUnits: Number(raw.current_units ?? 0),
      productsAtLocation: Number(raw.products_at_location ?? 0),
      stockReceived: Number(raw.stock_received ?? 0),
      stockIssued: Number(raw.stock_issued ?? 0),
      totalTransactions: Number(raw.total_transactions ?? 0),
    },
    transactions: (transactionResult.data ?? []).map(row => ({
      id: row.id, productName: row.product_name, category: row.category, type: row.transaction_type,
      quantity: row.quantity, previousStock: row.previous_stock, newStock: row.new_stock,
      remarks: row.remarks, performerName: row.performer_name, performerEmail: row.performer_email,
      createdAt: row.created_at,
    })),
    expiryBatches: (expiryResult.data ?? []).map(row => ({
      id: row.batch_id, productName: row.product_name, category: row.category,
      batchNumber: row.batch_number, expiryDate: row.expiry_date, status: row.expiry_status,
      daysToExpiry: row.days_to_expiry, quantity: row.quantity,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

export function expiryReportToCsv(report: ReportData): string {
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = report.expiryBatches.map(item => [
    item.productName, item.category, item.batchNumber, item.expiryDate,
    item.daysToExpiry, item.status, item.quantity,
  ].map(quote).join(','));
  return ['Product,Category,Batch,Expiry date,Days to expiry,Status,Quantity', ...rows].join('\n');
}

export async function loadExpirySettings(tenantId: string): Promise<ExpirySettings> {
  const result = await supabase.from('tenant_inventory_settings')
    .select('expiry_warning_days,expiry_critical_days').eq('tenant_id', tenantId).single();
  if (result.error) throw result.error;
  return { warningDays: result.data.expiry_warning_days, criticalDays: result.data.expiry_critical_days };
}

export async function updateExpirySettings(tenantId: string, settings: ExpirySettings): Promise<void> {
  const result = await supabase.from('tenant_inventory_settings').update({
    expiry_warning_days: settings.warningDays,
    expiry_critical_days: settings.criticalDays,
    updated_at: new Date().toISOString(),
  }).eq('tenant_id', tenantId).select('tenant_id').single();
  if (result.error) throw result.error;
}

export function reportCacheKey(userId: string, tenantId: string, locationId: string, range: ReportRange, type: ReportTransactionType): string {
  return `reports:v3:${userId}:${tenantId}:${locationId}:${range.from}:${range.toExclusive}:${type}`;
}

export function reportToCsv(report: ReportData): string {
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = report.transactions.map(item => [
    item.createdAt, item.productName, item.category, item.type, item.quantity,
    item.previousStock, item.newStock, item.performerName, item.performerEmail, item.remarks,
  ].map(quote).join(','));
  return ['Date,Product,Category,Type,Quantity,Previous stock,New stock,Performer,Email,Remarks', ...rows].join('\n');
}
