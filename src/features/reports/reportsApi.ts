import { supabase } from '../../shared/supabase';
import { resolveReportRange, type ReportPeriod } from './reportRange';

export type ReportTransactionType = 'ALL' | 'RECEIPT' | 'SALE' | 'DAMAGE' | 'EXPIRED' | 'ADJUSTMENT';
export interface ReportSummary { currentUnits: number; productsAtLocation: number; stockReceived: number; stockIssued: number; totalTransactions: number; }
export interface ReportTransaction { id: string; productName: string; category: string | null; type: string; quantity: number; previousStock: number | null; newStock: number | null; remarks: string | null; performerName: string; performerEmail: string | null; createdAt: string; }
export interface ReportData { summary: ReportSummary; transactions: ReportTransaction[]; fetchedAt: string; }

export async function loadReport(tenantId: string, locationId: string, period: ReportPeriod, type: ReportTransactionType): Promise<ReportData> {
  const range = resolveReportRange(period);
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
  const transactionResult = await query;
  if (transactionResult.error) throw transactionResult.error;
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
    fetchedAt: new Date().toISOString(),
  };
}

export function reportCacheKey(userId: string, tenantId: string, locationId: string, period: ReportPeriod, type: ReportTransactionType): string {
  return `reports:v1:${userId}:${tenantId}:${locationId}:${period}:${type}`;
}

export function reportToCsv(report: ReportData): string {
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = report.transactions.map(item => [
    item.createdAt, item.productName, item.category, item.type, item.quantity,
    item.previousStock, item.newStock, item.performerName, item.performerEmail, item.remarks,
  ].map(quote).join(','));
  return ['Date,Product,Category,Type,Quantity,Previous stock,New stock,Performer,Email,Remarks', ...rows].join('\n');
}
