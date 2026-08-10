# Handoff — feat-688-kpi-review-time-anchor

**Current step:** 8 (ship, normal lane). RISK = normal, SURFACE = backend, no migration.

**Step 5-7 outcome (2026-08-10):** Gate GREEN twice (`--review`; sole WARN =
reclassify, adjudicated in deviations file — ADR doc lines counted as prod;
true prod ≈ 69 lines). Deviations: 9 entries, all ACCEPT; surface amendment #1
(tenant-scope allowlist re-pin) user-approved. Review round 1: spec HIGH →
confirmed pre-existing gap (`/api/dashboard/kpis` has zero consumers; visible
dashboard aggregates still detected_at) → resolved as GA-blocking follow-up
**issue #757** (extending this branch rejected: 2nd amendment fires abort
criteria; different module/cache). 3 LOWs: approval_method literal FIXED;
two timing risks adjudicated wontfix + documented in the suite header.
Round 2: VERIFIED all, both axes (appendices in
`docs/reviews/feat-688-kpi-review-time-anchor/*-round1.md`).

**Step 8 remaining:** push branch → PR to main (body records both HIGH-triage
positions + #757) → CI green → merge → pull main → realign staging →
`scripts/feature-cleanup.sh` → deviations promotion (lab-notes candidates:
seedLocation isPrimary uniqueness; postgres.js date-decode weekStart) →
`document-feature` sweep (note: stale `types.ts` "ISO date" comment; CLAUDE.md
"served by GET /api/dashboard/kpis" now misleading — see #757) → domain sweep
(CONTEXT.md already carries Review-time anchor) → entropy counter → close #688
with the decision comment; note map #667.

- Ticket: #688 (wayfinder decision ticket off map #667) — decision LOCKED at grilling 2026-08-10 (all four questions answered in-session, recommended options chosen: review-time anchor for reputation KPIs; response rate + digest stay detected_at; TTR excludes `approved_at < detected_at`; no discriminator migration; no card copy).
- Intake: `docs/superpowers/plans/feat-688-kpi-review-time-anchor-intake.json` (armed: `.feature/intake.json`)
- Plan: `docs/superpowers/plans/2026-08-10-feat-688-kpi-review-time-anchor.md` (4 tasks; Task 1 eval first + alone; Task 4 ∥ Tasks 2-3)
- Deviations: `docs/superpowers/plans/feat-688-kpi-review-time-anchor-deviations.md` (created on first deviation)
- Glossary: CONTEXT.md **Review import**, **Import window**; coining **Review-time anchor** (Task 4).
- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-688-kpi-review-time-anchor` (branch `feat-688-kpi-review-time-anchor`, forked from 8db5fe28)
- Ship lane: normal (PR → CI green → merge). Close #688 with the decision recorded; note it on map #667.
