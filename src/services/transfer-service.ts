import type { PartStock, StockTransfer, TransferStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

// Legal transitions of the transfer lifecycle. Anything not listed here is an
// out-of-order or regressive callback and must be rejected instead of skipping
// prerequisite states.
const TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  CREATED: ['PICKED', 'CANCELLED'],
  PICKED: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['STORED', 'CANCELLED'],
  STORED: [],
  CANCELLED: [],
};

export class TransferService {
  constructor(private readonly store: Store) {}

  create(tenantId: string, stockId: string, sourceLocation: string, targetLocation: string, quantity: number): StockTransfer {
    if (quantity <= 0) throw new Error('transfer quantity must be positive');
    if (sourceLocation === targetLocation) throw new Error('source and target location must differ');
    const stock = this.store.stocks.get(stockId);
    if (!stock || stock.tenantId !== tenantId) throw new Error('stock not found');
    if (stock.location !== sourceLocation) throw new Error('stock is not at the source location');
    if (stock.quantity - stock.reserved < quantity) throw new Error('insufficient available stock');
    const transfer: StockTransfer = { id: this.store.nextId('transfer'), tenantId, stockId, sourceLocation, targetLocation, quantity, status: 'CREATED', processedStages: [], version: 1 };
    this.store.transfers.set(transfer.id, transfer);
    this.store.addAudit(tenantId, 'transfer.created', 'transfer', transfer.id, { stockId, sourceLocation, targetLocation, quantity });
    this.store.addOutbox(tenantId, 'mro.transfer-updated', transfer.id, { transferId: transfer.id, stage: 'CREATED' });
    return transfer;
  }

  async applyStage(transferId: string, stage: TransferStatus): Promise<StockTransfer> {
    return this.store.lock.runExclusive(() => {
      const transfer = this.store.transfers.get(transferId);
      if (!transfer) throw new Error('transfer not found');
      // Duplicate or late redelivery of an already-applied stage: return the
      // stable current state without repeating inventory, audit or outbox effects.
      if (transfer.processedStages.includes(stage)) return transfer;
      if (!TRANSITIONS[transfer.status].includes(stage)) {
        throw new Error(`invalid transfer transition from ${transfer.status} to ${stage}`);
      }
      const stock = this.store.stocks.get(transfer.stockId);
      if (!stock) throw new Error('stock not found');
      this.applyInventoryEffect(transfer, stock, stage);
      transfer.status = stage;
      transfer.processedStages.push(stage);
      transfer.version += 1;
      this.store.addAudit(transfer.tenantId, `transfer.${stage.toLowerCase()}`, 'transfer', transfer.id, { stockId: transfer.stockId, quantity: transfer.quantity });
      this.store.addOutbox(transfer.tenantId, 'mro.transfer-updated', transfer.id, { transferId, stage });
      return transfer;
    });
  }

  private applyInventoryEffect(transfer: StockTransfer, stock: PartStock, stage: TransferStatus): void {
    switch (stage) {
      case 'PICKED': {
        if (stock.location !== transfer.sourceLocation) throw new Error('stock is not at the transfer source location');
        if (stock.quantity - stock.reserved < transfer.quantity) throw new Error('insufficient available stock to pick');
        stock.quantity -= transfer.quantity;
        stock.version += 1;
        break;
      }
      case 'RECEIVED': {
        stock.quantity += transfer.quantity;
        stock.location = transfer.targetLocation;
        stock.version += 1;
        break;
      }
      case 'CANCELLED': {
        // Compensation reverses exactly the net effect committed so far, so a
        // cancel callback can never add or subtract stock twice.
        const picked = transfer.processedStages.includes('PICKED');
        const received = transfer.processedStages.includes('RECEIVED');
        if (received) {
          // Pick (-qty) and receipt (+qty) already offset each other; only the
          // location change remains to be rolled back.
          stock.location = transfer.sourceLocation;
          stock.version += 1;
        } else if (picked) {
          stock.quantity += transfer.quantity;
          stock.location = transfer.sourceLocation;
          stock.version += 1;
        }
        // Cancelled before picking: nothing was deducted, nothing to return.
        break;
      }
      default:
        // IN_TRANSIT and STORED are status-only stages with no inventory effect.
        break;
    }
  }
}
