import { describe, it } from 'vitest';

describe('POST /api/operator/turns', () => {
  it.todo('POST turns inserts the conversation, the accepted turn, and the outbox row in one transaction and returns the ids');
  it.todo('POST turns returns the existing ids for a repeated clientTurnKey with the same payload and 409 for a different payload');
  it.todo('POST turns rejects a missing or mismatched Origin before any write');
  it.todo('POST turns returns 404 operator_disabled before any write when OWNER_OPERATOR_ENABLED is off');
  it.todo('POST turns rejects a location that is archived or belongs to another account and a conversation owned by another account');
});
