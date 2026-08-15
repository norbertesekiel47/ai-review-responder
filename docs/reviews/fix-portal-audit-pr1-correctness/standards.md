# Standards & maintainability review — `fix/portal-audit-pr1-correctness`

Method: `/thermo-nuclear-code-quality-review` against
`git diff $(git merge-base HEAD main)..HEAD -- src/`. `docs/**` ignored as
instructed. Read-only; no source file was modified.

Scope measured: 309 added lines under `src/`, of which 86 (28%) are comment-only.
No file crossed the 1000-line threshold (largest touched: `AutoApprovalClient.tsx`
at 835, unchanged in size; `named-rival.ts` 742).

**Overall: APPROVE with findings.** No structural regression, no spaghetti
growth, no file-size explosion, no boundary leak. Two of the six findings are
worth fixing before merge (F1, F2); the rest are low-cost cleanups.

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| F1 | Medium | `src/lib/auto-approval/types.ts:15` | `AUTO_APPROVAL_THRESHOLD_LABELS` is exported with **zero production consumers** — its only importer is its own test. Widened interface + test asserts implementation shape. |
| F2 | Medium | `src/lib/config/server.ts:224` | Comment now false: it records `TELEGRAM_BOT_USERNAME: admin `?? 'RepWorthBot'`, dashboard `?.trim() \|\| 'RepWorthBot'`` — the divergence this branch just removed. |
| F3 | Medium | `src/lib/competitors/named-rival.ts:519-534` | JSDoc claims to mirror `loadLocationsSettingsView`, but that precedent explicitly avoids per-location queries (`settings-view.ts:77-79`). The loop turns an N-wide fan-out into **3N sequential round trips**; the set-based judo move gives both one-in-flight *and* constant round trips. Cost not recorded anywhere. |
| F4 | Low | `src/lib/auto-approval/types.ts:21-23` | Declared `: string`, returns `undefined` for any argument outside `{4,5}`. Only producer is an **unvalidated** row cast (`business-detail/queries.ts:67`). The deleted `thresholdLabel` had an explicit out-of-domain fallback. |
| F5 | Low | `src/app/(authenticated)/settings/competitors/__tests__/page-source.test.ts:23` | Asymmetric with its admin sibling: admin pins the explanatory comment (`toContain('SEQUENTIAL')`), this one pins nothing — so the comment `stripComments` exists to protect can be deleted without failing. `stripComments` is also a no-op in this file today. |
| F6 | Low | `src/lib/auto-approval/types.ts:9-23` | `types.ts` now owns zod schemas + branded types + runtime constants + DTOs + the PATCH contract + type guards + **UI display copy**. Acceptable under "default is no new file", but this is the last label that should land here. |

---

## Detail

### F1 — `AUTO_APPROVAL_THRESHOLD_LABELS` is exported for its test only

```
$ rg -n "AUTO_APPROVAL_THRESHOLD_LABELS" src/
src/lib/auto-approval/__tests__/threshold-labels.test.ts:3
src/lib/auto-approval/__tests__/threshold-labels.test.ts:9
src/lib/auto-approval/types.ts:15   (declaration)
src/lib/auto-approval/types.ts:22   (internal use)
```

Both production consumers (`AutoApprovalClient.tsx`,
`AutoApprovalDiagnosticsPanel.tsx`) import only `autoApprovalThresholdLabel`.
The map is a private implementation detail promoted to public API so a test can
`toEqual` its object literal.

Two problems, one fix:

- **Deep-module discipline (axis 2).** The module's interface should be one
  function. Two exports where one has no caller is interface for free.
- **Test quality (axis 5).** `expect(AUTO_APPROVAL_THRESHOLD_LABELS).toEqual({ 4: '4–5★', 5: '5★ only' })`
  asserts the *shape of the storage*, and the three following lines already
  assert the *behaviour* through the public function. The `toEqual` line adds
  no coverage and fails on a refactor that preserves behaviour — the textbook
  implementation-coupled assertion.

Fix: drop `export` from line 15, delete the `toEqual` line. The test then
covers exactly the same behaviour with no coupling. Also removes a `fallow`
unused-export candidate.

### F2 — stale config inventory in `server.ts`

`src/lib/config/server.ts:210-228` is a deliberate, curated inventory of *how
each `rawOpt` var is guarded at its call site* — that inventory is the stated
justification for `rawOpt` over the collapsing `opt`. Line 224 still reads:

```
//  - TELEGRAM_BOT_USERNAME: admin `?? 'RepWorthBot'`, dashboard `?.trim() || 'RepWorthBot'`.
```

The whole point of this branch's §3.2 fix is that those are now identical. A
reader auditing `rawOpt` declarations will read a divergence that no longer
exists. CLAUDE.md's cross-reference rule ("grep the filename to clean every
cross-reference in the same change") is the same instinct; this is a one-line
edit inside the same concern.

### F3 — the sequential loop, and a precedent citation that points the other way

The JSDoc on `loadRivalPickerViews` closes with *"Mirrors
`loadLocationsSettingsView`."* That precedent does two things:

1. sequences its top-level reads (`settings-view.ts:61-63`) — **which this
   change does mirror**, and
2. for the *per-location* data, refuses the per-location query outright:

```
src/lib/locations/settings-view.ts:77-79
// Zernio connection status for every location, active AND archived — one
// ANY(...) read rather than one per location.
```

That second half is the part `loadRivalPickerViews` is the counterexample to.
`loadRivalPickerView` is a 3-query chain, so N locations now cost **3N
sequential round trips** on a `force-dynamic` page render — where the old
`Promise.all` cost 3 round trips of wall-clock. Pool safety is bought with
latency that grows linearly in the customer's location count, and the spec, the
JSDoc and the deviations doc all record the pool-safety half of that trade
without recording the latency half.

The judo move that the cited precedent actually demonstrates: three set-based
reads —

- `businesses WHERE id = ANY(${businessIds}) AND account_id = ${accountId}`
- latest `ranking_snapshots` per `(business_id, keyword, search_location)` via
  `DISTINCT ON`
- `competitor_snapshots` joined against those anchors

— followed by a **pure** per-location fold that derives
`not_configured` / `awaiting_pack` / `ready`. That is one query in flight *and*
constant round trips, and it makes the state machine unit-testable without a
thenable spy at all.

I am not asserting this must land in a PR labelled "correctness". Two things I
would ask for regardless:

- The JSDoc should stop citing `loadLocationsSettingsView` as the precedent for
  a per-location loop, or should cite it accurately ("sequences like
  `loadLocationsSettingsView`; unlike it, does not batch — see below").
- The O(N) round-trip cost should be written down where the next reader will
  find it, so "make it set-based" is a known follow-up rather than a
  rediscovery.

`toHaveLength(3)` is also the only assertion tying output to input; the loader's
input↔output correspondence is untested. It happens not to matter —
`CompetitorsClient` keys on `view.businessId`, which is threaded from the
argument, not from a row — so this is an observation, not a finding.

### F4 — the return type now lies

```ts
export function autoApprovalThresholdLabel(threshold: AutoApprovalThreshold | null): string {
  return threshold === null ? 'Off' : AUTO_APPROVAL_THRESHOLD_LABELS[threshold];
}
```

The deleted admin helper took `number | null` and ended with
`return \`${threshold}–5★\`` under a comment saying *"the fallback covers only
out-of-domain legacy data."* The replacement narrows the parameter to
`AutoApprovalThreshold` and drops the fallback, so an out-of-domain value
returns `undefined` behind a `: string` signature.

TypeScript is satisfied, but the only producer of this argument is
`AutoApprovalPolicyRow.auto_approve_min_star`
(`src/lib/admin/business-detail/queries.ts:67`) — an interface **assertion** over
a postgres.js row, not a parse. The runtime guarantee comes from migration 074
(`CHECK (auto_approve_min_star IS NULL OR auto_approve_min_star BETWEEN 4 AND 5)`,
with a backfill of `< 4` → 4), which is applied everywhere, so the case is
unreachable today. That is why this is Low and why I do **not** think the
triage was wrong to accept the change. But the failure mode if it ever is
reached is a silently blank cell in an ops diagnostics panel, which is the
worst kind. Either widen the parameter back to `number | null` with the
fallback, or make the signature honest (`string | undefined`) and let the panel
decide.

### F5 — the two page-source tests are not equally strong

The admin test does the right thing:

```ts
// The comment explaining the invariant must survive — it is why the next
// reader does not "optimise" this back into a fan-out.
expect(source).toContain('SEQUENTIAL');
```

The competitors test has no equivalent. Its page's explanatory comment
(`page.tsx:2-3`, *"loads every active location's view SEQUENTIALLY — the page
does not fan out (#773)"*) is the thing that stops the next reader restoring the
`Promise.all`, and nothing pins it. One line — `expect(source).toContain('SEQUENTIALLY')`
— closes the gap and makes the pair symmetric.

Related: because the competitors page's comment contains no `Promise.all`,
`stripComments` currently changes nothing in that file. It is pure
future-proofing, and its comment justifies itself by reference to the sibling
rather than to its own subject.

### F6 — is `types.ts` the right home?

Asked directly, so answered directly: **yes for this change, and it should be
the last one.** The D1 triage is correct on every check it made — `types.ts`
already exports runtime constants (`APPROVAL_METHOD`, `POLICY_PERSONA_REPLY`),
is already client-safe, and is already imported by the panel being edited, so
"default is no new file" genuinely applies and creating `labels.ts` for eleven
lines would have been slop.

The reservation is that a module named `types.ts` now owns presentation copy,
and it is already the auto-approval module's grab-bag: zod schemas, branded
types, runtime constants, seven DTOs, the PATCH discriminated union, and two
type guards, in 209 lines. Display strings are the one category in there that is
not a contract. If a second label family arrives (block reasons, source labels,
veto-window copy), that is the trigger to do the extraction the spec originally
called for — not a third accretion.

---

## Explicitly checked and clean

- **Repo standards.** No `any`; no `crypto-js`; no new top-level directory; no
  string literal standing in for a status/tier/job name (`'Off'` / `'4–5★'` are
  display copy, correctly not constants); no `NEXT_PUBLIC_*` added; invariant
  #15 respected — `loadRivalPickerViews` takes `db: Sql` and the page (a
  composition root) passes the singleton.
- **The two `BLOCK_REASON` maps.** Not flagged, as instructed — and the
  explanatory comment does say the right thing. `AutoApprovalDiagnosticsPanel.tsx:8-10`
  states the register difference ("terse ops labels" vs "explanatory sentences")
  *and* adds the load-bearing fact that both are exhaustive over
  `AutoApprovalReadinessBlockReason`, so neither can silently miss a reason.
  That is a genuine why. The same fact is restated in `types.ts:9-14`; two
  copies of one rationale is tolerable at this size.
- **`autoApprovalThresholdLabel` deletion test.** Passes. Delete it and
  `thresholdLabel` returns to the admin panel while three literals return to
  `THRESHOLD_OPTIONS` — complexity reappears across 2 callers, and the drift it
  prevents is documented (the deleted comment already said the two vocabularies
  must match). Earns its place.
- **`loadRivalPickerViews` deletion test.** Passes, less emphatically. Delete it
  and the loop moves inline into the page — one caller, so the interface is
  justified by *testability* rather than by reuse. D2 says exactly that and is
  honest about coverage being the driver. Accepted: it also satisfies invariant
  #15 and keeps the page a one-line composition root, which is house style.
- **`makeSequentialSpySql` — sound, and it proves what it claims.** I verified
  the discrimination rather than trusting it. Simulating the exact stub against
  a 3-location, 3-query-per-location workload:

  ```
  sequential maxInFlight = 1
  parallel   maxInFlight = 3
  ```

  The stub increments inside `then` and decrements on a scheduled microtask, so
  a second chain that starts before the first resolves is observed. It would
  also catch a bounded-concurrency regression (`p-limit(2)` → 2). The comment
  explaining *why* the counter lives in `then` and not at call time (postgres.js
  Queries are lazy thenables, and `primaryTrackedKeywordSql` builds one that is
  never awaited) is exactly the kind of comment that earns its keep. The
  companion "no queries at all for zero locations" test is real behaviour, not
  a tautology.
- **`Sidebar.test.tsx`.** Behavioural: clicks the real button, asserts the
  navigation target and, in both failure modes, asserts *no* navigation plus the
  visible error. Not coupled to implementation. The mock-hoisting comment cites
  a real precedent.
- **Comment accuracy on the admin page.** `page.tsx:25-31` claims
  `getBusinessDetail` is "a 13-query chain that sequences deliberately… which
  says so twice in the imperative". Verified: 13 `await`s in
  `business-detail/queries.ts`, with the "do NOT re-introduce a `Promise.all`"
  imperative at lines 97 and 214. Accurate.
- **File sizes.** Nothing near 1000 lines.
- **Glossary.** `docs/superpowers/specs/CONTEXT.md` locks *Auto-approval*,
  *Policy*, *`policyEligible`*, *Origin lane*. Nothing in the diff renames a
  locked concept; "threshold" is used consistently with the glossary's
  `auto_approve_min_star` definition. No violation.
- **All six touched/added test files pass** (33 tests, 6 files).

---

## Triage verdicts — do I disagree with any ACCEPT?

No. All five stand, with one correction and one caveat:

- **D1 (types.ts over labels.ts)** — correct, see F6. The caveat is the accretion
  threshold, not this change.
- **D2 (extracted loader over inline loop)** — correct. Precedent, invariant #15
  and testability all point the same way. F3 is about *what the loader does*,
  not about whether it should exist.
- **D3 (`?id?` glob unblock)** — correct, and the reasoning is sound: reach is
  identical, only the spelling changed, and `?id?` provably cannot over-match in
  that directory. Deferring the durable `edit-surface-guard.sh` fix out of a
  correctness PR is the right call.
- **D4 (`stripComments`)** — correct, and the corrected assertion genuinely is
  strictly stronger. **One correction to the record:** the doc says a shared
  helper "would need a home outside both `__tests__` directories" as though no
  home exists — `src/__tests__/helpers/` does exist and is the conventional one.
  The *conclusion* is still right (4 lines, 2 call sites, and the shared file
  would sit outside the declared surface), but the justification should be "not
  worth a file", not "nowhere to put it".
- **D5 (reclassify WARN on a miscount)** — correct; the trigger was obeyed and
  re-measured rather than waived.

---

## Low-confidence appendix (deliberately NOT in the table)

- **Telegram deep-link duplication.** After this branch,
  `src/app/api/admin/channels/telegram/start/route.ts:19-25` and
  `src/app/api/dashboard/channels/telegram/start/route.ts:71-74` hold a
  byte-identical expression *and* near-identical 3-line rationale comments, plus
  duplicated blank/whitespace tests. Normally a clear "extract to the canonical
  helper" finding — `_shared.ts` is right there and is already imported by the
  dashboard route. Not flagged because spec §4.1 assigns the QR/deep-link
  response to PR 2's shared `runChannelStart`, so the duplication is a
  deliberate one-PR-lived state. Worth confirming PR 2 actually absorbs it.
- **Three near-identical "deliberately NOT sequentialised" comments**
  (`api/account/settings/route.ts:70-72`, `dashboard/add-location/page.tsx:35-37`,
  `api/locations/add/route.ts:123-126`) encode one policy three times, in three
  spellings, with two different citation forms for the same doc (two spell
  `docs/superpowers/specs/…`, one abbreviates to the bare filename). Each
  individually records a real *why* (fixed width, and the write-path one adds
  "adds latency to a write for no safety gain"), and inline is where a future
  sweeper will look, so I judge them as earning their keep. Only the citation
  inconsistency is worth a pass if the file is touched again.
- **`Sidebar.tsx:82` hardcodes `/login`** where `loginUrlForFlow('owner')`
  (`src/lib/shared/auth-flow.ts:8-13`, pure and client-safe) already owns that
  mapping. Marginal: the helper's contract is flow-param-driven and the sidebar
  has no flow. Not worth the import.
- **The other `/admin/login` owner dead-ends** (`require-owner-access.ts:60,77`;
  `(authenticated)/layout.tsx:81,95`) are the same defect, unfixed. Not flagged:
  spec §3.1 declares the scope guard explicitly and §8 lists them as out of
  scope, and the in-code comment reproduces that reasoning faithfully. Whether
  the scope guard is *right* is a spec question, not a standards one.
- **`stripComments` regex edge cases** — the block-comment pattern can eat across
  a string literal containing `/*`, and the `[^:]` line-comment guard skips a
  comment immediately preceded by `:`. Test-only, no current exposure.
- **`THRESHOLD_OPTIONS`** (`AutoApprovalClient.tsx:27-31`) now calls
  `autoApprovalThresholdLabel(null|5|4)` to build a three-element array whose
  order is meaningful UI ordering. Deriving it from the map would lose the
  ordering intent. Current shape is right.
