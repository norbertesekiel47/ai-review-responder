import { describe, it } from 'vitest';

describe('ApprovalPanel', () => {
  // Retitled after round-1 plan review (finding 2): readiness means every ask
  // has a finished ATTEMPT, and a withheld attempt is finished.
  it.todo('shows the approve control only when every ask has an attempt');
  it.todo('excludes an ask when its control is cleared and approves the rest');
  it.todo('shows the stop control while the batch is in its veto window');
  it.todo('shows the expired state with no approve control');
  it.todo('shows a halted batch as read-only and states it cannot be resumed');
});
