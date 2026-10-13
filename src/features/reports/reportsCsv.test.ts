import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReportData } from './reportsApi';
import { expiryReportToCsv, reportToCsv } from './reportsCsv.ts';

const report: ReportData = {
  summary: { currentUnits: 13, productsAtLocation: 2, stockReceived: 10, stockIssued: 3, totalTransactions: 1 },
  transactions: [{
    id: 'tx-1', productName: 'Paracetamol', category: 'Pills', type: 'RECEIPT', quantity: 10,
    previousStock: 0, newStock: 10, remarks: 'note, with "quotes"', performerName: 'Ana',
    performerEmail: 'ana@example.com', createdAt: '2026-10-01T10:00:00.000Z',
  }],
  expiryBatches: [{
    id: 'batch-1', productName: 'Ibuprofen', category: 'Pills', batchNumber: 'B-1',
    expiryDate: '2026-12-01', status: 'ok', daysToExpiry: 60, quantity: 3,
  }],
  fetchedAt: '2026-10-13T10:00:00.000Z',
};

test('transaction csv omits the expiry section by default', () => {
  const csv = reportToCsv(report);
  assert.ok(csv.startsWith('Date,Product,Category,Type,Quantity'));
  assert.ok(csv.includes('"note, with ""quotes"""'));
  assert.ok(!csv.includes('Batch expiry report'));
  assert.ok(!csv.includes('Expiry date'));
});

test('transaction csv appends the expiry section when requested', () => {
  const csv = reportToCsv(report, true);
  assert.ok(csv.includes('\n\nBatch expiry report (current stock)\n'));
  assert.ok(csv.includes('Product,Category,Batch,Expiry date,Days to expiry,Status,Quantity'));
  assert.ok(csv.includes('"Ibuprofen","Pills","B-1","2026-12-01","60","ok","3"'));
});

test('expiry csv keeps its original single-section output', () => {
  assert.equal(
    expiryReportToCsv(report),
    'Product,Category,Batch,Expiry date,Days to expiry,Status,Quantity\n"Ibuprofen","Pills","B-1","2026-12-01","60","ok","3"',
  );
});