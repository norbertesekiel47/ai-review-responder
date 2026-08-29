# Spec & correctness review — `feat/refusal-log`

Axis: **spec & correctness**. Read-only. Branch `feat/refusal-log`, HEAD `1466ffc6`,
fork point `5ab6bfee`. Contract: `docs/superpowers/plans/feat-refusal-log-intake.json`
(the plan is commentary). Inputs consumed: `docs/reviews/feat-refusal-log/blast-radius.md`,
`docs/superpowers/plans/feat-refusal-log-deviations.md` (17 entries, all ACCEPT).

**Verdict: the diff faithfully implements the locked intake contract.** All 74
promised test titles exist verbatim and all but the ones listed below genuinely test
their claim; all 11 invariants hold; every non-goal is respected; no path outside
`allowed_edit_surface` changed. Five findings, all in the "the eval is weaker than it
looks" class the brief asked for — one of them a latent correctness hazard, four of
them test-strength.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| MEDIUM | `src/lib/refusals/vocabulary.ts:142-146` | `RENDER_WITHHOLD_REASONS` is `satisfies readonly RenderWithholdReason[]` — membership, **not** exhaustiveness — and is referenced by no test. A 4th `RenderWithholdReason` is compile-forced into `RENDER_LANE_REFUSAL_CATEGORIES` but **not** into this list, so `read.ts:593` anchors it on `COALESCE(run.started_at, r.updated_at)` instead of `rendered_at`. Silent wrong dates, nothing red. |
| LOW | `src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:138-155` | "renders one owner sentence per category" uses 7 groups of exactly ONE entry, so `getByText` cannot distinguish per-category from per-entry. A sentence duplicated per row in a link-less category leaves the suite green — the D16b failure mode, one level over. |
| LOW | `src/app/api/dashboard/__tests__/refusals-route.test.ts:486-497` | "reads only the impersonated account" mocks `requireRole`, so impersonation is never exercised; `not.toContain(ADMIN_ACCOUNT_ID)` is vacuous in arm 1 (that id is never introduced into the flow). Only arm 2's foreign-location 404 is load-bearing. |
| LOW | `src/components/dashboard/restraint/RestraintContent.tsx:68` | Intake `edge_cases[12]` says "A **past_due** or cancelled subscription takes the existing SubscriptionUnavailableCard branch." `perLocationActive` (`src/lib/dashboard/scope.ts:24`) grants `past_due` full access, so a past_due account sees the whole tab. Only `cancelled` is tested. |
| LOW | `src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:188-216` | "lists entries newest first within each category" passes on a fixture that is already newest-first while the component never sorts. It proves "does not re-sort"; the newest-first claim rests entirely on `read.integration.test.ts:1141`. |

---

## 1. `user_visible_behavior` — 13 entries

Read against `src/components/dashboard/restraint/{RestraintContent,RestraintReport}.tsx`,
`src/app/(authenticated)/dashboard/analytics/restraint/page.tsx`,
`src/components/dashboard/analytics/AnalyticsTabs.tsx`.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Restraint tab on `/dashboard/analytics` → `/dashboard/analytics/restraint` | TRUE | `AnalyticsTabs.tsx:34-40`; mounted in both `AnalyticsAggregateView.tsx:44` and `AnalyticsPerLocationView.tsx:52` (deliberately outside the per-location `hasAnything` ternary, so it survives the empty state). |
| 2 | States the total for the window and breaks it down by category | TRUE | `RestraintReport.tsx:157-163` (total), `:171-173` + `CategorySection` (breakdown). |
| 3 | Total = sum of category counts | TRUE **by construction** | `groupEntries` (`read.ts:411-414`) computes `total` as `categories.reduce(sum + group.count)`; `RestraintReport` reads both off the same object and never recomputes. |
| 4 | Categories list dated entries newest first, each carrying one owner sentence | TRUE (per-**category** reading) | Sentence is `rst-group-sentence` (`RestraintReport.tsx:206`), one per `CategorySection`. The intake's own test title ("one owner sentence per **category**") settles the "each" ambiguity in favour of this reading; ordering is the read's (`ORDER BY occurred_at DESC, entry_id DESC`, `read.ts:684`) and the view maps without sorting. |
| 5 | Held-draft entry names its review and links to it; no draft/review/moderation text | PARTLY — see LOW-CONFIDENCE | Links: yes (`reviewHrefFor`, `RestraintReport.tsx:126-132` → `/dashboard/reviews/<id>/timeline`, route exists). Shows no text: yes (the read projects five safe fields only). "Names" the review: the row renders only a date, a relative day and a generic "See the review" — nothing identifies *which* review. |
| 6 | Autonomy-paused entry links to `/settings/auto-approval` | TRUE | `vocabulary.ts:423`; route `src/app/(authenticated)/settings/auto-approval` exists. |
| 7 | No-permission entry links to the contacts list | TRUE | `vocabulary.ts:413` → `/dashboard/requests/contacts`; route exists. |
| 8 | `wrong_moment` / `below_our_bar` / `missing_information` carry no link | TRUE | `vocabulary.ts:405-429`, `link: null`; `sharedDestinationFor` returns null and `reviewHrefFor` bails on a non-`review` kind. |
| 9 | 7d/30d/90d/12w window control works as on other analytics views | TRUE | Same `PeriodToolbar` in the same `TopBar` action slot, same lifted `period` state as `AnalyticsContent.tsx:29-32`; both reads take it. |
| 10 | Follows the active location scope | TRUE | `useLocationScope()` → `?scope=` on `/api/dashboard/refusals`; route maps `scope=all` → `{kind:'account'}`, otherwise `resolveDashboardLocation` → `{kind:'location'}`. |
| 11 | An account-wide refusal appears in every location scope | TRUE | S4 arm carries no `businesses` join and no `inLocation` conjunct (`read.ts:497-512`); pinned behaviourally at `read.integration.test.ts:743`. |
| 12 | Empty window reads as a plain statement | TRUE | `RestraintReport.tsx:146-154`; `queryByRole('alert')` absent, zero `.rst-row`, zero `.rst-group` asserted at `RestraintContent.test.tsx:365`. |
| 13 | No full subscription access → existing `SubscriptionUnavailableCard` branch | TRUE for the "existing branch" | `RestraintContent.tsx:68` delegates to `perLocationActive`, the same predicate `AnalyticsContent.tsx:47` uses. See the past_due finding for the one clause this makes literally false. |

Nothing renders that is not named here: the extra affordances are a relative-day
string derived from the same timestamp (`relativeDay`, adds no new fact) and a
`LiveRegion` announcement — both presentational, neither a new behaviour.

## 2. `invariants` — 11 entries

1. **Tenant isolation, per arm.** Every arm spells `r.account_id = ${scope.accountId}`
   in its own template (`read.ts:445, 476, 507, 529, 614, 676`) and every
   business-keyed arm carries `AND ${inLocation}` as its own conjunct. Structural
   proof is per-arm (the test splits on `UNION ALL` before asserting,
   `read.test.ts:203-228`), and each arm additionally carries a behavioural
   foreign-account **or** foreign-location negative-row case
   (`read.integration.test.ts:576, 597, 611, 634, 654, 676, 755`). The intake says
   "or", so this is satisfied; note that S5/S6/S7 have only the foreign-**location**
   half, and their account predicate is proven structurally.
2. **Every join scoped on both sides.** S1 `businesses loc` pinned to the account +
   `rev.business_id = loc.id`; S3 the same via `resp.business_id = loc.id`; S6's
   `LEFT JOIN agent_runs` carries `run.account_id` + `run.business_id = loc.id`.
   Both cross-tenant drift cases pass a perfectly-scoped root row that names a
   foreign child and assert the whole entry is dropped (`:697`, `:717`).
3. **`flagged_responses` keeps deny-all RLS.** No migration in the diff; `pnpm
   ci:rls-audit` passes (43 tenant tables, static gate).
4. **`flagged_responses.reason` never selected.** Not in the projection, not in a
   predicate, not logged. Four independent proofs: the SQL text scan
   (`read.test.ts:132`), the live-DB seeded-prose absence + positive five-key
   assertion (`read.integration.test.ts:844`), and the three route cases
   (body-at-any-depth, error path with a postgres.js `query`/`parameters`/`detail`
   body, log capture).
5. **Invariant #15.** `read.ts` and `vocabulary.ts` take/receive no singleton; the
   whole-directory substring scan at `read.test.ts:389` enforces it (strong enough
   that even prose naming the path fails — which is why the module comment
   deliberately does not spell it). `pnpm ci:db-imports` is green in the gate record.
6. **Route orchestrates only.** 26 lines of body; one `getRefusalLog` call per
   branch, asserted `toHaveBeenCalledTimes(1)` in both; the source scan bans
   `sql\``, SQL verbs, the vocabulary import and `.map(`/`.filter(`/`.reduce(`/`.sort(`
   (`refusals-route.test.ts:363-410`).
7. **One authoritative vocabulary, no refusal literal at a call site.** Confirmed by
   inspection: `read.ts` binds `= ANY(...)` lists derived from the maps
   (`refusalCodesOf`), never a code; `RestraintReport`'s `DESTINATION_LABEL` is keyed
   by `HrefDestination` extracted from `REFUSAL_CATEGORY_META`, so re-pointing a link
   is a compile error at the label table. The only SQL literals are lane predicates
   (`'high'`, `'withhold'`, `'withheld'`), not refusal codes.
8. **Every code maps to a category or explicit `null`.** 42 codes (excluding the
   codeless `held_draft` lane): 25 categorised, 17 explicit `null`, matching the
   `docs/directory.md` row. `expectTotalMapping` asserts key-set **equality** against
   the authority and uses `Object.hasOwn`, so an omission and an invention both fail.
9. **`satisfies Record<SourceEnum, …>` on the four TS enums.** Present for
   `WithholdReason`, `AutoPolicyDowngradeReason`, `AutonomySuspensionTrigger`,
   `BatchHaltReason` and `RenderWithholdReason`. **One gap** — see the MEDIUM
   finding: the render/dispatch **anchor partition** (`RENDER_WITHHOLD_REASONS`) is
   *not* under an exhaustiveness guard even though the category map beside it is.
10. **Outreach withheld vocabulary guarded by a migration-111 parse, not the type
    system.** Correct, and `BATCH_HALT_REASONS` is guarded the same way with an
    explicit array-equality assertion against the CHECK first — which is what earns
    the self-referential `satisfies` on the map.
11. **Category order is a closed precedence list.** Pinned at
    `vocabulary.test.ts:324` and consumed directly by `groupEntries`
    (`REFUSAL_CATEGORIES.flatMap`), so the output order cannot drift from the pinned
    constant without editing the constant.

## 3. `edge_cases` — 14 entries (the brief said 12)

All handled with a behavioural test except #12.

1. Zero refusals → empty statement — `read.integration.test.ts:1130`, `RestraintContent.test.tsx:365`.
2. Location with zero location-keyed refusals renders only the account-keyed ones — `:743` (S4-only in both location scopes).
3. Flagged response whose review is gone → dropped by the INNER JOIN — `:1117` (with the fixture's own note that the FK cascade makes this doubly enforced).
4. Lifted suspension still appears — `:1077`, which asserts the *premise* (both policy columns NULL after the lift) before asserting the entry.
5. One response downgraded twice → two entries — `:1035`.
6. `>=` at the window start — `:1284` (`decidedAt` derived from the same arithmetic the read uses, under a frozen clock).
7. After the window end → excluded — `:1307`.
8. Reason-dependent S6 anchor — `:1182` / `:1202` / `:1223`. Every fixture sets `rendered_at`, the run start and `updated_at` to **three different instants**, so each assertion is about the anchor rather than a coincidence.
9. A later mutation does not move a durable-anchored entry — `:1244`, mutating `updated_at` to an in-window instant and asserting neither anchor follows.
10. One suspension = exactly one entry in both scopes — `:779` / `:797`; the aggregate case first asserts the account has >1 location, so the exactly-once claim can actually bite.
11. Impersonated admin — covered, weakly; see the LOW finding.
12. **past_due or cancelled → SubscriptionUnavailableCard** — cancelled yes, **past_due no**. See the LOW finding.
13. Foreign location → uniform not-found — `refusals-route.test.ts:436`, including the byte-identical "does not exist" arm.
14. Unrecognised code is a fault — `read.test.ts:274` (through the real `getRefusalLog` over a mock row), plus `refusalCategoryFor`/`resolveRefusalCategory` throw cases.

## 4. `non_goals` — 13 entries

Nothing excluded has crept in.

- **No migration** — `supabase/migrations/` untouched in `git diff --stat`.
- **No RLS change** — same; `ci:rls-audit` green.
- **No capture layer, no write action** — the only new write-shaped code is the eval's
  fixtures. The route is `GET` only; `RestraintReport` renders `Link`s and nothing else.
- **`judge_verdicts` absent** — the only occurrence anywhere in the new source is the
  comment at `vocabulary.ts:82` explaining why it was dropped.
- **`velocity_banked` → `null`** — `vocabulary.ts:204`.
- **Owner acts → `null`** — `owner_veto`/`owner_halt` in `BATCH_HALTED_REFUSAL_CATEGORIES`;
  all four in `OUTREACH_NON_REFUSAL_CATEGORIES`.
- **Delivery failures → `null`**; **`superseded`/`send_indeterminate` → `null`** — `vocabulary.ts:281-291`.
- **S6 cancelled arm out of scope, halt copies included** — `delivery_status = 'withheld'`
  plus a code list derived only from the withheld map, and the asymmetry is pinned
  from both sides (`vocabulary.test.ts:378` and `read.integration.test.ts:1324`, which
  seeds the exact `latchHalt` shape — one halted batch + three cancelled copies — and
  asserts **two** entries, not five).
- **`/dashboard/requests` unchanged** — not in the diff.
- **`AutoApprovalBlockReason` stays unavailable** — no attempt to reach it; the limit is
  stated in `vocabulary.ts`, ADR 0023 § "The highest-volume refusal cannot be explained",
  and CONTEXT.md → **Refusal**.

## 5. `tests_to_add` — 74 titles

**All 74 exist verbatim** (verified programmatically against the JSON, not by eye).
Five additional titles were added beyond the promised set — four for the S3 audit-action
key space that D13 moved out of `vocabulary.test.ts`, one extra downgrade-mapping case.
D2 covers additions.

Genuinely-tests-its-claim review of the load-bearing ones:

- **Strong.** The tenant-isolation six and the two cross-tenant join cases each seed a
  real foreign row and assert *both* directions (mine excluded from theirs, theirs
  returned under their own scope) — an empty fixture cannot pass them. The three
  redaction route cases plant a real sentinel in the request, in a thrown error's
  message, and in a postgres.js error body, then walk the serialized response at every
  depth and every captured console line. The exactly-once suspension pair asserts a
  count with a >1-location precondition. The S6 anchor trio uses three distinct instants
  per fixture. The window trio derives its boundary from the same arithmetic the read
  uses under a frozen clock. `expectTotalMapping` asserts key-set equality, not presence.
- **Weaker than the title** — the five in the findings table.
- **Redundant-but-harmless.** `the outreach withheld disposition mapping is exhaustive
  against the migration 111 CHECK vocabulary` (`vocabulary.test.ts:198`) closes with a
  substring scan (`source.includes("'code'") || source.includes("code:")`) that a mere
  *comment* mention would satisfy. The claim is genuinely proven by the two assertions
  above it (the literal 8-member list, and the sibling case's key-set equality), so the
  weak half adds nothing rather than misleading.

### D13d follow-up — other tests that pass for a different reason

D13d is right that the five `getRefusalLog exclusions` cases prove the vocabulary's
`null` mappings and not the SQL filters, because `groupEntries` drops a `null` category
before anything asserts. I re-ran that mutation argument across the rest of the suite:

- Dropping S5's `r.status = 'withhold'` stays green — but only because `withheld_reason`
  is NULL on `send` rows and `NULL = ANY(…)` is NULL. Compensated, not proven.
- Dropping S6's `r.delivery_status = 'withheld'` stays green — same `null`-category
  mechanism as D13d, on the sibling filter D13d does not name.
- Dropping S4's `event_type` or `trigger` filter stays green, because the other filter
  compensates and the `afterEach` truncates every `account_audit_log` row for both accounts.
- Dropping S1's `r.severity = 'high'` stays green — no fixture seeds a non-high flag
  (the `seedHeldDraft` helper accepts `severity` but no case passes it). Inert today:
  `worker/jobs/response-generation/persist.ts:683` writes a `flagged_responses` row only
  when `moderation.severity === 'high'`, so the filter can never change a result.
- **Category precedence order of `getRefusalLog`'s output is untested behaviourally** —
  every integration case returns at most one category, so replacing
  `REFUSAL_CATEGORIES.flatMap` with first-seen order would leave the suite green. The
  invariant is nonetheless closed by construction: `groupEntries` reads the constant the
  precedence test pins, so there is no second ordering to drift.
- The two D16b-class blind spots I did find are the sentence-per-category case and the
  newest-first case, both in the findings table.

### D16b follow-up — what else could the eval pass that a person would reject

- A sentence repeated once per row under a link-less heading (the finding above) —
  visually the exact defect D16b caught, and the eval is blind to it because the
  fixture that checks sentences has one entry per group.
- A `<time>` element whose visible text disagrees with its `dateTime` attribute: the
  ordering case asserts only the attribute, and no case asserts the rendered day string.
- A row for a held draft that is indistinguishable from every other held-draft row —
  see UVB #5. The eval asserts a link exists with the right `href`; nothing asserts the
  owner can tell two rows apart beyond their dates.

## 6. Drift

**Edit surface: clean.** Every changed path maps to an `allowed_edit_surface` glob. The
one apparent exception, `docs/superpowers/plans/feat-refusal-log-intake.json`, is the
contract file itself, created by the first commit in the range (`75a1f436`) and amended
four times during plan review — D1 and D15a record the two surface amendments, and the
last (`fd318524`) only added `.claude/reference/arch-review-log.md` and re-estimated
line counts. Two untracked files sit in `docs/reviews/feat-refusal-log/`
(`approach-review.log`, `blast-radius.md`); neither is committed.

**Blast radius.** The only rename is `AgentTeamScope` → `DashboardReadScope`
(`src/lib/agents/read.ts:202`). It is a **pure type-alias rename**: the union body is
byte-identical, `getAgentTeamSummary`'s runtime behaviour is untouched, and no other
symbol in that module changed. `grep` finds zero remaining `AgentTeamScope` references
in `src/`, `worker/` or `scripts/`. Of the 15 listed importers, none imported the old
name — they import `getAgentTeamSummary`, `getReviewTimeline` and the DTO types — so
there is no caller whose semantics could have relied on old behaviour. The one semantic
question a rename of this kind raises (does a shared discriminant now let a caller pass
a scope built for a different read?) is a non-issue: both reads take the same two-arm
union and both branch on `kind` identically.

**Verification commands** (all three from the intake, re-run at HEAD):
`pnpm ci:tenant-scope` → passed, 370 entries, baseline 370 (no new exemption).
`pnpm ci:rls-audit` → passed. `pnpm ci:directory-map` → passed, 584 files, no stale rows.

---

## LOW-CONFIDENCE appendix

Below the 80% bar; recorded, not asserted.

- **UVB #5, "names the review".** The sentence has two verbs — *names* and *links to* —
  and the built row does only the second: an owner with five held drafts sees five
  identical "See the review" links separated only by date. Nothing in the plan, the
  deviations or ADR 0023 records a decision that "names" was satisfied by the link, and
  the read projects no review identity beyond the id. Against that: naming a review
  would need reviewer/rating data the same clause's second half is nervous about, and
  the read's five-key projection is itself pinned by a test. ~65% that a person would
  call this a gap.
- **`resolveRefusalCategory`'s lookup is not `Object.hasOwn`-guarded**
  (`read.ts:365`). It tests `=== undefined` against a plain object built by
  `Object.fromEntries`, so a code of `'toString'` or `'constructor'` would resolve to an
  inherited function rather than throwing. `vocabulary.ts:355` gets this right with
  `Object.hasOwn`. Unreachable today — the S3 arm filters `action = ANY(<five literals>)`
  before the value can arrive — so this is a consistency nit, not a bug.
- **Error-with-no-data renders a skeleton, not an error card**
  (`RestraintContent.tsx:56-62`). `showError` requires `data !== null`, so a
  `/api/dashboard` failure that yields no payload loops on the loading skeleton. This is
  a faithful copy of `renderDashboardStatePanel`'s own precedence
  (`DashboardStatePanel.tsx:61`), which D10 says was the intent, so it is inherited
  rather than introduced. Worth fixing in the shared helper, not here.
- **`AnalyticsTabs` disappears on the gated and loading branches of
  `/dashboard/analytics`** (`AnalyticsContent.tsx:38-54` returns before the views that
  mount it). Matches the Restraint page's own gate, and no UVB clause requires the tabs
  to survive those branches — but "a Restraint tab appears on /dashboard/analytics" is
  false for an account in exactly the state (no subscription) where it would be most
  reassuring.
