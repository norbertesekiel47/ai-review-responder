// Unit seams for src/lib/agents/operator/turns.ts. The live proofs for
// createTurn's transaction and for the claim/fence protocol are T7's
// turn-worker.integration.test.ts; this file holds the mocked-sql assertions
// that T4 and T5 fill in.
import { describe, it } from 'vitest';

describe('operator turns', () => {
  it.todo('createTurn assigns the next sequence under the conversation row lock');
});
