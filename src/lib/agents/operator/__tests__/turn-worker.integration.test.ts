// Live-DB proofs for the AgentTurnWorker claim/fence protocol (T7). Seeds
// through seedTenantAccount / seedLocation, gates on describeWithDb, locks with
// acquireLiveDbLock, and asserts the schema with assertSchemaReady. runLlmTask,
// the cost guard and the api_costs audit are mocked (plan decision V2); the
// database is real.
import { describe, it } from 'vitest';

describe('AgentTurnWorker (live DB)', () => {
  it.todo('worker claim race: two dispatches of one turn produce one completed turn and one proposal set');
  it.todo('worker fenced completion discards an attempt whose lease was lost');
  it.todo('worker predecessor wait releases the claim and delays the job without spending retry budget');
  it.todo('worker fails the turn predecessor_stalled after the stall limit');
  it.todo('worker step 3 fails the turn unauthorized for a revoked owner and builds no snapshot');
  it.todo('worker step 3 fails the turn account_offboarding for an offboarding account and builds no snapshot');
  it.todo('worker retries the model call once on invalid output and fails the turn model_output_invalid on the second failure');
  it.todo('worker supersedes earlier pending proposals with the same operation and scope');
});
