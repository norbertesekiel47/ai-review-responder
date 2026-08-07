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
- **Phase:** `executing`. T0 is committed; T1 ‖ T2 is next. No production code
  exists yet — the 70 tests are the only artifact.
- **Gate is GREEN at `930358cc` — all 26 rows, in full (not `docs_only`) mode**,
  including `build`, `promised-tests` (all 70 titles found), and **four live-DB
  integration rows that RAN rather than skipping**, because
  `TEST_DATABASE_POOL_URL` was exported (see traps — this is the difference
  between a real gate and a falsely-green one).
- **The gate script sets `phase=gate_green`; it has been set back to
  `executing` on purpose.** Execution is NOT finished — only T0 is done, T1–T6
  remain. Leaving `gate_green` in the record would invite a resumed session to
  skip to step 6 (review) with no production code written. A green gate here
  means "the branch is consistent at this SHA", not "the feature is built".
- **Enforcement:** ARMED (`scripts/arm-check.sh` clean at setup).
- `.feature/state.json`: `planReviewRounds` = 3 — **exhausted**. The plan is
  locked by owner adjudication; do not open a fourth plan-review round.
- **Surface amendments used: 1 of the abort budget** (D4 —
  `archive-location-tx.ts`). D2 was auto-approved (one file inside an existing
  tree) and does not count. A second amendment triggers abort criteria.
- **Estimates:** 800 prod / 2400 test lines, 70 test titles. Step 5's
  `reclassify` row measures against these post-review numbers.
- **Three plan-review rounds, all `REVISE`.** Round 1 caught a consent hole
  (a NULL deadline was answerable, so a direct POST could manufacture
  `accepted`); rounds 2 and 3 caught defects the *fixes* introduced. Treat the
  §6/§7/§8 appendices as the record of what has already been argued — do not
  re-litigate them during implementation.

---

## Next actions

1. ~~`set-phase executing`~~ — **done** (phase is `executing`).
2. ~~**T0**, the eval~~ — **done at `54ef9808`.** All 70 intake titles authored
   VERBATIM, exactly once, in the suite the corrected matrix assigns (D6);
   placement verified mechanically against the intake, 70/70. 68 are `it.todo`
   (their modules do not exist, and importing a missing module reds the whole
   *file* instead of the slice); **titles 13 and 70 assert**. 13 passes live —
   it proves migration 101's three-valued CHECK, which
   `MIGRATION_100_IMPORT_CONSENT` structurally cannot (F113). 70 is legibly red:
   `producer source not found: ../import-consent.ts`. First-task enforcement
   spot check PASS — 12 paths, all in surface, and the guard is confirmed live
   (it blocked a Bash append mid-task).
3. **NEXT: T1 ‖ T2**, then **T3 ‖ T4**, then T5, then T6 (plan §4). T1 fills in
   assertions rather than building the live rig — running title 13 already
   validated the harness end to end (connect → `assertSchemaReady` →
   `seedTenantAccount` → business insert → cleanup) in
   `import-consent.integration.test.ts`.
4. Step 5 gate: `scripts/verify-gate.sh`. **`TEST_DATABASE_POOL_URL` must be
   set** — four live-DB suites carry this feature's load-bearing semantics, and
   a gate with the SKIP warning is not review-ready for this ticket. Run
   `pnpm test:db:setup` first if the local DB is behind head.
5. Step 8 is the **high lane**: staging ride before `main`, then PR, then pause
   for owner merge approval.

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
