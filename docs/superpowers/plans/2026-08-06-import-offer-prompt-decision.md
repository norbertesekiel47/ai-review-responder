# #677 — Import offer: decision API + prompt UI + importing state

**Branch:** `feat-677-import-offer-prompt-decision`
**Intake:** `docs/superpowers/plans/feat-677-import-offer-prompt-decision-intake.json`
**Design of record:** `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`
(§3 user flow, §4 data model, §5.2 the resume bug, §5.3 derived expiry, §7 edge cases)
**Rollout posture:** `docs/adr/0015-consented-import-unflagged-replacement.md` (R1 no flag, R2 ordering)
**Map:** #667 · **Blocked by:** #673 ✅, #675 ✅, #668 ✅ · **Gates:** #676

---

## 1. Design pass (`codebase-design`)

Named in the skill's vocabulary. Two new modules, four deepenings, zero
widened interfaces.

| Module | New or deepening | Interface | Depth / deletion test |
|---|---|---|---|
| `src/lib/reviews/import-consent.ts` | **NEW module, new seam** | `importConsentStateSql`, `readImportConsent`, `createImportOffer`, `recordImportDecision`, `IMPORT_OFFER_WINDOW_DAYS` | Deep. Hides the three-valued enum + derived expiry + the F3 atomic-transition `WHERE` discipline + the 7-day window. **Delete it and the derivation reappears at five call sites** (offer view, decision route, finalize-tx, stripe resume, #679's worker guard) — spec §5.3 exists precisely to forbid that. |
| `src/lib/reviews/import-offer-view.ts` | **NEW module** (see deviations D2) | `readImportOfferView(sql, businessId)` → discriminated union | Deep. Hides a three-table join (`businesses` × `zernio_backfill_runs` × `job_outbox`) and the outbox-status → banner-state mapping. Delete it and ~40 lines of mapping land in a route handler, violating the "route handlers orchestrate only" working rule. |
| `finalize-tx.ts` | Deepening | `finalizeConnectionTx(sql, args)` **unchanged** | **Net-negative.** The `needs_backfill` CTE and its documented #41 over-fire are *deleted*, replaced by `consent = 'accepted' AND NOT EXISTS(completed run)`. |
| `worker/ingress/stripe/shared.ts` | Deepening | `resumePrimaryBusinessBackfill(businessId)` **unchanged** | Gains junction offer-creation + the consent gate. The §5.2 bug dies inside the existing interface. |
| `src/lib/locations/add-location-tx.ts` | Deepening | `addLocationTransaction(...)` **unchanged** | +15 lines, no branching (deviations D3). |
| `ImportOfferBanner.tsx` | **New adapter at an existing seam** | Same slot as `ConnectGoogleBanner` | Not a new seam — the dashboard banner seam already exists and already has an adapter that self-nulls. |

**Interface-reduction pass.** `importConsentStateSql` and `readImportConsent`
both ship because two consumers genuinely *compose* the predicate into a larger
query (`import-offer-view.ts` now, #679's `guardImportConsent` next) while three
only need the row. One derivation, two access shapes — not two derivations.

**Testability.** Every export takes `sql` / `tx` as an explicit first parameter
(invariant #15). No module under `src/lib/**` imports `@/lib/db/server`; only
the route and the ingress composition roots do.

---

## 2. Test placement — which suites are live-DB, and why

The repo's convention, set by #674: **the mocked suite asserts the bindings,
the `*.integration.test.ts` suite asserts the SQL actually runs**
(`src/lib/reviews/__tests__/import-review.integration.test.ts` header).

For this feature the load-bearing semantics are *in the SQL*: the derivation is
evaluated by Postgres `now()`, and the F3 contract is a `WHERE` predicate on an
`UPDATE`. A mocked `sql` tag cannot falsify either. So:

- **Live-DB** (`src/lib/reviews/__tests__/import-consent.integration.test.ts`):
  test titles 1–8 + the property test. Uses `describeWithDb`,
  `seedTenantAccount`/`cleanupTenantAccount`, `assertSchemaReady` — **never**
  applies migration SQL (CLAUDE.md gotcha; `ci:live-db-suites` enforces it).
- **Live-DB** (`src/lib/locations/__tests__/duplicate-place-id.integration.test.ts`,
  existing file): the archived-sibling inheritance proof — this is already the
  suite that owns the archived/active `google_place_id` uniqueness shape.
- **Mocked** everywhere else, each following the harness already in its
  directory: `finalize-modules.test.ts`'s `vi.hoisted` + `txScenario` +
  `txCalls` recorder; `add-location-tx.test.ts`'s `mockSql`; RTL for the banner.

**No mocked twin for `import-consent.ts`.** #674 needed both because
`importReview` shipped callerless. Here every export has callers whose own
mocked suites assert the bindings, so a bindings-only twin would be duplicate
coverage. Called out here so review does not read it as a gap.

**CI actually runs these** — `.github/workflows/ci.yml:118-133` gives the `test`
job a `postgres:16` service and sets `TEST_DATABASE_POOL_URL`. The #520
"existing-but-never-run suite" class does not apply.

---

## 3. Tasks (tracer bullets)

Each is a thin vertical slice. Glossary terms (**Import offer**, **Import
consent**, **Review import**, **Import window**, **Live-ingest cutoff**) are
used verbatim per `CONTEXT.md`.

### T0 — EVAL: the definition of done, as failing tests · *runs alone*

**Blocking edges:** none. **Turns green:** nothing (that is the point).

Author all 28 `tests_to_add` titles VERBATIM as failing tests, committed before
any implementation. Slices not yet buildable use `.todo`; slices whose failure
is meaningful now use real assertions that red.

Files:

| File | Titles |
|---|---|
| `src/lib/reviews/__tests__/import-consent.integration.test.ts` | 1–8 (incl. the `fast-check` property test) |
| `src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts` | 9–11 |
| `worker/ingress/stripe/__tests__/import-offer-resume.test.ts` | 12–14 |
| `src/app/api/dashboard/import-offer/__tests__/route.test.ts` | 15–24 |
| `src/lib/locations/__tests__/add-location-tx.test.ts` (+ `duplicate-place-id.integration.test.ts`) | 25–26 |
| `src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx` | 27–28 |

**The eval's own bar — can this pass while the feature is still wrong?** Three
failure modes the titles must actually catch, not merely name:

1. **A `pending` offer importing anyway.** Title 9 must assert *zero*
   `job_outbox` rows with topic `zernio_initial_backfill`, not merely that the
   offer row was written.
2. **A late click writing.** Title 17 must assert the row is byte-identical
   after the rejected POST — decision, `decision_at`, and `expires_at` all
   unchanged — not merely that the response was non-200.
3. **Terminal-state overwrite.** The property test must generate *sequences*
   of transitions (accept/decline/expire-then-answer) and assert the first
   terminal write is the last one that ever lands, at ≥100 runs. A single
   accept-then-decline example test is too weak for this.

`fast-check` house style: the "invariants" describe block in
`src/lib/reviews/__tests__/sentiment.test.ts`.

---

### T1 — `import-consent.ts`: the predicate and the two transitions

**Blocking edges:** T0. **Turns green:** 1–8 + property test.

Exports:

```ts
export const IMPORT_OFFER_WINDOW_DAYS = 7;

export type ImportConsentState = 'pending' | 'accepted' | 'declined' | 'expired';

/** The ONE spelling of spec §5.3's derivation. For composition into a larger
 *  query; prefer readImportConsent when the row is all you need. */
export function importConsentStateSql(sql: Sql, alias: string): PendingQuery;

export function readImportConsent(sql: Sql, businessId: string):
  Promise<{ state: ImportConsentState; decidedAt: Date | null; expiresAt: Date | null } | null>;

/** Idempotent: stamps only a pending row with a NULL deadline. Never extends
 *  or restarts the clock. */
export function createImportOffer(tx: TransactionSql, businessId: string):
  Promise<'created' | 'unchanged'>;

/** F3 atomic transition: UPDATE … WHERE decision='pending' AND (expires_at IS
 *  NULL OR expires_at > now()). Guarded in the WHERE, never read-then-write. */
export function recordImportDecision(tx: TransactionSql, businessId: string, decision: 'accepted' | 'declined'):
  Promise<'recorded' | 'already_answered' | 'expired' | 'no_offer'>;
```

Constraints:
- Precedent for the fragment shape: `suppressionMatchSql`
  (`src/lib/solicitation/suppression.ts`).
- `now()` is Postgres's, never a JS `Date` — the timestamptz µs-truncation
  class (CLAUDE.md gotcha) must not reach this boundary.
- The `<=` boundary is inclusive, spelled exactly as §5.3 writes it.
- No `@/lib/db/server` import (invariant #15).
- Also lands in T1 so T2/T3 can both use them: the two new names in
  `ANALYTICS_EVENT_NAMES` (`src/lib/analytics/events.ts`) —
  `import_offer_created`, `import_decision_recorded`. **Not** added to
  `CLIENT_ENQUEUEABLE_EVENT_NAMES`: these are durable server facts.

---

### T2 — `add-location-tx.ts`: inherit the archived sibling's Import consent

**Blocking edges:** T0 *(independent of T1 — no predicate needed, deviations D3)*.
**Turns green:** 25–26.

Inside the existing `sql.begin`, after the `INSERT INTO businesses`, and only
when `googlePlaceId` is non-null: one `UPDATE … FROM (SELECT … ORDER BY
archived_at DESC LIMIT 1)` copying all three consent columns verbatim from the
most recent archived sibling for the same `(account_id, google_place_id)`.

No branching on the sibling's state — every case lands correctly (deviations
D3's table). Follow-up `UPDATE` rather than rewriting the `VALUES` into a
`SELECT`: smaller diff, leaves the existing insert untouched.

---

### T3 — The junction: create the offer, stop importing on connect

**Blocking edges:** T1. **Turns green:** 9–14.
**Runs in parallel with T4** (disjoint files, no shared edges).

**`finalize-tx.ts`** — inside the existing tx, replacing the `needs_backfill`
block:
- When `subscription_activated_at` is non-null → `createImportOffer(tx, businessId)`,
  and `enqueueAnalyticsEvent(tx, …)` for `import_offer_created` when it returns
  `'created'` (the `gbp_connected` call two blocks up is the precedent).
- Enqueue `zernio_initial_backfill` **only** when `readImportConsent` says
  `'accepted'` **and** no `zernio_backfill_runs` row has `completed_at IS NOT NULL`
  (the §5.1 retryable case: accepted, import never finished, owner reconnects).
- **Delete** the `needs_backfill` CTE and its `#41` over-fire comment. The new
  predicate has no over-fire, so the comment describes nothing.
- The `subscription_activated_at IS NULL` warn branch is unchanged.

**`worker/ingress/stripe/shared.ts`** (`maybeEnqueueBackfillResume`, reached by
both handlers through `resumePrimaryBusinessBackfill`):
- The existing target query already establishes the junction (active connection
  + activated subscription). On a hit: `createImportOffer` + the analytics event.
- Enqueue **only** when consent is `'accepted'`. This is the §5.2 fix — a
  declined location must not be re-imported by the next `past_due → active`.
- The in-flight outbox dedup and the best-effort error boundary are unchanged.

**Accepted limitation, to be stated in the PR:** offer creation here inherits
`resumePrimaryBusinessBackfill`'s best-effort posture (it runs *outside* the
activation tx — the billing flip is the load-bearing mutation). A failure means
the connect-then-subscribe owner gets no offer until a later junction event.
Same reliability class as the enqueue it replaces, so this is not a regression;
moving it into `apply-subscription-state.ts` would widen the surface into the
single status applier and was rejected.

---

### T4 — `import-offer-view.ts` + `GET`/`POST /api/dashboard/import-offer`

**Blocking edges:** T1. **Turns green:** 15–24.
**Runs in parallel with T3.**

`readImportOfferView(sql, businessId)` returns a discriminated union:

```ts
| { state: 'none' }                          // no pending offer, or already imported+seen
| { state: 'offer'; expiresAt: string }
| { state: 'importing' }
| { state: 'imported'; count: number }       // zernio_backfill_runs.imported_count
| { state: 'empty' }                         // completed run, imported_count = 0
| { state: 'failed' }
```

Mapping rule, from the `draft-status` precedent: every terminal
non-`completed` outbox status maps to `failed`; in-flight
(`pending`/`dispatching`/`dispatched`) maps to `importing`. The in-flight set is
the byte-for-byte contract owned by `src/lib/shared/job-outbox-status.ts` —
import it, never re-spell it (invariant #2).

**`GET`** — no CSRF wrapper (GETs are exempt, per the `draft-status` header
comment). Owner scope via `resolveOwnerScope`; polled by the banner while
`importing`.

**`POST`** — `withSameOrigin`, `resolveOwnerScope`, body `{ decision:
'accepted' | 'declined' }` validated with `zod`. One `sql.begin`:
`recordImportDecision` → on `'recorded' && accepted`, raw
`INSERT INTO job_outbox` for `ZERNIO_INITIAL_BACKFILL` (payload shape
`ZernioInitialBackfillPayload`, exactly as `finalize-tx.ts` builds it) →
`enqueueAnalyticsEvent` for `import_decision_recorded`. Non-`'recorded'`
outcomes map to responses and write nothing; the `'expired'` outcome also emits
the structured log line named in `observability`.

Route handlers orchestrate only: parse, call one module function, map the
outcome (invariant #12 / the working rule).

---

### T5 — `ImportOfferBanner.tsx` + dashboard wiring

**Blocking edges:** T4. **Turns green:** 27–28.

Client component beside `ConnectGoogleBanner`, same `banner` / `banner-blue`
classes, same `Icon`, returns `null` on `{ state: 'none' }`. `useQuery` per
`DashboardContent`'s existing pattern, with `refetchInterval` active **only**
while `state === 'importing'`.

Copy is locked and must land verbatim (D10 + the mandatory reassurance line):

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
  NULL` sentinel — an owner-facing retry would enqueue a second row).

Rendered inside `DashboardOperationalContent` next to `ConnectGoogleBanner`.
Consult `repworth-brand-design` before writing markup. `LiveRegion` announces
the importing → terminal transition (the surrounding code already uses it).

---

### T6 — Docs sweep

**Blocking edges:** T1–T5.

- `CONTEXT.md`: coin **Import offer** (the one-time, per-location, 7-day offer
  created at the subscribe+connect junction) next to the existing **Import
  consent** entry, with the `_Avoid_` list and the `*(coined in #677)*`
  attribution the file's entries use.
- `docs/directory.md`: the two new `src/lib/reviews/` modules, the route, the
  banner.
- Record on #679's worktree deviations file that its plan drops
  `importConsentStateSql` (deviations D1).

---

## 4. Execution order

```
T0  (alone, then enforcement spot check)
 ├── T1 ──┬── T3 ─┐
 │        └── T4 ─┴── T5 ── T6
 └── T2 ──────────────────────┘
```

Parallel pairs: **T1 ‖ T2**, then **T3 ‖ T4**. Everything else serial.

## 5. Review appendix

Findings from the round-1 plan review and their disposition are appended here.
