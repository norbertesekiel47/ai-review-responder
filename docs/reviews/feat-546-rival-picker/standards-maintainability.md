# feat/546 rival picker — Standards & maintainability review

**Axis:** repo standards, design quality, maintainability. Spec compliance and
functional correctness are a separate reviewer's; where a finding touches
behaviour I say so and stop at the maintainability cost.

**Review skill used:** `thermo-nuclear-code-quality-review`, applied to
`git diff $(git merge-base HEAD origin/main)..HEAD` in
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-546-rival-picker`.
`860402ba` (runbook doc) excluded as instructed.

**Overall verdict: APPROVE WITH CHANGES.** No structural regression, no file
crosses 1000 lines, no spaghetti bolted onto an existing flow, no `any`, and the
central module is genuinely deep on its interface. What holds it back is a
single repeated theme: three business rules that the two halves of
`named-rival.ts` each re-derive instead of sharing, one of which has *already*
drifted. That is the branch's one real maintainability debt and it is cheap to
pay down now, expensive later.

---

## Findings (≥80% confidence only)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | MEDIUM | `src/lib/competitors/named-rival.ts:130-136`, `:409-414`, `:602-606` | The "which pack row is a nameable rival" rule is written three times (TS filter, TS type guard, SQL predicate) and the copies have already diverged on `review_count`. |
| 2 | MEDIUM | `src/lib/competitors/named-rival.ts:279-284`, `:433-438`, `:594-601` | The lane derivation (primary keyword + effective search location) is copy-pasted three times in this file; a fourth TS copy owns the write side at `worker/jobs/RankingTrackingWorker.ts:244-246`. Drift fails silently. |
| 3 | MEDIUM | `src/app/api/settings/competitors/route.ts:24-26,93-106` | `requireSettingsOwner` + its three type aliases are a byte-identical copy of `src/app/api/settings/auto-approval/route.ts:18-20,76-88`. Second concrete use case of a tenant-isolation guard, still un-extracted. |
| 4 | MEDIUM | `src/app/(authenticated)/settings/competitors/CompetitorsClient.tsx:43` | The `multiLocation` prop is provably dead — `shouldUseMultiLocationSettings(flag, n) \|\| n > 1` reduces to `n > 1`. A boolean is plumbed server→client that cannot change output, while the page reads as if it honours `MULTI_LOCATION_ENABLED`. |
| 5 | MEDIUM | `src/lib/competitors/named-rival.ts:669` | `export const __testing = { … }` is a second public interface exposing the module's entire decision core, and the only such export in `src/` or `worker/`. Nothing enforces "tests only". |
| 6 | LOW | `src/lib/notifications/email/templates/weekly-value-report.ts:9` | `export type { CompetitorDelta }` re-export serves zero consumers — a backwards-compat shim in a pre-launch codebase. |
| 7 | LOW | `src/lib/competitors/named-rival.ts:17-19` (also `:6`, `:285-286`) | Intra-branch task-sequencing comments left in a shipped module; `:17-19` is now factually false. |
| 8 | LOW | `src/lib/competitors/named-rival.ts:178`, `:211`, `:217` | `selectNamedRival` repeats `return autoDefault ? { kind: 'rival', line: autoDefault } : null;` verbatim three times inside one 48-line function. |
| 9 | LOW | `src/lib/competitors/named-rival.ts:110`, `:113`, `:139`, `:189` | Six non-null assertions encode an invariant (`review_count` is an integer) that the type does not carry; it is enforced by a filter 30 lines away. |
| 10 | LOW | `src/app/(authenticated)/settings/competitors/CompetitorsClient.tsx:214` | `optionLabel` separates rank/name/reviews with runs of spaces that HTML collapses inside `<option>`, contradicting the hint at `:204` ("Rank · name · reviews · rating"). |
| 11 | LOW | `src/lib/competitors/named-rival.ts:34` | `StoredRivalPick` is exported but referenced only inside its own module — public surface with no consumer. |

---

## Detail

### 1 — MEDIUM · "nameable rival" rule written three times, already drifted

Three independent expressions of the same rule:

- `selectAutoDefaultRival` candidate filter (`:130-136`) —
  `!is_self && place_id !== null && place_id.length > 0 && title.trim().length > 0 && Number.isInteger(review_count)`
- `isPickableOption` (`:409-414`) — the same four clauses **minus** the
  `review_count` clause.
- `storeRivalPick`'s SQL `WHERE` (`:602-606`) — `cs.is_self = false AND
  btrim(cs.title) <> ''`, with the `place_id` clause only implicit in
  `cs.place_id = ${placeId}`.

**Standard violated** — `.claude/rules/engineering.md`: *"Keep one authoritative
representation for each piece of system knowledge… When the same fact appears in
multiple artifacts, choose one owner and derive, generate, validate, or trace the
rest."*

The code's own comments are the tell. `:405-407`: *"The blank-title exclusion is
deliberate and mirrors `selectAutoDefaultRival`"*. `:603-605`: *"btrim, not
`<> ''`: the picker options and the digest both reject whitespace-only titles via
trim()"*. A comment whose job is to promise that two other copies agree is a
comment standing in for a missing owner.

And they do not agree: the picker offers a rival with a NULL review count, the
digest refuses to name one. Whether that asymmetry is intended is the correctness
reviewer's call — my point is structural. Nothing in the code says it is
intended, no test pins it, and the next person to touch either predicate has no
way to tell a deliberate difference from a missed edit.

**Remedy.** One exported predicate owning identity + nameability
(`isNameableRivalRow`), used by both TS sites; the review-count requirement stated
separately and explicitly at the one place it applies. Derive the SQL clause from
a single shared const so all three read from one source. This also dissolves
finding 9.

### 2 — MEDIUM · lane derivation copy-pasted four ways

`b.tracked_keywords->>0 AS keyword` plus the
`CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN lat||','||lng ELSE
ranking_search_location END` expression appears at `:279-284`, `:433-438` and
`:594-601` — and the *writer* of the value these must match computes it in
TypeScript at `worker/jobs/RankingTrackingWorker.ts:244-246`. This branch added
two of the four copies.

**Standard violated** — same engineering.md rule as #1; and its trigger rule:
*"When one change requires edits in many unrelated places, repair the missing
boundary or hidden coupling before it spreads."*

**Concrete cost, and it is the nasty kind.** These are join keys. If a reader copy
ever diverges from the writer, `ranking_snapshots`/`competitor_snapshots` match
zero rows — and the module's design turns zero rows into
`{ kind: 'teaser' }` and `state: 'awaiting_pack'`, which are *legitimate empty
states*. The failure surfaces as "we're still watching that keyword" forever, with
no error, no exception, and nothing in the `competitor_delta_resolved` log line to
distinguish it from a genuinely new location.

**Remedy.** A single fragment builder — `const laneContext = (db: Sql) => db\`…\``
— interpolated into all three statements, so the rule has one owner inside the
module. Honest cost to flag: the interpolation changes the literal SQL text that
`scripts/ci/tenant-scope-allowlist.ts:167` matches on, so `NAMED_RIVAL_LANE_SQL`
needs updating in the same change. That is a one-time edit against a permanent
four-way drift risk.

### 3 — MEDIUM · duplicated settings-route security guard

`src/app/api/settings/competitors/route.ts:24-26` and `:93-106` are a verbatim
copy of `src/app/api/settings/auto-approval/route.ts:18-20` and `:76-88` — the
same three type aliases and the same 14-line guard (reject an `accountId` search
param, `requireOwnerWithAccount`, offboarding-block → 403).

**Standard violated** — `.claude/rules/repworth.md`: *"Do not add abstraction
layers in anticipation of a feature… Wait for the second concrete use case before
extracting."* This **is** the second concrete use case, so the rule now argues
*for* extraction, not against it.

This is not a style nit because of what the code is: a tenant-isolation and
offboarding gate. When `isOperationalUIBlocked` gains a state, or the
`accountId`-param rejection tightens, one copy gets it and the other is a silent
hole. Extract to `src/lib/auth/route-helpers.ts` beside `requireOwnerWithAccount`,
which both files already import.

### 4 — MEDIUM · dead `multiLocation` prop

```
page.tsx:46      multiLocation={shouldUseMultiLocationSettings(multiLocationEnabled(), locations.length)}
CompetitorsClient.tsx:43   const showLocationNames = multiLocation || views.length > 1;
```

`shouldUseMultiLocationSettings(flag, n)` is `flag && n > 1`
(`src/lib/locations/multi-location-mode.ts:8-13`), and `views` is a `Promise.all`
over `locations` (`page.tsx:26-31`), so `views.length === locations.length`. The
expression therefore reduces to `views.length > 1` for every input. The prop, the
`multiLocationEnabled()` import, and the `shouldUseMultiLocationSettings` call
cannot change a single rendered pixel.

**Standard violated** — `.claude/rules/design.md`: *"When splitting, extracting,
or introducing variables, check whether the new boundary or name captures meaning
or only adds jumps, pass-through state."* Also brushes CLAUDE.md invariant #9b,
which keeps the three multi-location checks distinct precisely so that "mode" is
never fudged: here the mode check is imported, passed down, and then overridden.

The deviations log (Task 5) records the *reason* for the OR honestly — a flag-off
account with several locations would render indistinguishable pickers. That
reasoning is right; the implementation keeps both answers instead of choosing one.

**Remedy.** Decide. Either location naming is a count question — drop the prop,
the import and the helper call, name blocks when `views.length > 1` — or it is a
flag question and the OR goes. Do not ship the dead argument.

### 5 — MEDIUM · `__testing` is a second public interface

`:669` exports `selectAutoDefaultRival`, `selectNamedRival` and
`parseCompetitorRating` — the module's whole decision core. It is the only
`__testing` export anywhere in `src/` or `worker/`, so it establishes a repo-wide
pattern with no precedent, no ADR and no enforcement: the leading underscore is a
convention, not a boundary. No ESLint rule and no `ci:*` audit stops production
code importing it.

**Standard violated** — `.claude/rules/design.md`: *"Use tests to protect behavior
through public contracts and stable APIs… Do not let test convenience force
shallow or leaky interfaces."*

It also directly contradicts the module's own header at `:4` — *"Callers learn
three functions"*. Both statements cannot be true.

**Remedy.** Move the three pure functions into
`src/lib/competitors/named-rival/selection.ts` with ordinary named exports and let
`named-rival.ts` compose over them. Identical test access, one honest interface,
no pseudo-private marker — and the DB-touching seam gets *deeper*, because the
arithmetic stops being something it merely happens to contain.

### 6 — LOW · dead type re-export in the email template

`weekly-value-report.ts:9` re-exports `CompetitorDelta` so the
`src/lib/notifications/email.ts` barrel "keeps serving the type to existing
consumers". There are none. `CompetitorDelta` appears in exactly three files, and
the only consumer — `worker/jobs/WeeklySummaryWorker.ts:8-12` — was changed in
this same branch to import it from `named-rival.ts` directly.

**Standard violated** — the pre-launch no-backwards-compat-shim rule; and
design.md's *"every interface element… must hide enough complexity to justify its
existence."* Delete the re-export and the comment above it. The template keeps its
`import type` and nothing else changes.

To answer the question posed in the brief directly: **not a clean seam, a smell.**
A seam earns its name by serving a consumer. This one serves a hypothetical.

### 7 — LOW · stale task-sequencing comments

`:17-19` reads *"the FINAL shape lands here in #546 Task 2, even though `source`
is always 'auto_default' and `dropout` is unreachable until Task 3."* At HEAD,
Task 3 has shipped: `source` is `'owner_pick'` on the pick path (`:189`) and
`dropout` is returned at `:214`. The comment now tells a reader something false
about the type immediately below it.

Same class, less harmful: `:6` "(from Task 3)", `:285-286`
`-- read from Task 3 onward`, `:335` "(#546 Task 4)",
`CompetitorsClient.tsx:3` "(#546 Task 5)".

**Standard violated** — design.md final checklist: *"comments current and
non-duplicative."* Intra-branch task numbers are build-order scaffolding; after
the squash-merge they name nothing a reader can look up. Keep `#546`, drop the
task ordinals, and delete `:17-19` outright — the type is self-describing now.

### 8 — LOW · triplicated fallback tail

`:178`, `:211` and `:217` are the identical expression
`autoDefault ? { kind: 'rival', line: autoDefault } : null`. Hoisting
`const autoDefaultDelta: CompetitorDelta = autoDefault ? { kind: 'rival', line:
autoDefault } : null;` right after `:177` turns the function's four exits into
four *decisions* rather than three copies of one, and drops ~6 lines from a
48-line function. Pure legibility, zero behavioural risk.

### 9 — LOW · invariant carried by `!` instead of by the type

`NormalizedCompetitorSnapshotRow.review_count` is `number | null`, and the "it is
really an integer here" fact is established by `Number.isInteger(...)` filters at
`:125`, `:135`, `:181`, `:184` and then asserted with `!` at `:110`, `:113`,
`:139` and `:189`.

**Standard violated** — design.md: *"Question unnecessary optionality… If a branch
relies on silent fallback to paper over an unclear invariant, ask whether the
boundary should be made explicit instead."* The repo bans `any` for exactly this
reason; `!` is the same trade with less visibility.

A type guard returning
`row is NormalizedCompetitorSnapshotRow & { review_count: number }` — the same one
finding 1 wants — deletes every `!` and makes the rule checkable by the compiler
rather than by a reader tracing 30 lines upward.

### 10 — LOW · option label separators collapse

`:214` builds `` `#${rank}␣␣${title}␣␣${reviews} · ${rating}` `` while the hint at
`:204` promises "Rank · name · reviews · rating". Browsers collapse whitespace runs
in `<option>` text, so rank, name and review count render as one undifferentiated
run and only the rating is visibly separated. Use `·` for all three separators (or
` `), and the label matches its own hint.

### 11 — LOW · `StoredRivalPick` exported with no external consumer

`:34`. Referenced only at `:175` and `:327`, both inside the file. Make it
`interface` without `export` until something outside needs it.

---

## Deep-module assessment — `src/lib/competitors/named-rival.ts`

**Verdict: genuinely deep on its interface; not yet deep on its internals. Keep
the file, close the seams. It is not a grab-bag.**

### Where the depth is real

- **The interface is semantic, not mechanical.** `resolveNamedRival(db,
  businessId) → CompetitorDelta`, `loadRivalPickerView(db, scope) →
  RivalPickerView`, `setNamedRivalPick(db, input) → RivalPickerView`. No caller
  learns about snapshot dates, place_ids as keys, `DATE`→`::text`,
  `NUMERIC`-as-string, `LEFT JOIN` empty-pack sentinels, the two-snapshot window,
  or replace-pack races. That is the definition of a deep module.
- **Complexity moved down, measurably.** `WeeklySummaryWorker.ts` went 596 → 478
  lines and shed three row interfaces plus ~130 lines of selection logic. The
  worker's remaining involvement is one call and one log line. This is Ousterhout's
  "pull complexity downward" executed correctly, not complexity rearranged.
- **The two return types are the branch's best decision.** `CompetitorDelta` and
  `RivalPickerView` are discriminated unions over *states the caller must render*,
  never over internals. This is what lets `weekly-value-report.ts` dispatch on
  `kind` and `CompetitorsClient.tsx` dispatch on `state` while re-deriving nothing
  — the client's claim at `:5-6` ("the component never filters, sorts, or
  re-derives anything about a Competitor pack") is *true*, and it is true because
  of the type, not because of discipline.
- **Failure classification is owned at the right layer.** `RivalPickNotFoundError`
  / `RivalPickStaleError` let `route.ts:108-115` map 404/409 without string
  matching. Module owns behaviour, route owns HTTP — repworth.md's rule, honoured.
- **The hardest thing is invisible.** `storeRivalPick`'s single-statement
  validate-and-write (`:566-628`) closes a race the caller cannot even perceive,
  let alone get wrong. That is complexity genuinely hidden, and the comment
  explaining *why locking is the wrong tool* is exactly what a comment is for.

### Where it falls short

1. **`__testing` contradicts the header's own claim** (finding 5). A module cannot
   advertise a three-function contract and simultaneously export its decision core.
2. **The two halves leak into each other through duplication, not through the
   interface** (findings 1 and 2). This is the grab-bag signal — and note precisely
   *what* it is and is not. It is **not** that the file holds two concerns: digest
   resolution and picker CRUD are one concept read in two directions, and they
   belong together. It is that the two directions re-derive three shared business
   rules side by side instead of sharing them. A reader who wants to confirm the
   picker offers exactly what the digest can report must diff three SQL blocks and
   two TypeScript predicates by eye. That is a leaked seam.
3. **The central invariant is a convention, not a type** (finding 9). A module this
   deep should have made "a rival without a review count is not a rival"
   unrepresentable rather than repeatedly asserted.

### On the two design decisions the brief flagged

- **`selectAutoDefaultRival` delegating to `buildLineForRow` — correct, and a
  deepening.** Before it, gap/velocity arithmetic existed in two places that must
  never diverge; now `buildLineForRow:93-116` is its single owner and its doc
  comment says so. This is the *opposite* of findings 1 and 2 — it is the pattern
  the rest of the module should follow.
- **`loadRivalPickerView` using three flat statements while `resolveNamedRival`
  uses one CTE — accept, but the justification is not the one in the deviations
  log.** The comment at `:418-424` gives the right reason (a read-only view's worst
  concurrent outcome is rendering a just-replaced pack, and the write re-validates
  regardless) and it holds. The deviations-log reason — *"`tenant-scope-allowlist.ts`
  is outside this task's edit surface"* — is a process artifact, not an engineering
  one, and by Task 4 the file was already in the surface anyway. Two functions in
  one module reading the same tables in two different shapes is a cost a reader
  pays; it is worth paying here, but only the in-code reason justifies it. Keep the
  code comment; do not let the workflow reason survive into the design record.

### Size

669 lines, under the 1000-line threshold; `WeeklySummaryWorker.ts` shrank. No
decomposition is required on size grounds, and I am not asking for one. The
finding-5 remedy (a `selection.ts` sibling) is motivated by interface honesty, not
by line count.

---

## Checked and clean

- **No `any`** anywhere in the diff. No PgBouncer JSONB carve-out was needed or
  taken.
- **No file crosses 1000 lines**; the largest production file added is 669, and the
  branch is net *negative* on `WeeklySummaryWorker.ts`.
- **Route handler is textbook** (`route.ts`): parse, one module call, map errors.
  Zero business logic — repworth.md's rule and CLAUDE.md invariant #12, both clean.
- **Invariant #15** honoured throughout: `named-rival.ts` takes `db: Sql` /
  `tx: TransactionSql` explicitly and never imports `@/lib/db/server`. The three
  composition roots (`page.tsx`, `route.ts`, `WeeklySummaryWorker.ts`) own the
  singleton.
- **Invariant #1**: only `import type { Sql }` reaches `src/app/**`; no runtime
  driver import. **Invariant #2**: the pick write and the analytics insert share
  one `db.begin()` (`:524-549`). **Invariant #13**: no `NEXT_PUBLIC_*` companion;
  the flag is read server-side.
- **Analytics discipline is exemplary.** Registered in `ANALYTICS_EVENT_NAMES`, in
  `docs/analytics/events.md`, and in the 089 CHECK; deliberately absent from
  `CLIENT_ENQUEUEABLE_EVENT_NAMES`; the event key is seeded from the write's
  `RETURNING` timestamp rather than a JS clock, so retries dedupe. The
  `businessId`-in-properties comment (`:543-546`) explains a non-obvious
  constraint rather than restating code.
- **No silent catches.** `reloadView`'s swallow (`:59-67`) is documented and
  widens a user-visible notice; `res.json().catch(() => null)` is on the error path
  where a body may be absent.
- **Style rules**: named exports only, `const` throughout, async/await, template
  literals, early returns, no string literals where a constant exists.
- **Glossary**: `Named rival`, `Auto-default rival` / `Auto-selected rival`,
  `Competitor pack`, `Competitor Delta line` are used consistently in code,
  comments, types (`source: 'owner_pick' | 'auto_default'`) and UI copy. `CONTEXT.md`
  was extended rather than contradicted. One borderline case in the appendix.
- **Comment quality**: unusually high. ~27% of `named-rival.ts` is comment, and
  essentially all of it is rationale — races, guards, why-not-locking, why-btrim.
  I found no comment that restates its code. The only comment findings are staleness
  (7) and comments substituting for a missing owner (1).

---

## Appendix — low confidence (below the 80% bar; not findings)

1. **`AUTO_DEFAULT_LABEL = 'Auto-selected (nearest ahead)'`**
   (`CompetitorsClient.tsx:13`) vs `CONTEXT.md`'s `Auto-selected rival`. The
   glossary scopes that string to *digest copy*, so the picker is arguably free to
   differ — but it does leave one concept with two owner-facing names across two
   surfaces. Worth a deliberate decision rather than an accident.
2. **`replaceView(body as RivalPickerView)`** (`:81`, `:63`) — an unchecked cast of
   a fetch response that is then rendered. Matches the repo's norm at other client
   fetch boundaries, so not a standards violation; still an unvalidated trust edge.
3. **`saveErrorMessage`** (`:226-231`) turns wire error codes into owner-facing
   copy via `code.replace(/_/g, ' ')` — "Could not save your rival pick — account
   offboarding blocked." Presentation derived from transport identifiers couples
   two vocabularies, but the fallback is graceful and the strings are plausible.
4. **`competitorDeltaSource`** (`WeeklySummaryWorker.ts:181-186`) returns `string`
   where a union (`'omitted' | 'teaser' | 'dropout' | NamedRivalLine['source']`)
   would let the compiler catch a future variant. Minor; the function is four lines.
5. **Migration 089 re-lists all 19 `analytics_events` names.** The recurring
   immutable-CHECK landmine, correctly identified in the deviations log and tagged
   for lab-notes promotion. Not this branch's invention and out of its scope.
6. **`setNamedRivalPick` costs one transaction plus a three-statement re-read per
   pick.** Deliberate (the caller renders committed state) and documented at `:551`.
   Fine at owner-action volume; noting it only because the re-read is invisible from
   the call site.
7. **Comment density in `named-rival.ts` is near its ceiling.** Nearly all of it
   earns its place today, but a 669-line file where a quarter of the lines are prose
   has its own maintenance surface — finding 7 is what that looks like when it slips.

---

## Step 7 triage verdicts

Recorded decisions from the step-7 dual-review triage. These are the
orchestrator's dispositions, not a re-review.

### Finding 4 (MEDIUM) — dead `multiLocation` prop — **ACCEPTED — fixed**

The prop is gone. `CompetitorsClient`'s `Props` no longer declares
`multiLocation`, `showLocationNames` is now `views.length > 1` alone, and
`page.tsx` dropped the `shouldUseMultiLocationSettings(multiLocationEnabled(), …)`
computation together with both now-unused imports (`multiLocationEnabled`,
`shouldUseMultiLocationSettings` — verified unused elsewhere in the file).
`CompetitorsClient.test.tsx`'s `renderClient` helper and its multi-location
call site were updated.

Rendered behavior is unchanged by construction (the removed expression was
algebraically equivalent). A comment at the condition now records WHY the check
is location-count-only — a flag-off multi-location account must still
distinguish its pickers — so the flag check is not "restored" later.

### Findings 1, 2, 3, 5 (MEDIUM) — **ACCEPTED AS VALID, DEFERRED**

| # | Finding | Disposition |
|---|---|---|
| 1 | "Nameable rival" rule written three times, already drifted | Valid. Deferred — extracting one owner spanning a TS filter, a TS type guard, and a SQL predicate is a cross-seam refactor. Note: the `review_count` divergence this finding called out is now a **fourth** aligned copy rather than a drift, because the step-7 blank-title fix brought the pick-honor path in line; the triplication itself remains. |
| 2 | Lane derivation duplicated 3× in this file + a 4th in `RankingTrackingWorker` | Valid. Deferred — the fourth copy is outside the intake edit surface, so the extraction cannot be done here. |
| 3 | `requireSettingsOwner` byte-identical to the auto-approval route's copy, still un-extracted | Valid (second concrete use case). Deferred — touching `src/app/api/settings/auto-approval/route.ts` breaches the edit surface. |
| 5 | `__testing` is a second public interface | Valid. Deferred — replacing it means re-deciding the module's test seam, a design change rather than a review patch. |

Each is a cross-seam refactor that would breach the intake edit surface and
trip the abort criteria for no correctness gain. All four are recorded for
follow-up tickets.

### Findings 6–11 (LOW) — **DEFERRED**

Deferred likewise, except where subsumed by the three step-7 fixes. Reviewed
against the fixes: none of the LOW findings is subsumed — finding 4's removal
touched `CompetitorsClient.tsx` but not `optionLabel` (finding 10), and the
`named-rival.ts` edits did not alter the fallback tail (8), the non-null
assertions (9), the stale task comments (7), or either dead export (6, 11).
