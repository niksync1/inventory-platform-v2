import type { OfflineOperation } from '../../core/offline/operation';
import { stockIn, stockOutBatch, stockOutSale } from '../inventory/inventoryApi';
import { cancelTransfer, createTransfer, dispatchTransfer, receiveTransfer } from '../transfers/transfersApi';
export async function executeOfflineOperation(operation: OfflineOperation): Promise<void> {
  const common = { tenantId: operation.tenantId, locationId: operation.locationId, productId: operation.productId ?? '', operationId: operation.id };
  switch (operation.kind) {
    case 'stock_in': await stockIn({ ...common, quantity: operation.payload.quantity, batchNumber: operation.payload.batchNumber, expiryDate: operation.payload.expiryDate, remarks: operation.payload.remarks ?? undefined }); return;
    case 'stock_out_sale': await stockOutSale({ ...common, quantity: operation.payload.quantity, remarks: operation.payload.remarks ?? undefined }); return;
    case 'stock_out_batch': await stockOutBatch({ ...common, batchId: operation.payload.batchId, quantity: operation.payload.quantity, transactionType: operation.payload.transactionType, remarks: operation.payload.remarks }); return;
    case 'transfer_create': await createTransfer({ tenantId: operation.tenantId, sourceLocationId: operation.locationId, destinationLocationId: operation.payload.destinationLocationId, batchId: operation.payload.batchId, quantity: operation.payload.quantity, remarks: operation.payload.remarks ?? undefined, operationId: operation.id }); return;
    case 'transfer_dispatch': await dispatchTransfer(operation.payload.transferId, operation.id); return;
    case 'transfer_receive': await receiveTransfer(operation.payload.transferId, operation.payload.quantity, operation.id); return;
    case 'transfer_cancel': await cancelTransfer(operation.payload.transferId, operation.payload.reason, operation.id); return;
  }
}
