// Dispatch half of the veto-notice family (#631 Task 1 — the eval task,
// docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md). Mirrors
// worker/jobs/pending-post-notice/'s dispatch/context/Worker split and the
// notification_deliveries claim discipline. Scaffolds the four promised
// titles for `solicitation veto notice dispatch`, verbatim from intake rev 2.
// Bodies land in Tasks 3-8.

import { describe, it } from 'vitest';

describe('solicitation veto notice dispatch', () => {
  it.todo('dispatches the veto notice to enrolled channels and records notification_deliveries rows');

  it.todo('logs a systemic failure when zero veto-notice channels deliver');

  it.todo('an unset WhatsApp veto template skips only WhatsApp while other channels continue');

  it.todo('the veto-notice CTA links to /dashboard/requests and contains no approval token');
});
