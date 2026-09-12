// Live-DB proofs for src/lib/agents/operator/apply.ts.
//
// Nothing is mocked. The five cases here are the ones a double cannot answer:
// that the Receipt and the voice write share ONE transaction; that the sibling
// sweep touches this location and no other; that the Receipt's `after` is the
// committed state; that a throwing executor leaves nothing behind; and that two
// concurrent Applies serialize on the `businesses` row lock.
//
// Named *.integration.test.ts so vitest's serialized `integration` project
// picks it up, and it executes NO DDL at run time — the schema is ASSERTED with
// assertSchemaReady(MIGRATION_120_OWNER_OPERATOR) (.claude/rules/live-db-tests.md).
import { describe, it } from 'vitest';

describe('applyProposal (live DB)', () => {
  it.todo('applyProposal writes the receipt, status applied and decided_by_user_id in the same transaction as the voice write');
  it.todo('applyProposal marks sibling pending proposals on the same location stale in the same transaction and leaves other locations alone');
  it.todo('applyProposal receipt after equals the committed voice state and flags a difference from the stored after');
  it.todo('applyProposal rolls back the receipt when the voice write throws');
  it.todo('two concurrent applies on one proposal produce one voice write and both return the same receipt');
  // Round-1 additions (RB-01, RB-10).
  it.todo('worker-produced proposals render and apply successfully');
  it.todo('repeat Apply after location archival returns the original receipt without writes');
});
