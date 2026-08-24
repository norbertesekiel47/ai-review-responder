// The owner read route (#632 Task 6): a thin adapter — flag gate, owner auth,
// location scope, one module call (invariant #12).
//
// The flag is checked BEFORE auth so an unauthenticated probe cannot use the
// route's response shape to learn whether `SOLICITATION_SEND_ENABLED` is on,
// and the send state is PASSED to the read model rather than read inside it
// (flags stay server-authoritative, invariant #13).
//
// Task 0 authors the promised title parked; Task 6 lands the body.

import { describe, it } from 'vitest';

describe('GET attributed', () => {
  it.todo('GET attributed: gates on the flag before auth and passes account, location scope and send state to the read model');
});
