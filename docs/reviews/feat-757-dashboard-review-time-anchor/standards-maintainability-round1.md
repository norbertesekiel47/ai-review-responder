# Standards & maintainability review — round 1

**Branch:** `feat-757-dashboard-review-time-anchor`
**Diff under review:** `git diff f5151902..HEAD` (24 files, +3293 / −2111)
**Axis:** repo standards, deep-module discipline, Fowler smell baseline, glossary fidelity.
Spec-correctness and design/approach are owned by sibling reviewers and are not
re-litigated here.
**Method:** `thermo-nuclear-code-quality-review` skill applied on top of
`.claude/CLAUDE.md` working rules + invariants.
**Verification run during review:**

- `pnpm ci:tenant-scope` → `passed — entries: 401 (baseline: 401)`
- `vitest run` on the four touched/added suites → **4 files / 36 tests passed**
- `rg` sweep for the deleted surfaces across `src/ worker/ scripts/ e2e/` → **CLEAN**

---

## Verdict

**No structural regression, no file-size explosion, no spaghetti growth, no
invariant violation.** The branch is net-negative on concept count: it deletes a
415-line service, a 91-line route, three suites and seven tenant-scope allowlist
entries, and replaces the duplicated bucketing decision with one 58-line
single-owner module. The `rv`/`rev` → `r` alias rename is complete and
consistent — no residue anywhere in the two dashboard files, and the aggregate
counter query already used `r`, so the rename made the file *more* uniform, not
less.

The findings below are all **maintainability / test-integrity**, none behavioral.
The two MEDIUM ones are worth fixing before merge; the LOWs are cheap.

---

## Standards checklist

| Standard | Result |
|---|---|
| No `any` (JSONB carve-out) | **PASS** — the one new narrowing (`route.test.ts:507`) is a proper `v is {…}` type guard over `unknown`, not a cast. |
| No silent catches | **PASS** — no new `catch` in the diff. |
| No string literals for status / tier / job / review status | **PASS** — `REVIEW_STATUS.DELETED`, `HANDLED_STATUSES`, `APPROVAL_METHOD.OWNER` imported. The one raw `'posted'` in the integration fixture is `satisfies (typeof HANDLED_STATUSES)[number]` with a comment naming why `responses.status` has no per-value export. Correct handling of a real gap. |
| Invariant #15 — domain modules take `sql` explicitly | **PASS** — `fragments.ts` takes `sql: Sql` as its first parameter and imports nothing from `@/lib/db/server`. `db-imports-audit.test.ts` fixtures were re-pointed at surviving files rather than deleted, so the root-classification assertions keep their coverage. |
| Invariant #8 — tenant scope | **PASS** — no fragment spells a `FROM`/`JOIN` or a tenant predicate; every composition site keeps `business_id =` / `account_id =` literal in its own template. `fragments.test.ts:41` asserts this negatively. Audit passes at the shrunk baseline. |
| Entry points orchestrate; modules own failure behavior | **PASS** — no logic moved into a route. |
| Glossary fidelity (`CONTEXT.md` → Review-time anchor, Review import) | **PASS** — code, comments, tests and the ADR addendum all say "Review-time anchor" and "Review import". No invented synonym anywhere in the diff. `CONTEXT.md` owner path updated to `src/lib/kpi/fragments.ts` in the same change. |
| No new file without justification | **PASS, with a caveat** — see "Does `fragments.ts` earn its existence" below. |
| File-size discipline (<1k lines) | **PASS** — `service.ts` 618, `aggregate-queries.ts` 359, `fragments.ts` 58, `types.ts` 50 (was 107). Nothing near the threshold. |
| Net-negative bias | **PASS** — code lines are strongly net negative; the +3293 is dominated by plan/deviation/blast-radius docs and the 482-line eval suite. |
| Dangling references to deleted exports | **PASS in code** (`rg` CLEAN), **FAIL in one live doc** — Finding 3. |

---

## Does `src/lib/kpi/fragments.ts` earn its existence?

**Yes.** The "not a variation seam" claim is honored, not quietly violated:

- Nothing varies across the module. `ReviewsPrefix` is a closed `'' | 'r.'`
  union, not an open strategy parameter; there is no registry, no injected
  clock, no `anchorKind` argument, no options bag. The doc comment forbids
  exactly those and the code matches the comment.
- The deletion test holds: removing it re-spells one load-bearing invariant
  (LEAST + NULL-skip + future-clamp) at 17 composition sites across two files.
  That is locality, not indirection.
- Precedent cited (`openFlagExistsSql`, #730) is real and structurally
  identical — a lazy fragment factory taking the caller's client, carrying a
  comment explaining a non-obvious Postgres property (there: partial-index
  inference; here: LEAST's NULL semantics and the future clamp).

Two notes on placement, neither blocking:

- The `openFlagExistsSql` precedent lives *inside its owning domain module*
  (`src/lib/moderation/held-draft.ts`), not in a dedicated `fragments.ts`. A
  literal reading would have put these two factories in `src/lib/dashboard/`,
  their only composers. `src/lib/kpi/` is nonetheless defensible: `kpi/types.ts`
  is broadly imported (11 production files — hooks, components, routes,
  `agents/read.ts`), so `kpi/` is a real vocabulary namespace rather than a
  dashboard appendage, and `docs/directory.md` documents the choice in the same
  change.
- The `'' | 'r.'` branch returning two hardcoded templates (rather than
  interpolating `prefix`) is *correct* — an interpolated prefix would become a
  bind parameter — but nothing says so. The failure mode is loud (syntax error
  on first run), so this is an appendix note, not a finding.

**Doc-comment accuracy:** high, with one over-claim (Finding 4). Every non-obvious
claim in the file — LEAST vs COALESCE, the future clamp vs `generate_series`, why
no FROM/JOIN, why workflow KPIs stay on `detected_at` — carries reasoning a reader
cannot derive from the code. This is dense-but-load-bearing, which is the repo
convention, not comment bloat.

---

## Composition-site readability (17 sites, 2 files)

Readable. The fragment renders inline where a column expression would have been,
so the SQL still scans top-to-bottom as SQL. The one place density rises is
`service.ts:521-540` (the star window), where six `${reviewTimeAnchor(sql, '')}`
calls appear inside four `FILTER (WHERE …)` clauses — but that query was already
the densest in the file and the fragment did not make it worse. The alias rename
to `r` actually *reduced* the reader's load in `aggregate-queries.ts`: all four
review-touching queries in that file now use the same alias.

The two comments added in `aggregate-queries.ts:193-196` and `:213-214` carry
genuinely non-obvious reasoning (the anchor must stay in the `LEFT JOIN … ON`
clause or the outer join degenerates and a review-less location loses its
zero-filled series) and are pinned by a live-DB test (`t13`). Good comment.

---

## Test quality

**Strong overall.** Specifically good:

- The **negative controls are real controls**, not decoration: response rate,
  the aggregate counters, timeSaved and the recent-review feed each have a
  fixture engineered so the *wrong* anchoring would visibly change the number
  (t7's `priorSampleSize`/`delta`, t12's `windowedReceived: 2`).
- `t6` (future-`review_date` clamp) is explicitly labelled as **not**
  red-before/green-after and says what it actually protects against
  (a `COALESCE` swap). That honesty is rare and worth keeping.
- The `+8 days` choice over `+2 days`, and the "any fixture whose assertion
  names a week is seeded at `NOW()`" rule, are both documented with the ISO-week
  reasoning. These are the kind of test-flake root causes that normally get
  rediscovered a year later.
- Exact anchor **occurrence counts** (`{velocity: 3, star: 7, trend: 3, rating: 1}`)
  rather than `toContain` — a partially re-anchored query fails. Paired with
  `stripAnchor()` so any surviving bare `detected_at` also fails. This is the
  right shape for a spelling pin: brittle *on purpose*, and brittle in a
  direction that produces a true positive.

**Are the SQL-shape pins brittle in a bad way?** No. They break only when the
anchored predicate set changes, which is precisely the event that should force a
reviewer back to ADR 0019. The counts are stable under the Finding-2 fix
(`star` stays 7), which is a good sign the pin is measuring the invariant and
not the formatting.

Weaknesses are Findings 1, 4 and 5 below.

---

## Findings (≥80% confidence)

### 1. MEDIUM — `src/app/api/dashboard/__tests__/route.test.ts:967, 989`

**The two whole-file #403 negative controls silently stopped covering the three
predicates this branch moved into fragments.**

This file's `sql` mock is not fragment-aware: a nested fragment is returned as an
inert `{ fragmentText, values }` object and is **never** pushed to
`capturedSqlTexts`/`capturedSqlValues` (`route.test.ts:47-56`). The branch
recognised this and patched **one** assertion site (the rating-breakdown test,
amendment #2 / deviation D10, `:495-516`), but left the two file-wide controls
untouched:

- `:967` `numericBoundValues()` does `capturedSqlValues.flat()` — a fragment's
  bound `windowDays`/`priorEndDays` is inside the fragment object and is dropped
  by the `typeof v === 'number'` filter. The four tests at `:982/:1004/:1017/:1029`
  still pass only because `30`/`60`/`7`/`14` are *also* bound top-level by other
  queries; the evidence base for the assertion shrank without the assertion
  changing.
- `:989-991` `for (const text of capturedSqlTexts) expect(text).not.toMatch(/INTERVAL '\d+ (days|weeks)'/i)` —
  the branch's stated purpose is "No interval is ever interpolated as raw SQL
  text; **every** windowed query uses `make_interval(...)`". Three predicates
  (`service.ts:372`, `:540`, and the aggregate's `reviewTimeWindowFilter` site)
  moved out of the parent template and are now invisible to this loop. They were
  covered before this branch.

The branch's own comment at `:495-499` states the mechanism, so this is a
carry-over the author was one step from making. Cost: the #403 invariant now has
a hole exactly where the new abstraction lives, and it will widen every time a
predicate moves into a fragment.

**Suggested fix:** hoist the `isFragment` guard added at `:507` to module scope
and use it in both `numericBoundValues()` (flatten fragment `values`) and the
`:989` loop (also scan `fragmentText`). One helper, both controls restored, no
new file.

---

### 2. MEDIUM — `src/lib/dashboard/service.ts:523, 526`

**The `star_current` / `star_n_current` FILTER predicates hand-spell exactly what
`reviewTimeWindowFilter` returns — in the same query that uses the helper at
`:540`.**

```
:523  WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${windowDays})
:526  WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${windowDays})
:540  AND   ${reviewTimeWindowFilter(sql, '', priorEndDays)}
```

`reviewTimeWindowFilter(sql, prefix, n)` is defined as
`${reviewTimeAnchor(sql, prefix)} >= NOW() - make_interval(days => ${n})` —
byte-identical to `:523`/`:526` with `n = windowDays`. Both are single-sided
day lookbacks, which is the exact shape the helper's own doc comment claims for
itself: *"Single-sided rolling review-time lookback in DAYS. Two-sided (current
vs prior) buckets and week-based lookbacks compose `reviewTimeAnchor` directly
instead — one fragment per predicate shape, not per call site."* `:529-534`
(two-sided) and the week-based sites correctly follow that rule; `:523`/`:526`
contradict it.

This is the copy-pasted-instead-of-reused smell, appearing inside the one module
whose entire justification is single-ownership of a spelling. Cost is small but
directional: a future change to how a days-window is expressed now has to be made
in two forms, and the next reader has no way to tell which form is canonical.

**Suggested fix:** replace `:523` and `:526` with
`${reviewTimeWindowFilter(sql, '', windowDays)}`. Anchor occurrence counts are
unchanged (`star` stays 7), so `service.review-time-anchor.test.ts` needs no edit —
which is itself evidence the shape pin is measuring the right thing.

---

### 3. MEDIUM — `docs/analytics/posthog-dashboards.md:10-11`

**A live reference doc still routes readers to the module and route this branch
deleted.**

> These render from `src/lib/kpi/*` (`DashboardKpiSummary`, served by
> `GET /api/dashboard/kpis`), scoped per-location or per-account …

`DashboardKpiSummary` (`src/lib/kpi/types.ts`), `getLocationKpiSummary`,
`getAccountKpiSummary` and `GET /api/dashboard/kpis` are all deleted on this
branch. The table underneath it also still documents "Review volume MoM" and
"Average time-to-respond" as shipping KPIs — both died with the service (the ADR
addendum records them as returning with the deferred KPI-cards work).

Violates the working rule *"When deleting a doc or ticking a checklist item, fix
its audit tick and grep the filename to clean every cross-reference in the same
change."* The branch ran that sweep, but scoped it to
`src worker scripts e2e` plus `docs/directory.md CONTEXT.md .claude/CLAUDE.md`
(deviations D8/D9) — `docs/analytics/` was outside the net.

This one matters more than the other stale hits because **it is not a dated build
record and it is not swept post-merge**: the `document-feature` convention covers
`currents.md`, `progresstracking.md`, the `.claude/reference` inventories and
`CLAUDE.md`. Nothing will ever come back for this file.

**Suggested fix:** repoint the section at the dashboard payload
(`GET /api/dashboard`, `src/lib/dashboard/*`), drop the two rows for the metrics
that no longer render, and note the anchor. Three lines.

---

### 4. LOW — `src/lib/kpi/__tests__/fragments.test.ts:21` (claim at `src/lib/kpi/fragments.ts:7`)

**The single-owner source audit only matches the `review_date`-first argument
order, so a semantically identical re-spelling evades it.**

```ts
const ANCHOR_PATTERN = /LEAST\(\s*(?:[A-Za-z_][\w$]*\.)?review_date\s*,/;
```

`LEAST(detected_at, review_date)` — same value, same NULL semantics, same clamp —
does not match. So does `LEAST(r.detected_at, r.review_date)`. A developer
writing the predicate fresh (rather than copying the canonical form) has a
coin-flip chance of landing on the unguarded order, and the audit is the *only*
thing standing between that and `fragments.ts` quietly going dead — the shape
pins and the live-DB suite would all stay green, exactly as the test's own
comment at `:62-64` warns.

The doc comment at `fragments.ts:7` over-claims relative to what runs: "fails if
any non-test source file outside this one spells **the anchor**" (the concept),
where the regex only catches one of its two spellings. The ADR addendum is more
careful — it names the literal string — but the module comment is what a
maintainer reads.

**Suggested fix:** make the pattern order-agnostic
(`/LEAST\(\s*(?:\w+\.)?(?:review_date|detected_at)\s*,\s*(?:\w+\.)?(?:detected_at|review_date)\s*\)/`)
or, cheaper, keep the regex and narrow the comment to the exact spelling it
guards.

---

### 5. LOW — `src/lib/dashboard/__tests__/service.review-time-anchor.test.ts:52-59` and `aggregate-queries.review-time-anchor.test.ts:26-32`

**The `findOnly` throw-on-ambiguous-marker helper is duplicated verbatim between
two suites in the same directory, and the first copy carries a dead alias.**

Two separate issues, one location:

- The helper is copied byte-for-byte into both files, with the aggregate copy's
  comment saying *"Same throw-on-ambiguous-marker helper as the single-location
  suite — copy it verbatim"* — acknowledging the duplication without justifying
  it. Both files sit in `src/lib/dashboard/__tests__/`, so sharing is a
  four-line local module (or one importing the other). The helper exists because
  a real defect (deviations round-2 MAJOR #5: `find('FROM responses resp')`
  silently matching the rate query's EXISTS subquery) got through with a plain
  `.find()` — it is a *safety* helper, and safety helpers drifting between two
  copies is how the next version of that defect ships.
- `const find = findOnly;` at `:59` is dead indirection: `findOnly` is declared,
  documented, immediately aliased, and only `find` is ever called. Name it once.
  (This came straight from the plan at `:445/:452`, so it is a plan artifact
  rather than an authoring slip — but it should not survive review.)

**Suggested fix:** one shared `findOnly` in
`src/lib/dashboard/__tests__/helpers/`, imported by both suites under its real
name.

---

### 6. LOW — `scripts/ci/tenant-scope-allowlist.ts:80`

**Trailing comment restates the changelog block added four lines above it.**

```ts
//   408 → 401 (#757), a SHRINK. The consumer-less Stack A KPI service under
//     `src/lib/kpi/` was deleted with its route, taking all seven of its
//     entries with it. …
export const ALLOWLIST_BASELINE = 401;   // was 408 — seven Stack A KPI-service entries removed with the file (#757)
```

The block comment is the file's established convention for every prior baseline
move and already says everything the trailing comment says. The pre-branch line
was bare (`export const ALLOWLIST_BASELINE = 408;`), so this trailing comment is
new duplication, not a preserved convention — two places to update on the next
baseline change, and the file's comment-heaviness makes drift easy to miss.
Drop the trailing comment; keep the block entry.

---

## Low-confidence appendix (not findings — judgement calls, context, or below the bar)

- **`docs/currents.md:32-33, 44-51`** still name `src/lib/kpi/service.ts` as the
  anchor owner and call `GET /api/dashboard/kpis` consumer-less. Deliberately
  *not* a finding: `currents.md` is a chronological build log (each entry is a
  dated snapshot of what a PR shipped) and it is swept post-merge by the
  `document-feature` convention — the recent history shows exactly that
  (`docs(#688): post-merge sweep — currents, progress, lab notes …`, `402779a3`).
  Worth confirming the #757 sweep entry lands, since the #688 entry's "GA gate
  transferred to #757" pointer is now resolved.
- **`PLAN.md:32, 90`** ("`/api/dashboard/kpis` stays as-is for non-UI callers")
  is now false, but that document already carries a superseded banner from
  2026-06-19 and reads as a frozen historical plan. Low value to touch.
- **`docs/sass_ready/11-data-analytics-bi.md:5`**, **`docs/sass_ready/updates.md:108,155`**,
  **`docs/progresstracking.md:143`** — all dated Wave-3 status records. Historical
  by construction; leave them.
- **`docs/adr/0019-kpi-review-time-anchor.md:44, 118`** still point at
  `src/lib/kpi/service.ts`. Deliberately excluded from the sweep (deviation D9)
  on the grounds that an ADR is a historical decision record. Agreed for `:44`
  (inside the original decision). `:118` sits in **Consequences → Glossary** and
  reads as a live pointer ("the fragment doc comment in `src/lib/kpi/service.ts`
  cites this ADR"), which the addendum then contradicts 20 lines later. A
  one-word "(then; now `fragments.ts`)" would remove the contradiction without
  rewriting history. Below the bar because the addendum is adjacent and
  unambiguous.
- **`fragments.ts:44-51`** — the `'' | 'r.'` branch returns two hardcoded
  templates rather than interpolating `prefix`, and nothing explains why
  (interpolation would bind the prefix as a parameter). Not raised as a finding
  because the failure is immediate and loud — `LEAST($1review_date` is a syntax
  error on first execution, and `fragments.test.ts:36-37` pins both spellings.
- **Placement of `fragments.ts`** — `src/lib/dashboard/` would follow the
  `openFlagExistsSql` precedent more literally (fragment lives in its owning
  domain module). `src/lib/kpi/` is defensible and documented; not worth a move.
- **`route.test.ts:515`** `expect(boundValues).toContain(30)` is a loose
  assertion (any `30` in that query's bind list satisfies it). In practice the
  breakdown query binds only `businessId`, `REVIEW_STATUS.DELETED` and the
  fragment, so it is unambiguous today. Would tighten to an exact
  `toEqual([30])` on the fragment's own `values`.
- **`fragments.test.ts:24-28`** `sourceFiles()` reads every `.ts`/`.tsx` under
  `src` + `worker` on each run. Measured cost is negligible (the four suites ran
  in 507 ms total), and there is repo precedent for static-policy invariants
  living in vitest (`eslint-boundaries.test.ts`, `model-pinning.test.ts`), so
  this is not a layer violation. Flagging only so a future reader knows it is a
  whole-repo scan and does not casually widen its glob.
- **Positional `sqlReturnQueue` seeding** in both new suites (a comment-documented
  array of `[]` placeholders keyed to wave order) is brittle against query
  reordering — but it is the established `service.rating-breakdown.test.ts`
  pattern, so changing it is a repo-wide decision, not a branch finding.

---

## Approval bar (thermo-nuclear criteria)

| Criterion | Result |
|---|---|
| No clear structural regression | **Met** |
| No missed dramatic simplification | **Met** — the code-judo move (delete Stack A rather than dual-maintain the anchor) is the branch's central act |
| No unjustified file-size explosion | **Met** |
| No spaghetti growth from special-case branching | **Met** — zero new conditionals in production code |
| No hacky/magical abstraction | **Met** — closed union, no strategy, no registry |
| No unnecessary wrapper/cast/optionality churn | **Met** |
| No architecture-boundary leak or canonical-helper duplication | **One instance** — Finding 2 (`reviewTimeWindowFilter` hand-spelled) |
| No missed obvious decomposition | **One instance** — Finding 5 (`findOnly` duplicated across sibling suites) |

**Recommendation: approve after Findings 1–3.** Findings 4–6 are cheap enough to
fold into the same commit.
