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

## ⚠ Intake was RE-ISSUED (v2) — the plan has NOT yet been revised to match

Plan review round 1 returned **REVISE** (3 Critical). Owner call: re-issue the
intake as a step-1 correction rather than tear down a docs-only branch.

- Post-mortem: `docs/superpowers/plans/feat-656-postal-address-attestation-postmortem.md`
- Review report + triage verdicts: `docs/reviews/feat-656-postal-address-attestation/`
- **Intake v2 is armed and verified** — 46 promised tests (was 22), 20 surface
  globs, zero `098` titles.

**`docs/superpowers/plans/2026-08-03-656-postal-address-attestation.md` is STALE.**
It is intake-v1's plan. Revising it is the next action. What must change:

1. **Migration 099 gains a fifth column**, `solicitation_postal_address_attested_digest`,
   inside the same all-or-nothing tuple, plus a second CHECK that it equals
   `encode(sha256(convert_to(solicitation_postal_address,'UTF8')),'hex')`. Without
   it an address-only `UPDATE` keeps all four columns non-NULL, passes the CHECK,
   and leaves a stale attestation over new bytes — the precise defect this
   feature exists to prevent. `attestPostalAddress` being well-behaved constrains
   no other writer.
2. **Task 4/5 auth is wrong.** The real precedent is
   `src/app/api/settings/competitors/route.ts` — `requireSettingsOwner` +
   `withSameOrigin` + explicit `businessId` — NOT `/api/settings/route.ts`'s
   `requireRoleOr401` / `user.locationId` / `assertWritableSubscriptionForAccount`.
   And `requireOwnerAccess` returns **`currentLocationId`** (cookie-resolved via
   `getRequestScope`), not `businessId`: writing the account primary location
   would save the wrong location for multi-location accounts.
3. **`attestPostalAddress` must validate the actor** — exists, belongs to the
   account — inside the same scoped UPDATE, because there is no FK to do it.
4. **Task 6 must update existing fixtures** it breaks:
   `worker/jobs/solicitation-batch/__tests__/index.test.ts` asserts the exact log
   object, and the batch-builder unit fixtures assert the exact result shape.
5. **Add a `MIGRATION_099_SOLICITATION_POSTAL_ADDRESS` schema requirement** and
   assert it in every affected live-DB suite.
6. **Add a final task**: zero-pending check + `verify-gate.sh --review`. `it.todo`
   satisfies the `promised-tests` row, so the gate can otherwise go green with
   the feature absent.
7. **Pre-T2 blocking check** that migration 098 and its migrations-log entry
   exist before T2 records head 099.
8. **Fix four false citations** (all verified false): Task 6 cites deviation D2
   for the watch-mode decision — D2 is the allowlist entry, and that decision is
   on ticket #656 / map #617, not in the deviations file; Task 7 cites an
   "existing `google_place_address` assertion" in the offboarding suite that does
   not exist; Task 1 Step 6 cites a "flag-stubbing helper" that does not exist
   (the suite mutates `process.env`); `acquireLiveDbLock` is in
   `helpers/live-db-lock.ts`, not `schema-ready.ts`.
9. **Fix the dependency graph** — T7/T8 depend on T2 only, not T3 — and the
   "only two new test files" line that contradicts the five Creates listed.
10. **Record the §7.6.1 / §2.4 override in
    `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`** (now
    in surface). It currently lives only on ticket #656 and map #617, so a reader
    of the locked spec still gets "no batch produced" — the #643 lesson in a new
    shape, and exactly what the reviewer caught.

**Rejected finding, do not action:** codex claimed
`subagent-driven-development` / `executing-plans` do not exist. They are
user-level skills; it searched only the repo.

## State

- `.feature/state.json` — phase, `planReviewRounds`, gate SHAs. **Trust this over any summary.**
- Plan review round **1** dispatched via direct `codex exec` (read-only sandbox).
  - First attempt timed out at the harness 10-min wall mid-run; codex thread id
    `019fcb03-6c76-7310-8829-fa7d80dd8b7e`. That run produced no verdict.
  - Second attempt relaunched in background, stdin closed. Output:
    `<scratchpad>/codex-plan-r1b.txt`, brief at `<scratchpad>/codex-brief-656.md`.
  - **Verdict: pending — record it here and in the plan's review appendix.**
- **Surface amendment budget: RESET by the intake re-issue.** v1's amendments
  (D1's renumber, D3's narrowing, D4's worker file) are history; v2 declares the
  full surface up front. The next amendment is #1 of 2 against v2.
- `planReviewRounds` is **1** and does NOT reset — round 2 is the next dispatch
  and it is **verification-only** (verify each round-1 finding is addressed; it
  may flag a defect a FIX introduced, but may NOT open new fronts against
  unchanged plan sections). Max 3, then surface the disagreement to the owner.

## Next actions

1. **Revise the plan** against the ten items above. Do not re-derive them —
   they are the triaged round-1 findings, already verified against the code.
2. `bash scripts/feature-state.sh incr-round plan`, then dispatch round 2 as
   **verification-only**: hand the reviewer the round-1 findings table plus the
   revision diff, and ask only whether each finding is addressed. Reuse the
   brief at `<scratchpad>/codex-brief-656.md` as a base, but replace the primary
   question. **Run it in the background with stdin closed** — the first round-1
   dispatch died at the harness 10-minute wall.
3. On `APPROVED`: `bash scripts/feature-state.sh set-phase plan_approved`, then
   step 4 — `set-phase executing` and dispatch Task 1 **alone** (its enforcement
   spot check proves the guard binds for subagent tool calls).
4. Tasks 4, 6, 7, 8 are mutually independent and parallel-dispatchable; T4→T5 is
   serial; docs task last.
5. Gate: `scripts/verify-gate.sh`, and `--review` for the last run before step 7.
   `TEST_DATABASE_POOL_URL` must be set — a SKIP row on this DB-touching branch
   is not review-ready (#520 class).

**Before any intake edit ships, re-run `feature-setup.sh` and verify the
ARMING copy**, not the committed one:

```bash
python3 -c "import json; s=json.load(open('.feature/intake.json'))['allowed_edit_surface']; print('<path>' in s)"
```

Editing the committed intake is not the amendment — re-arming is. That gap is
how v1's owner-approved worker-file amendment never reached the guard.
