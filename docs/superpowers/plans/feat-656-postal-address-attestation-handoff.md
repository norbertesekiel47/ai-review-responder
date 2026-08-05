# Handoff — #656 attested postal address

**Branch:** `feat-656-postal-address-attestation`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-656-postal-address-attestation`
**Lane:** RISK=high · SURFACE=mixed · `db_touching: true` → staging ride before `main`.
## ▶ RESUME HERE — apply 099 to prod, then merge

**The staging soak is DONE and PASSED (2026-08-05 07:57 UTC).** Do **not** re-run
the plan, the reviews, the migration, or the soak. What is left is the prod
migration and the merge.

### State as of 2026-08-05

| Thing | State |
|---|---|
| PR | **[#666](https://github.com/RepWorth/ai-review-responder/pull/666)** → `main`, open |
| Branch HEAD | `a608559b` (D7 fallow fix on top of the `924dc295` main merge) |
| Gate | **GREEN**, full `--review` mode, 29 rows at `a608559b` |
| `staging` branch | fast-forwarded to `924dc295` — **now one commit behind the branch** (`a608559b` is test+docs only, no worker code; re-ff optional) |
| Railway staging deploy | `de752b82` — SUCCESS, booted clean, 0 errors / 0 warns |
| **Staging soak** | ✅ **PASSED** — live batch build, see below |
| Migration 099 → **staging** Supabase (`kubdiqdhqbhwmqfditeg`) | ✅ **APPLIED + proven by a live build** |
| Migration 099 → **prod** Supabase (`udeyaqnvpojbwgoaxwdg`) | ❌ **NOT applied — re-verified absent 2026-08-05. Do this BEFORE merging.** |
| `planReviewRounds` / `branchReviewRounds` | 3 / 1 — both closed, do not reopen |

### The soak — what actually ran, and what it proved

Triggered the real pipeline rather than a direct query: one synthetic
`contact_csv_uploads` row + its `csv_ingest` outbox job written as a **single
data-modifying CTE** (atomic, invariant #2), then the worker did the rest —
OutboxPoller → ingest → `createSolicitationBatchTrigger` → build enqueue → build.

Target: **Tancia Resort** `019f877f-2352-722c-94e6-7018319c5513`
(`owner_email_bounced=false`, `_attested_at=NULL`, `trialing`).
Upload `019fd0ec-fbda-7ebc-ba65-cf4aaca45c4e` → batch
**`019fd0ed-385d-76bf-bc09-0afb81f7ba46`**.

```
solicitation batch build finished  status="built"
  selected_count=46  pool_count=46  send_count=3  withhold_count=43
  withheld_by_reason={no_consent:39, suppressed:0, already_reviewed:0,
                      stale_visit:0, over_contacted:4, velocity_banked:0}
  send_handoff={"status":"not_applicable"}
```

- **No `42703`.** `status:"built"` means `constructBatch` ran the widened SELECT
  to completion against the migrated schema. That SELECT is **unconditional** —
  it also feeds `business.category` to the restraint policy — so it executes on
  every build regardless of the send flag. This is the deployment risk the soak
  existed to retire, and it is retired.
- `send_handoff` is present on the log line.
- **Watch-mode did not regress**: still `built`, a real count, and
  `withheld_by_reason` still carries exactly the six existing members — no new
  `WITHHOLD_REASONS` entry (hard constraint 3).
- **Zero** `generate_solicitation_asks` rows — 0 for the batch, 0 globally.

**Why `not_applicable` and not `withheld`:** `SOLICITATION_SEND_ENABLED` is off
on staging (confirmed via the Railway CLI; `SOLICITATION_WATCH_ENABLED=true`), so
the guard `summary.sendCount > 0 && solicitationSendEnabled()` short-circuits and
`sendHandoff` stays at its `not_applicable` initializer. **`send_count` was 3,
i.e. > 0** — the flag was the *sole* thing keeping this run out of the withheld
branch. With it on, `sendHandoffWithheldReason(business)` would have run and
returned `postal_address_missing`. Owner decision 2026-08-05: **do not flip the
flag** on shared staging for one log line; the withheld VALUE is already covered
by the integration suites. Read `not_applicable` here as expected, not as failure.

**Residue left on staging (additive, harmless):** 3 synthetic contacts at
`@example.invalid` (RFC 2606 — unroutable by construction), 1 upload, 1 batch, 46
watch-mode ask decision rows. Nothing was sent; send is off. Delete by
`source_upload_id` / `batch_id` above if you want staging pristine.

### Merge sequence, in this order

1. Confirm PR #666 CI is green (`fallow` is **not** a required check — see D7).
2. **Apply 099 to PRODUCTION Supabase FIRST** (`udeyaqnvpojbwgoaxwdg`), same SQL
   as `supabase/migrations/099_solicitation_postal_address.sql`. Migration before
   code — a prod deploy against a 099-less database throws `42703` on every batch
   build, and the soak above is exactly what that failure would have looked like.
3. Merge PR #666 into `main` (squash).
4. `git checkout staging && git merge --ff-only main && git push` so staging never drifts.
5. Update `.claude/reference/migrations-log.md` to record prod application.
6. Consider the `/document-feature` sweep.

### Do NOT fix these on this branch

- **#665** — `purge-verification.ts` is blind to the five new columns. Purge itself
  is correct and tested three ways; only the detector is blind (D6).
- `src/lib/solicitation/ask-render.ts:42` cites #627 for the column's provenance.
- Locked spec §2.4 cross-references §6.3 where it means §7.5/§7.6.

---

**Historical step record (all complete):** step 6 branch review closed at round 1; step 7 staging ride done.

**ALL 11 TASKS ARE DONE.** Gate is **GREEN in full `--review` mode at HEAD**:
29 rows, zero non-PASS, `promised-tests` matching all **47** titles, and five
dedicated live-DB integration rows that **ran** (no SKIP — the `test` row's
"TEST_DATABASE_POOL_URL unset" line is the gate's own #563/#520 mitigation, and
`merge-coverage` folds the dedicated rows' coverage back in). `planReviewRounds`
is **3** and `branchReviewRounds` is **1** — both closed; see the RESUME block.

Plan review is CLOSED: three rounds, all REVISE, every disposition applied; the
owner approved on 2026-08-04 rather than spend a fourth round on two wording
edits. **Do not re-open it.**

A resumed session bootstraps from this doc → plan → deviations → review findings.
**Never re-read the grilling conversation; everything locked is on disk.**

## ⚠ Two traps T1 discovered — a later task WILL trip on these

Found while authoring the eval suite, not predicted by the plan. Both are now
load-bearing facts about the test code:

1. **The gate-integrity guard must assemble its marker strings, never spell them.**
   It lives in `src/lib/solicitation/__tests__/postal-address.test.ts`, which is
   one of the eleven files it scans. Writing `it.todo(` or `it.skip(` literally
   anywhere in that file — *including inside a comment explaining the guard* —
   makes it fail on itself forever and prove nothing about the other ten. It
   builds the four markers from `['it','describe'] × ['todo','skip']`. **T11 must
   not "simplify" that back to literals.** For the same reason, the placeholder
   comments in the other ten files say "pending placeholder" rather than naming
   the marker.

2. **Three promised titles contain apostrophes, and `verify-gate.sh` matches with
   `grep -F` against raw bytes.** They are written with double-quoted JS strings:
   `"…outside the caller's account"` (×2) and `"…another account's attested postal
   address untouched"`. A later task converting those `todo`s to real assertions
   **must keep the double quotes** — reflowing to `'…caller\'s…'` silently breaks
   the `promised-tests` gate row while the test itself still passes.

## Read these, by path — do not restate them here

| What | Path |
|---|---|
| Intake contract (the drift detector) | `.feature/intake.json` |
| Implementation plan (**11** tasks, dependency graph, glossary) | `docs/superpowers/plans/2026-08-03-656-postal-address-attestation.md` |
| Deviations **D1–D6** — **read before touching anything** | `docs/superpowers/plans/feat-656-postal-address-attestation-deviations.md` |
| Locked spec §7.5 / §7.6 / §2.4 | `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` |
| Binding amendments over that spec | `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` |
| Ticket | `gh issue view 656` |
| Parent wayfinder map | `gh issue view 617` |
| Glossary (existing terms consumed) | `CONTEXT.md` → "Solicitation (watch-mode)" + "Solicitation (send-mode)" |

Two glossary terms are **coined by this branch** and were written into
`CONTEXT.md` by T10: **Attested postal address** and **Send handoff**. Use them
verbatim in commits, tests and code comments.

## Hard constraints a resumed session must not rediscover

1. **Migration number is 099.** ✅ **Blocker cleared 2026-08-04** — #645 merged
   (PR #659), 098 applied to staging + prod (PR #661). This branch is rebased
   onto `origin/main` @ `4a16bcfd`; `migrations-log.md` reads "head: 098 — next
   is 099". The PR to `main` is no longer blocked.
2. **Do not block batch construction.** `buildSolicitationBatch` is ONE builder
   shared by watch-mode and send-mode. The precondition withholds the **Send
   handoff** at the `enqueueGenerateSolicitationAsks` call in `batch-builder.ts`, never the build — spec §7.6 point 1's
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
`batch-builder.integration.test.ts`'s *result-shape* assertions use `toMatchObject`
(tolerate the new `sendHandoff` field), but **three** fixtures break in T6 and all
three are named in T6 Step 5: the exact `toHaveBeenCalledWith` log object at
`worker/jobs/solicitation-batch/__tests__/index.test.ts:100`, the three
`{ category: 'automotive' }` mock rows behind `pushConstructionPreamble()`, and —
found by round 2 — the shared `beforeAll` business fixture at
`batch-builder.integration.test.ts:365-374`, whose flag-on **enqueue** assertion at
`:508` sees zero generation rows once the gate withholds.

## Round 2 (verification-only) — REVISE, all dispositions applied

7 of 11 round-1 findings ADDRESSED, 3 PARTIAL, 1 NOT; all 4 miscitations corrected;
all 12 new citations verified present. Report + triage:
`docs/reviews/feat-656-postal-address-attestation/plan-review-round2-*.md`.

Applied to the plan — **do not re-derive these**:

- **Defect 2 (High).** `resolveOwnerScope` does **not** cover offboarding. Verified:
  `isFullBlockState` returns true for `mode === 'delete_data'` at ANY status
  (`src/lib/account-offboarding/gate.ts:212-215`), and confirming offboarding does
  not itself cancel the subscription — so a `delete_data/pending` account is still
  `active` and could edit its sender address mid-teardown. T4 now calls
  `getOffboardingState` + `isOperationalUIBlocked` explicitly, before the body
  parse, matching `past-replies/draft/[responseId]/route.ts:103-106`. The earlier
  "the subscription gate covers offboarding" claim was **false** and is struck.
- **Defect 3 (High).** The third broken fixture, above.
- **Defect 4 (Low).** `convert_to` is **STABLE**, not IMMUTABLE (`pg_proc` says `s`;
  `encode`/`sha256` are `i`). The CHECK is still sound — Postgres does not reject a
  STABLE function in a CHECK the way it does in an index predicate, and
  `server_encoding` is UTF8. Comment corrected, with a "do not copy into an index"
  warning.
- **Finding 10.** The pre-T2 check exited **0** on failure (`… && echo OK || echo
  STOP`). Rewritten as two guarded statements with `exit 1`.

**Defect 1 (Critical) — OWNER-DECIDED 2026-08-04: accept the residual.**
The fact was *reproduced* on the test DB: an UPDATE that sets the address **and**
recomputes the digest keeps a stale `_attested_at` and passes both CHECKs. Closing
it needs `OLD` vs `NEW`, i.e. a `BEFORE UPDATE` trigger, which the plan
deliberately avoids. Owner chose to keep the two CHECKs and **narrow the claim**
instead: the digest guarantees only that the bytes cannot change without the digest
being recomputed. That closes the accidental path; the residual is deliberate
forgery, and a forger could equally stamp a fresh timestamp. **Do not re-open this,
and do not restate the guarantee more broadly than "Design decisions" #1 does.**

## ⚠ Intake is now **v3** — 47 promised tests

Round 2's defect-2 fix needs a test that v2 did not promise, so the intake was
re-issued: **`PUT /api/settings/postal-address refuses writes while the account is
offboarding`** (47th title, inserted after the non-writable-subscription one).

**`allowed_edit_surface` is UNCHANGED at 20 globs** — this is a test-list widening,
not a surface amendment, so the amendment budget stays at **#1 of 2**.

Re-armed with `feature-setup.sh` and the ARMING copy verified (47 titles, both
copies byte-identical) — the exact step D4 skipped in v1.

## State

- `.feature/state.json` — phase, `planReviewRounds`, gate SHAs. **Trust this over any summary.**
- Plan review round **1** dispatched via direct `codex exec` (read-only sandbox).
  - First attempt timed out at the harness 10-min wall mid-run; codex thread id
    `019fcb03-6c76-7310-8829-fa7d80dd8b7e`. That run produced no verdict.
  - Second attempt relaunched in background, stdin closed. Output:
    `<scratchpad>/codex-plan-r1b.txt`, brief at `<scratchpad>/codex-brief-656.md`.
  - **Verdict: REVISE** — recorded in the triage file and in the plan's
    "Review appendix" table. Round 1 is closed.
- Plan review round **2** dispatched the same way, **verification-only**. Brief:
  `<scratchpad>/codex-brief-656-r2.md`; output `<scratchpad>/codex-plan-r2.txt`.
  - **Verdict: REVISE.** Recorded in `plan-review-round2-triage.md` and the plan's
    "Review appendix". The reviewer honoured the scope bound — every finding it
    raised traces to a specific round-1 fix; nothing was rejected on scope grounds.
- **Surface amendment budget: RESET by the v2 intake re-issue.** v1's amendments
  (D1's renumber, D3's narrowing, D4's worker file) are history; v2 declared the
  full surface up front and **v3 did not touch it**. The next amendment is #1 of 2.
- `planReviewRounds` is **2** and does NOT reset — **round 3 is the CAP**. It is
  again **verification-only** (verify each round-2 disposition holds; it may flag a
  defect a FIX introduced, but may NOT open new fronts against unchanged plan
  sections). This branch is `RISK=high`, so a disagreement surviving round 3
  **escalates to the owner** rather than being decided by the runner.

## Next actions

1. ✅ **Plan review CLOSED.** Three rounds, all REVISE, every disposition applied.
   Owner approved 2026-08-04. **Do not re-open any round's findings**, and do not
   re-open the owner-decided defect 1 (the digest guarantee is narrow *by
   decision*, not by oversight) — see `plan-review-round3-triage.md` for both
   owner decisions on the record.
2. ✅ **All 11 tasks executed and committed**, sequentially per D5. Every task
   found at least one place the plan and the code disagreed; each correction is
   committed as its own `docs(#656): T<n> findings` commit next to the task, so
   the plan on disk is the corrected one.
3. ➡️ **Branch review (step 6)** — has NOT run. `branchReviewRounds` is 0.
4. Then **step 7, the ship lane**: `db_touching: true` + `RISK=high`, so this
   **rides `staging` before `main`**, and migration 099 applies to **both**
   Supabase projects in lockstep, **staging first**. `main` is protected — land
   via PR, never a direct push.

## Deferred by owner decision — do NOT "fix" these on this branch

- **Issue #665** — `src/lib/account-offboarding/purge-verification.ts` is blind to
  the five attestation columns. The purge itself is correct and tested three ways;
  only the detector is blind (D6). Out of surface; fixing it would have been
  amendment #2 of 2.
- `src/lib/solicitation/ask-render.ts:42` still cites **#627** for the column's
  provenance; **#656** landed it. Out of surface (D6).
- Locked spec #622 **§2.4** cross-references **§6.3** where it means §7.5/§7.6.
  Recorded inside T9's amendment entry rather than editing the locked spec (D6).
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

> The v3 re-issue followed this: edit the committed copy, then
> `bash scripts/feature-setup.sh docs/superpowers/plans/<branch>-intake.json`
> (it copies to BOTH), then verify the **arming** copy. Note `feature-setup.sh`
> resets `phase` to `worktree_ready` and commits the docs copy itself — expected,
> not drift. `planReviewRounds` survives it.
