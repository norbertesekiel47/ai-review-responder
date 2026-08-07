# Spec & correctness review — round 1 — `feat-677-import-offer-prompt-decision`

**Scope:** `git diff 349c8c57...HEAD` (36 files, ~6.0k insertions).
**Contract:** `.feature/intake.json` (LOCKED), checked field by field.
**Verdict:** **APPROVE WITH CHANGES.** The state machine, the transaction
boundaries, the four enqueue gates, tenant scoping and the lineage SQL are all
correct and well covered. Two of the three named exposures come back clean; the
third (`run_reason = 'initial'`) is applied where it was named but is
inconsistent with two sibling guards. The findings that matter are all on the
**edges of the accepted path**: the intake's replacement observability signal is
missing, and the banner has no behaviour at all for a rejected POST or for an
acceptance whose enqueue silently no-ops.

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | High | `src/lib/reviews/import-consent.ts:260-268` | The intake's `observability` item 2 — "a structured log line from the decision transaction on a rejected request, naming the rejection class (`no_offer`, `expired`, `already_answered`) and `business_id`" — is not implemented anywhere. Nothing logs on any of the three rejection branches. |
| 2 | High | `src/components/dashboard/account-state/ImportOfferBanner.tsx:73-81` | The decision mutation has no `onError`. A 409/404 leaves the banner rendering the offer with live buttons and no feedback — the named late-click edge case produces a button that visibly does nothing, forever. |
| 3 | Medium | `src/lib/reviews/import-consent.ts:330-333` + `src/lib/reviews/import-offer-view.ts:164-167` | An acceptance whose enqueue silently no-ops commits consent anyway and the banner reports `importing` permanently (4 s poll, no terminal state, no log). The intake's own stall counter-signal cannot detect it — there is no `zernio_backfill_runs` row. |
| 4 | Medium | `src/lib/reviews/import-consent.ts:317-319` + `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:228-234` | Both completed-run guards match **any** `run_reason`, while `import-offer-view.ts:94-96` scopes to `'initial'`. A completed `reactivation` run therefore permanently suppresses an initial import the view still reports as `importing`. |
| 5 | Medium | `src/components/dashboard/account-state/ImportOfferBanner.tsx:149,165,181` | `LiveRegion` is mounted **together with** its message on every terminal branch, which its own contract forbids ("Render it unconditionally"). Title 68's announcement will not fire in a real screen reader; the test asserts DOM presence, which cannot catch this. |
| 6 | Medium | `src/lib/reviews/__tests__/import-consent-lock-order-source.test.ts:69-120` | Title 69 claims "**every** `zernio_initial_backfill` producer"; the test reads four hard-coded paths. A fifth producer in a new file is invisible to it, contradicting the file's own claim at `:16-17` and weakening the owner's lock-over-unique-index decision. |
| 7 | Low | `src/lib/reviews/__tests__/import-consent-lock-order-source.test.ts` (whole file) | Deviations D9 names this test as the mitigation for the `b.`-alias contract. It never mentions the alias. Nothing in the repo enforces it. |
| 8 | Low | `src/lib/locations/__tests__/add-location-tx.test.ts:638-676` | Title 45 ("leaves import consent pending when no archived sibling exists") asserts the lineage UPDATE's **template text**, never the resulting consent state, and the no-sibling case has no live-DB twin. |
| 9 | Low | `src/lib/reviews/import-consent.ts:249-258, 358-363` | The guarded UPDATE and the outbox dedup subquery omit `account_id`, contradicting the module's own stated contract at `:112-118`. Safe today only because the preceding `FOR UPDATE` is account-scoped. |
| 10 | Low | `src/lib/reviews/import-offer-view.ts:125-130` | The `imported` / `empty` / `failed` banner is permanent — no dismissal, no TTL. Every dashboard render forever shows "Imported N reviews. They're in your reviews list." |

---

## Finding detail

### 1 — High: the decision-rejection log line does not exist (`observability` item 2)

`recordImportDecisionAndEnqueue` classifies the zero-row case into `no_offer` /
`expired` / `already_answered` at `import-consent.ts:260-268` and returns.
`route.ts:116-125` maps those to 404/409. Neither emits a log line.
`reportCaughtError` at `route.ts:127` fires only on a **thrown** exception, which
none of these are.

The locked intake's `observability` names this explicitly, and names the exact
scenario it is for: *"so 'the owner says the button did nothing' resolves to an
expiry or a missing offer rather than an outage."* Deviations D7 records that
analytics was deferred to #679 **on the condition** that the three log lines
stand in for it, and carries that forward to review verbatim: *"a deferral that
quietly took the replacement signal with it would leave the feature
unobservable."*

Two of the three lines exist and carry the named fields:

| Gate | Site | Names `business_id` | Names derived state |
|---|---|---|---|
| Connect finalize | `finalize-tx.ts:262-265` | ✅ | ✅ |
| Stripe activation resume | `worker/ingress/stripe/shared.ts:159-163` | ✅ | ✅ |
| Reactivation catch-up | `archive-location-tx.ts:569-572` | ✅ | ✅ |
| **Decision transaction** | — | ❌ | ❌ |

Combined with finding 2 this is the whole diagnostic loop for the single most
likely support ticket on this feature: the owner clicks and nothing happens, the
UI says nothing, and Railway logs say nothing.

Item 4 (stall counter-signal) is satisfied by construction *only for the stall
shape it describes* — see finding 3, which produces a stall with no run row at
all. Item 5 (no new metric/Sentry event) holds. **Zero new analytics emissions**
confirmed: `git diff 349c8c57...HEAD | rg '^\+.*enqueueAnalyticsEvent'` returns
only prose in docs and one comment in `import-consent.ts:24`;
`src/lib/analytics/events.ts` is untouched and absent from the edit surface.

### 2 — High: the banner has no rejected-POST path

```ts
// ImportOfferBanner.tsx:73-81
const decide = useMutation({
  mutationFn: postDecision,
  onSuccess: async () => { await queryClient.invalidateQueries({ queryKey }); },
});
```

`postDecision` (`:50-57`) throws on `!res.ok`. There is no `onError`, no error
render branch, and no invalidation on failure. So:

**Failure scenario.** Owner leaves the dashboard open. The offer's deadline
passes (nothing fires at the deadline, by design — #670 — so the banner stays on
screen). Owner clicks **Import my reviews**. POST → `expired` → 409. The
mutation rejects; `data` is still `{ state: 'offer' }` so the same banner
re-renders with both buttons re-enabled and no message. The owner clicks again,
and again. The route's own header at `:111-115` states the 409 exists *"so the
banner can distinguish 'your click was too late' from 'recorded' without
inspecting a body field"* — the banner never reads the status.

The intake names this outcome in `user_visible_behavior` ("An owner who answers
after the 7-day deadline gets no write and no import — the banner is already
gone, and a late request is rejected") and in `edge_cases` ("the route returns a
gone/conflict outcome"). The server half is implemented and well tested; the
client half of the same sentence is not implemented and has no test — the banner
suite (`ImportOfferBanner.test.tsx`) never returns a non-`ok` POST response.

Minimum fix: `onError` → invalidate the query (a re-fetch returns `none` for an
expired/answered offer, which makes the banner disappear, which is what the
intake promises).

### 3 — Medium: accepted-but-never-enqueued reports `importing` forever

`enqueueInitialImport` returns silently when its target query misses
(`import-consent.ts:330-333`), and the comment is explicit that this is
deliberate: *"The consent write still stands — consent and enqueue eligibility
are different questions."* The target query requires an `active`
`zernio_connections` row, `archived_at IS NULL`, `subscription_activated_at IS
NOT NULL`, and no completed run (`:314-327`).

`readImportOfferView` then takes the last branch at `:164-167`: accepted, no
initial run, no outbox row → `{ state: 'importing' }`. The banner polls that
every 4 s (`ImportOfferBanner.tsx:69-70`) and shows *"Importing your reviews…
this usually takes a minute."*

**Failure scenario.** Zernio emits `account.disconnected` (or the owner
disconnects) after the Import offer is created but before they answer. The
banner is still on screen. Owner clicks Import → 200 `recorded` → banner flips
to "Importing your reviews… this usually takes a minute" and stays there
indefinitely. Nothing is queued, nothing is logged, and the intake's stall
counter-signal ("an accepted import whose `zernio_backfill_runs` row still has
`completed_at` NULL") cannot see it, because **no run row was ever created**.

This contradicts `user_visible_behavior` item 4, which says the importing state
"then resolves to" one of three terminal states. It self-heals only if the owner
reconnects Google (finalize-tx re-enqueues on `accepted`); otherwise it is
permanent.

Two cheap mitigations, either sufficient: log the no-enqueue reason here (which
is also finding 1's line), and/or have `readImportOfferView` distinguish
"accepted with no run **and** no outbox row **and** no active connection" from
`importing`.

### 4 — Medium: the completed-run guards ignore `run_reason`, the view does not

Three places ask "has a run completed?" and two of them ask it differently from
the third:

| Site | Predicate | Scoped to `initial`? |
|---|---|---|
| `import-offer-view.ts:94-96` | `LEFT JOIN … AND br.run_reason = 'initial'` | ✅ |
| `import-consent.ts:317-319` | `LEFT JOIN … AND br.completed_at IS NOT NULL` | ❌ |
| `finalize-tx.ts:228-234` | `WHERE br.business_id = … AND br.completed_at IS NOT NULL` | ❌ |
| `worker/ingress/stripe/shared.ts:139-143` | `NOT EXISTS (… completed_at IS NOT NULL)` | ❌ (pre-existing) |

`import-offer-view.ts:52-62` documents *why* the view must scope: reactivation
runs recur by design and would otherwise flip the banner back to `importing`
months later. The same reasoning applies in the opposite direction to the
guards — a recurring reactivation run must not permanently suppress the
one-time import.

**Failure scenario** (narrow but real, and it is precisely the archive/reactivate
loop D4 exists to close):

1. Owner accepts. `enqueueInitialImport` queues the job.
2. Before the worker runs, the owner archives the location.
   `ZernioBackfillWorker` inserts the `initial` run row (`:148-171`) and *then*
   `guardZernioJobEligibility` skips on `archived_at`, leaving
   `completed_at NULL`.
3. Owner reactivates. Consent is `accepted`, so the catch-up enqueues with
   `backfill_reason: 'reactivation'`, and that run completes.
4. From here on: `finalize-tx` and `enqueueInitialImport` both see a completed
   run and refuse to enqueue the initial import — forever. Meanwhile the view,
   scoped to `initial` with `completed_at NULL`, reads the newest **shared-topic**
   outbox row (`import-offer-view.ts:138-145`, deliberately unfiltered), finds
   the reactivation row at `completed`, and returns `importing` (`:160`).

Net: the initial import never runs and the banner spins forever. Adding
`AND br.run_reason = 'initial'` to the two guards this branch owns makes all
three consistent; the Stripe one is pre-existing and out of surface.

### 5 — Medium: the terminal `LiveRegion` cannot announce

`src/components/ui/LiveRegion.tsx:9-12` states the contract in its own JSDoc:
*"Render it unconditionally and update `message`; screen readers only announce
changes to a region that already exists in the DOM."*

`ImportOfferBanner` renders it only inside the `imported` (`:149`), `empty`
(`:165`) and `failed` (`:181`) branches. The `importing` branch (`:125-136`)
renders none. So the live region is inserted into the DOM **already containing**
its message, at the same commit — the exact case the helper says will not
announce.

Title 68 ("…and announces the terminal transition through LiveRegion") asserts
`document.querySelector('[aria-live]')` exists and contains the text
(`ImportOfferBanner.test.tsx:228-230`), which passes on a region that no screen
reader will read. Fix: hoist one `<LiveRegion>` above the branch switch with a
derived message (`''` for `offer`/`importing`).

Related, lower: the `failed` branch nests `LiveRegion level="assertive"`
(`role="alert"`) inside a `<div role="alert">` (`:180-181`) — two alert roles for
one message.

### 6 — Medium: title 69 does not assert "every producer"

`import-consent-lock-order-source.test.ts` reads four hard-coded relative paths
(`:72, :86, :97, :114`) and checks marker ordering inside a named function in
each. It cannot see a producer that does not live in one of those four files, so
the title's "every … producer" is not what is asserted. The file's own
justification at `:16-17` — *"this is the only check that survives a FIFTH
producer being added, because it fails the moment a new enqueue site appears
without the lock above it"* — is false as written.

This matters more than a normal title/assertion gap because the owner chose the
`businesses` row lock **over** a partial unique index on `job_outbox`
(`non_goals`, invariant list, plan §5) partly on the strength of this tripwire.
A repo-wide scan for `INSERT INTO job_outbox` + `ZERNIO_INITIAL_BACKFILL` (or an
enumeration derived from `QUEUE_NAMES` usage) would make the title true; the
current form is a per-file regression guard, which is still valuable but should
be titled as such.

### 7 — Low: the `b.`-alias contract has no enforcement, and D9's named mitigation is not it

Current state is **correct**: `importConsentStateSql` is composed at exactly two
sites, and both alias `businesses` as `b`.

| Composer | Alias |
|---|---|
| `import-consent.ts:131` (`readImportConsent`) | `FROM businesses b` (`:134`) ✅ |
| `import-offer-view.ts:89` (`readImportOfferView`) | `FROM businesses b` (`:93`) ✅ |

The four producers all go through `readImportConsent`, so none of them touch the
fragment directly. So there is no live defect.

But deviations D9 states the mitigation is
`import-consent-lock-order-source.test.ts` — that file never mentions the alias,
`businesses b`, or `importConsentStateSql`. It checks lock ordering only. Nothing
in the compiler, the CI audits, or the test suite would catch a third composer
(#679's `guardImportConsent` is the next one) aliasing the table differently —
which, as `import-consent.ts:75-76` notes, either throws or silently derives
consent from the wrong row. A three-line source assertion in the same tripwire
file ("every file importing `importConsentStateSql` also contains
`businesses b`") would close it.

### 8 — Low: title 45 asserts SQL text, not the outcome

`add-location-tx.test.ts:638-676` asserts the lineage UPDATE was issued once and
that its template contains eight substrings. It never reads the resulting
`import_decision` — with a mocked `sql` it cannot. The five *positive* lineage
titles run live (D6's owner decision) and are strong; the negative case
("no sibling → stays pending") is the one that has no live twin, so the claim in
the title is unproven. It is also the case that guards the round-1 Critical (a
fresh location must not come out of add-location holding an answerable offer).

### 9 — Low: two statements infer tenancy instead of binding it

`import-consent.ts:112-118` states: *"Every function in this module takes
`accountId` and binds it directly, rather than inferring tenancy by correlating
to a `businesses` row (invariant #8)… 'the caller checked' is not a property the
next caller inherits."*

Two statements in the same module do exactly what that paragraph forbids:

- the guarded transition `UPDATE businesses … WHERE id = ${businessId} AND
  import_decision = 'pending' AND …` (`:249-258`) — no `account_id`;
- the outbox dedup `SELECT 1 FROM job_outbox jo WHERE jo.aggregate_id =
  ${businessId} …` (`:358-363`) — no account key.

Both are safe **today** because the account-scoped `FOR UPDATE` at `:240-247`
returns `no_offer` first for a foreign id. The finding is that the module's
stated invariant and the module's code disagree, on the two statements that
actually write.

### 10 — Low: the terminal banner is permanent

Once consent is `accepted` and the initial run has `completed_at`,
`readImportOfferView` returns `{ state: 'imported', count }` on every call
forever (`:125-130`) — there is no dismissal, no `import_decision_at` age check,
nothing. The dashboard permanently carries *"Imported 37 reviews. They're in your
reviews list."* Neither the intake nor spec §3 says the terminal state ever goes
away, so this is arguably as-designed; flagged because a banner that never
clears is a user-visible outcome nobody signed off on.

---

## Contract check — clean results

Recording these explicitly so the next round does not re-derive them.

### Edit-surface drift: **none**

All 36 changed paths fall inside `allowed_edit_surface`. `src/lib/shared/__tests__/**`
is declared but unused (the lock-order tripwire went to
`src/lib/reviews/__tests__/`, which is also in surface). No production file
outside the surface is touched; `src/lib/analytics/events.ts`,
`supabase/migrations/**`, `docs/analytics/events.md` and `src/lib/dashboard/**`
are all absent, as D7/D2 require.

### Scope creep: **none found**

Every behaviour in the diff maps to a `user_visible_behavior` or `invariants`
item. Two additions beyond the 69 titles are declared as such in their own
comments and are defensible (`route.test.ts:179` zod validation;
`route.integration.test.ts:260` `createImportOffer` under concurrency;
`import-offer-resume.test.ts:161` offer-creation before the kill switch).

### `user_visible_behavior`, item by item

| # | Item | Where | Verdict |
|---|---|---|---|
| 1 | Offer created at the junction, deadline +7d, banner shows for the location in scope | `import-consent.ts:185-199`, `DashboardContent.tsx:337-339` | ✅ |
| 2 | Copy verbatim incl. reassurance line | `ImportOfferBanner.tsx:92-119` | ✅ verbatim |
| 3 | Accept records + enqueues in one tx, returns immediately, never blocks on Zernio | `import-consent.ts:234-274` | ✅ |
| 4 | importing → imported / empty / failed | `import-offer-view.ts:118-167` | ⚠️ findings 3, 4 |
| 5 | Decline records, banner gone permanently, nothing fetched, nothing enqueued | `import-consent.ts:270`, `import-offer-view.ts:116` | ✅ |
| 6 | Late answer → no write, no import, request rejected | `import-consent.ts:249-267`, `route.ts:119-122` | ⚠️ server ✅, client finding 2 |
| 7 | Answer with no offer → rejected, nothing recorded | `import-consent.ts:255, 265` | ✅ |
| 8 | Connect no longer starts an import on its own | `finalize-tx.ts:184-273` | ✅ (`needs_backfill` deleted) |
| 9 | past_due → active no longer re-imports a declined location | `stripe/shared.ts:158-164` | ✅ |
| 10 | Reactivation gated on `accepted` | `archive-location-tx.ts:538-546` | ✅ |
| 11 | Re-add inherits the archived sibling's decision (place id **or** maps url) | `add-location-tx.ts:281-305` | ✅ |
| 12 | Exactly one import per acceptance; reconnect mid-flight adds none | `import-consent.ts:349-364`, `finalize-tx.ts:248-257` | ✅ |

### `invariants`, item by item

- **#2 transactional outbox** — every producer's consent write/state change and
  its `job_outbox` INSERT are in one `sql.begin`. The four raw INSERTs are the
  sanctioned carve-out. The in-flight set is spelled byte-for-byte and in order
  at `import-consent.ts:362`, `finalize-tx.ts:255`, `stripe/shared.ts:189` —
  never parameterized. ✅
- **#3 no unapproved posting** — the only topic enqueued anywhere in the diff is
  `ZERNIO_INITIAL_BACKFILL`. No `generate_response`, no publish topic, no reply
  write. ✅
- **#1 Vercel = UI only** — the decision route performs Postgres statements only;
  no Zernio, no LLM, no long-running work. ✅
- **#8 tenant scope** — every read and the offer-creation write bind
  `account_id`; the location comes from `resolveOwnerScope`, never the body
  (`route.ts:42-44` has no location field). Lineage lookup is account-scoped
  (`add-location-tx.ts:290`). See finding 9 for the two exceptions. ✅ with nit
- **#12 entry points orchestrate** — `route.ts` holds no `sql.begin` for the
  decision and makes exactly one domain call. The GET's self-heal `sql.begin` is
  an explicit, documented exception. ✅
- **#15 explicit db client** — neither `import-consent.ts` nor
  `import-offer-view.ts` imports `@/lib/db/server`. ✅
- **#13 / ADR 0015 R1** — no flag, no `NEXT_PUBLIC_*`, no `env-vars.md` entry. ✅
- **Offer must EXIST before it can be answered** — `import_offer_expires_at IS
  NOT NULL AND > now()` at `import-consent.ts:255-256`, plus the view's
  `row.expires_at ? offer : none` at `import-offer-view.ts:108-112`. ✅
- **F3 atomic transition** — guarded UPDATE, never read-then-write; the re-read
  at `:263` only classifies the zero-row case and is race-free under the lock.
  Proven live by the concurrency and property titles. ✅
- **One owner for the derivation** — `importConsentStateSql` is the only place
  the predicate is spelled; grep confirms two composers and no re-spelling. ✅
- **Expiry evaluated by Postgres `now()`** — no JS `Date` at the boundary;
  the µs-precision title (`import-consent.integration.test.ts:225-265`) proves it
  with a `+ interval '419 microseconds'` fixture, exactly as CLAUDE.md requires. ✅
- **D8 permanence** — `createImportOffer` refuses any non-`pending` row and any
  non-NULL deadline (`:193-194`); re-add inherits; reactivation creates no offer.
  ✅
- **Row lock at every producer** — all four hold a `businesses` `FOR UPDATE`
  inside a transaction; the two that own their transaction open it first. See
  finding 6 for the tripwire's reach. ✅

### `edge_cases`, one by one

| Edge case | Handled at | Verdict |
|---|---|---|
| Junction fires twice | `import-consent.ts:193-194` (`IS NULL` guard) | ✅ pinned by title 6 |
| Deadline from creation, not junction | `:187` `now() + 7 days` | ✅ pinned by title 60 |
| Stripe-path offer creation fails → GET self-heal | `route.ts:62-70` | ✅ |
| Junction with `subscription_activated_at` NULL | `finalize-tx.ts:269-272` (warn branch preserved) | ✅ |
| Decision on a `pending` + NULL-deadline row | `:255`, `:265` → `no_offer` | ✅ |
| Late click at/after deadline | `:256` (`> now()`), `:266` → `expired` | ✅ server; ⚠️ finding 2 client |
| Double-click / duplicate accept | `:254` → `already_answered` | ✅ |
| Two concurrent accepts | row lock `:240-246` | ✅ live title 33 |
| Accept vs decline race | same | ✅ live title 11 + property title 12 |
| Accept then reconnect mid-flight | `:358-363`, `finalize-tx.ts:248-257` | ✅ |
| Accepted but never completes | no completed-run write; `completed_at IS NULL` sentinel preserved | ✅ |
| Terminal non-completed outbox → failed | `import-offer-view.ts:161` | ✅ |
| Zero reviews imported → `empty` | `:129` (`completed_at` decides, not count) | ✅ |
| Multi-location scope | query key `['import-offer', locationId]`, `DashboardContent.tsx:339` | ✅ |
| Re-add archived location (disjunction over non-NULL keys, ORDER BY, account scope) | `add-location-tx.ts:288-302` | ✅ five live titles |
| URL-mode add (never-resolved place id) | same disjunction, both directions | ✅ titles 47 + 65 |
| Owner never opens the dashboard | derived expiry, no poller | ✅ |
| Declined location still gets live-lane drafts | live lane untouched (no diff in ingest) | ✅ |
| Live-ingested reviews deduped by `importReview` `ON CONFLICT` | unchanged | ✅ |
| Reactivation after a completed initial run still catches up | no completed-run gate at `archive-location-tx.ts:538-546` | ✅ titles 63-64 |
| One-sided junction → no offer, no self-heal offer | `import-consent.ts:196-197` | ✅ titles 57-58 |

### The third named exposure — `run_reason = 'initial'`

Applied where D9 named it (`import-offer-view.ts:96`), and the specific hazard
D9 describes is closed: a completed **initial** run short-circuits at
`import-offer-view.ts:125` before the outbox read, so no number of reactivation
runs can flip the banner back to `importing` after the one-time import finished.
The gap is the *other* direction — the two completed-run guards — see finding 4.

### `tests_to_add` — 69/69 present; assertion audit

Spot-checked every title against its body. The suite is unusually strong: the
live-DB rollback, byte-identical-row, boundary-µs, property-sequence, self-heal
race and lineage-disjunction titles all genuinely falsify their claims, and the
`live DB:` titles sit in `*.integration.test.ts` files (D6's defect class does
not recur). Assertion gaps found: findings 6 and 8 above, plus the low-confidence
notes below.

---

## Low-confidence appendix (NOT findings — observations only)

- **Title 61 uses a stand-in producer.** "concurrent acceptance and connect
  finalize…" (`route.integration.test.ts:214-258`) races
  `recordImportDecisionAndEnqueue` against a hand-written
  `finalizeLikeProducer()`, not the real `finalizeConnectionTx`. It proves the
  *pattern* serializes, not that finalize implements it. Defensible given the
  connect flow's fixture cost; worth knowing the real producer has no live
  concurrency coverage.
- **Title 18's assertion is a SQL-shape check** (`import-offer-junction.test.ts:196-208`)
  — it fails if the guard is deleted but cannot catch a subtly wrong one. The
  file says so explicitly, and it is the right trade for a mocked suite.
- **Titles 63/64 assert absence, not the named state.** They prove reactivation
  never queries `zernio_backfill_runs`, which is stronger than seeding a completed
  run. Deliberate and well argued at `archive-location-tx.test.ts:1206-1211`.
- **The GET writes and takes a row lock on every dashboard render.** Idempotent
  and documented, but it is write amplification on a read path, and two polling
  tabs on the same location serialize on the same `businesses` row.
- **The GET is not CSRF-wrapped and performs a durable write.** A cross-origin
  GET can stamp an Import offer deadline for a junction location. Harmless (it
  creates only what the owner was going to be offered anyway, and records no
  consent), but "GETs are exempt from the CSRF threat model" is a weaker
  statement once the GET writes.
- **`allowReadOnly: true` on the GET** lets a past-due read-only account trigger
  `createImportOffer`. Same benign shape.
- **Stale header counts.** `route.test.ts:3` still says "of the intake's 70" after
  D7 took it to 69; `route.integration.test.ts:3` says "titles 31–33 and 61" while
  `route.test.ts:7` says its live twin owns "31–33, 61 and 68" (68 is in
  `ImportOfferBanner.test.tsx`). Cosmetic.
- **`maybeEnqueueBackfillResume` now opens a transaction before checking
  `zernioPublishingEnabled()`** — correct per F106, but it means every activation
  event takes a `businesses` row lock even when publishing is off.
- **`readImportOfferView` issues two round trips** on the accepted-incomplete
  branch. Documented as deliberate.
