import { MroApplication } from './app.js';
import type { PartStock } from './domain/types.js';

function makeStock(app: MroApplication, id: string, quantity: number, location: string): PartStock {
  const stock: PartStock = {
    id, tenantId: 'tenant_demo', partNumber: 'PUMP-9000', kind: 'LOT', lotNumber: 'LOT-1',
    quantity, reserved: 0, qualityStatus: 'RELEASED', certificateVersion: 1, certificateStatus: 'APPROVED',
    certificateExpiresOn: '2027-12-31', certificateTimeZone: 'Asia/Shanghai', location, version: 1,
  };
  app.store.stocks.set(id, stock);
  return stock;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`ok - ${message}`);
}

async function expectThrow(work: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await work();
  } catch {
    console.log(`ok - ${message}`);
    return;
  }
  throw new Error(`ASSERTION FAILED (expected throw): ${message}`);
}

const app = new MroApplication();

// 1. Happy path: PICKED -> IN_TRANSIT -> RECEIVED -> STORED, each with a duplicate redelivery.
{
  const stock = makeStock(app, 'stock_t1', 10, 'SHA');
  const transfer = app.transfers.create('tenant_demo', stock.id, 'SHA', 'FRA', 4);
  const outboxBefore = app.store.outbox.length;
  const auditBefore = app.store.audit.length;

  await app.transfers.applyStage(transfer.id, 'PICKED');
  assert(stock.quantity === 6, 'PICKED deducts source stock once');
  const again = await app.transfers.applyStage(transfer.id, 'PICKED');
  assert(stock.quantity === 6 && again.status === 'PICKED' && again.version === 2, 'duplicate PICKED is a stable no-op');

  await app.transfers.applyStage(transfer.id, 'IN_TRANSIT');
  await app.transfers.applyStage(transfer.id, 'IN_TRANSIT');
  assert(stock.quantity === 6, 'IN_TRANSIT has no inventory effect, duplicate included');

  await app.transfers.applyStage(transfer.id, 'RECEIVED');
  await app.transfers.applyStage(transfer.id, 'RECEIVED');
  assert(stock.quantity === 10 && stock.location === 'FRA', 'RECEIVED adds stock at target once');

  await app.transfers.applyStage(transfer.id, 'STORED');
  await app.transfers.applyStage(transfer.id, 'STORED');
  assert(stock.quantity === 10 && transfer.processedStages.length === 4, 'STORED confirms putaway once');

  const transitionEffects = app.store.outbox.length - outboxBefore;
  const auditEffects = app.store.audit.length - auditBefore;
  assert(transitionEffects === 4 && auditEffects === 4, 'exactly one audit+outbox record per applied stage');
}

// 2. Out-of-order callbacks cannot skip prerequisite states.
{
  const stock = makeStock(app, 'stock_t2', 5, 'SHA');
  const transfer = app.transfers.create('tenant_demo', stock.id, 'SHA', 'SIN', 2);
  await expectThrow(() => app.transfers.applyStage(transfer.id, 'RECEIVED'), 'RECEIVED before PICKED is rejected');
  await expectThrow(() => app.transfers.applyStage(transfer.id, 'IN_TRANSIT'), 'IN_TRANSIT before PICKED is rejected');
  await app.transfers.applyStage(transfer.id, 'PICKED');
  await expectThrow(() => app.transfers.applyStage(transfer.id, 'RECEIVED'), 'RECEIVED before IN_TRANSIT is rejected');
  await expectThrow(() => app.transfers.applyStage(transfer.id, 'STORED'), 'STORED before RECEIVED is rejected');
  assert(stock.quantity === 3 && stock.location === 'SHA', 'rejected callbacks leave stock untouched');
  assert(transfer.status === 'PICKED' && transfer.processedStages.length === 1, 'rejected callbacks leave transfer state untouched');
}

// 3. Cancel after pick: stock returned to source exactly once.
{
  const stock = makeStock(app, 'stock_t3', 8, 'SHA');
  const transfer = app.transfers.create('tenant_demo', stock.id, 'SHA', 'FRA', 3);
  await app.transfers.applyStage(transfer.id, 'PICKED');
  await app.transfers.applyStage(transfer.id, 'IN_TRANSIT');
  await app.transfers.applyStage(transfer.id, 'CANCELLED');
  assert(stock.quantity === 8 && stock.location === 'SHA', 'cancel after pick returns stock to source');
  const again = await app.transfers.applyStage(transfer.id, 'CANCELLED');
  assert(stock.quantity === 8 && again.status === 'CANCELLED', 'duplicate cancel does not compensate twice');
  await expectThrow(() => app.transfers.applyStage(transfer.id, 'RECEIVED'), 'no transition out of CANCELLED');
}

// 4. Cancel before pick: pure status change, no phantom stock.
{
  const stock = makeStock(app, 'stock_t4', 7, 'FRA');
  const transfer = app.transfers.create('tenant_demo', stock.id, 'FRA', 'SHA', 2);
  await app.transfers.applyStage(transfer.id, 'CANCELLED');
  await app.transfers.applyStage(transfer.id, 'CANCELLED');
  assert(stock.quantity === 7 && stock.location === 'FRA', 'cancel before pick has no inventory effect');
}

// 5. Cancel after receipt: compensation reverses the receipt exactly once.
{
  const stock = makeStock(app, 'stock_t5', 9, 'SHA');
  const transfer = app.transfers.create('tenant_demo', stock.id, 'SHA', 'SIN', 4);
  await app.transfers.applyStage(transfer.id, 'PICKED');
  await app.transfers.applyStage(transfer.id, 'IN_TRANSIT');
  await app.transfers.applyStage(transfer.id, 'RECEIVED');
  await app.transfers.applyStage(transfer.id, 'CANCELLED');
  assert(stock.quantity === 9 && stock.location === 'SHA', 'cancel after receipt reverses target increment');
  await app.transfers.applyStage(transfer.id, 'CANCELLED');
  assert(stock.quantity === 9, 'repeated cancel after receipt stays consistent');
}

// 6. Concurrent duplicate callbacks settle into a single effect.
{
  const stock = makeStock(app, 'stock_t6', 6, 'SHA');
  const transfer = app.transfers.create('tenant_demo', stock.id, 'SHA', 'FRA', 5);
  await Promise.all([
    app.transfers.applyStage(transfer.id, 'PICKED'),
    app.transfers.applyStage(transfer.id, 'PICKED'),
    app.transfers.applyStage(transfer.id, 'PICKED'),
  ]);
  assert(stock.quantity === 1 && transfer.version === 2, 'concurrent duplicate PICKED applies once');
}

console.log('all transfer scenarios passed');
