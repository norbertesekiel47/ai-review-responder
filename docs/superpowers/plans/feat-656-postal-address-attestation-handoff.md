# Handoff — #656 attested postal address

**Branch:** `feat-656-postal-address-attestation`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-656-postal-address-attestation`
**Lane:** RISK=high · SURFACE=mixed · `db_touching: true` → staging ride before `main`.
**Current step:** 3 (plan). Round-1 review returned REVISE; **the revision is written
and committed**. Next action is the round-2 **verification-only** dispatch.

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

1. **Migration number is 099.** ✅ **Blocker cleared 2026-08-04** — #645 merged
   (PR #659), 098 applied to staging + prod (PR #661). This branch is rebased
   onto `origin/main` @ `4a16bcfd`; `migrations-log.md` reads "head: 098 — next
   is 099". The PR to `main` is no longer blocked.
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
6. `scripts/ci/tenant-scope-allowlist.ts` — ✅ **overlap resolved**; #645's three
   entries are on `main` and were absorbed by the rebase. If #656 needs entries,
   append and **recompute `ALLOWLIST_BASELINE` from the actual count** (D2).

## ✅ Intake v2 re-issued AND the plan revised to match

Plan review round 1 returned **REVISE** (3 Critical). Owner call: re-issue the
intake as a step-1 correction rather than tear down a docs-only branch.

- Post-mortem: `docs/superpowers/plans/feat-656-postal-address-attestation-postmortem.md`
- Review report + triage verdicts: `docs/reviews/feat-656-postal-address-attestation/`
- **Intake v2 is armed and verified** — 46 promised tests (was 22), 20 surface
  globs, zero `098` titles.
- **The plan is the intake-v2 plan as of 2026-08-04.** All 46 intake titles
  appear in it verbatim (checked mechanically). 11 tasks, not 9.

All eleven ACCEPTED round-1 findings are actioned in the plan — see its
**"Round-1 findings, disposition"** paragraph under Self-review for the
finding→task mapping, and **"Design decisions this revision locks"** for the
three that changed the design rather than the prose:

1. **Migration 099 has five columns and two CHECKs** — the fifth,
   `solicitation_postal_address_attested_digest`, is CHECKed to equal
   `encode(sha256(convert_to(solicitation_postal_address,'UTF8')),'hex')`, so an
   address-only `UPDATE` by **any** writer fails closed. Tuple completeness is
   not byte coverage.
2. **The route's auth helper is `resolveOwnerScope`, not `requireSettingsOwner`.**
   Verified: `requireSettingsOwner` resolves no location and, per its own doc
   comment, deliberately skips the writable-subscription gate — the intake
   demands both. `resolveOwnerScope` returns `{ accountId, locationId, userId }`
   with `locationId` cookie-resolved and `userId` = `users.id`. `withSameOrigin()`
   still wraps it (that helper does no CSRF check). The competitors route stays
   the **shape** precedent, not the auth one.
3. **`attestPostalAddress` carries the actor-membership predicate in its own
   UPDATE**, because `_attested_by_user_id` has no FK to do it.

**Rejected finding, do not action:** codex claimed
`subagent-driven-development` / `executing-plans` do not exist. They are
user-level skills; it searched only the repo.

**Verified during the revision, so a resumed session need not re-derive it:**
`batch-builder.integration.test.ts` asserts with `toMatchObject` (tolerates the
new `sendHandoff` field), but `worker/jobs/solicitation-batch/__tests__/index.test.ts:100`
uses an exact `toHaveBeenCalledWith` and `batch-builder.test.ts`'s
`pushConstructionPreamble()` pushes `{ category: 'automotive' }` at three sites —
both must widen in T6, or those suites go red.

## State

- `.feature/state.json` — phase, `planReviewRounds`, gate SHAs. **Trust this over any summary.**
- Plan review round **1** dispatched via direct `codex exec` (read-only sandbox).
  - First attempt timed out at the harness 10-min wall mid-run; codex thread id
    `019fcb03-6c76-7310-8829-fa7d80dd8b7e`. That run produced no verdict.
  - Second attempt relaunched in background, stdin closed. Output:
    `<scratchpad>/codex-plan-r1b.txt`, brief at `<scratchpad>/codex-brief-656.md`.
  - **Verdict: REVISE** — recorded in the triage file and in the plan's
    "Review appendix" table. Round 1 is closed.
- **Surface amendment budget: RESET by the intake re-issue.** v1's amendments
  (D1's renumber, D3's narrowing, D4's worker file) are history; v2 declares the
  full surface up front. The next amendment is #1 of 2 against v2.
- `planReviewRounds` is **1** and does NOT reset — round 2 is the next dispatch
  and it is **verification-only** (verify each round-1 finding is addressed; it
  may flag a defect a FIX introduced, but may NOT open new fronts against
  unchanged plan sections). Max 3, then surface the disagreement to the owner.

## Next actions

1. ✅ **Plan revised** (2026-08-04). Do not re-open the round-1 findings.
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
