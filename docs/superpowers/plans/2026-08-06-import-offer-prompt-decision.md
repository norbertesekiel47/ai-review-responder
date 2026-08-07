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

---

## 1. Design pass (`codebase-design`)

Named in the skill's vocabulary. Two new modules, five deepenings, zero widened
interfaces.

| Module | New or deepening | Interface | Depth / deletion test |
|---|---|---|---|
| `src/lib/reviews/import-consent.ts` | **NEW module, new seam** | `importConsentStateSql`, `readImportConsent`, `createImportOffer`, `recordImportDecisionAndEnqueue`, `IMPORT_OFFER_WINDOW_DAYS` | Deep. Hides the three-valued enum, the derived expiry, the F3 atomic-transition `WHERE` discipline, the junction-anchored deadline, and the acceptance transaction. **Delete it and the derivation reappears at six call sites** (offer view, decision route, three enqueue gates, #679's worker guard) — spec §5.3 exists precisely to forbid that. |
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
| `src/lib/reviews/__tests__/import-consent.integration.test.ts` | derivation, boundary, offer creation + anchoring, F3 transitions, concurrency, the property test, the migration-101 CHECK assertion |
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
does (titles 9–10). Called out so review does not read it as a gap.

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

Author all **57** `tests_to_add` titles VERBATIM as failing tests, committed
before any implementation. Slices not yet buildable use `.todo`; slices whose
failure is meaningful now assert and red.

| File | Titles |
|---|---|
| `src/lib/reviews/__tests__/import-consent.integration.test.ts` | 1–14 (incl. the `fast-check` property test) |
| `src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts` | 15–20 |
| `worker/ingress/stripe/__tests__/import-offer-resume.test.ts` | 21–24 |
| `src/lib/locations/__tests__/archive-location-tx.test.ts` (existing) | 25–26 |
| `src/app/api/dashboard/import-offer/__tests__/route.test.ts` | 27–31, 35–40 |
| `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts` | 32–34 |
| `src/lib/reviews/__tests__/import-offer-view.integration.test.ts` | 41–44 |
| `src/lib/locations/__tests__/add-location-tx.test.ts` + `add-location-tx.integration.test.ts` | 45–49 |
| `src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx` | 50–55 |
| `src/components/dashboard/__tests__/` | 56–57 |

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
5. **A feature that is never mounted** → title 56 asserts
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

/** Idempotent. Stamps ONLY a pending row whose deadline is NULL, and anchors
 *  the deadline to the junction — GREATEST(subscription_activated_at,
 *  connected_at) + IMPORT_OFFER_WINDOW_DAYS — not to the moment of the write. */
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

**Why the deadline is junction-anchored, not `now() + 7 days`.** It makes
creation *position-independent*: the primary creation at the junction, and the
GET route's idempotent self-heal (T4), produce the identical deadline. That is
what lets offer creation stay best-effort on the Stripe path without the
round-1 High (F105) failure — a transient failure delays the banner instead of
permanently denying the offer.

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

**Lineage key (round-1 High, F103).** Match on `google_place_id` when the new
row has one, **else** on `google_maps_url`. URL-mode adds deliberately store a
`google_maps_url` with a NULL `google_place_id` until `validate_place_id`
resolves it (`add-location-tx.ts:263-279`), so a place-id-only lookup silently
misses a declined URL-mode location and re-offers it. Never match NULL to NULL.

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
re-decision 2026-08-06):
- The catch-up enqueue (`:~505-529`) becomes conditional on `'accepted'` with
  the same completed-run + in-flight dedup.
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
`createImportOffer` idempotently** when the location is at the junction and
still has no deadline: this is the self-heal that makes best-effort offer
creation on the Stripe path safe (F105/F106). Because the deadline is
junction-anchored, a self-healed offer is indistinguishable from one created on
time.

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

---

## 6. Review appendix — round 1 triage

Full report: `docs/reviews/feat-677-import-offer-prompt-decision/plan-review-round-1.md`.
Verdict `REVISE`. 33 proposed missing tests, 16 plan-level findings.

**ACCEPTED and folded into this revision** — F100 (Critical: NULL deadline
answerable → `IS NOT NULL` in the guard, `no_offer` classification, title 10);
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
