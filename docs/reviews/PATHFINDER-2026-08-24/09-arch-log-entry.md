# Architecture-log entry — ✅ APPLIED 2026-08-24

> **STATUS: applied.** PR #951 was merged (`2026-08-24T18:28:56Z`), which took
> the counter 10 → 11. The reset and the pass row below were then written to
> `.claude/reference/arch-review-log.md` in this same PR. **The counter now
> reads 0.** This file is kept as the record of what was applied and why the
> sequencing mattered — it is not a pending action.

**Why this was staged rather than edited directly.** PR #951
(`docs(631): post-merge documentation sweep`) was **OPEN** during the pass and
its file list included `.claude/reference/arch-review-log.md`. It bumps the
counter 10 → 11 on the same lines this pass must reset to 0. Editing the log
while it was open would have produced a direct conflict, or silently dropped
#951's increment.

**Sequence executed:** merge #951 → apply the block below → commit the artifacts.

`ci:merge-ledger` requires a line in the log for a merge that changes the
production or governance surface. This pass's artifacts PR is docs-only under
`docs/reviews/`, so it needs the row below regardless of the counter reset.

---

## 1. Replace the counter paragraph

Replace the "Merges since last architecture pass" paragraph with:

```markdown
**Merges since last architecture pass: 0** — reset by the **2026-08-24 pass**
(entry below). Full artifacts: `docs/reviews/PATHFINDER-2026-08-24/`.
Prior passes: `PATHFINDER-2026-08-22/`, `-08-18/`, `-08-15/`, `-08-10/`.

> **The counter was CORRECT this time — the first pass in five for which that is
> true.** The 2026-08-24 pass measured the window independently
> (`42a247b1..0278366c`: 13 first-parent merges, 11 counting, 75 production
> files) and got the same answer this log already had. `ci:merge-ledger`
> (`2f386c52`, PR #935) landed inside that window and is the reason. The
> four-pass streak of hand-corrections — 2026-08-10, -08-15, -08-18, -08-22 —
> is closed, and the note recording it should not be re-derived next pass.
```

## 2. Append the pass row

```markdown
- **Architecture pass — 2026-08-24** (windowed: `42a247b1..0278366c`, 11
  counting merges, 75 production files). Artifacts:
  `docs/reviews/PATHFINDER-2026-08-24/`. Counter reset 11 → 0.

  **Window shape:** one merge is 64% of it — #950/#631, the Solicitation
  auto-approval lane (48 files, migration 113), landed hours before the pass.
  The rest is the admin consolidation wave (#880/#886/#893/#909, 19 files) and
  the send-lane vocabulary work (#890/#891/#913/#914).

  **Health baseline: 20/20 CI audits, typecheck and lint all green.** Migration
  lockstep verified by direct `pg_indexes` introspection in **both** projects —
  112 and 113 fully applied, no drift. The standing 078-absent exception was
  re-introspected in production and is **accurate, not stale**
  (`businesses.subscription_tier` nullable, neither check constraint present).

  **Headline finding — the notice-family clone, decided.** The family has **six**
  members, not the four the seed claimed. The decision taken is **bless the
  four-file shape, extract the invariants**: a shared `runNoticeJob` owner is
  explicitly REJECTED because every current member assumes a single
  `businessId`, and the next plausible member (Insights / Governor) needs
  account-scoped fan-in — extracting today would encode the wrong axis. Three
  latent bugs were found, all of the form "the fix landed in some copies":
  - **BUG 1** `auto-post-notice` enrolls in `OWNER_DIRECTED_TEMPLATES`
    (`resend.ts:97-99`) so a bounce **sets** `owner_email_bounced`, but it is the
    only member of six that never **reads** it (0 references vs 7–8 in the other
    five). Identified 2026-07-12 as "known follow-up #3a"; `grep -rn "#3a" docs/`
    returns one hit — the sentence itself. Six weeks live, untracked.
  - **BUG 2** `auto-post-notice` and `escalation-notice` lack the 15-minute
    stale-claim reap the other three have, **and** treat a claim conflict as a
    harmless dedup. One crash permanently dedup-blocks a channel while the outbox
    reports success — losing the Guardian persona's only owner-facing output.
  - **BUG 3** three members classify a Postgres failure with the provider
    classifier and can mark a delivered notice failed. The two newest members
    carry a written warning about it.

  **Second finding — the autonomy control surface is split.** There are now two
  independent kill-switch families; `AUTO_APPROVAL_ENABLED` has **zero** effect
  on the Solicitation lane. `env-vars.md:661` is correct per-flag and invariant
  #3 is **not** violated (that lane does not post to Google), and production has
  none of the flags set — **zero live hazard**. The gap is that the runbooks
  enumerating "the autonomy flags" predate this lane. Must close before #633.

  **Seed 3 REFUTED, and worth recording as a clean result:** the four admin
  consolidations compose cleanly. No file imports from more than one of the four
  seams; three stack in disjoint layers and the fourth is on a different surface.

  **Prior handoffs:** five of nine genuinely closed (#890, #893, #896, and both
  08-22 next-session PRs). #891 closed but incompletely adopted — **latent, not a
  live defect** (a first reading called it live; the correction and its reasoning
  are preserved in `07-handoff-reverification.md`). #892, #894, #895 untouched
  across two consecutive windows and re-verified live.

  **Five DO-NOT-UNIFY entries added**, including a boundary correction: the
  21-line offboarding SELECT appears in **18 files repo-wide**, so it must NOT be
  extracted into the notice family — if extracted it belongs at
  `src/lib/account-offboarding/gate.ts`.
```

## 3. Process note worth carrying (optional, `05-process-findings.md` §4)

A follow-up named only in spec prose is not tracked. `#3a` proves it: a real
defect, correctly identified, named with an identifier that exists nowhere else,
still live six weeks and two new family members later. Suggested rule: **a
follow-up named in a spec gets an issue number in the same PR, or it does not get
named.**
