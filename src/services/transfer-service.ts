import type { StockTransfer, TransferStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

// Forward path: CREATED -> PICKED -> IN_TRANSIT -> RECEIVED -> PUTAWAY.
// A transfer may be cancelled any time before the target warehouse receives the
// goods; the compensation callback then returns any picked stock to the source.
const transitions: Record<TransferStatus, TransferStatus[]> = {
  CREATED: ['PICKED', 'CANCELLED'],
  PICKED: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['PUTAWAY'],
  PUTAWAY: [],
  CANCELLED: ['COMPENSATED'],
  COMPENSATED: [],
};

export class TransferService {
  constructor(private readonly store: Store) {}

  create(tenantId: string, stockId: string, sourceLocation: string, targetLocation: string, quantity: number): StockTransfer {
    const transfer: StockTransfer = { id: this.store.nextId('transfer'), tenantId, stockId, sourceLocation, targetLocation, quantity, status: 'CREATED', processedStages: [], version: 1 };
    this.store.transfers.set(transfer.id, transfer);
    return transfer;
  }

  async applyStage(transferId: string, stage: TransferStatus): Promise<StockTransfer> {
    return this.store.lock.runExclusive(() => {
      const transfer = this.store.transfers.get(transferId);
      if (!transfer) throw new Error('transfer not found');
      // Idempotent replay: a stage that was already applied must not repeat its
      // inventory effect; return the current state so retries see a stable result.
      if (transfer.processedStages.includes(stage)) return transfer;
      // Out-of-order or late callbacks must not skip prerequisite states: reject
      // the transition without touching stock; the warehouse will redeliver it
      // once the missing stages have been applied.
      if (!transitions[transfer.status].includes(stage)) {
        this.store.addAudit(transfer.tenantId, 'transfer.invalid-stage', 'transfer', transfer.id, { stage, current: transfer.status });
        return transfer;
      }
      const stock = this.store.stocks.get(transfer.stockId);
      if (!stock) throw new Error('stock not found');
      // Inventory effects are attached to the state transition itself, so each
      // stage produces its effect exactly once and stock stays consistent with
      // the transfer status.
      if (stage === 'PICKED') {
        if (stock.quantity < transfer.quantity) throw new Error('insufficient stock to pick');
        stock.quantity -= transfer.quantity;
        stock.version += 1;
      } else if (stage === 'RECEIVED') {
        stock.quantity += transfer.quantity;
        stock.location = transfer.targetLocation;
        stock.version += 1;
      } else if (stage === 'COMPENSATED' && transfer.processedStages.includes('PICKED')) {
        // The stock was deducted at pick time but never received at the target:
        // return it to the source exactly once.
        stock.quantity += transfer.quantity;
        stock.location = transfer.sourceLocation;
        stock.version += 1;
      }
      transfer.status = stage;
      transfer.processedStages.push(stage);
      transfer.version += 1;
      this.store.addAudit(transfer.tenantId, `transfer.${stage.toLowerCase()}`, 'transfer', transfer.id, { stockId: transfer.stockId, quantity: transfer.quantity });
      this.store.addOutbox(transfer.tenantId, 'mro.transfer-updated', transfer.id, { transferId, stage });
      return transfer;
    });
  }
}
