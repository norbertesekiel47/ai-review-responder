// @vitest-environment jsdom
// The conversation state machine, against a mocked fetch and vitest's fake
// timers. Four titles, four behaviours the owner actually experiences: the
// post-and-poll round trip with URL resumption, the back-off and timeout, the
// per-reason failure wording plus the disabled stop, and the All-locations gate.
import { describe, it } from 'vitest';

describe('OperatorClient', () => {
  it.todo('operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload');
  it.todo('operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes');
  it.todo('operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled');
  it.todo('operator screen disables the composer under All locations and enables it once a location is chosen');
  // Round-1 additions (RB-02, RB-05, RB-06, RB-07, RB-08).
  it.todo('operator times out while a poll request remains unresolved');
  it.todo('retry after a lost POST response resumes the original turn');
  it.todo('operator renders every stored segment kind in order');
  it.todo('terminal failures and requested capabilities survive reload and subsequent turns');
  it.todo('loaded conversations retain identity and starting over stays empty');
  // Round-3 addition (RB3-01).
  it.todo('a delayed conversation response never replaces a newly submitted turn');
  // Round-1 addition RB-03, converted by T4 (it wires Refresh plan).
  it.todo('Refresh plan preserves the original instruction and location after scope changes');
});
