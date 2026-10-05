import type { StockTransfer, TransferStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

export class TransferService {
  constructor(private readonly store: Store) {}

  create(tenantId: string, stockId: string, sourceLocation: string, targetLocation: string, quantity: number): StockTransfer {
    const transfer: StockTransfer = { id: this.store.nextId('transfer'), tenantId, stockId, sourceLocation, targetLocation, quantity, status: 'CREATED', processedStages: [], version: 1 };
    this.store.transfers.set(transfer.id, transfer);
    return transfer;
  }

  applyStage(transferId: string, stage: TransferStatus): StockTransfer {
    const transfer = this.store.transfers.get(transferId);
    if (!transfer) throw new Error('transfer not found');
    const stock = this.store.stocks.get(transfer.stockId);
    if (!stock) throw new Error('stock not found');
    // BUG: every callback is treated as a new state transition; the stage history is recorded
    // only after the inventory mutation, so retries and late callbacks repeat stock effects.
    if (stage === 'PICKED') {
      stock.quantity -= transfer.quantity;
    } else if (stage === 'RECEIVED') {
      stock.quantity += transfer.quantity;
      stock.location = transfer.targetLocation;
    } else if (stage === 'CANCELLED') {
      stock.quantity += transfer.quantity;
      stock.location = transfer.sourceLocation;
    }
    transfer.status = stage;
    transfer.processedStages.push(stage);
    transfer.version += 1;
    this.store.addAudit(transfer.tenantId, `transfer.${stage.toLowerCase()}`, 'transfer', transfer.id, { stockId: transfer.stockId, quantity: transfer.quantity });
    this.store.addOutbox(transfer.tenantId, 'mro.transfer-updated', transfer.id, { transferId, stage });
    return transfer;
  }
}
