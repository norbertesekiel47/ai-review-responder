// Composition root for the Solicitation send worker (#899 Task 0 — the eval task).
//
// `worker/jobs/solicitation-send.ts` is a SHIM, and this suite exists to keep it
// one. Invariant #12: entry points orchestrate, modules own failure behaviour.
// The whole handler is: extract the outbox handle from the BullMQ payload, hand
// the singleton `sql` down (invariant #15 — this file is a composition root, so
// it is one of the few places allowed to import it), call `dispatchOutreach`,
// return. No gate logic, no adapter call, no transaction, no retry decision.
//
// None of the plan's thirty-four promised titles belongs here: every one of them
// is a claim about the domain module, and asserting it through the root would
// test `dispatch.ts` twice while leaving the root's own thinness unpinned.
//
// Task 1 converts the todo below once the root exists.

import { describe, it } from 'vitest';

describe('SolicitationSendWorker', () => {
  // Assert the shape, not the behaviour: `dispatchOutreach` is mocked, the
  // handler is invoked with one payload, and the assertions are that it was
  // called exactly once with the payload's ids plus the extracted outbox
  // handle — and that no other collaborator (the Messaging adapter, the run
  // spine, the outbox writer) was touched by the root itself.
  it.todo('delegates to dispatchOutreach and touches nothing else');
});
