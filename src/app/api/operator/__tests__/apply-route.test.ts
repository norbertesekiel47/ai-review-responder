// Orchestration seams for POST /api/operator/proposals/:id/apply. T2 converts
// these against a mocked `applyProposal`, exactly as turns-route.test.ts mocks
// `createTurn` — the module's own behaviour is T1's subject, not the route's.
import { describe, it } from 'vitest';

describe('POST /api/operator/proposals/[id]/apply', () => {
  it.todo('POST apply returns 404 operator_disabled before auth when the flag is off');
  it.todo('POST apply rejects a missing or mismatched Origin before any read');
  it.todo('POST apply rejects an impersonated session with 409 impersonation_not_allowed');
  it.todo('POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409');
});
