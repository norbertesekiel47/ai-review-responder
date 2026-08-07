# feat-677-import-offer-prompt-decision — handoff

**Ticket:** #677 — Import offer: decision API + prompt UI + importing state
**Map:** #667 (Consented Review Import) · **Absorbs:** #676
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-677-import-offer-prompt-decision`
**Lane:** RISK = high · SURFACE = mixed · `db_touching: true` · full `/feature` path
**Phase at handoff:** `plan_approved` → next step is **4 (EXECUTE)**, starting with T0.

This doc references artifacts by path. It does not restate them. Read them.

---

## Read these, in this order

1. **Plan** — `docs/superpowers/plans/2026-08-06-import-offer-prompt-decision.md`
   (marked *Revision 4* — **LOCKED**). §1 design pass, §2 test placement,
   §3 tasks T0–T6, §4 execution order, §5 known limitations, §6/§7/§8 triage
   appendices for rounds 1/2/3. **Read the revision-4 header first**; §6–§8 are
   history, not instructions.
2. **Intake contract** — `docs/superpowers/plans/feat-677-import-offer-prompt-decision-intake.json`
   (audit copy; `.feature/intake.json` is the byte-identical arming copy).
   This is the drift detector — check work against it field by field, not from
   memory.
3. **Deviations** — `docs/superpowers/plans/feat-677-import-offer-prompt-decision-deviations.md`
   D1 (#679 merge order, corrected), D2 (`import-offer-view.ts`), D3 (consent
   lineage, amended), D4 (third gate absorbed, owner-approved), D5 (test growth).
4. **Plan reviews** — `docs/reviews/feat-677-import-offer-prompt-decision/`
   `plan-review-round-1.md` (REVISE, 33 proposed tests + 16 findings),
   `plan-review-round-2.md`, and `plan-review-round-3.md` (final round; its one
   substantive item went to owner adjudication).
5. **Design of record** — `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`
   §3, §4, §5.1, §5.2, §5.3, §7. Its §2 decision table D1–D10 is **locked**;
   do not re-litigate it.
6. **Rollout ADR** — `docs/adr/0015-consented-import-unflagged-replacement.md`
   (R1 no flag, R2 ordering).
7. **Glossary** — `CONTEXT.md` lines 25–28: **Review import**, **Import
   consent**, **Import window**, **Live-ingest cutoff**. Use verbatim.
   **"Import offer" is NOT yet in the glossary** — T6 coins it.

---

## Owner decisions locked at intake (do not reopen)

| # | Decision |
|---|---|
| 1 | **#677 owns `src/lib/reviews/import-consent.ts`** incl. `importConsentStateSql`. #679 rebases after this merges and drops that task from its plan. Merge order **#677 → #679 → #676(absorbed)**. |
| 2 | The offer is **created at the junction**, server-side, in-transaction — not lazily on first render. `createImportOffer` proves the junction in its own SQL (activation non-NULL **and** an active connection). The deadline is **`now() + 7 days` at creation — there is NO junction anchor**; anchoring was tried in revisions 2–3, produced two High findings, and was dropped by owner adjudication 2026-08-06 (plan T1 has the reasoning). |
| 3 | The prompt is a **dashboard banner for the location currently in scope**, not a modal and not an account-level roll-up. |
| 4 | The banner carries **offer → importing → outcome → gone**, with the zero-review case surfaced as "No recent reviews found — nothing to import." |
| 5 | **All three enqueue paths gated** (#676 absorbed). Re-decided 2026-08-06 after round 1 established reactivation is owner-facing — see deviations D4. |
| 6 | **Prompt copy is locked verbatim**, including the 7-day disclosure and the mandatory reassurance line. Plan T5 has the exact text. |

Decided from the code rather than asked, and worth not re-deriving:

- The banner sources its own state from `GET /api/dashboard/import-offer`, **not**
  from `DashboardDataActive` — `getActiveDashboardData` is Redis-cached
  (`src/lib/dashboard/service.ts:118`), so a declined offer would re-render for
  the whole TTL. `src/lib/dashboard/**` is deliberately absent from the surface.
- The outbox enqueue is a **raw `INSERT INTO job_outbox`**. No helper exists for
  `ZERNIO_INITIAL_BACKFILL`; minting one turns every raw producer red under
  `ci:outbox-seam` and forces migrating them in this PR (invariant #2's
  carve-out). Verified by round 1 against `job-outbox-helpers.ts`.

---

## State

- **Branch commits:** intake → plan rev 1 → rev 2 → rev 3 → rev 4 → revision-4
  prose reconciliation → T0 matrix fix (D6) → **T0 eval**. **Read the plan's
  revision-4 header first: where earlier revisions conflict, revision 4 wins,
  and §6/§7/§8 are history, not instructions.**
- **Phase:** execution COMPLETE — T0–T6 all committed. Production surface:
  `src/lib/reviews/import-consent.ts` + `import-offer-view.ts` (new),
  `api/dashboard/import-offer/route.ts` (new), `ImportOfferBanner.tsx` (new), plus
  gates added to `finalize-tx.ts`, `worker/ingress/stripe/shared.ts`,
  `archive-location-tx.ts`, `add-location-tx.ts` and `DashboardContent.tsx`.
- **Three plan defects were found DURING execution, all recorded and none of which
  changed what the feature does:** the analytics events were impossible as
  specified (D7 — extending the `analytics_events.event_name` CHECK needs a
  migration the intake's own non-goals forbid, so they moved to #679);
  `importConsentStateSql`'s published signature was unimplementable against the
  repo's hand-rolled `sql` mocks (D9); and `ci:tenant-scope` cannot see predicates
  inside subqueries, which reshaped three queries to bind their tenant keys at the
  top level (D9).
- **Gate is GREEN — all 26 rows, in full (not `docs_only`) mode**,
  including `build`, `promised-tests` (all 69 titles found), and **four live-DB
  integration rows that RAN rather than skipping**, because
  `TEST_DATABASE_POOL_URL` was exported (see traps — this is the difference
  between a real gate and a falsely-green one).
- **Phase is `gate_green`, and that is now correct.** It was deliberately held
  at `executing` through T0–T6 — a green gate mid-execution means "the branch is
  consistent at this SHA", not "the feature is built", and leaving `gate_green`
  in the record would have invited a resumed session to skip to review with no
  production code written. Execution is complete, so the hold is lifted.
- **Step 6 (deviations read-back) is DONE — 2026-08-07.** All nine entries
  ACCEPT, zero RE-PLAN, each verdict checked against code and recorded in the
  deviations file. Standing totals re-confirmed at read-back: amendments **1 of
  2** (D4), `planReviewRounds` **3**, `tests_to_add` **69**, `open_questions`
  empty. Two items were explicitly carried into review rather than settled — D7's
  replacement log lines, and D9's unenforced `b.`-alias contract across the four
  producers.
- **Enforcement:** ARMED (`scripts/arm-check.sh` clean at setup).
- `.feature/state.json`: `planReviewRounds` = 3 — **exhausted**. The plan is
  locked by owner adjudication; do not open a fourth plan-review round.
- **Surface amendments used: 1 of the abort budget** (D4 —
  `archive-location-tx.ts`). D2 was auto-approved (one file inside an existing
  tree) and does not count.
- **Six further surface paths were added during execution and DELIBERATELY do not
  consume the budget** (owner-approved: D8, D9). All six are test or audit-config
  paths whose change is the mechanical consequence of already-approved production
  scope, not new scope — the same reasoning D5/D6 used for test placement:
  `select-location/__tests__/**`, `worker/ingress/__tests__/**`,
  `scripts/ci/__tests__/**`, `scripts/ci/tenant-scope-allowlist.ts`,
  `scripts/ci/static-policy-audit.ts`. `src/lib/analytics/events.ts` was
  **removed** from the surface (D7) so the guard enforces the analytics deferral.
  **The lesson for the next intake:** gating an existing side effect invalidates
  assertions in every suite that exercises a CALLER of the gated function, and
  callers' suites are not in the producer's directory — so they are not in the
  producer's surface either. Budget for caller-suite fallout up front.
- **Estimates vs actuals.** Intake: 800 prod / 2400 test lines, **69** test titles
  (70 until the analytics title moved to #679 — D7). Actual, excluding `docs/`,
  `.feature/` and `scripts/ci/`: **1,174 prod / 2,975 test lines added.** Both are
  inside the `reclassify` row's 2× thresholds (1,600 / 4,800), so it does not fire
  — prod ran ~1.5× the estimate, mostly the four producer gates and the two new
  modules coming out larger than sketched.
- **Three plan-review rounds, all `REVISE`.** Round 1 caught a consent hole
  (a NULL deadline was answerable, so a direct POST could manufacture
  `accepted`); rounds 2 and 3 caught defects the *fixes* introduced. Treat the
  §6/§7/§8 appendices as the record of what has already been argued — do not
  re-litigate them during implementation.

---

## Next actions

1. ~~`set-phase executing`~~ — **done** (phase is `executing`).
2. ~~**T0**, the eval~~ — **done at `54ef9808`.** Every intake title authored
   VERBATIM, exactly once, in the suite the corrected matrix assigns (D6), verified
   mechanically against the intake. *(T0 authored 70; the count became 69 when the
   analytics title moved to #679 — D7 — which also renumbered the tail, old 69 → 68
   and old 70 → 69. Numbers below are AS OF T0.)* All but two were `it.todo` —
   their modules did not exist, and importing a missing module reds the whole *file*
   instead of the slice. Title 13 asserted and passed live, proving migration 101's
   three-valued CHECK, which `MIGRATION_100_IMPORT_CONSENT` structurally cannot
   (F113). The source tripwire was legibly red
   (`producer source not found: ../import-consent.ts`) and was then deliberately
   deferred to T3, which restored it once all four producers existed. First-task
   enforcement spot check PASS — 12 paths, all in surface, and the guard is
   confirmed live (it blocked a Bash append mid-task).
3. ~~T1 ‖ T2, T3 ‖ T4, T5, T6~~ — **all done.** Execution is COMPLETE:
   `2f281ad2` (T1+T2), `27d4b8eb` (T3+T4), `635f5aef` (T5+T6). **All 69 titles
   assert; zero `.todo` remain.** Gate GREEN 26/26 in full mode with the four
   live-DB rows running.
4. ~~Step 6 — deviations read-back~~ — **done at `7f4658c8`.** All nine entries
   ACCEPT, zero RE-PLAN, each verdict checked against code rather than against
   the file's own prose.
5. ~~Step 7 — review, round 1~~ — **done.** Three axes in parallel: spec
   `APPROVE WITH CHANGES`, standards `REQUEST CHANGES`, Codex adversarial
   `needs-attention`. Reports + consolidated triage committed at `a161730f`
   (`docs/reviews/<branch>/`). **10 accepted, 5 rejected with reasoning, 3
   escalated to the owner.** `branchReviewRounds = 1`.
6. ~~Owner decisions~~ — **done at `a34e2467`** (D10–D13): ship order
   re-affirmed; extract the triplicated enqueue now; inheritance must not carry
   a live deadline.
7. ~~Fix round~~ — **done at `1a1905d6`** (four parallel batches, disjoint file
   sets) **and `e3a23329`** (locked-title restore + the `reclassify` step-0
   re-run, D15).
8. **Gate GREEN 28/28 in full mode at `e3a23329`**, `--review` variant, so
   `diff-coverage` and `merge-coverage` both pass and all four live-DB rows ran.
   `reclassify` no longer fires.
9. **NEXT: step 8, the high lane.** Land on `staging` first (push →
   full stack auto-deploys; migrations to the staging Supabase project FIRST —
   though **no migration rides this ticket**), smoke the touched path, then open
   the PR to `main`, confirm CI green, and **PAUSE for owner merge approval**.
   Merge order is **#677 → #679 → #676(absorbed)**.

**Standing totals at review completion:** surface amendments **1 of 2** (D4
only — D2, D8, D9, D14 were all inside existing trees or mechanical
consequences of settled scope); `planReviewRounds` **3** (exhausted);
`branchReviewRounds` **1**; gate-fail rounds **1 of 3**; `tests_to_add` **70**;
`open_questions` **[]**.

**Two things deliberately NOT done, both to protect the surface budget** — a
2nd amendment is itself an abort trigger, so neither was worth it:
- `src/lib/shared/worker-types.ts:226-227` keeps a stale `needs_backfill`
  JSDoc (D13). Outside the surface. Handed to #679.
- `ImportOfferBanner` shares stagger index `section-enter-2` with the hero band,
  so they animate together instead of stepping. `console.css` defines only
  `-1…6` and all six are claimed; stepping the page means renumbering
  `NeedsAttentionList.tsx`, outside the surface. Cosmetic only.

## Traps this feature has already walked into once

- **`TEST_DATABASE_POOL_URL` in `.env.local` is NOT enough — it must be exported
  into the shell.** `describeWithDb` reads `process.env.TEST_DATABASE_POOL_URL`
  directly; it does **not** go through `resolveTestDatabaseUrl`, so it never sees
  the `.env.local` disk fallback that CLAUDE.md's other gotcha describes. A bare
  `pnpm vitest run <suite>.integration.test.ts` therefore prints
  `TEST_DATABASE_POOL_URL unset — DB-gated integration suites SKIPPED` and exits
  **green with zero tests run**, even though the variable is sitting in
  `.env.local`. Confirmed at T0 (2026-08-07). `pnpm test:integration` only
  *validates* presence in a separate `node -e` process — that does not export it
  into vitest's environment either. Run live suites as:
  `export TEST_DATABASE_POOL_URL=$(grep -m1 '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2-)`.
  **This is the falsely-green step-5 gate for this ticket** — four live suites
  carry the load-bearing semantics, and the SKIP line is a warning, not a
  failure.
- **A title *range* is a derived value copied by hand across four documents, and
  it drifted three times.** Rev 3 left T0 ordering "57" after the intake reached
  70; rev 4 fixed the count but built the matrix against the old numbering
  (off by one from title 14 — see D6); the handoff kept "57" a revision longer
  than the plan. Do not trust a remembered range: re-derive the row from
  `tests_to_add` and check the partition.

- **A parked worktree is invisible to the cross-worktree surface check.**
  `feature-setup.sh` reported "no overlap" while #679 held the same file, because
  #679's intake is `intake.parked.json`. Deviations D1.
- **A module header lied about who can call it.** `archive-location-tx.ts:8`
  says "admin re-activate"; the route at
  `src/app/api/locations/reactivate/route.ts:111` is owner-facing. That stale
  comment cost a wrong scope decision. Verify callers, don't trust headers.
- **Migration 100 DEFAULTs every business to `pending` with a NULL deadline.**
  A consent predicate that admits NULL lets a direct POST manufacture consent.
  This was the round-1 Critical; the `IS NOT NULL` guard in T1 is load-bearing.
- **`GREATEST(NULL, x)` returns `x` in Postgres.** A predicate that merely
  combined the two junction timestamps would hand an offer to a location holding
  only one half of the junction. `createImportOffer` proves both halves in its
  own SQL — the callers do not check, so the helper must.
- **Inventing a property nothing asked for cost two review rounds.**
  "Position-independence" of the deadline was not in the spec; chasing it
  produced two High findings before being deleted. When a fix starts needing its
  own fixes, check whether the requirement was real.
- **`connected_at` is mutable and `disconnect` mints a new connection row.**
  `finalize-tx.ts:123-132` overwrites `connected_at` on reconnect;
  `disconnect/route.ts:251-262` leaves the old row `disconnected` and finalize
  INSERTs a fresh one. Neither is a stable identity for a location's connection.
- **Reactivation is not another initial-import producer.** It enqueues with
  `backfill_reason: 'reactivation'`, and the worker's
  `ON CONFLICT … WHERE run_reason = 'initial'` deliberately does not dedup it.
  Applying initial-import dedup or completed-run logic there deletes the
  archived-period catch-up.
