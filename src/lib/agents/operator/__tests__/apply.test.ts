// Unit seams for src/lib/agents/operator/apply.ts, against the recording
// mock-sql double (worker/__tests__/helpers/mock-sql.ts). These prove
// ORDERING, BRANCHING and WHAT IS BOUND — the things a mock can prove.
//
// Deliberately NOT here: the rollback, the row lock, the sibling sweep and the
// read-back, which are live-DB properties and live in
// apply.integration.test.ts. A mock that "proves" a rollback proves only that
// the double was told to say so.
import { describe, it } from 'vitest';

describe('applyProposal', () => {
  it.todo("applyProposal locks the businesses row before the proposal row and writes only the operation's own fields through updateVoiceConfig");
  it.todo('applyProposal on an applied proposal returns the stored receipt and executes nothing');
  it.todo('applyProposal marks the proposal stale without mutation when the current token differs from the prepared token');
  it.todo("applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token");
  it.todo("applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock");
  it.todo('applyProposal returns proposal_not_found for a proposal of another account');
  it.todo('applyProposal answers proposal_not_pending for a stale, rejected, superseded or failed proposal');
  it.todo('applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner');
  it.todo('applyProposal rejects the proposal location_not_found when the location was archived after preparation');
});

describe('applyProposal invariants', () => {
  it.todo('invariants: from any non-pending status applyProposal never writes businesses');
});
