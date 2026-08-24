# Feature inventory — Pathfinder 2026-08-24

**Windowed.** This is not a repo inventory. It covers only what the entropy
window `42a247b1..0278366c` changed: 13 first-parent merges, 11 counting, 75
production files.

The repo-wide inventory lives in the prior passes; do not rebuild it here.

## The window at a glance

| Theme | Merges | Prod files | Share |
|---|---|---|---|
| A — Auto-approval lane for Solicitation | 1 | 48 | 64% |
| B — Admin surface consolidation | 4 | 19 | 25% |
| C — Send-lane vocabulary and predicates | 4 | 30 | (overlaps A) |
| D — Small (migration 112, pull-forwards) | 2 | 8 | 11% |

Theme C overlaps Theme A's file set in `src/lib/solicitation/`; the counts are
per-merge and do not sum cleanly. The honest headline is simpler: **one merge is
64% of this window**, and it is the newest code in the repo.

## Distribution by area

```
13  src/lib/solicitation      <- Theme A + C
 9  src/lib/notifications     <- Theme A (the 4th notice-family member)
 6  worker/jobs
 6  src/lib/shared            <- Theme C (#913 error vocabulary)
 6  src/app/api
 6  src/app/admin             <- Theme B
 5  src/lib/auto-approval     <- Theme A
 5  src/app/(authenticated)
 4  src/lib/admin             <- Theme B
 2  supabase/                 <- migrations 112, 113
 2  src/lib/payments
 1  each: worker/{queues,ingress,index,background}, src/lib/{reviews,db,
       config,auth,agents,account-offboarding}, src/hooks/useAdminActionForm.ts
```

---

## F1 — Auto-approval lane for Solicitation

- **Purpose**: let an Autopilot account's solicitation batch reach an approved,
  sent state without an owner touching it, behind flags and a veto window.
- **Merge**: `0278366c` PR #950 / issue #631, 2026-08-24 10:40 PDT
- **Owns**: `solicitation_batches` auto-approval columns, the
  `solicitation_veto_notice` outbox topic and notification template, migration
  113's two dedup indexes
- **Core areas**: `src/lib/solicitation/`, `src/lib/auto-approval/`,
  `worker/jobs/solicitation-veto-notice/`,
  `worker/background/pollers/SolicitationReleasePoller.ts`
- **Calls into**: F3 (send-lane vocabulary), the notification channel stack,
  the run spine
- **Size**: 48 production files
- **Flowchart**: `01-flowcharts/F1-auto-approval-solicitation.md`

The dominant feature of this window. It is gate-heavy, and the ORDER of its
gates is the architecture. It also adds the fourth member of the notice-family
clone, which is why X1 exists.

## F2 — Admin action surface, after four consolidations

- **Purpose**: one owner each for the four things every mutating admin action
  does — submit reducing, lane writing, gate/parse/400 preamble, read fan-out.
- **Merges**: `757bf639` #880, `2a9ede74` #886, `1e407fee` #909, `efd2145d` #893
  — all 2026-08-23, within 15 minutes of one another
- **Owns**: `src/hooks/useAdminActionForm.ts`, the admin route preamble,
  `lane-writes.ts`, the `ci:pool-fanout` rule
- **Calls into**: the admin read model, `writeAccountAuditLog`, the MFA/AAL2 gate
- **Size**: 19 production files
- **Flowchart**: `01-flowcharts/F2-admin-action-surface.md`

Four consolidations of one surface in one sitting is itself the finding to
investigate. The question is whether they converged on one shape or four.

## F3 — Send-lane vocabulary and predicates

- **Purpose**: give names to the send lane's status subsets and outcome
  vocabulary so call sites stop re-spelling them.
- **Merges**: `3d45dfab` #891 (`batchDidClose`), `e2ee6895` #890 (three named
  owners for delivery-status subsets), `626ff0ec` #913 (provider-agnostic error
  vocabulary relocated to `shared`), `22fe659b` #914 (Send handoff withholds a
  location with no canonical place id)
- **Owns**: the delivery-status subset predicates, the shared error vocabulary
- **Calls into**: F1 consumes this vocabulary
- **Size**: 30 production files across four merges

Three of these four merges are the direct execution of 2026-08-18 handoffs
(#890, #891) and a 08-22 finding (#913). This is the prior pass's backlog
landing — which is the system working.

## F4 — Migration 112: the Breaker window read model

- **Purpose**: make `readBreakerWindow` index-servable instead of a growing
  sequential scan.
- **Merge**: `7d174812` PR #941 / issue #908
- **Size**: 2 production files
- **Note**: migration 112's own header corrects a WRONG comment shipped in
  migration 110 ("deliberately unindexed … a bitmap scan is cheaper than two
  more indexes"). One index cannot serve an OR of three predicates. Measured
  8.5x improvement at 1M rows. This is a good instance of a migration carrying
  its own correction record; it needs no follow-up.

---

## Deliberately out of scope

- `b6f41dcf` #948 — `/feature` skill run-progress ladder. Governance-only, zero
  production files. Leaves a `ci:merge-ledger` row, correctly.
- `6b7afa92` #942 — `seedContactCsvUpload`. Test-only.
- Everything the window did not touch. Four prior passes cover the rest of the
  repo; re-deriving it here would produce volume, not insight.
