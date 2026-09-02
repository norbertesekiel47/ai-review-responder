# Red team — round 2 — `feat/1014-restraint-tab`

Round 1's report was written at head `3716d253`. This round re-verifies every one of its
twelve findings against current HEAD by measurement rather than by trusting the fix claim,
then hunts fresh inside the fix hunks. It is the second and final round; the runner refuses
a third.

| | |
|---|---|
| Mode | `feature` (step 7.5) |
| Risk | **high** |
| Round | **2 of 2 — cap reached** |
| Fork / merge-base | `b55b07822ef92f6c85047e6f42b5513ea8427257` |
| Head | `1d7e1bb699f033c682a3b82c7e8f6e95b8eb36b2` |
| Intake SHA-256 | `bdda96281dd7b49171f0f662540c20172c166cb402dc23066c0964c98a37c6d8` |
| Budget | **30 of 30 runs used** (1 wasted — see Deviation 2); 27 mutations applied and restored |
| **STATUS** | **`OPEN_P0`** |

**Counts.** 25 findings — P0: 7 open, 3 fixed · P1: 3 open, 4 fixed · P2: 5 open, 2 fixed,
1 rejected · accepted-risk 0.
**Inventory:** 49 rows — 20 killed · 6 survived-confirmed-P0 · 1 inconclusive (`oracle`) ·
1 equivalent (with proof) · 1 excluded · 20 skipped-budget.

**Baselines at HEAD, green in both projects:** `read.integration.test.ts` 28/28, plus one
combined run over `RestraintReport.test.tsx` (24), `RestraintContent.test.tsx` (10),
`refusals-route.test.ts` (11), `read.test.ts` (4) and `DashboardStatePanel.test.tsx` (3) —
52/52. Total 80/80.

## The one-paragraph version

The fix commit `84f821ab` is largely real: it closed nine of round 1's twelve findings and
its new tests are genuine, which twenty kills prove. **It did not close F3.** The test written
for that finding asserts a *different SQL statement* — `total` comes from the separate `COUNT`,
not from the entry arm the mutation targets — and its other assertion is immune because the
out-of-window fixture sorts last. The same blind spot has three more instances the fix did not
sweep (F14, F15, F16), plus an unasserted `LIMIT` on the location arm (F13) and an unasserted
link arm (F17). One production regression was introduced by the fix itself: the notes refactor
dropped two CSS class emitters and silently demoted the scope line to muted text (F18). All six
mutation-derived P0s are **test-only** fixes; only F18 implies a production edit.

---

## Deviations from the protocol, recorded

1. **`assert-one-test` was not used; every mutant ran the whole covering test file.** The local
   database makes a full-file run about 1.4 s, so a file run costs the same one budgeted run
   and yields strictly more information — the named covering test's individual pass/fail is
   read out of the JSON report, and every other case in the file is checked for an incidental
   kill. Each inventory row names the covering test and its individual outcome. The whole-file
   result is what distinguishes "this test kills it" from "something else does".
2. **One run was wasted.** Run 1 omitted `--test-db` on the `run` subcommand (`env` validates
   the URL, but `run` rebuilds the environment from its own `--test-db`), so the live-DB suites
   silently skipped. Detected immediately from `numPendingTests` in the report and repeated
   correctly. 29 usable runs, 27 mutations.
3. **Environment.** `mutation-runner env --tmp-home <scratch> --test-db <localhost>` plus
   `dotenv-swap`; every mutant run passed the same `--tmp-home` and `--test-db`. Baseline and
   mutant runs shared that environment byte for byte.
4. **Watcher precondition.** The guard aborted on four host-wide dev-server processes. None had
   its cwd in this worktree (verified by `lsof -a -p <pid> -d cwd`), but the detector matches
   command text only and cannot read a cwd. The four processes were stopped with the owner's
   approval rather than the guard being bypassed.

---

# 1. Round-1 findings, re-verified against HEAD

### F1 — P0 — `src/lib/refusals/read.ts:189` — **fixed**
*resolveLinkKind's per-lane link authority is asserted by no test.*
**M101 killed.** The new case seeds two `unsafe_content` rows with resolving response subjects
on different lanes and asserts `heldRow.linkKind === 'review'` / `gatedRow.linkKind === null`
while both carry a non-null `reviewId`. Re-keying the rule on the category reddens it.

### F2 — P0 — `src/lib/refusals/read.ts:349` — **fixed**
**M102 killed** by `bounds the LOCATION arm at windowEnd, not only the account arm`.

### F3 — P0 — `src/lib/refusals/read.ts:379` — **STILL OPEN**
*The account entry arm's lower window bound is asserted by nothing. The new test does not
assert the statement it appears to.*

**M103 survived** the whole 28-case suite, including the case written to close it. Both of that
case's assertions are answered elsewhere:

- `expect(thirty.total).toBe(1)` is served by the **separate `COUNT` statement** at
  `read.ts:463`, which keeps its own `>= windowStart`. **M105 proves this** — deleting the
  COUNT arm's lower bound reddens exactly this test. The assertion pins `:463`, not `:379`.
- `expect(thirty.entries[0]?.category).toBe('unsafe_content')` is unaffected, because the
  45-day-old fixture is the **oldest** row and `ORDER BY r.occurred_at DESC` puts it **last**.
  There is no assertion on `thirty.entries.length`.

> **Arbiter.** Not equivalent: with `:379` gone, a 30-day account read returns every retained
> row back to 180 days. With this test's own fixtures the tab renders **two** rows under a
> header stating `total = 1` and a 30-day range — the list and the headline visibly disagree —
> and `truncated` (`total > entries.length` = `1 > 2`) is `false`, so the tab does not even say
> it is showing extra. Not an unexecuted branch: the account arm's `WHERE` runs in roughly
> twenty of the 28 cases.
>
> Verified independently by the invoking agent against `read.ts:373-395`, `read.ts:459-475`
> and the test body at `read.integration.test.ts:644-668`.

**Fix, one line:** add `expect(thirty.entries).toHaveLength(1);` beside the existing `total`
assertion — and, for the same reason, an `entries` length assertion in the windowEnd test,
whose upper-bound kill (M123) currently rides on sort order.

### F4 — P0 — `src/lib/refusals/read.ts:343,375` — **fixed**
**M104 killed** by `resolves a review only when the response belongs to the same location`.

### F5 — P1 — `src/components/dashboard/restraint/RestraintContent.tsx` — **fixed**
The `scope` prop was removed; the server's `scope` now rides the payload. Two new cases render
the success path. **M111 killed** — restoring the client-side derivation reddens
`takes scope from the payload, not from its own location context`.

### F6 — P1 — `src/components/dashboard/restraint/RestraintReport.tsx:127` — **fixed**
**M112 killed** by `omits the coverage line entirely when the ledger has no start date for this view`.

### F7 — P1 — `.../RestraintReport.test.tsx:245` — **fixed**
The `not.toMatch(/reason|draft|moderat/i)` English-word proxy is gone, replaced by six
leak-shaped sentinels. The round-1 defect — "cannot fail for the reason it claims" — is closed:
the sentinel list can fail on a real leak and can no longer redden on a copy change containing
the word "draft". Residual gap recorded separately as **F22** (P2).

### F8 — P1 — `.../analytics/restraint/page.tsx` — **fixed**
The covering case lives in `RestraintContent.test.tsx` (`describe('RestraintPage')`), not in a
`page.test.tsx`. **Verified, not assumed:** it imports the page module by path, asserts
`dynamic === 'force-dynamic'`, and renders `<RestraintPage />` under a `QueryClientProvider`
with a stubbed fetch. **M113 killed** (`dynamic` → `'auto'`) and **M114 killed** (the page stops
mounting `RestraintContent`) — both halves of the hunk are genuinely covered. The
`import './restraint.css'` side effect is exercised by the import but not asserted; that is
inherent to a stylesheet and is not raised as a finding.

### F9 — P2 — `.../RestraintReport.tsx:197` — **open, narrowed**
Two of the three singular arms are now asserted (**M127 killed**). The third —
`'1 archived location'` — is asserted by nothing, and **M128 is `inconclusive` (`oracle`)**
rather than a confirmed survivor because the branch is unreachable from any fixture:
`archivedFootnote` returns `null` when `refusalCount === 0`, and the suite's only
`locationCount: 1` fixture has `refusalCount: 0`.
**Fix:** one fixture with `{ refusalCount: 3, locationCount: 1 }`.

### F10 — P2 — `docs/directory.md:892` — **fixed**
Trap (d) now records that the other two links **are** category-keyed and why that is safe.
Verified against `read.ts:189-192`. (The same row carries a different, newly false claim — see
**F19**.)

### F11 — P2 — `restraint.css` — **fixed**
`.rst-group-link`, `.rst-row-ago` and `.rst-error-body` are gone; the scripted token diff
confirms none remains. **But the same edit created two new dead rule sets — see F18.**

### F12 — P2 — `docs/directory.md` per-file rows — **rejected**

---

# 2. New findings — round 2, inside the fix hunks

### F13 — P0 — `src/lib/refusals/read.ts:357` — **open**
*The location entry arm's `LIMIT ${ENTRY_LIMIT}` is asserted by nothing.*
**M109 survived** all 28 cases. The new cap test is **account-scope only**; the account arm's
`LIMIT` is proven (**M110 killed**), the location arm's is not.

> **Arbiter.** Not equivalent: for a location window holding more than 200 rows the mutant
> returns all of them. The `ENTRY_LIMIT` docblock (`read.ts:120-134`) names the pathology
> itself — one `solicitation` batch build proposing `MAX_DATA_ROWS` (5,000) `ask_withheld`
> Refusals — and `ask_withheld` rows carry a `business_id`, so a **location** view is precisely
> where that volume lands. Not unexecuted: the location arm runs in eight cases.

**Fix:** parameterise the existing cap test over both scopes, or add its location twin.

### F14 — P0 — `src/lib/refusals/read.ts:348` — **open**
*The location entry arm's lower window bound is asserted by nothing.* **M121 survived** all 28
cases. Same species as F3 on the other arm; no location-scope fixture is older than the window.
Arbiter: a location read then returns the whole retained ledger regardless of the selected
window; the arm runs in eight cases.

### F15 — P0 — `src/lib/refusals/read.ts:450` — **open**
*The COUNT location arm's lower window bound is asserted by nothing.* **M122 survived** all 28
cases. Arbiter: the headline number on a location view would count rows outside the range the
tab prints — the "false zero one step short of zero" that the `total` docblock
(`read.ts:89-97`) says the separate `COUNT` exists to prevent, in the other direction.

### F16 — P0 — `src/lib/refusals/read.ts:413` — **open**
*The archived-location footnote's lower window bound is asserted by nothing.* **M125 survived**
all 28 cases. The footnote's own comment (`read.ts:398-402`) says both bounds exist because the
footnote states a count for **the same window the tab prints**. The upper bound is proven
(round 1 M5); the lower is not.

> **Window-bound summary — four of the five lower bounds in this module are unasserted.**
> `:348` location entry (F14), `:379` account entry (F3), `:413` footnote (F16), `:450` COUNT
> location (F15) all survive. Only `:463` (COUNT account) is proven (M105). Both proven **upper**
> bounds (`:349`, `:380`) are killed only because a **future**-dated row sorts FIRST; every
> lower-bound fixture sorts LAST, which is why the whole edge is blind.

### F17 — P0 — `src/lib/refusals/read.ts:191` — **open**
*`resolveLinkKind`'s `contacts` arm is asserted by no live-DB test.* **M126 survived** all 28
cases.

> **Arbiter.** Not equivalent: every `no_permission` row silently loses its
> `/dashboard/requests/contacts` link — one of the exactly three links the ticket names. **Not
> unexecuted:** the suite seeds three `no_permission` fixtures, so line 191 is evaluated; only
> the assertion is missing. The sibling arm one line up (`autonomy_paused` → `auto-approval`)
> **is** asserted at `read.integration.test.ts:386`, which makes this a gap rather than a policy.

**Fix:** add `expect(<no_permission row>.linkKind).toBe('contacts')` to the existing link case.

### F18 — P1 — `.../restraint/restraint.css:230,239` — **open**
*The notes refactor dropped two class emitters, silently losing a documented visual distinction —
and left two dead rule sets, the exact defect the same commit claims to have cleaned up.*

Before `84f821ab`, `RestraintReport.tsx` emitted `className="rst-note rst-note-scope"` and
`className="rst-note rst-note-footnote"`. The refactor collapsed every note into
`notes.map((line) => <p className="rst-note">…)`, so both modifiers now have **no emitter
anywhere**.

- `.rst-note-scope { color: var(--rw-app-text); }` — full contrast, against `.rst-note`'s
  `var(--rw-app-text-muted)`. Its comment says *"It leads the block because … this one says what
  the count IS."* The D3 scope sentence now renders muted like every qualifier.
- `.rst-note-footnote { font-variant-numeric: tabular-nums; }` — lost on the one line that
  renders two counts.

No test can see this: Vitest asserts text, not computed style, and the review wave's UI axis ran
before the refactor. Verified independently by the invoking agent — the only emitter is the bare
`.rst-note` at `RestraintReport.tsx:360`.
**Fix:** re-attach the modifiers (for example, key the notes on a small `{ text, modifier }`
shape) or delete the two rule sets deliberately.

### F19 — P0 — `docs/directory.md:892` — **open**
*The `read.ts` row still says "three sequential scoped queries behind one interface". This
branch's own fix made that false.*

`getRefusalLog` now issues **four** statements per request: coverage (`:284`/`:290`), entries
(`:336`/`:368`), the scope-specific third (footnote `:404` in an account scope, archived periods
`:422` in a location scope), and the new `COUNT` (`:445`/`:459`). The fix commit added a comment
justifying *"Two statements instead of a window function"* and did not update the row.

> **Grading.** The mutation subagent proposed **P1** and recorded that a stricter reading is
> defensible. The invoking agent re-grades to **P0** and records the dissent: duty 3 says a
> misleading FALSE claim is P0 and a merely stale line number is P1. This is not a line number.
> It is a false structural claim in the code map's own row, on a read whose entire `ENTRY_LIMIT`
> rationale is tenant-shared pool pressure — statements-per-request is exactly what a reader
> budgets round-trips from. Verified independently: `grep -n 'await sql<'` over `read.ts` returns
> eight sites, resolving to four statements per request across the scope branches.

**Fix:** one word.

### F20 — P1 — `.../refusals-route.test.ts:324` — **open**
*A six-line comment now contradicts both the code and the line appended below it.*
It reads *"TWO modules, and the second is a CONSTANT not a behaviour … `write` contributes the
flag NAME (`REFUSAL_LEDGER_FLAG`) … If a third appears …"*. Commit `a818e7ec` removed that
import — `route.ts:1-11` imports `@/lib/refusals/read` and nothing else from the domain — and
appended, immediately under it, *"The refusals domain reaches this file through exactly ONE
symbol."* The two halves contradict each other and the first is false about the current route.
The assertion beneath (`toEqual(['@/lib/refusals/read'])`) is correct.
Graded P1 rather than P0: a stale code comment beside a correct assertion is not a claim in a
plan, handoff or evidence document.
**Fix:** delete the stale six lines.

### F21 — P1 — `.../RestraintReport.test.tsx:377` — **open**
*Absence-of-substring proxy over concatenated sibling paragraph text.*
`expect(container.textContent).not.toContain('caught up when it came back. This location has been')`
stands in for "an open archived period does not use the closed-period wording". It only fails if
the two `<p>` elements' text happens to concatenate in exactly that order with no separator —
insert any note between them, reorder `notes`, or add whitespace and the assertion passes while
the bug is present. This is the F7 shape.
**Behavioural replacement:** `expect(screen.queryByText(/archived from Aug 25, 2026 to now/)).toBeNull();`

### F22 — P2 — `.../RestraintReport.test.tsx:255` — **open**
The redaction test's six sentinels are allow-by-omission: a real leak spelled `refusal_source`,
`policy_gate_held`, `moderation_flagged`, or any field added later slips through. Round 1's
recommended replacement — a positive closure asserting the row's rendered text set is exactly
the formatted date plus the optional link label — was not taken. Strictly better than the
round-1 regex, so recorded rather than blocking.

### F23 — P2 — `.../RestraintContent.test.tsx:145` — **open**
`not.toContain('useEffect' | 'AbortController' | 'useRef')` are source-text absence proxies.
They redden on a comment that merely names one of the words, and pass if the machinery moves
into an imported helper — the one escape the test's own comment claims to exclude.
**Behavioural replacement:** assert the observable contract — one `fetch` per key change, an
abort on unmount.

### F24 — P2 — `src/lib/refusals/read.ts:422` — **open**
*The `ENTRY_LIMIT` sweep missed one unbounded read in the same function.* The `archivedPeriods`
query selects **every** `location_archived`/`location_reactivated` row for a location from
`account_audit_log` with no `LIMIT` and no SQL window predicate, then filters to the window in
TypeScript. Its own comment notes `account_audit_log` is a table `ArchivalPoller` never sweeps,
so the row set grows without bound. Row volume is driven by operator archive and reactivate
actions rather than tenant data, so the practical risk is low — but it is the one sibling of the
"neither arm was bounded" fix that was not swept.

### F25 — P2 — `.../RestraintContent.tsx:27` — **open**
*The new `FETCH_FAILED_MESSAGE` copy is rendered by no test.* It was changed to fix a real defect
— the message was byte-identical to the state panel's `errorHeading`, so a failure rendered the
same sentence twice. Neither error case can reach it: the 500 case stubs a body carrying an
`error` string, so `errorMessageOf` takes the body arm, and the guard-rejection case throws a
distinct literal. Graded P2 rather than P1 because the hunk does have covering candidates that
simply never take the branch, it is presentation copy on a degraded path, and no document calls
it load-bearing.
**Fix:** one case whose fetch rejects with a body carrying no `error` string.

---

# 3. Duty 2 — fragile assertions in the changed tests

| Where | Shape | Verdict |
|---|---|---|
| `RestraintReport.test.tsx:377` | absence-of-substring over concatenated sibling `<p>` text | **F21, P1** — replacement stated |
| `RestraintReport.test.tsx:255-266` | six-sentinel absence list, allow-by-omission | **F22, P2** — replacement stated |
| `RestraintContent.test.tsx:145-147` | source-text absence proxies | **F23, P2** — replacement stated |
| `read.integration.test.ts` — the new windowStart case | asserts `total` (a *different* statement) plus `entries[0]` (immune to sort order); no `entries.length` | folded into **F3** — this is why the P0 is still open |
| `RestraintReport.test.tsx:280,300,318,326,381,388` | `not.toContain('<exact owner-facing sentence>')` | **not fragile.** Each names exactly the string a sibling positive test asserts, and most are paired with a non-vacuity assertion. Recorded, no finding. |
| `RestraintReport.test.tsx:148` | exact `toEqual([...dates])` on rendered output | **not fragile.** The formatter is pinned to `en-US`, so the strings *are* the contract. |
| `RestraintReport.test.tsx:394` | `expect(new Set(names).size).toBe(2)` | **not fragile.** Distinctness *is* the accessibility claim. |
| `refusals-route.test.ts:618` | `expect(sqlCallCount.value).toBe(0)` | **not fragile.** "The route issues no query of its own" is the claim, and 0 is its only spelling. |
| `RestraintReport.tsx:304-314` note ORDER | no test asserts note order | **correct as-is.** An order assertion here would be the duty-2 defect, not the fix. |

# 4. Duty 3 — docs versus reality

`prevalidate-plan.py` was run on every changed document. The script was present; no hand-check
fallback was needed.

| Document | Result |
|---|---|
| `docs/superpowers/plans/feat-1014-restraint-tab-handoff.md` | **PASS** — 0 citations, 1 commit, 0 stale. It makes no `path:line` claims, so the script proves little; its load-bearing claim was hand-checked instead (below). |
| `docs/reviews/feat-1014-restraint-tab/blast-radius.md` | **PASS** — 8 fixtures, 0 citations |
| `.../security-tenancy.md` | **PASS** — 63 citations, 0 unresolved |
| `.../spec-correctness.md` | **PASS** — 26 citations, 0 unresolved |
| `.../standards-maintainability.md` | **PASS** — 40 citations, 0 unresolved |
| `.../ui-accessibility.md` | **1 reported issue, hand-resolved as a FALSE POSITIVE.** The citation is written as `admin/ui/format.ts:36` without its `src/components/` prefix, so the resolver cannot find it. The file is `src/components/admin/ui/format.ts` and line 36 is the `en-US` `Intl.DateTimeFormat` the row claims. Citation FORM only; the claim is true. Not a finding. |

Hand-checks beyond the script:

- **`docs/directory.md:892` trap (d)** — corrected; round-1 **F10 closed** (verified against
  `read.ts:189-192`).
- **`docs/directory.md:892` "three sequential scoped queries"** — now **false**: four statements
  per request. → **F19 (P0)**.
- **`docs/directory.md:16-17`** — *"`src/app/**` and `src/components/**` are described at folder
  level by design and are not audited."* This makes the author's rejection of round-1 **F12**
  sound.
- **`CONTEXT.md:166`, the branch's one added line (Coverage start)** — every clause checked
  against code: the `accounts.created_at` / `businesses.created_at` split (`read.ts:284-292`);
  "renders one account-wide Coverage start plus a separate line naming that lane as not yet
  recording, shown only while the flag is off" (`policyGateLine`, `RestraintReport.tsx:167-170`);
  and "a `businesses.created_at` of NULL is representable … and the tab OMITS the line"
  (`read.ts:295`, `RestraintReport.tsx:127`, now asserted by M112's test). **No finding.**
- **The handoff's blocking claim** — *"every one of those findings is already fixed"*. Against
  HEAD this is **false in one particular and true in the rest**: F1, F2, F4 and all four P1s
  (F5–F8) are genuinely fixed, but **F3 is not**. Recorded as evidence rather than a separate
  finding, because the document's own remedy — "the honest close is a fresh round that re-checks
  its findings rather than trusting a claim" — is exactly this round, and the claim was written
  before it.
- **`refusals-route.test.ts:324-329`** — in-code comment now false. → **F20 (P1)**.

# 5. Duty 4 — missed siblings

| Fixed pattern | Pattern searched | Scope | Exclusions | Result |
|---|---|---|---|---|
| The missing `LIMIT` (`ENTRY_LIMIT`) | `grep -n 'LIMIT \${ENTRY_LIMIT}'`, then an enumeration of every `await sql<` in the module (8 statements) | `src/lib/refusals/read.ts` | none | **Two siblings.** (a) the location entry arm's `LIMIT` exists but is asserted by nothing → **F13**; (b) the `archivedPeriods` query (`:422`) has no `LIMIT` and no SQL window predicate at all → **F24**. The two coverage queries and the two COUNT queries are aggregates or single-row and need none. |
| The unasserted window bound | enumerated all eight `AND r.occurred_at (>=\|<=)` predicates via `grep -n 'AND r.occurred_at'`; mutated six of eight | `src/lib/refusals/read.ts` | `:414`, `:451`, `:464` — budget, recorded as SB-1..SB-3 | **Three siblings** beyond F3 → **F14, F15, F16**. Full map under F16. |
| The two dead hrefs | `rg -n '/dashboard/contacts\|/dashboard/reviews/' -g '*.ts' -g '*.tsx' src` | all of `src/` | `__tests__` | **Zero siblings**, sound. No other component links to `/dashboard/contacts`, and no other site builds a `/dashboard/reviews/<id>` href from a non-review id. Both destinations verified to exist. |
| The unread kill switch / a flag name invisible to `ci:env-registry` | `rg -n 'readFlagEnabledByDefault\(\|readFlagEnabled\(\|flagEnabled\('`, filtered to call sites whose first argument is not a quoted literal | `src/`, `worker/` | `**/__tests__/**` | **Zero siblings**, sound. Two non-literal call sites exist and both are safe: `src/lib/refusals/write.ts:369,512` use `REFUSAL_LEDGER_FLAG`, defined in that same file, and `src/lib/db/admission.ts:61` uses `ADMISSION_ENABLED_ENV`, defined at `admission.ts:58` — both same-file consts, which `env-registry-audit.ts` resolves. The `a818e7ec` defect (an **imported** identifier) has exactly one historical instance, now fixed. |
| The three dead CSS rule sets | scripted token diff: `grep -o 'rst-[a-z-]*'` over `restraint.css` (20 unique) against the same over `src/components/dashboard/restraint/*.tsx`, then `comm` both ways | the restraint folder | ids (`rst-summary-heading`), `:first-child` grep artifacts, classes that intentionally compose with `.card` | **Two NEW siblings created by the fix**: `.rst-note-scope` (`:230`) and `.rst-note-footnote` (`:239`) now have no emitter → **F18**. The three round-1 rule sets are confirmed gone. |

# 6. Duty 5 — operational completeness

**No finding.** The search that establishes it:

- Every failure path the diff adds was enumerated. Three exist: (a) the new `COUNT` statement's
  rejection; (b) `readFlagEnabledByDefault`, a pure `process.env` read with no throw path; and
  (c) `RestraintContent`'s new `throw` when `isRestraintPayload` rejects.
- (a) propagates into the route's **unchanged** error arm →
  `reportCaughtError('api/dashboard/refusals', …)` → Sentry with `{ accountId }` and no new tag,
  no `subsystem`, no `cost_event`, no `feature`, no `finding`. Compared against all six rules in
  `docs/runbooks/beta-launch-alerting.md`: none can or should match, and there is no orphan rule
  row on the other side. The sibling precedent (`agent-team/route.ts`, WS5) likewise has none —
  the alerting model does not page on dashboard-read 500s, by design.
- The one runbook rule that names this domain — **"Refusal ledger disabled routed to Discord"**
  (`beta-launch-alerting.md:54-68`, `subsystem:refusal_ledger`, level `warning`, emitted by
  `writeRefusalEvent`/`writeRefusalEvents`, once per disabled episode, captured-but-not-paged) —
  was compared on all six facets against HEAD. **The diff does not touch `write.ts`**, so signal
  identity, filter, level, grouping title, cadence and destination action are all unchanged and
  none is contradicted.
- Considered and **rejected** as a finding: the fix makes `REFUSAL_LEDGER_ENABLED=false`
  owner-visible for the first time. The runbook's sentence *"This is the only signal that the
  ledger has a gap"* is about **operator** signals; an owner-facing disclosure is not one, so the
  row is not contradicted.
- Considered and **rejected** as a finding: (c) is a new swallowed path — a route/client contract
  mismatch, exactly what a partial deploy produces — that reaches the owner as an error card and
  reaches operators not at all. Duty 5's rule fires when one half of an alert path is missing;
  here **no** signal is emitted, so there is no path to compare, and round 1 reached the same
  conclusion for the sibling `response.json().catch(() => ({}))` swallow.

---

# 7. Red-team findings rejected

Per the rejection protocol, every rejected finding carries a one-line verdict plus `file:line`
evidence, and must also be listed in the PR description.

- **F12 (P2)** — *"five new production files were added with no `docs/directory.md` row, and CI
  cannot see it."* **Rejected.** `docs/directory.md:16-17` states verbatim: *"`src/app/**` and
  `src/components/**` are described at folder level by design and are not audited."* Round 1's
  premise contradicts the file's own rule. The author's rejection was independently confirmed
  this round.

# 8. Authorizations

None. No finding on this branch is dispositioned `accepted-risk`.

# 9. Inventory

Every candidate, executed or not. The machine-readable copy is `findings.json`; that file is the
authority, and the checker recomputes counts and status from it.

- **killed (20)** — M101, M102, M104, M105, M106, M107, M108, M110, M111, M112, M113, M114,
  M115, M116, M117, M118, M119, M120, M123, M127
- **survived-confirmed-P0 (6)** — M103 (F3), M109 (F13), M121 (F14), M122 (F15), M125 (F16),
  M126 (F17)
- **inconclusive, class `oracle` (1)** — M128
- **equivalent, with proof (1)** — EQ-1, `read.ts:478`. The `??` right arm is unreachable:
  `SELECT COUNT(*)::int AS total` with no `GROUP BY` is an aggregate over the whole result set
  and returns exactly one row for every input, including the empty one, so `totalRow` cannot be
  `undefined`.
- **excluded (1)** — EX-1, `restraint.css`. A stylesheet: no Vitest oracle can observe a rule
  change. Reviewed statically instead — see F18.
- **skipped-budget (20)** — SB-1 … SB-20. All in scope; the 30-run budget was exhausted. Where a
  static verdict exists it is recorded in `findings.json`, but a static verdict is not a mutation
  and these rows force `INCOMPLETE_BUDGET` on their own.

# 10. Cheapest path to `CLEAR`

Six of the seven open P0s are **test-only**. F19 is a one-word documentation fix. Only F18
implies a production edit.

1. `expect(thirty.entries).toHaveLength(1)` in the windowStart case → **F3**.
2. Its location twin, plus an `entries`-length assertion in the windowEnd case → **F14**, and it
   hardens F3 and M123 against sort-order luck.
3. A location-scope row older than the window, asserted absent from **both** `entries` and
   `total` → **F15**.
4. An archived-location fixture older than the window, asserted out of the footnote → **F16**.
5. Parameterise the cap test over both scopes → **F13**.
6. `expect(<no_permission row>.linkKind).toBe('contacts')` in the existing link case → **F17**.
7. One word in `docs/directory.md:892` — "three" becomes "four" → **F19**.

Note that closing every finding still leaves `INCOMPLETE_ORACLE` (M128) and
`INCOMPLETE_BUDGET` (20 unexecuted rows) ahead of `CLEAR` in the precedence, and the round cap is
spent. Reaching a literal `CLEAR` on this branch is therefore not available without an owner
decision on the cap.
