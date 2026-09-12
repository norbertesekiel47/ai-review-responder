// Orchestration seams for POST /api/operator/proposals/:id/decline. Same shim
// as the apply route's suite; `declineProposal` is mocked.
import { describe, it } from 'vitest';

describe('POST /api/operator/proposals/[id]/decline', () => {
  it.todo('POST decline returns 404 operator_disabled before auth when the flag is off and rejects a mismatched Origin');
  it.todo("POST decline returns 200 with the rejected proposal and 404 for another account's proposal");
});
