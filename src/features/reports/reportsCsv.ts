import type { ReportData } from './reportsApi';

const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const TRANSACTIONS_HEADER = 'Date,Product,Category,Type,Quantity,Previous stock,New stock,Performer,Email,Remarks';
const EXPIRY_HEADER = 'Product,Category,Batch,Expiry date,Days to expiry,Status,Quantity';

function expiryLines(report: ReportData): string[] {
  const rows = report.expiryBatches.map(item => [
    item.productName, item.category, item.batchNumber, item.expiryDate,
    item.daysToExpiry, item.status, item.quantity,
  ].map(quote).join(','));
  return [EXPIRY_HEADER, ...rows];
}

export function expiryReportToCsv(report: ReportData): string {
  return expiryLines(report).join('\n');
}

export function reportToCsv(report: ReportData, includeExpiry = false): string {
  const rows = report.transactions.map(item => [
    item.createdAt, item.productName, item.category, item.type, item.quantity,
    item.previousStock, item.newStock, item.performerName, item.performerEmail, item.remarks,
  ].map(quote).join(','));
  const lines = [TRANSACTIONS_HEADER, ...rows];
  if (includeExpiry) lines.push('', 'Batch expiry report (current stock)', ...expiryLines(report));
  return lines.join('\n');
}