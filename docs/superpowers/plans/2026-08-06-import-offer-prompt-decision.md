# #677 — Import offer: decision API + prompt UI + importing state

**Branch:** `feat-677-import-offer-prompt-decision`
**Intake:** `docs/superpowers/plans/feat-677-import-offer-prompt-decision-intake.json`
**Design of record:** `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`
(§3 user flow, §4 data model, §5.1 declined-vs-failed, §5.2 the resume bug, §5.3 derived expiry, §7 edge cases)
**Rollout posture:** `docs/adr/0015-consented-import-unflagged-replacement.md` (R1 no flag, R2 ordering)
**Map:** #667 · **Blocked by:** #673 ✅, #675 ✅, #668 ✅ · **Absorbs:** #676 (all three enqueue gates)

> **Revision 2** (2026-08-06), after plan-review round 1 returned `REVISE`.
> Triage verdicts in §6. The three structural changes: the decision predicate
> now requires an offer to *exist*; all three enqueue producers are gated and
> in-flight-deduped; the acceptance transaction moves into a domain module.
>
> **Revision 3** (2026-08-06), after round 2 returned `REVISE` on defects that
> revision 2's own fixes introduced. Triage in §7. Four structural changes:
> **(a)** junction eligibility moves *inside* `createImportOffer`'s SQL — the
> `pending + NULL` guard alone let a one-sided location get a pre-junction offer,
> because Postgres `GREATEST(NULL, x)` returns `x`; **(b)** the deadline anchors
> on `zernio_connections.created_at`, not `connected_at`, which reconnect
> overwrites; **(c)** every producer runs inside `sql.begin` holding the
> `businesses` row lock, which retires the check-then-insert dedup race, the
> unresolved transaction-shape finding, and the zero-row classification race
> together (owner decision 2026-08-06: row lock, not a migration); **(d)**
> reactivation gets the consent gate **only** — revision 2 wrongly imposed a
> generic completed-run predicate on a path with its own `run_reason`.
>
> **Revision 4** (2026-08-06) — **the plan is LOCKED**. Round 3 was the final
> review round; the owner's adjudication substitutes for `APPROVED`. Triage in
> §8. One substantive change: **the junction deadline anchor is dropped** —
> `createImportOffer` uses `now() + 7 days`. The junction *eligibility* check
> stays. Three clerical corrections: T0 rewritten to all 70 titles with suite
> and live-DB assignments, the lineage test retargeted at the actual
> cross-representation case, and the stale anchor/lineage wording reconciled
> across both intake copies, deviations D3, and the handoff doc.
>
> **Where earlier revisions conflict with this one, this one wins.** §6 and §7
> are historical triage records, not instructions.

---

## 1. Design pass (`codebase-design`)

Named in the skill's vocabulary. Two new modules, five deepenings, zero widened
interfaces.

| Module | New or deepening | Interface | Depth / deletion test |
|---|---|---|---|
| `src/lib/reviews/import-consent.ts` | **NEW module, new seam** | `importConsentStateSql`, `readImportConsent`, `createImportOffer`, `recordImportDecisionAndEnqueue`, `IMPORT_OFFER_WINDOW_DAYS` | Deep. Hides the three-valued enum, the derived expiry, the F3 atomic-transition `WHERE` discipline, the junction eligibility predicate, and the acceptance transaction. **Delete it and the derivation reappears at six call sites** (offer view, decision route, three enqueue gates, #679's worker guard) — spec §5.3 exists precisely to forbid that. |
| `src/lib/reviews/import-offer-view.ts` | **NEW module** (deviations D2) | `readImportOfferView(sql, businessId)` → discriminated union | Deep. Hides a three-table join (`businesses` × `zernio_backfill_runs` × `job_outbox`), the row-selection precedence, and the outbox-status → banner-state mapping. Delete it and ~40 lines of mapping land in a route handler, violating invariant #12. |
| `finalize-tx.ts` | Deepening | `finalizeConnectionTx(sql, args)` **unchanged** | **Net-negative.** The `needs_backfill` `SELECT` and its documented #41 over-fire are *deleted*. |
| `worker/ingress/stripe/shared.ts` | Deepening | `resumePrimaryBusinessBackfill(businessId)` **unchanged** | Gains junction offer-creation + the consent gate. The §5.2 bug dies inside the existing interface. |
| `src/lib/locations/archive-location-tx.ts` | Deepening | `reactivateLocationTransaction(...)` **unchanged** | The third enqueue gate. Owner-reachable via `src/app/api/locations/reactivate/route.ts:111` — the module header calling it "admin re-activate" (`:8`) is stale and should be corrected in the same edit. |
| `src/lib/locations/add-location-tx.ts` | Deepening | `addLocationTransaction(...)` **unchanged** | +25 lines, no branching (deviations D3). |
| `ImportOfferBanner.tsx` | **New adapter at an existing seam** | Same slot as `ConnectGoogleBanner` | Not a new seam — the dashboard banner seam already exists and already has an adapter that self-nulls. |

**Interface-reduction pass.** `importConsentStateSql` and `readImportConsent`
both ship because two consumers genuinely *compose* the predicate into a larger
query (`import-offer-view.ts` now, #679's `guardImportConsent` next) while four
only need the row. One derivation, two access shapes — not two derivations.

**Why `recordImportDecisionAndEnqueue` and not a bare transition.** Round 1
found the route was being handed `sql.begin` + the transition + a raw outbox
insert + an analytics enqueue while the plan simultaneously claimed routes only
"parse, call one module, map" (invariant #12). One domain function owns the
whole transaction; the route validates, calls it once, maps the outcome. This
also makes the rollback behaviour testable against live Postgres, which a
mocked route suite cannot prove.

**Testability.** Every export takes `sql` / `tx` as an explicit first parameter
(invariant #15). No module under `src/lib/**` imports `@/lib/db/server`; only
the route and the ingress composition roots do.

---

## 2. Test placement — which suites are live-DB, and why

The repo's convention, set by #674: **the mocked suite asserts the bindings,
the `*.integration.test.ts` suite asserts the SQL actually runs**
(`src/lib/reviews/__tests__/import-review.integration.test.ts:3-8`).

For this feature the load-bearing semantics are *in the SQL*: the derivation is
evaluated by Postgres `now()`, the F3 contract is a `WHERE` predicate on an
`UPDATE`, the offer view is a three-table join with row-selection precedence,
and the acceptance is a transaction that must roll back as a unit. A mocked
`sql` tag cannot falsify any of those. Four live suites:

| Live-DB suite | Covers |
|---|---|
| `src/lib/reviews/__tests__/import-consent.integration.test.ts` | derivation, boundary, offer creation + junction eligibility, F3 transitions, concurrency, the property test, the migration-101 CHECK assertion |
| `src/lib/reviews/__tests__/import-offer-view.integration.test.ts` | join correctness, status precedence, partial-count vs completed, stale/foreign row exclusion |
| `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts` | committed state after accept/decline, rollback on outbox failure, byte-identical rejected states, concurrent accepts → one job |
| `src/lib/locations/__tests__/add-location-tx.integration.test.ts` | consent lineage across archived siblings, incl. the URL-mode path |

All four use `describeWithDb`, `seedTenantAccount` / `cleanupTenantAccount`,
`assertSchemaReady` — and **never** apply migration SQL (CLAUDE.md gotcha;
`ci:live-db-suites` enforces it).

**Schema-readiness gap (round 1, F113).** `MIGRATION_100_IMPORT_CONSENT`
(`schema-ready.ts:389-400`) proves the columns and the constraint *name*, which
migration 101 did not change — so a DB stopped at 100 passes while carrying the
four-valued CHECK. The consent suite therefore asserts the three-valued
constraint *definition* itself, rather than trusting the helper.

**Mocked suites** everywhere else, each following the harness already in its
directory: `finalize-modules.test.ts`'s `vi.hoisted` + `txScenario` + `txCalls`
recorder (`:18-24`); `add-location-tx.test.ts`'s `mockSql` (`:14-20`); RTL for
the banner.

**No mocked twin for `import-consent.ts`** — the live suite covers its
semantics and each caller's own mocked suite covers the bindings. Round 1
rightly narrowed the rationale: the live suite must therefore itself assert
business-id binding and the no-row / no-offer classifications, which it now
does (titles 8–9). Called out so review does not read it as a gap.

**CI actually runs these** — `.github/workflows/ci.yml:118-133` gives the `test`
job a `postgres:16` service and sets `TEST_DATABASE_POOL_URL`, and `pnpm test`
runs at `:147-148`. The #520 "existing-but-never-run suite" class does not
apply.

---

## 3. Tasks (tracer bullets)

Glossary terms (**Import offer**, **Import consent**, **Review import**,
**Import window**, **Live-ingest cutoff**) are used verbatim per `CONTEXT.md`.
**Import offer** is the one term not yet in the glossary — T6 coins it; do not
cite it as pre-existing.

### T0 — EVAL: the definition of done, as failing tests · *runs alone*

**Blocking edges:** none. **Turns green:** nothing (that is the point).

Author all **70** `tests_to_add` titles VERBATIM as failing tests, committed
before any implementation. Slices not yet buildable use `.todo`; slices whose
failure is meaningful now assert and red.

Title numbers below index `tests_to_add` in **both intake copies**, which are the
authority. Re-derive the row you are about to author from the intake; do not
trust a range you remember.

| File | Titles | Count | Live DB? |
|---|---|---|---|
| `src/lib/reviews/__tests__/import-consent.integration.test.ts` | 1–13, 57–60, 62 | 18 | **yes** |
| `src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts` | 14–19 | 6 | no |
| `worker/ingress/stripe/__tests__/import-offer-resume.test.ts` | 20–23 | 4 | no |
| `src/lib/locations/__tests__/archive-location-tx.test.ts` (existing) | 24–25, 63–64 | 4 | no |
| `src/app/api/dashboard/import-offer/__tests__/route.test.ts` | 26–30, 34–39 | 11 | no |
| `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts` | 31–33, 61, 68 | 5 | **yes** |
| `src/lib/reviews/__tests__/import-offer-view.integration.test.ts` | 40–43, 66–67 | 6 | **yes** |
| `src/lib/locations/__tests__/add-location-tx.test.ts` | 45 | 1 | no |
| `src/lib/locations/__tests__/add-location-tx.integration.test.ts` | 44, 46–48, 65 | 5 | **yes** |
| `src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx` | 49–54, 69 | 7 | no |
| `src/components/dashboard/__tests__/` | 55–56 | 2 | no |
| `src/lib/reviews/__tests__/import-consent-lock-order-source.test.ts` | 70 | 1 | no (source tripwire) |

**The counts sum to 70 and the ranges partition 1–70 with no gap and no overlap.
Check that before authoring** — revision 4 shipped this matrix off by one from
title 14 onward (it was built against a numbering in which the `import-consent`
block held 14 titles; the intake's holds 13), which sent a `finalize-tx` title
into the consent suite, a `live DB:` rollback title into a *mocked* suite, and an
`ImportOfferBanner` title into the live `add-location` suite. Corrected
2026-08-07 at the start of execution; the add-location mocked/live split is the
owner's call of the same date, following §2 — only title 45 (no archived sibling
→ stays pending) is a mocked binding assertion, and all five lineage titles are
live.

**Every concurrency and SQL-semantics title is live-DB.** Titles 61 (concurrent
producers → exactly one job) and 62 (concurrent self-heal vs a decision) are
races that a mocked `sql` tag cannot express at all. Title 70 is a *source* tripwire in the
style of `location-lifecycle-lock-order-source.test.ts` — it reads the producer
files and asserts each acquires the `businesses` row lock before its topic
`INSERT`, which is the only check that survives a future producer being added.

**The eval's own bar — can this pass while the feature is still wrong?** The
assertions, not the titles, carry these:

1. **A `pending` offer importing anyway** → assert *zero* `job_outbox` rows with
   topic `zernio_initial_backfill`, not merely that the offer row was written.
2. **A late click writing** → assert the row is byte-identical after the
   rejected POST: decision, `decision_at`, `expires_at`, plus zero new outbox
   and zero new analytics rows.
3. **Terminal-state overwrite** → the property test generates *sequences* of
   transitions (accept/decline/expire-then-answer) and asserts the first
   terminal write is the last one that ever lands, at ≥100 runs. A single
   accept-then-decline example is too weak.
4. **A dead UI passing its tests** → the banner tests drive the buttons and
   assert the POST body and the post-response state, not just rendered copy.
5. **A feature that is never mounted** → title 55 asserts
   `DashboardOperationalContent` actually renders the banner.

`fast-check` house style: the "invariants" describe block in
`src/lib/reviews/__tests__/sentiment.test.ts:42-86`.

---

### T1 — `import-consent.ts`: the predicate, the offer, the acceptance transaction

**Blocking edges:** T0. **Turns green:** 1–14.

```ts
export const IMPORT_OFFER_WINDOW_DAYS = 7;

export type ImportConsentState = 'pending' | 'accepted' | 'declined' | 'expired';

/** The ONE spelling of spec §5.3's derivation. For composition into a larger
 *  query; prefer readImportConsent when the row is all you need. */
export function importConsentStateSql(sql: Sql, alias: string): PendingQuery;

export function readImportConsent(sql: Sql, businessId: string):
  Promise<{ state: ImportConsentState; decidedAt: Date | null; expiresAt: Date | null } | null>;

/** Idempotent. Stamps ONLY a pending row whose deadline is NULL, AND ONLY when
 *  the junction has actually been reached — activation non-NULL AND an active
 *  connection, both proven in this helper's own SQL. Deadline is
 *  now() + IMPORT_OFFER_WINDOW_DAYS; there is NO junction anchor (revision 4).
 *  Caller must hold the businesses row lock. */
export function createImportOffer(tx: TransactionSql, businessId: string):
  Promise<'created' | 'unchanged'>;

/** Owns the whole acceptance: sql.begin → guarded transition → (on accept) raw
 *  deduped job_outbox INSERT → analytics enqueue. Invariant #12: the route
 *  calls this once and maps the result. */
export function recordImportDecisionAndEnqueue(
  sql: Sql, businessId: string, accountId: string, decision: 'accepted' | 'declined',
): Promise<'recorded' | 'already_answered' | 'expired' | 'no_offer'>;
```

**The guarded predicate (round-1 Critical, F100).** The transition UPDATE is:

```sql
WHERE id = $businessId
  AND import_decision = 'pending'
  AND import_offer_expires_at IS NOT NULL
  AND import_offer_expires_at > now()
```

`IS NOT NULL` is load-bearing and is the fix for the round-1 Critical: migration
100 gives **every** business row `pending` + NULL deadline by DEFAULT
(`100_…sql:47-63`), so a predicate that admits NULL lets a direct POST
manufacture `accepted` consent for a location that was never offered anything —
and makes the advertised `no_offer` outcome unreachable. Zero rows matched is
then classified by re-reading the row: no row → `no_offer`; `pending` + NULL
deadline → `no_offer`; `pending` + passed deadline → `expired`; otherwise
→ `already_answered`.

**The re-read is race-free only under the row lock (round-2 Medium).** Under
READ COMMITTED a concurrent self-heal could turn NULL into a live deadline
between the `UPDATE` and the re-read, and the classifier would report
`already_answered` for a row that is in fact still answerable. The `FOR UPDATE`
below removes the window rather than adding a retry branch — the fix is
serialization, not a wider classifier.

**Every producer holds the `businesses` row lock (round-2 High ×2, owner
decision).** `recordImportDecisionAndEnqueue` opens `sql.begin` and takes
`SELECT … FROM businesses WHERE id = $1 AND account_id = $2 FOR UPDATE` as its
first statement; so does every other producer (T3, T4). That single discipline
retires three separate round-2 findings: the `INSERT … WHERE NOT EXISTS`
check-then-insert race, the unresolved transaction-shape finding (F107), and the
classification race above. **`SELECT … FOR UPDATE` is a no-op outside
`sql.begin()`** under Supabase's transaction pooling (CLAUDE.md gotcha) — so a
producer without its own transaction is not "mostly safe", it is unprotected.
Chosen over migration 004's partial-unique-index precedent because it needs no
migration; the trade — enforcement by convention rather than by constraint — is
recorded in §5.

**Junction eligibility lives INSIDE the SQL (round-2 High).** Revision 2 guarded
only on `pending` + NULL deadline and trusted callers to be junction sites. The
GET self-heal (T4) breaks that assumption — it runs from a read path with no
junction of its own. Combined with Postgres `GREATEST(NULL, x) = x`, a location
holding *one* half of the junction would have been handed an offer. So the
`UPDATE` itself requires, in the same statement:

- `accounts.subscription_activated_at IS NOT NULL`, **and**
- an `active` `zernio_connections` row for the business.

Both are required in the same statement, so a one-sided location cannot be
handed an offer. (Revisions 2–3 also *combined* those two timestamps with
`GREATEST` to derive the deadline, which is where `GREATEST(NULL, x) = x` bit.
Revision 4 deletes that expression — but the eligibility requirement stands on
its own and is what the round-2 High actually asked for.)

**There is no junction anchor. The deadline is `now() + INTERVAL '7 days'`
(owner adjudication, 2026-08-06, closing round 3).**

Revisions 2 and 3 tried to anchor the deadline to the junction so that a
self-healed offer would carry the deadline the junction *would* have produced.
That property was **self-invented** — no spec decision requires it — and it cost
two review rounds and two High findings: first `connected_at` turned out to be
mutable on reconnect (`finalize-tx.ts:123-132`), then `MIN(created_at)` turned
out to be ambiguous across the real disconnect lifecycle, where disconnect
preserves the old row as `disconnected` (`disconnect/route.ts:251-262`) and
finalize INSERTs a *new* active row.

It is unnecessary because **`createImportOffer` writes the deadline exactly
once** — only when it is NULL. So the anchor never applied to the normal path at
all; it only ever governed locations whose junction-time write *failed* and were
later repaired by the GET self-heal. For that narrow population, starting the
clock at the repair gives the owner a full 7 days from when they could first
have seen the offer, which is the more defensible behaviour anyway. Spec §2.2's
decay argument operates on months and is untouched by a repair measured in
minutes to days.

The junction *eligibility* check above stays — that fix was independent and
round 3 confirmed it closed. What is deleted is the connection-history SQL, the
`GREATEST` expression, and the interval reasoning that came with them.

Other constraints:
- Fragment shape precedent: `suppressionMatchSql`
  (`src/lib/solicitation/suppression.ts:75-92`).
- `now()` is Postgres's, never a JS `Date` — the timestamptz µs-truncation class
  (CLAUDE.md gotcha) must not reach this boundary.
- The read-side `<=` boundary is inclusive, spelled exactly as §5.3 writes it.
- The outbox INSERT dedups against `OUTBOX_IN_FLIGHT_STATUSES`
  (`src/lib/shared/job-outbox-status.ts:34`), re-spelled byte-for-byte and
  never parameterized (invariant #2's contract).
- No `@/lib/db/server` import (invariant #15).
- Also lands in T1 so T3/T4 can both use them: `import_offer_created` and
  `import_decision_recorded` in `ANALYTICS_EVENT_NAMES`
  (`src/lib/analytics/events.ts`). **Not** in `CLIENT_ENQUEUEABLE_EVENT_NAMES` —
  these are durable server facts.

---

### T2 — `add-location-tx.ts`: inherit the archived sibling's Import consent

**Blocking edges:** T0 *(independent of T1 — no predicate needed, deviations D3)*.
**Turns green:** 45–49.

Inside the existing `sql.begin`, after the `INSERT INTO businesses`
(`:214-241`): one `UPDATE … FROM (SELECT … LIMIT 1)` copying all three consent
columns verbatim from the archived sibling.

**Lineage key (round-1 F103, corrected by round-2 Medium).** Revision 2 chose
the match key from the **new row only** — place id if it has one, else maps url.
That still misses the cross-representation case: a new row carrying a canonical
place id against an archived row for the same place whose place id was never
resolved. URL-mode adds deliberately store a `google_maps_url` with a NULL
`google_place_id` until `validate_place_id` resolves it
(`add-location-tx.ts:263-279`), so both directions occur in practice.

The match is therefore a **disjunction over non-NULL keys**: a sibling qualifies
when its `google_place_id` equals the new row's (both non-NULL) **OR** its
`google_maps_url` equals the new row's (both non-NULL). Never NULL to NULL, in
either column. Both directions are pinned by test (titles 48 and 49).

**Ordering (round-1 Medium, F104).** `ORDER BY archived_at DESC, created_at
DESC, id DESC` — `archived_at` alone is nondeterministic on a tie. Scoped by
`account_id` (invariant #8).

No branching on the sibling's state — every case lands correctly (deviations
D3's table). A follow-up `UPDATE` rather than rewriting the `VALUES` into a
`SELECT`: smaller diff, leaves the existing insert untouched.

---

### T3 — All three enqueue producers: gate, dedup, and create the offer

**Blocking edges:** T1. **Turns green:** 15–26.
**Runs in parallel with T4** (disjoint files, no shared edges).

Every producer follows the same shape: **create the offer if this is the
junction; enqueue only on `accepted` with no completed run and no in-flight
row; log the blocked reason otherwise.**

**`finalize-tx.ts`** — inside the existing tx, replacing the `needs_backfill`
block (`:187-232`):
- `subscription_activated_at` non-null → `createImportOffer`, plus
  `enqueueAnalyticsEvent` for `import_offer_created` when it returns `'created'`
  (the `gbp_connected` call at `:167-178` is the precedent).
- Enqueue **only** when consent is `'accepted'`, no `zernio_backfill_runs` row
  has `completed_at IS NOT NULL`, and no in-flight `zernio_initial_backfill`
  outbox row exists (round-1 High, F101 — accept-then-reconnect otherwise
  inserts a second job; the Stripe path already dedups at `shared.ts:145-150`
  and is the pattern to copy).
- **Delete** the `needs_backfill` `SELECT` and its `#41` over-fire comment
  (`:187-209`) — the new predicate has no over-fire, so the comment describes
  nothing. Note it is a plain `SELECT`, not a CTE; revision 1 misnamed it.
- The `subscription_activated_at IS NULL` warn branch (`:234-240`) is unchanged.

**`worker/ingress/stripe/shared.ts`** (`maybeEnqueueBackfillResume`, `:92`):
- **Wrap the whole thing in `sql.begin` with the `businesses` row lock first**
  (round-2 F107, still open after revision 2). Today this path runs on root
  `sql` with no transaction, so `createImportOffer` — which requires
  `TransactionSql` — had no transaction to run in, and its dedup check was
  unserialized.
- The existing target query (`:95-120`) already establishes the junction. On a
  hit: `createImportOffer` + the analytics event, then enqueue **only** on
  `'accepted'`. This is the §5.2 fix.
- **Offer creation must sit before the `zernioPublishingEnabled()` early return**
  (round-1 Medium, F106): the kill switch governs *publishing*, and skipping
  durable offer creation behind it would silently lose the offer with no replay.
- Existing in-flight dedup and the best-effort boundary (`:173-179`) unchanged.
  Best-effort is acceptable **only because** T4's GET self-heal exists — do not
  drop one without the other.

**`src/lib/locations/archive-location-tx.ts`** (`reactivateLocationTransaction`,
`:377`) — the third gate, absorbed from #676 (round-1 High, F102; owner
re-decision 2026-08-06). **Consent gate ONLY — nothing else about this path
changes** (round-2 High ×2):

- The existing catch-up condition is
  `if (backfillContext && lockedAccount.subscription_activated_at)` (`:507`).
  One conjunct is added: Import consent is `'accepted'`. That is the whole edit.
- **Do NOT apply the completed-run predicate or the in-flight dedup here.**
  Revision 2 did, and it was wrong twice over. Reactivation enqueues with
  `backfill_reason: 'reactivation'` (`:516`), and the worker's
  `ON CONFLICT (business_id) WHERE run_reason = 'initial' DO NOTHING`
  (`ZernioBackfillWorker.ts:170`) deliberately does **not** dedup it — the
  archived-period catch-up is *supposed* to run again after a completed initial
  run. A generic "no completed run" gate would have silently deleted that
  feature. The in-flight variant additionally opened a lost-recovery race
  against a worker holding a stale `archived_at` read
  (`job-eligibility.ts:60-81`).
- Already inside `sql.begin` with the account and business rows locked, so the
  row-lock discipline is satisfied without new code.
- This path is **owner-reachable** (`src/app/api/locations/reactivate/route.ts:111`).
  Left un-gated, an owner who declined could archive and reactivate from the
  locations UI to get the import anyway — a D8 violation with no SQL required.
- Correct the stale "admin re-activate" header comment at `:8` in the same edit.
- Reactivation does **not** create an offer: spec §7 "re-connect after
  declining → stays declined". It only honours the consent already on the row.

---

### T4 — `import-offer-view.ts` + `GET`/`POST /api/dashboard/import-offer`

**Blocking edges:** T1. **Turns green:** 27–44.
**Runs in parallel with T3.**

`readImportOfferView(sql, businessId)`:

```ts
| { state: 'none' }
| { state: 'offer'; expiresAt: string }
| { state: 'importing' }
| { state: 'imported'; count: number }   // zernio_backfill_runs.imported_count
| { state: 'empty' }
| { state: 'failed' }
```

Precedence rules — each one is a round-1 finding, not a preference:
- **`completed_at` decides done, never `imported_count`.** `imported_count`
  DEFAULTs to 0 (`100_…sql:65-67`) and is written incrementally
  (`ZernioBackfillWorker.ts:379`), so a mid-run read with a positive partial
  count is still `importing`, and `empty` requires `completed_at IS NOT NULL
  AND imported_count = 0`.
- **Outbox status maps per the `draft-status` precedent** (`:95-143`): the
  in-flight set → `importing`; every terminal non-`completed` status → `failed`.
  Import the set, never re-spell it.
- **Row selection is explicit**: the run and outbox rows are scoped to this
  `business_id` and this account, newest first — a stale or foreign row must
  never win the join (invariant #8).

**`GET`** — no CSRF wrapper (GETs are exempt, `draft-status:18-20`). Owner scope
via `resolveOwnerScope`. Polled by the banner while `importing`. **Also calls
`createImportOffer` idempotently** — the self-heal that makes best-effort offer
creation on the Stripe path safe (F105/F106). A self-healed offer starts its
7 days **at the repair**, not at the junction (revision 4): the owner gets a
full window from the first moment they could have seen the offer. Do not add an
anchor to make repair indistinguishable from on-time creation — that property
was invented, not required, and cost two review rounds.

Three constraints on the self-heal, each a round-2 finding:
- It runs in its own `sql.begin` holding the `businesses` row lock. A GET that
  writes is unusual but the write is idempotent and serialized; the alternative
  (a read path calling a `TransactionSql` helper with no transaction) is the
  F107 defect.
- It relies on `createImportOffer`'s own junction predicate — the route does
  **not** re-implement a junction check, and must not call the helper "when at
  the junction" as revision 2 phrased it. One owner for that condition.
- On `'created'` it emits `import_offer_created` **in the same transaction**.
  Revision 2 omitted this, so an offer that only ever existed because the
  Stripe path failed would have been invisible in the analytics ratio the
  intake names as the churn signal.

**`POST`** — `withSameOrigin`, `resolveOwnerScope`, body `{ decision:
'accepted' | 'declined' }` validated with `zod`, then **one call** to
`recordImportDecisionAndEnqueue` and a mapping of its four outcomes to
responses. No `sql.begin` in the handler (invariant #12).

---

### T5 — `ImportOfferBanner.tsx` + dashboard wiring

**Blocking edges:** T4. **Turns green:** 50–57.

Client component beside `ConnectGoogleBanner`, same `banner` / `banner-blue` /
`banner-attn` classes, same `Icon`, returns `null` on `{ state: 'none' }`.
`useQuery` + `useMutation` per `DashboardContent`'s existing pattern
(`:33-46`), with `refetchInterval` active **only** while `state === 'importing'`
and the query key including the scoped location id (round-1 High, F110 — a
key that omits location serves location A's offer on location B).

Copy is locked and lands verbatim (D10 + the mandatory reassurance line):

> **Import your recent reviews?**
> We can pull in your 100 most recent Google reviews from the past year so you
> can generate replies for them. Nothing gets posted — you choose what to reply
> to.
> This is a one-time import, available for the next 7 days. New reviews will
> still be handled automatically either way.
>
> `[ Import my reviews ]  [ No thanks ]`

Terminal states, same banner:
- `importing` → "Importing your reviews… this usually takes a minute."
- `imported` → "Imported {count} reviews. They're in your reviews list."
- `empty` → "No recent reviews found — nothing to import."
- `failed` → a neutral "We couldn't finish importing your reviews" with support
  contact; **no retry button** (retry is the worker's, via the `completed_at IS
  NULL` sentinel — an owner-facing retry would enqueue a second job).

State advances only on a **successful** response — an optimistic flip to
`importing` after a failed POST is exactly what title 52 exists to catch.
Rendered inside `DashboardOperationalContent` (`DashboardContent.tsx:125`) next
to the Connect banner slot (`:310-320`). Consult `repworth-brand-design` before
writing markup. `LiveRegion` announces the importing → terminal transition.

---

### T6 — Docs sweep

**Blocking edges:** T1–T5.

- `CONTEXT.md`: **coin "Import offer"** (the one-time, per-location offer created
  at the subscribe+connect junction, deadline junction + 7 days, answerable only
  while it exists and is live) beside the existing **Import consent** entry, with
  the `_Avoid_` list and `*(coined in #677)*` attribution the file's entries use.
  Also correct the **Import consent** entry, which currently states the
  fail-closed worker guard as built — it is #679's and does not exist yet
  (round-1 cited-artifact check).
- `docs/directory.md`: the two new `src/lib/reviews/` modules, the route, the
  banner.
- `docs/superpowers/plans/feat-679-…-deviations.md`: record that #679's plan
  drops `importConsentStateSql` (deviations D1).
- The tracker: #676 is absorbed — note it on the issue at merge, don't retitle now.

---

## 4. Execution order

```
T0  (alone, then enforcement spot check)
 ├── T1 ──┬── T3 ─┐
 │        └── T4 ─┴── T5 ── T6
 └── T2 ──────────────────────┘
```

Parallel pairs: **T1 ‖ T2**, then **T3 ‖ T4**. Everything else serial.

---

## 5. Known limitations, stated rather than hidden

- **`main` still lacks the worker-side fail-closed guard until #679.** A
  hand-inserted `zernio_initial_backfill` row imports without consent. All three
  *product* paths are closed by this ticket; the manual admin path is #679's,
  by explicit non-goal. Merge order **#677 → #679 → #676(absorbed)** is the
  mitigation, and ADR 0015 accepts the interim state while production holds zero
  customers.
- **Inheriting `accepted` from an archived sibling re-imports for the new row.**
  Deliberate: the new business row has its own empty inventory and the owner did
  consent for that place. "One-time" is per business row. Flagged by round 1 at
  65% confidence as a product question; recorded here rather than silently
  resolved.
- **Single-enqueue is enforced by convention, not by constraint.** The
  `businesses` row lock makes the check-then-insert dedup safe at all four
  producers, but a future producer that skips the lock reopens the race. Migration
  004 chose a partial unique index for this class on `sync_reviews`; the owner
  chose the lock here (2026-08-06) to keep this ticket migration-free. If a fifth
  producer ever appears, revisit — the index is the durable answer.

---

## 6. Review appendix — round 1 triage

Full report: `docs/reviews/feat-677-import-offer-prompt-decision/plan-review-round-1.md`.
Verdict `REVISE`. 33 proposed missing tests, 16 plan-level findings.

**ACCEPTED and folded into this revision** — F100 (Critical: NULL deadline
answerable → `IS NOT NULL` in the guard, `no_offer` classification, title 9);
F101 (in-flight dedup at all producers); F102 (reactivation is owner-facing →
third gate absorbed, owner re-decision); F103 (URL-mode lineage via
`google_maps_url`); F104 (deterministic tie-break + account predicate); F105 +
F106 + F107 (junction-anchored deadline + GET self-heal + offer creation ahead
of the kill switch — one fix retires all three); F108 (live-DB view suite);
F109 + F112 (acceptance transaction extracted to a domain module, live-DB
rollback test); F110 (banner interaction/terminal/polling/mount/scope tests);
F111 (narrowed the no-mocked-twin rationale, added binding + no-row titles);
F113 (assert the migration-101 CHECK definition, not the helper). Test count
28 → 57; estimates 600/1250 → 780/2100 prod/test lines.

**REJECTED, with reasoning:**

| Finding | Verdict |
|---|---|
| `ZernioBackfillWorker no-op-completes hand-inserted jobs…` | Out of scope — explicit intake non-goal, it is #679's entire ticket. Recorded as a merge-order dependency in §5 instead of duplicated here. |
| `declining Review import does not change live-ingest eligibility` | Already a declared test on #679's intake (`ZernioReviewIngestWorker does not consult import consent…`). This diff never touches the ingest lane, so the assertion belongs where the guard is added. |
| Full composed lifecycle: `declined URL-mode place … after Place ID resolution, re-add, and reconnect` | The unit-level halves are covered (titles 48–49, 25–26). The composed lifecycle is staging-ride evidence, not a unit test. |
| `live DB: an unanswered offer returns none at T+7d and no reconnect/activation/reactivation path enqueues it` | Duplicative — covered per-path by titles 16, 24, 25. |
| Separate polling and `LiveRegion` titles | Merged into title 55 rather than split. |

**Cited-artifact check** returned three real misses, all corrected above: the
`needs_backfill` "CTE" is a plain `SELECT`; `duplicate-place-id.integration.test.ts`
does *not* already own the archived-sibling shape (a new
`add-location-tx.integration.test.ts` does); and **`CONTEXT.md` has no "Import
offer" entry** — revision 1 wrongly listed it among terms already in the
glossary. It also caught that the POST `draft` route now uses a typed
`enqueueGenerateResponse` rather than a raw insert, so the intake's precedent
wording was corrected. Everything else the plan cited was verified present.

---

## 7. Review appendix — round 2 triage

Full report: `docs/reviews/feat-677-import-offer-prompt-decision/plan-review-round-2.md`.
Verdict `REVISE`. Verification-only and it stayed in scope — the
`NEW — UNTRIAGED` appendix is empty. Six round-1 findings confirmed fully
addressed (F102, F104, F106, F109, F111, F112, F113); the rest were `PARTIAL`
or, for F107, `NO`. Ten defects introduced by revision 2's own fixes.

**ACCEPTED and folded into revision 3** — every High and Medium:

| Defect | Fix |
|---|---|
| `createImportOffer` did not prove the junction; `GREATEST(NULL, x) = x` allowed a one-sided pre-junction offer | Junction eligibility moved into the helper's `UPDATE`: activation non-NULL **and** an active connection, both required before `GREATEST` |
| `connected_at` is mutable on reconnect, so repair could extend the 7-day window | ~~Anchor on `MIN(zernio_connections.created_at)`~~ — **superseded by revision 4**: round 3 showed that anchor is ambiguous too, and anchoring was dropped entirely (§8). Historical record only; do not implement this row. |
| `WHERE NOT EXISTS` dedup is check-then-insert | `businesses` row lock at every producer (owner decision over migration 004's index) |
| F107 still open — `TransactionSql` helper called with no transaction | Stripe path and GET self-heal each open `sql.begin` |
| Reactivation lost accepted-but-incomplete recovery against a stale-`archived_at` worker read | Dropped the in-flight dedup at that producer entirely |
| Reactivation's generic completed-run predicate suppressed the archived-period catch-up | Consent gate **only**; `backfill_reason: 'reactivation'` semantics untouched |
| Zero-row classification race on concurrent self-heal | Removed by the row lock, not by widening the classifier |
| Lineage key chosen from the new row only, missing the cross-representation case | Disjunction over non-NULL keys, both directions pinned |
| Live view suite omitted positive-complete and pending-offer SQL | Titles 66–67 |
| Banner suite omitted `imported` rendering and `LiveRegion` | Title 69 |
| Self-heal did not emit `import_offer_created` | Emitted in the same transaction; title 68 |
| Intake still misstated the `draft` route as a thin domain-call precedent | Reworded to cite only its real CSRF / scope / zod traits |

**Rejected-finding reassessment.** Round 2 judged three of revision 2's five
rejections defensible and two **not**:

- *Full URL-mode composed lifecycle* — **rejection withdrawn.** It was rejected
  on the premise that titles 48–49 covered the lineage; round 2 showed the
  cross-representation hole survived. The lineage fix plus title 66 now covers
  the mechanism; the composed resolution→re-add→reconnect lifecycle remains
  staging-ride evidence, which is the right home for it, but it is now listed
  explicitly in the staging plan rather than waved off.
- *Merged polling / `LiveRegion` titles* — **rejection withdrawn.** Title 55
  named polling only. Title 70 now names the announcement explicitly.

**Sizing.** Round 2 assessed 57 tests / ~2,880 lines as large but cohesive and
advised **against** splitting: the producer gates, the API, and the UI depend on
each other, and D5's reclassification gate is the right instrument. Revision 3
takes that advice. Estimates raised to **800 prod / 2400 test** — the figures
carried by both intake copies, which are what step 5's `reclassify` row measures
against. (Revision 3 drafted 850; the intake landed at 800. The intake wins.)

---

## 8. Review appendix — round 3 triage (FINAL round)

Full report: `docs/reviews/feat-677-import-offer-prompt-decision/plan-review-round-3.md`.
Verdict `REVISE` with four ranked items. `NEW — UNTRIAGED` empty again.

**Confirmed closed by round 3** — junction eligibility in SQL (incl. the
`pending`-connection race, which cannot occur: `finalizeConnectionTx` is the
only production connection INSERT and it writes `active`); the row lock, with
**no lock-order inversion** against `location-lifecycle-lock-order-source.test.ts`
or `status-lock-order-source.test.ts`, and exactly four producer sites; both
reactivation defects; the zero-row classification race; F107; the false
draft-route precedent; the self-heal analytics omission.

**The one substantive item — the anchor — went to the owner** per the round-3
stop rule, and was adjudicated 2026-08-06: **drop anchoring entirely.** Rationale
and the two rejected alternatives are recorded in T1. This deletes the finding
rather than answering it — the connection-history SQL, the `GREATEST`
expression, and the disconnect/reconnect interval reasoning all go away with it.
The lesson is worth carrying: **position-independence was a property I invented,
not one the spec asked for**, and it generated two High findings across two
rounds before being removed.

**The other three items were clerical misses of mine, fixed without argument:**

| Item | Fix |
|---|---|
| T0 still said "all 57" with a matrix ending at 57, while the intake held 70 — an implementer would have authored 57 and skipped every round-2 fix | T0 rewritten to 70 with every title assigned a suite **and** an explicit live-DB column |
| Title 66 asserted equal place ids with differing URLs — the ordinary branch, not the cross-representation hole it claimed to close | Retitled (now 65) to require: new row place id non-NULL, archived sibling place id NULL, equal maps URLs, consent inherited |
| Title 62 said "concurrent producers" without naming which, and read across all four it contradicted reactivation's deliberate recurrence | Names acceptance vs connect-finalize; reactivation explicitly excluded from the exactly-one-job assertion; new title 70 is a source tripwire proving every producer takes the lock before its INSERT |
| Intake edge cases + invariant 14 + deviations D3 still carried revision 2's superseded `GREATEST(…, connected_at)` and "place id else URL" | Both intake copies and D3 reconciled to the adjudicated contract; verified zero stale `GREATEST(subscription_activated_at` references remain |

**Round 3 was the final round.** The owner's adjudication substitutes for
`APPROVED`; the plan is locked and step 4 may begin.
