// Registration and logging contract for `SolicitationAttributionWorker`
// (#632 Task 5).
//
// The topic must map to a queue AND a registered handler — an unregistered
// topic leaves its outbox rows dispatching forever. The log line carries
// `resolution` from the closed set attributed | no_candidates | no_match |
// ambiguous, plus `reviewId`, `businessId` and `candidateCount`, and never the
// reviewer name or the review text.
//
// Task 0 authors both promised titles parked; Task 5 lands the bodies.

import { describe, it } from 'vitest';

describe('worker registration', () => {
  it.todo('worker registration: solicitation_attribution maps to a queue and a registered handler');
});

describe('SolicitationAttributionWorker', () => {
  it.todo('SolicitationAttributionWorker: logs every resolution without reviewer name or review text');
});
