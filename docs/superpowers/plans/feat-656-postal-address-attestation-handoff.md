# Handoff — #656 attested postal address

**Branch:** `feat-656-postal-address-attestation`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-656-postal-address-attestation`
**Lane:** RISK=high · SURFACE=mixed · `db_touching: true` → staging ride before `main`.
**Current step:** 3 → 4 boundary (plan written, round-1 adversarial review dispatched).

A resumed session bootstraps from this doc → plan → deviations → review findings.
**Never re-read the grilling conversation; everything locked is on disk.**

## Read these, by path — do not restate them here

| What | Path |
|---|---|
| Intake contract (the drift detector) | `.feature/intake.json` |
| Implementation plan (9 tasks, dependency graph, glossary) | `docs/superpowers/plans/2026-08-03-656-postal-address-attestation.md` |
| Deviations D1–D4 — **read before touching anything** | `docs/superpowers/plans/feat-656-postal-address-attestation-deviations.md` |
| Locked spec §7.5 / §7.6 / §2.4 | `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` |
| Binding amendments over that spec | `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` |
| Ticket | `gh issue view 656` |
| Parent wayfinder map | `gh issue view 617` |
| Glossary (existing terms consumed) | `CONTEXT.md` → "Solicitation (watch-mode)" + "Solicitation (send-mode)" |

Two glossary terms are **coined by this branch** and live in the plan's Glossary
section until Task 9 writes them into `CONTEXT.md`: **Attested postal address**
and **Send handoff**. Use them verbatim in commits, tests and code comments.

## Hard constraints a resumed session must not rediscover

1. **Migration number is 099, not 098.** 098 belongs to sibling branch #645
   (deviations D1). **Do not open the PR to `main` until #645 has merged.**
2. **Do not block batch construction.** `buildSolicitationBatch` is ONE builder
   shared by watch-mode and send-mode. The precondition withholds the **Send
   handoff** at `batch-builder.ts:766`, never the build — spec §7.6 point 1's
   "no batch produced" predates the shared builder (deviations D2).
3. **No new `WITHHOLD_REASONS` member.** That enum is closed, precedence-ordered
   and versioned by `RESTRAINT_POLICY_VERSION`; every member is a per-candidate
   reason and this is a per-location fact.
4. **`attested_by_user_id` has NO foreign key**, deliberately — migration 093's
   written lesson (086's `ON DELETE CASCADE` meant deleting a staff member
   deleted their uploads).
5. **The attestation surface is `settings/profile`, not `settings/locations`** —
   the latter is gated by `MULTI_LOCATION_ENABLED`, unset→off in prod, which
   would make a CAN-SPAM precondition unreachable (recorded on #656 and #617).
6. `scripts/ci/tenant-scope-allowlist.ts` is shared with #645 — append-only,
   rebase and re-append, recompute the baseline from the actual entry count
   (deviations D2).

## State

- `.feature/state.json` — phase, `planReviewRounds`, gate SHAs. **Trust this over any summary.**
- Plan review round **1** dispatched via direct `codex exec` (read-only sandbox).
  - First attempt timed out at the harness 10-min wall mid-run; codex thread id
    `019fcb03-6c76-7310-8829-fa7d80dd8b7e`. That run produced no verdict.
  - Second attempt relaunched in background, stdin closed. Output:
    `<scratchpad>/codex-plan-r1b.txt`, brief at `<scratchpad>/codex-brief-656.md`.
  - **Verdict: pending — record it here and in the plan's review appendix.**
- Surface amendments used: **1 of 2** (D4, `worker/jobs/solicitation-batch/index.ts`).
  D1's 098→099 renumber and D3's narrowing are **not** counted; reasoning is in
  the deviations file.

## Next actions

1. Read the codex verdict. On `REVISE`, apply fixes, run
   `bash scripts/feature-state.sh incr-round plan`, and re-submit **only the
   findings-and-fixes delta** (rounds 2–3 are verification-only). After round 3,
   stop and surface the disagreement to the owner.
2. On `APPROVED`: `bash scripts/feature-state.sh set-phase plan_approved`, then
   step 4 — `set-phase executing` and dispatch Task 1 **alone** (its
   enforcement spot check proves the guard binds for subagent tool calls).
3. Tasks 4, 6, 7, 8 are mutually independent and parallel-dispatchable after
   Task 3; T4→T5 is serial; T9 last.
4. Gate: `scripts/verify-gate.sh`, and `--review` for the last run before step 7.
   `TEST_DATABASE_POOL_URL` must be set — a SKIP row on this DB-touching branch
   is not review-ready (#520 class).
