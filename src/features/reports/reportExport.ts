import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import type { ReportData } from './reportsApi';

// expo-print and expo-sharing resolve their native module synchronously at import time and
// throw when it is missing (e.g. a native binary built before they were installed), which
// crashes the app at launch. Loading them on demand keeps the app bootable and turns that
// failure into a readable alert from the export handler instead. Same pattern as loadNotifications.
async function loadPrint() {
  try { return await import('expo-print'); }
  catch { throw new Error('Printing is unavailable in this build of the app. Use Expo Go or rebuild the native app to export PDFs.'); }
}
async function loadSharing() {
  try { return await import('expo-sharing'); }
  catch { throw new Error('File sharing is unavailable in this build of the app. Use Expo Go or rebuild the native app to export files.'); }
}

type ExportKind = 'csv' | 'pdf';

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

async function saveToDevice(fileName: string, mimeType: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<boolean> {
  if (Platform.OS === 'android') {
    const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) return false;
    const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, fileName, mimeType);
    await FileSystem.writeAsStringAsync(fileUri, content, {
      encoding: encoding === 'base64' ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
    });
    return true;
  }

  const directory = FileSystem.documentDirectory;
  if (!directory) throw new Error('Device storage is unavailable.');
  const uri = `${directory}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, content, {
    encoding: encoding === 'base64' ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
  });
  const Sharing = await loadSharing();
  if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is not available on this device.');
  await Sharing.shareAsync(uri, { mimeType, UTI: mimeType === 'application/pdf' ? 'com.adobe.pdf' : 'public.comma-separated-values-text' });
  return true;
}

export async function exportCsvToDevice(fileName: string, csv: string): Promise<boolean> {
  return saveToDevice(fileName.endsWith('.csv') ? fileName : `${fileName}.csv`, 'text/csv', csv);
}

export async function exportPdfToDevice(fileName: string, html: string): Promise<boolean> {
  const Print = await loadPrint();
  const pdf = await Print.printToFileAsync({ html, base64: Platform.OS === 'android' });
  if (Platform.OS === 'android') {
    if (!pdf.base64) throw new Error('Could not prepare the PDF for saving.');
    return saveToDevice(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`, 'application/pdf', pdf.base64, 'base64');
  }
  const Sharing = await loadSharing();
  if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is not available on this device.');
  await Sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
  return true;
}

function htmlDocument(title: string, subtitle: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    @page { margin: 18mm 12mm; } body { font-family: Arial, sans-serif; color: #202938; font-size: 10px; }
    h1 { font-size: 20px; margin-bottom: 4px; } .subtitle { color: #596579; margin-bottom: 16px; }
    h2 { font-size: 14px; margin: 20px 0 8px; } .metrics { display: flex; gap: 16px; margin: 12px 0; }
    .metric { border: 1px solid #d7dce3; padding: 8px; flex: 1; } table { border-collapse: collapse; width: 100%; table-layout: auto; }
    th, td { border: 1px solid #d7dce3; padding: 5px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #eef1f5; } tr { page-break-inside: avoid; } .muted { color: #596579; }
  </style></head><body><h1>${escapeHtml(title)}</h1><div class="subtitle">${escapeHtml(subtitle)}</div>${body}</body></html>`;
}

function table(headers: string[], rows: unknown[][]): string {
  return `<table><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.length
    ? rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}">No records</td></tr>`}</tbody></table>`;
}

export function reportToPdfHtml(report: ReportData, tenantName: string, locationName: string, dateRange: string): string {
  const summary = report.summary;
  const transactions = table(
    ['Date', 'Product', 'Category', 'Type', 'Qty', 'Previous', 'New', 'Performer', 'Email', 'Remarks'],
    report.transactions.map(item => [new Date(item.createdAt).toLocaleString(), item.productName, item.category, item.type, item.quantity, item.previousStock, item.newStock, item.performerName, item.performerEmail, item.remarks]),
  );
  const expiry = table(
    ['Product', 'Category', 'Batch', 'Expiry date', 'Days to expiry', 'Status', 'Quantity'],
    report.expiryBatches.map(item => [item.productName, item.category, item.batchNumber, item.expiryDate, item.daysToExpiry, item.status, item.quantity]),
  );
  const body = `<div class="metrics"><div class="metric"><b>Current units</b><br>${summary.currentUnits}</div><div class="metric"><b>Received</b><br>${summary.stockReceived}</div><div class="metric"><b>Issued</b><br>${summary.stockIssued}</div><div class="metric"><b>Transactions in report</b><br>${report.transactions.length}</div></div><h2>Transactions</h2>${transactions}<h2>Current batch expiry</h2><p class="muted">Batch stock is current and independent of the transaction date range.</p>${expiry}<p class="muted">Generated ${escapeHtml(new Date(report.fetchedAt).toLocaleString())}</p>`;
  return htmlDocument('Inventory report', `${tenantName} · ${locationName} · ${dateRange}`, body);
}

export function expiryReportToPdfHtml(report: ReportData, tenantName: string, locationName: string): string {
  const expiry = table(
    ['Product', 'Category', 'Batch', 'Expiry date', 'Days to expiry', 'Status', 'Quantity'],
    report.expiryBatches.map(item => [item.productName, item.category, item.batchNumber, item.expiryDate, item.daysToExpiry, item.status, item.quantity]),
  );
  return htmlDocument('Batch expiry report', `${tenantName} · ${locationName} · Current stock`, `<h2>Batch expiry (${report.expiryBatches.length})</h2>${expiry}<p class="muted">Generated ${escapeHtml(new Date(report.fetchedAt).toLocaleString())}</p>`);
}

export function reportExportFileName(prefix: string, dateRange: string, extension: ExportKind): string {
  return `${safeFileName(prefix)}-${safeFileName(dateRange)}.${extension}`;
}
