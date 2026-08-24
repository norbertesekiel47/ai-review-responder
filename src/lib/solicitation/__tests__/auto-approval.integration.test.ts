// Live-DB half of the Auto-approval lane (#631 Task 1 — the eval task,
// docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md). The
// `.integration.test.ts` name is load-bearing on its own — it is what selects
// vitest's serialized `integration` project (`ci:live-db-suites` R1) — so this
// file claims that slot from its first commit even though it executes no DDL
// and imports no DB helper yet. Scaffolds the twelve promised titles for
// `autoApproveBatch` (the auto-approval verb, its spine step, the veto-notice
// outbox enqueue, and its 23505/owner-race edge cases) and
// `anchorVetoDeadlines` (the D9 Veto anchor CAS), verbatim from intake rev 2.
// Bodies land in Tasks 3-8, which is also where the real bootstrap (schema
// assertion, tenant seed, live-DB lock) is added.
//
// The four generation-finale titles below were originally scaffolded in
// ask-generation.integration.test.ts per the plan, but that file is one of
// the #656 promised-test files postal-address.test.ts's integrity meta-test
// asserts is FREE of `it.todo`/`it.skip` — so they moved here instead (see
// docs/superpowers/plans/631-auto-approval-lane-deviations.md, dated entry).
// Task 4 authors their bodies against `generateAsksForBatch` by import, which
// is unaffected by which file drives it.

import { describe, it } from 'vitest';

describe('autoApproveBatch', () => {
  it.todo(
    'auto-approves a built batch as auto_policy when all four conditions hold and records the spine step',
  );

  it.todo('enqueues the veto notice through job_outbox in the same transaction as the auto approval');

  it.todo('falls back to owner review when the one-active-send-batch index rejects the auto approval');

  it.todo(
    'preserves an owner approval committed after the final render but before the generation finale',
  );

  it.todo(
    'autoApproveBatch rethrows a 23505 from every constraint except solicitation_batches_one_active_send_per_business',
  );

  it.todo('the database-backed gate approves a trialing autopilot account');

  it.todo('turning the auto flag on does not retroactively approve a previously built batch');
});

describe('anchorVetoDeadlines', () => {
  it.todo('anchors veto_deadline_at from the first sent notice exactly once via CAS');

  it.todo('never anchors a halted batch even when a notice send lands later');

  it.todo('records the granted window from the policy row at approval and ignores later policy edits');

  it.todo('one corrupt anchor candidate does not prevent a healthy sibling batch from anchoring');

  it.todo('a wrong-template or different-batch delivery row never anchors');
});

// Relocated from ask-generation.integration.test.ts — see file header.
describe('auto-approval at the generation finale (#631)', () => {
  it.todo(
    'the initial ask-generation finale auto-approves and enqueues the Veto notice when every gate holds',
  );

  it.todo('regenerateAsk never invokes the auto-approval lane');

  it.todo(
    'the real generation finale leaves the batch built when SOLICITATION_SEND_ENABLED is off',
  );

  it.todo('Judge unavailability at approval time does not block auto approval');
});
