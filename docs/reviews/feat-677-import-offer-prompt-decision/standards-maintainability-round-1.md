# feat-677 — Standards & maintainability review, round 1

Method: `thermo-nuclear-code-quality-review` skill applied to `git diff 349c8c57...HEAD`
(36 files, +6,034 / −178). Axes: repo standards (`.claude/CLAUDE.md`), deep-module
discipline, Fowler smell baseline, glossary fidelity (`CONTEXT.md`), anti-slop
(precedent over invention, no abstraction before second use, net-negative bias),
test quality.

Read-only review. The only file written is this one.

---

## Verdict

**REQUEST CHANGES** — two High findings. Both are structural, both have a concrete
customer-visible or maintenance failure, and both have a cheap fix that does not
change the shipped behaviour the plan locked.

This is not a sloppy diff. The consent model is coherent, the derivation is spelled
once, the live-DB integration suites assert real behaviour against real Postgres,
and the `ci:tenant-scope` allowlist **shrank** by two entries — a diff that deletes
suppressions is rare and worth saying out loud. The findings below are about the
seams around that model, not the model.

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | **High** | `src/app/api/dashboard/import-offer/route.ts:50-70` | GET performs a durable write behind `allowReadOnly: true`, so a past-due read-only owner's dashboard render starts a 7-day Import offer clock they are structurally forbidden from answering. |
| 2 | **High** | `src/lib/reviews/import-consent.ts:293-365`, `finalize-tx.ts:206-258`, `worker/ingress/stripe/shared.ts:110-190` | The initial-import enqueue is triplicated with the completed-run guard spelled three different ways; the stated blocker to extracting it (`ci:outbox-seam`) does not actually apply. |
| 3 | **Medium** | `src/app/api/dashboard/import-offer/route.ts:62-70` | Every GET takes an exclusive `businesses` row lock in its own transaction to protect a write that is already self-guarding — at a 4-second poll cadence during `importing`. |
| 4 | **Medium** | `finalize-tx.ts:30`, `src/lib/shared/worker-types.ts:226-227`, `worker/ingress/stripe/shared.ts:79` | Three JSDoc references to the `needs_backfill` predicate this diff deletes survive the deletion. |
| 5 | **Medium** | `src/components/dashboard/DashboardContent.tsx:337-341` | Always-mounted animation wrapper around a self-nulling banner — the exact defect the comment at `:311-313` documents and gates against for the sibling banner. |
| 6 | **Medium** | `src/components/dashboard/DashboardContent.tsx:337-341` | `ImportOfferBanner` is not passed `readOnly`, unlike `ConnectGoogleBanner` at `:317-320`; a read-only owner gets live buttons whose POST 402s into a swallowed error. |
| 7 | **Medium** | `src/lib/reviews/import-offer-view.ts:96,160` vs `import-consent.ts:317-326`, `finalize-tx.ts:228-234` | One rule ("has the initial import already run?") spelled two ways across modules that must agree; the view's terminal-`completed` mapping can pin the banner on `importing` forever. |
| 8 | **Low** | `src/lib/reviews/import-offer-view.ts:33-39` | `ViewRow.outbox_status` is dead (no query produces it; its only use is being `Omit`-ed), and `:34` re-spells the exported `ImportConsentState` union. |
| 9 | **Low** | `src/components/dashboard/account-state/ImportOfferBanner.tsx:26-32` | Hand-duplicated wire contract — a verbatim copy of `ImportOfferView`, against the repo's own `import type` precedent for exactly this boundary. |
| 10 | **Low** | `src/lib/reviews/__tests__/import-consent-lock-order-source.test.ts:16-17` | The tripwire documents a guarantee ("survives a FIFTH producer being added") that its hardcoded four-path scan cannot provide. |
| 11 | **Low** | `import-consent.ts:41-44,121-124`, `import-offer-view.ts:11-12,121-123`, `archive-location-tx.ts:517,522` | ~30 `file:line` citations embedded in comments; this PR itself proves them fragile (`static-policy-audit.ts:219` moved `:112` → `:137`). |

---

## Detail

### 1. High — GET writes behind a read-only scope carve-out

`src/app/api/dashboard/import-offer/route.ts:50-52`

```ts
({ accountId, locationId } = await resolveOwnerScope(sql, request, {
  allowReadOnly: true,
}));
```

…followed at `:62-70` by a durable `sql.begin` that stamps
`import_offer_expires_at = now() + 7 days`.

`allowReadOnly` is not "this is a GET". It is the past-due carve-out.
`src/lib/auth/resolve-owner-scope.ts:66-68` throws `ScopeError('past_due_read_only', 402)`
for a past-due account outside its recovery window **unless** the caller opts out,
and the function's own JSDoc at `:48-51` names its contract:

> "Subscription enforcement for owner **mutation** routes. Past-due accounts remain
> writable while the recovery window is open; all other non-active statuses stay
> blocked here."

The POST handler at `:84` uses the default (no `allowReadOnly`), correctly.

**Failure scenario, end to end.** `DashboardContent.tsx:117` renders
`DashboardOperationalContent` for past-due accounts (`:296-306` render
`PastDueBanner` with `pastDueData.isReadOnly` inside it), so `ImportOfferBanner`
mounts and fires the GET. `createImportOffer`'s predicate
(`import-consent.ts:189-197`) checks activation, active connection and `archived_at`
— it does **not** check subscription status — so the write lands. The owner now
has a live 7-day offer. Every accept or decline they attempt is rejected 402
`past_due_read_only` at `:84`. The deadline passes. Per `import-offer-view.ts:114-116`
a derived-expired offer returns `{ state: 'none' }` — "nothing to show, ever again" —
and `createImportOffer` will never re-stamp, because `import_offer_expires_at`
is no longer NULL (`:194`). The one-time Import offer is permanently consumed by an
owner who was never allowed to answer it.

**Fix.** Either drop `allowReadOnly: true` (a read-only owner then gets a 402 and no
clock starts), or gate the self-heal on write entitlement and let the read proceed.
The second is better product behaviour; the first is one line.

---

### 2. High — the initial-import enqueue is triplicated, and the stated blocker is wrong

Three sites now construct the same payload and run the same dedup:

| Site | completed-run guard | in-flight guard |
|---|---|---|
| `import-consent.ts:317-326` | `LEFT JOIN … completed_at IS NOT NULL` + `br.id IS NULL` | `INSERT … WHERE NOT EXISTS` (`:358-363`) |
| `finalize-tx.ts:228-234` | standalone `SELECT … LIMIT 1` + JS `if (!completedRun)` | `INSERT … WHERE NOT EXISTS` (`:251-256`) |
| `worker/ingress/stripe/shared.ts` | `NOT EXISTS (…)` inside the target SELECT | `INSERT … WHERE NOT EXISTS` |

Same seven-field payload with `backfill_reason: 'initial'`, same
`isSubscriptionTier` throw, same byte-for-byte
`jo.status IN ('pending', 'dispatching', 'dispatched')`. **One rule, three spellings,
three directories.** This is textbook shotgun surgery: tightening the dedup, adding a
field to the payload, or changing the tier guard is a three-file edit where two of the
three files are easy to miss (the worker ingress one especially — it is not in
`src/lib/reviews/`).

The diff *added* two of these three copies. Against the net-negative bias, "new code
only" is a claim this particular block cannot support: `finalize-tx`'s enqueue was
previously a plain `VALUES` INSERT, and `import-consent.ts`'s is wholly new.

**The stated justification does not hold.** `import-consent.ts:277-282`:

> "Raw `INSERT INTO job_outbox` on purpose: no typed helper exists for
> `ZERNIO_INITIAL_BACKFILL`, and minting one would turn all four raw producers red
> under `ci:outbox-seam` and force migrating them in this PR."

That is true only for a helper placed in `src/lib/shared/job-outbox-helpers.ts`.
`scripts/ci/outbox-seam-audit.ts:84` pins `HELPER_MODULE = 'src/lib/shared/job-outbox-helpers.ts'`
and `:458` derives helper coverage by parsing **that file and only that file**
(`deriveHelperTopicKeys`, `:360`). A function exported from `import-consent.ts` —
which is exactly what `enqueueInitialImport` already is, minus the `export` keyword —
adds nothing to `helperKeys`. The audit stays green, `ZERNIO_INITIAL_BACKFILL` keeps
its sanctioned raw-INSERT status, and the raw INSERT exists at **one** site instead of
three.

**The judo move.** Export `enqueueInitialImport(tx, businessId, accountId)` from
`import-consent.ts`. `finalize-tx.ts:206-258` collapses to one call (it already holds
the row lock and has already read consent). `stripe/shared.ts` collapses to one call
inside the `sql.begin` it now owns. Roughly 90 lines of near-identical SQL deleted,
the completed-run rule gets one spelling, and the "which of the three dedup variants
is authoritative?" question stops existing. Producer 4 (reactivation) stays out — it
enqueues `'reactivation'` and deliberately has no dedup, which is documented at
`archive-location-tx.ts:524-532` and is correct.

---

### 3. Medium — a read endpoint takes an exclusive row lock, at 4s cadence

`route.ts:62-70` wraps the self-heal in `sql.begin` and takes
`SELECT id FROM businesses … FOR UPDATE` before calling `createImportOffer`.

The lock is not needed for correctness. `createImportOffer` (`import-consent.ts:185-199`)
is a single `UPDATE … WHERE … import_offer_expires_at IS NULL`. Under READ COMMITTED,
a concurrent duplicate blocks on the row, re-evaluates its `WHERE` against the
committed new version (EvalPlanQual), finds the deadline non-NULL, and updates zero
rows. The statement is self-guarding; the route's own integration test
(`route.integration.test.ts`, "createImportOffer under concurrency stamps exactly one
deadline") would pass without the explicit lock. The `F107` finding the comment cites
is about `TransactionSql` in the *signature* — a typing concern, satisfiable with a
transaction, not requiring `FOR UPDATE`.

What it costs: every dashboard render for every location opens a write transaction
(pinning a PgBouncer server connection for its duration) and takes an exclusive lock
on the `businesses` row. `ImportOfferBanner.tsx:69-70` polls this endpoint every
4000 ms while `state === 'importing'` — i.e. precisely while `ZernioBackfillWorker` is
processing that location. And the self-heal can only ever do work **once per location,
ever**; after the first stamp `import_offer_expires_at` is non-NULL forever, so every
subsequent GET for the rest of that location's life pays for a lock and a write
transaction that provably cannot change anything.

**Fix.** Read first, self-heal only when the read shows the repairable shape
(`pending` + NULL deadline). `readImportOfferView` already selects
`b.import_offer_expires_at` at `:91`, so the information is in hand — return `none`
for that shape today, and let a second call repair it. Or simply drop the `sql.begin`
and call the UPDATE directly. Either way the common path becomes a pure read.

---

### 4. Medium — the deleted `needs_backfill` predicate is still referenced in three JSDocs

The diff removes the predicate and (commendably) its two `ci:tenant-scope` allowlist
entries. It leaves behind:

- `finalize-tx.ts:30` — "(on first activation per the needs_backfill predicate) the
  initial-backfill outbox enqueue". The function's own header now describes a
  predicate deleted 158 lines below it.
- `src/lib/shared/worker-types.ts:226-227` — "emitted by the connect-callback when the
  `needs_backfill` predicate is satisfied". This is the payload type's JSDoc, the
  first thing anyone reads when adding a field.
- `worker/ingress/stripe/shared.ts:79` — "connect callback's needs_backfill predicate
  didn't fire".

`.claude/CLAUDE.md`, Working rules: *"When deleting a doc or ticking a checklist item,
fix its audit tick and grep the filename to clean every cross-reference in the same
change."* `needs_backfill` is also dead vocabulary in the sense the review brief flags:
these three lines are the only thing keeping the term alive in production source.

---

### 5. Medium — always-mounted wrapper, contradicting the comment three lines above it

`DashboardContent.tsx:311-321` (pre-existing):

> "Only mount the connect banner (and its section wrapper) when it has something to
> show. ConnectGoogleBanner returns null for a connected account, so an always-on
> wrapper would leave an empty flex item that doubles the section gap above the hero."

`DashboardContent.tsx:337-341` (new), for a banner that self-nulls on
`{ state: 'none' }` — the overwhelmingly common case, since almost every location is
past its offer:

```tsx
{currentScope !== 'all' && (
  <div className="section-enter section-enter-1">
    <ImportOfferBanner locationId={currentScope} />
  </div>
)}
```

The new comment acknowledges it ("there is nothing here to gate the wrapper on") and
ships the defect anyway. It also reuses `section-enter-1`, the same stagger index as
`ConnectGoogleBanner`, so when both are visible they animate on the same beat instead
of stepping.

**Fix.** Move the wrapper `div` inside `ImportOfferBanner` so it disappears with the
banner, and give it its own stagger index. That is a strictly smaller diff than what
is there now and removes the gate question entirely.

---

### 6. Medium — the read-only prop the sibling banner takes was dropped

`DashboardContent.tsx:317-320` passes `readOnly={pastDueData?.isReadOnly ?? false}` to
`ConnectGoogleBanner`, which branches on it at three call sites
(`ConnectGoogleBanner.tsx:49,70,101`) to suppress CTAs a read-only owner cannot use.

`ImportOfferBanner` takes only `locationId` (`ImportOfferBanner.tsx:34-42`) and renders
both CTAs unconditionally at `:103-119`. A past-due read-only owner clicks
"Import my reviews", the POST returns 402, and `postDecision` throws
(`:56`) into a `useMutation` with **no** `onError` (`:73-81`) — so nothing renders, the
banner keeps showing the offer, and the click is indistinguishable from a no-op button.

This is the anti-slop rule the brief names: precedent over invention. The nearest
existing module in the same slot solves this exact problem and the new adapter, which
claims in its header to follow `ConnectGoogleBanner`'s anatomy "exactly", dropped the
one prop that carries behaviour.

Note this is downstream of finding 1: fixing the route to 402 the GET does not fix the
banner, because the GET failure is also unhandled (`retry: false`, no `onError`, `!data`
→ `null` at `:83`). The banner simply vanishes, which is at least honest.

---

### 7. Medium — "has the initial import run?" is spelled two different ways

`import-offer-view.ts:94-96` scopes the run row to `run_reason = 'initial'` and spends
`:51-62` explaining why that scoping is load-bearing (reactivation runs recur by design
and would otherwise flip the banner back to `importing` forever).

All three enqueue gates suppress on **any** completed run, regardless of reason:
`import-consent.ts:317-319` + `:326` (`br.completed_at IS NOT NULL … br.id IS NULL`),
`finalize-tx.ts:228-234`, and the `NOT EXISTS` inside `stripe/shared.ts`'s target
SELECT. Same question, opposite answer for a `'reactivation'` row.

Compounding it, `import-offer-view.ts:160` maps a **terminal** `completed` outbox row
to `{ state: 'importing' }`. The module's own justification at `:63-69` describes the
topic-sharing limit as applying to a reactivation row "in flight" — but `completed` is
not in flight, and it maps to `importing` too, which makes that state non-terminal.

**Failure scenario.** A location whose accept-time enqueue found no active connection
(`import-consent.ts:333`, the documented `!target` early return) has consent
`accepted` and no initial run. It is later archived and reactivated; the reactivation
gate (`archive-location-tx.ts:541-546`) sees `accepted`, enqueues a `'reactivation'`
job on the shared `ZERNIO_INITIAL_BACKFILL` topic, and that job completes. Now: every
enqueue gate refuses (a completed run exists), while the view sees no `'initial'` run,
falls through to the outbox read at `:138-145`, finds the reactivation row at
`completed`, and returns `importing` at `:160`. The banner shows
"Importing your reviews… this usually takes a minute." indefinitely, polling every
4 seconds, for a location whose initial import will never be enqueued by anything.

Narrow, but the divergence that produces it is not — it is one invariant maintained by
hand in four places. Extracting the enqueue per finding 2 gives the gates one spelling;
scoping them to `run_reason = 'initial'` makes it the same spelling as the view.

---

### 8. Low — dead field and a re-spelled union in the view's row type

`import-offer-view.ts:33-39` declares `ViewRow` with five fields. `outbox_status` has no
producer — the only query that could populate it is issued separately at `:138` into an
inline `{ status: string }[]`. Its sole use is being removed: `Omit<ViewRow, 'outbox_status'>`
at `:87`. A type whose only purpose is to be `Omit`-ed is a leftover; declare the row
shape the query actually returns.

`:34` also re-spells `'pending' | 'accepted' | 'declined' | 'expired'`, which
`import-consent.ts:57` exports as `ImportConsentState`. The module already imports from
that file (`:21`). Adding a state means editing both; the four-valued union is exactly
the kind of vocabulary CLAUDE.md's "import the constant from its single authoritative TS
file" rule exists to keep singular.

### 9. Low — hand-duplicated wire contract across the API boundary

`ImportOfferBanner.tsx:26-32` is a verbatim copy of `ImportOfferView`
(`import-offer-view.ts:25-31`) — six variants, character for character. The two are cast
together at `:47` (`as ImportOfferState`) with no runtime validation, so a server-side
addition to the union is invisible to the client and a divergence surfaces as an
unhandled state falling through to the `failed` branch at `:179`.

The repo's precedent for exactly this boundary is a shared type-only import:
`DashboardContent.tsx:7` does `import type { DashboardDataActive … } from '@/lib/dashboard/types'`.
Invariant #1 explicitly permits it ("type-only `import type` allowed"), and
`import-offer-view.ts`'s runtime imports are erased by a type-only import, so the ESLint
boundary is not at risk.

### 10. Low — the source tripwire documents a guarantee it does not provide

`import-consent-lock-order-source.test.ts:16-17`:

> "this is the only check that survives a FIFTH producer being added, because it fails
> the moment a new enqueue site appears without the lock above it."

It does not. The four sources are hardcoded at `:72`, `:86`, `:97`, `:114`. Nothing in
the test enumerates enqueue sites, greps for `ZERNIO_INITIAL_BACKFILL`, or cross-checks
against `QUEUE_NAMES`. A fifth producer in a new file is never read, and the suite stays
green.

Secondary: `segment()` with no `endMarker` (`:51`) slices to EOF, so producer 1's
"segment" includes every function below `recordImportDecisionAndEnqueue` in the file. A
new unlocked producer appended to `import-consent.ts` would inherit the earlier
function's `FOR UPDATE` in the `indexOf` ordering and pass.

The test is worth keeping — the precedent (`location-lifecycle-lock-order-source.test.ts`)
is real and the comment-stripping at `:43-45` is a genuinely good detail. It is the
docstring that overclaims. Make it enumerate: derive the file list by grepping the tree
for `QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL` adjacent to `INSERT INTO job_outbox`, then
assert lock-order per hit. That version actually survives a fifth producer.

### 11. Low — `file:line` citations in comments rot on contact

The new modules carry roughly thirty citations of the form `service.ts:118`,
`ZernioBackfillWorker.ts:379`, `disconnect/route.ts:251-262`, `job-eligibility.ts:60-81`,
`reactivate/route.ts:111`, `100_….sql:47-63`, `draft-status/route.ts:18-20`.

This PR is its own counter-example: `scripts/ci/static-policy-audit.ts:219` had to move
`worker/ingress/stripe/shared.ts:112` → `:137` because a `sql.begin` was inserted above
it, and the diff adds a five-line comment explaining the churn. Every one of these
citations has the same fragility with none of the CI enforcement. A reader who follows
`ZernioBackfillWorker.ts:379` in six months lands on unrelated code and cannot tell
whether the claim is stale or they miscounted.

Cite the symbol, not the line: "`ZernioBackfillWorker`'s incremental `imported_count`
update" survives every edit above it.

---

## What is good, and why it matters for the verdict

Recorded so the next round does not re-litigate it.

- **The derivation genuinely has one owner.** `importConsentStateSql`
  (`import-consent.ts:98-106`) is the single spelling of spec §5.3, composed into both
  `readImportConsent` and `readImportOfferView`. The fixed-`b`-alias contract is ugly,
  but the reason given at `:74-87` (four producer suites use hand-rolled tagged-template
  `sql` mocks that die on `db('b')`) is checked and true, and a fixed contract with zero
  interpolation is the safer of the two.
- **The module split is justified, not premature.** `import-consent.ts` owns writes and
  the predicate for four producers; `import-offer-view.ts` owns a read model for one
  banner. Different consumers, different change reasons. This is not abstraction before
  the second use — the second use already exists.
- **`ci:tenant-scope` allowlist SHRANK 420 → 418.** Two suppressions deleted, none added,
  and every new query binds its tenant keys in top-level predicates specifically so it
  needs none. That is the right instinct and it should be called out.
- **`jsonb()` → `tx.json()` in `stripe/shared.ts`** is correct for the newly-transactional
  code path (invariant #15).
- **No file crosses 1000 lines**; the largest new file is 365 and the largest touched is
  `archive-location-tx.ts` at 629.
- **Test quality is above the repo baseline.** The optimistic-flip trap
  (`ImportOfferBanner.test.tsx:104-142`) gates the POST behind a promise and asserts the
  offer copy *survives* until it resolves — that is a real trap, not a smoke test. The
  polling test (`:184-212`) advances fake timers 30s on a terminal state and asserts zero
  additional fetches. The live-DB suites assert committed state, rollback, inclusive
  boundary behaviour, and concurrency (two accepts → one transition, one outbox row).
  The mocked route suite asserts `mockSql.begin` was **not** called — a direct test of
  invariant #12. The main gap is that `finalize-tx`'s in-flight dedup is only proven by a
  string-containment assertion (`import-offer-junction.test.ts:207`), which the test's own
  comment at `:169-176` admits; its live counterpart covers the acceptance path, not
  finalize.
- **No glossary violations found.** `Import offer`, `Import consent`, `Review import`,
  `Import window` and `Live-ingest cutoff` are used as locked. No identifier renames a
  concept ("prompt", "backfill offer" appear only in the `_Avoid_` lists). `needs_backfill`
  is not revived — it is residue from a deletion (finding 4).
- **Repo-standard spot checks pass**: no `any` in production code; no silent catches (both
  route catches report through `reportCaughtError` or return a mapped 4xx); `node:crypto`
  not implicated; invariant #15 clean (domain modules take `sql`/`tx`; only route, ingress
  and worker roots import the singleton); invariant #2's byte-for-byte in-flight tuple is
  re-spelled correctly at all three sites; `isSubscriptionTier` used instead of raw tier
  literals; no new `NEXT_PUBLIC_*`.

---

## Low-confidence appendix

Not in the table. Judgement calls, or things I would want a second opinion on.

- **`archive-location-tx.ts:569-572` introduces the first `console.log` into
  `src/lib/locations/**`** (the file had no `console.*` at the fork point). CLAUDE.md
  names `createWorkerLogger` as the structured-logging owner. Weighed down because
  `src/lib` already carries ~75 console calls across ~35 files, so this follows repo-wide
  practice even though it does not follow the file's.
- **The three "proof that declines are honoured" `console.log` lines**
  (`finalize-tx.ts:263-265`, `archive-location-tx.ts:569-572`, `stripe/shared.ts`) log on
  the *ordinary* path — `pending` is the common state, so these fire on essentially every
  connect and every activation resume. Probably worth `debug` level or dropping two of the
  three; hard to call without seeing log volume.
- **Comment-to-code ratio.** `import-consent.ts` is roughly 60% comment, much of it review
  archaeology ("round-1 High, F101", "reverted in plan revision 2", "the owner dropped it
  2026-08-06"). Some of this is genuinely load-bearing (the `b`-alias contract, the
  `IS NOT NULL` rationale, the reactivation-dedup exclusion). Some of it is a record of
  arguments that a reader in a year has no way to act on. I would not ask for a rewrite,
  but I would resist adding more.
- **Nested `role="alert"`.** `ImportOfferBanner.tsx:180-181`: the failed banner sets
  `role="alert"` and contains a `LiveRegion level="assertive"`, which
  (`LiveRegion.tsx:17`) also renders `role="alert"`. Screen readers may announce twice.
  Not confident enough about assistive-tech behaviour to table it.
- **`recordImportDecisionAndEnqueue`'s four-outcome union** (`import-consent.ts:66-70`)
  plus the route's exhaustive `switch` (`route.ts:116-125`) is a clean typed dispatcher
  and I like it. The one thing I would probe: `no_offer` covers both "location not found /
  not yours" and "offer never created", which map to the same 404 — arguably right for
  anti-enumeration, arguably hides a real ops signal. Deliberate either way; not a finding.
- **`add-location-tx.ts:243-306` consent inheritance** reads correct to me — the
  both-directions non-NULL disjunction, the three-deep `ORDER BY`, and copying all three
  columns verbatim are each justified and each has a live-DB test. The 40 lines of comment
  above 30 lines of SQL is a lot, but the SQL is subtle enough to earn most of it. No
  finding.
