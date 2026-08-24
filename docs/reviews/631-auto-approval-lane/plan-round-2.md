
F1: **RESOLVED** — the CAS now returns quiet `owner_won`, and the integration test preserves the raced owner approval at [plan:350](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:350) and [plan:384](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:384).

F2: **RESOLVED** — the finale now takes the account lock after the batch lock and before condition evaluation/CAS, serializing against settings and Governor writers at [plan:368](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:368).

F3: **UNRESOLVED** — the quick release re-check still runs outside the authoritative transaction at [plan:501](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:501), while the locked re-read at [plan:505](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:505) occurs only when that quick read fails; if it passes, a policy deletion or suspension can still commit before `releaseOutreachRow` queues a recipient.

F4: **RESOLVED** — the detailed mapper now checks only auto flag, tier, policy presence, and suspension; subscription remains the B14 hold and master flag remains the B15 phase stop at [plan:499](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:499).

F5: **RESOLVED** — one reason-parameterized `applyDowngradeSplit` now serves Judge and auto paths, with the supplied reason written to spine/Sentry at [plan:491](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:491).

F6: **RESOLVED** — Task 3 uses real `autopilot`/`copilot` values and requires at least one approving generated case, eliminating the vacuous always-decline property at [plan:294](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:294).

F7: **RESOLVED** — Task 8 now extends the existing strict discriminated `operation` union rather than introducing an incompatible optional slice at [plan:525](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:525).

F8: **RESOLVED** — the settings upsert now spells `ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL` literally and includes an idempotent double-enable title at [plan:531](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:531) and [intake:138](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:138).

F9: **RESOLVED** — Task 8 now mandates `uuidv7()` for policy IDs and no longer proposes `randomUUID()` at [plan:534](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:534).

F10: **RESOLVED** — Task 5 specifies tokenless `${appUrl}/dashboard/requests`, explicitly excludes `createApprovalLink`, and includes a matching eval title at [plan:402](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:402).

F11: **RESOLVED** — systemic-failure logging is required on both dispatch zero-sent and Worker zero-enrolled paths, with separate tests at [plan:185](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:185) and [plan:409](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:409).

F12: **RESOLVED** — intake rev 2 authorizes `worker/ingress/resend.ts` and its tests, while Task 5 adds `solicitation_veto_notice` to `OWNER_DIRECTED_TEMPLATES` with hard-bounce coverage at [intake:81](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:81) and [plan:397](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:397).

F13: **RESOLVED** — the CAS runs through `sp`, the `23505` escapes the callback and is caught outside, only the named one-active constraint maps to `slot_held`, and other violations rethrow at [plan:326](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:326).

F14: **UNRESOLVED** — finale and anchor locks are correctly transactional at [plan:324](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:324) and [plan:445](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:445), but the release-side hazard remains because F3’s passing quick-read path is still outside the release transaction.

A1: **RESOLVED** — the owner re-lock is implemented as SQL `MIN(notification_deliveries.sent_at)` with `sent_at IS NOT NULL`, and anchor tests seed `sent_at` directly at [plan:451](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:451) and [plan:477](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:477).

A2: **RESOLVED** — the ambiguity is now owner-locked: queued notices gate only on batch state, perform no flag reads, and continue dispatching while the master flag is off at [plan:407](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:407) and [intake:48](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:48).

### Appendix (untriaged)

- **NEW, fix-introduced:** Task 5 now owns four dispatch titles, two Worker titles, and one resend title—seven total—but its execution step says “tests green (6 titles)” at [plan:414](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:414).

VERDICT: REVISE — F3/F14 remain unresolved because a passing release re-check is still outside the authoritative transaction, leaving the original policy-deletion/suspension race open.


