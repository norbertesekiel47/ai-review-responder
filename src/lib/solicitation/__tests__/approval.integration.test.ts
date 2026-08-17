import { describe, it } from 'vitest';

describe('approveBatch', () => {
  it.todo('approves a built batch with owner method and a 15-minute veto deadline');
  it.todo('a second approval writes nothing and reports the batch as already approved');
  it.todo('cancels excluded asks owner_excluded in the same transaction as the approval');
  it.todo('refuses to approve while a send ask has no outreach row');
  it.todo('refuses to approve a batch past its 7-day approval window');
  it.todo('excluding every ask closes the batch and terminalizes the send parent completed');
  it.todo('records the approval as a step on the send batch parent');
  // Added after round-1 plan review (findings 1, 2, 3).
  it.todo('refuses a stale exclusion list without cancelling any row or approving the batch');
  it.todo('approves the rendered subset when another send ask is withheld');
  it.todo('treats a superseded attempt as ready only once its replacement exists');
});

describe('haltBatch', () => {
  it.todo('halt latches once and a second halt writes nothing');
  it.todo('halt cancels rendered and queued rows and never a sending row');
  it.todo('halt before sending starts records owner_veto and after it records owner_halt');
  it.todo('refuses to halt a batch that is already closed');
  it.todo('halts a built batch that was never approved');
});

describe('tenant scope', () => {
  it.todo('refuses to approve or halt a batch owned by another account');
});
