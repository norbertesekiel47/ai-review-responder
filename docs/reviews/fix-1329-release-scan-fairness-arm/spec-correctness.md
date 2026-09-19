# Spec & correctness review — fix/1329-release-scan-fairness-arm

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1329-release-scan-fairness-arm`
- Base: `eba43bcca97325026a79cd3041cc25bf37e0c3f3` · HEAD: `383c34e93ad7221a1524858081bc4c4664293c6f`
- Nothing was committed, staged, rebased or edited. Only this file was written.

## Verdict

Both fairness arms are EXACT as claimed. I could not construct an
over-exclusion — the worst defect class here — for either arm, and both counters
do arrive on a zero-candidate tick. Everything that survived verification is a
DOC-ACCURACY or TEST-STRENGTH finding, all low. No behavioural defect found.

## Gates re-run at HEAD (383c34e93, no subagent work in flight)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `pnpm ci:tenant-scope` | passed — entries 382 (baseline 382) |
| `pnpm ci:static-policy` | passed, 1270 files; 25 subscription-status carve-outs (no new one) |
| `pnpm ci:db-imports` | passed (strict) |
| `pnpm ci:weakened-checks` | passed — **no finding**, so there are no REVIEW rows to account for |
| `release.integration.test.ts` (live DB) | 61/61 passed; all 9 new cases confirmed executed, not skipped |
| `release.test.ts` + `dispatch-rate-bound.test.ts` | 8/8 passed |

## Findings

| severity | file:line | finding |
|---|---|---|
| low | src/lib/solicitation/release.ts:1720 | Docstring says "The **four** predicates are the account-default row's identity" — the statement has THREE (`persona`, `action_class`, `location_id IS NULL`); the fourth, `account_id`, is deliberately absent because this read is platform-wide. Repeated at scripts/ci/tenant-scope-allowlist.ts:508. |
| low | src/lib/solicitation/release.ts:1730 | The two predicates the same docstring calls "the drift to watch" are bare SQL literals `'solicitation'`/`'sending'`, while the module they must match binds `POLICY_PERSONA_SOLICITATION`/`POLICY_ACTION_SENDING` (src/lib/auto-approval/types.ts:62-63). Values are byte-identical today; nothing mechanical keeps them so. |
| low | src/lib/solicitation/release.ts:1603 | `COALESCE(r.cap, ${DEFAULT_DAILY_SEND_CAP_ACCOUNT})` re-spells `resolveAccountDailySendCap`'s null branch as a bare constant — exactly what `resolvedCapFor`'s docstring at :1746 says it avoids ("so the default has one owner too"). Bind `resolveAccountDailySendCap({ dailySendCap: null })` instead. |
| low | scripts/ci/tenant-scope-allowlist.ts:507 | "the lane's query count per tick went DOWN" is stated unconditionally but holds only when >=2 accounts have candidates in one tick: N=1 is equal, N=0 is one query MORE. Same claim in .claude/reference/arch-review-log.md:2016 and the deviations doc. |
| low | src/lib/solicitation/release.ts:1723 | `readResolvedAccountCaps` is the only statement in this module with no `scanLimit`/`LIMIT`; it reads every solicitation policy row every 60s tick. Fine at beta scale, but it is an unacknowledged compromise (working-rules § No unacknowledged debt) and the allowlist reason names only the projection, not the bound. |
| low | src/lib/solicitation/__tests__/release.integration.test.ts:1222 | "keeps an account that configured a cap above the platform default bound by the default" cannot distinguish the ARM from the GATE — no competing candidate, so `released: 0` + `account_cap: 1` hold either way — yet its comment claims it pins the arm and that a raw-50 arm "would re-open the starvation". That starvation regression has no sibling account in the fixture to detect it. |

### Detail on finding 6 (the only test-strength one)

Fixture at :1222-1234 seeds ONLY `seedForeignCandidate(10)` + `seedSolicitationPolicy(50, foreignAccountId())`, then `cycle(sql(), { scanLimit: 1 })`.

- Correct behaviour: the arm resolves 50 → 10, the account is capped, zero
  candidates, `account_cap` comes from the scan. `released: 0`, `account_cap: 1`.
- Mutant "cap arm deleted" (or keyed on the raw stored 50): the foreign batch
  takes the uncontested slot, `runAccountArm` computes `cap = 10`, attempts = 10,
  `counters.account = 0` → `withhold('account_cap')`. `released: 0`,
  `account_cap: 1`. **Identical — the mutant survives.**

The mutant it DOES kill is "the resolver dropped from `readResolvedAccountCaps`"
(then the gate's cap would be 50 too and the row would release, breaking
`released: 0`). Its siblings at :1201 and :1261 kill "cap arm deleted", so the
branch is not unguarded — but the ABOVE-default clamp asserted *through the arm*
is asserted nowhere. Fix: add the competing primary batch exactly as :1201 does.

## Verified, no finding

### a) Over-exclusion — ruled out for both arms

**Cap arm.** Threshold and count basis are the same on both sides:

- Arm: release.ts:1602-1603 — `o.queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, `HAVING COUNT(*) >= COALESCE(r.cap, 10)`.
- Gate: send-caps.ts:73-74 — byte-identical predicate; release.ts:1305 refuses on `cap - COUNT(*) <= 0`, i.e. `COUNT(*) >= cap`.
- The two `cap` values are the SAME `ResolvedAccountCaps` local (`accountCaps`,
  release.ts:1414) — passed to the scan at :1416 and into `ctx.accountCaps` at
  :1471, consumed by `resolvedCapFor` at :1304. They cannot differ.
- Monotonicity: the arm runs at T0, the gate at T1 > T0, and `COUNT(*)` over
  today's `queued_at` rows only grows. So `capped at T0 ⇒ capped at T1`: the arm
  can never exclude an account the gate would have let send.

Each case the brief named, traced:

| state | map | SQL `r.cap` | gate `resolvedCapFor` | same? |
|---|---|---|---|---|
| stored cap NULL (row present) | 10 | 10 | 10 | yes |
| no `auto_approval_policies` row | absent | NULL → `COALESCE` 10 | 10 (resolver null branch) | yes |
| row for another persona / action_class / a location override | absent (filtered at :1730-1732) | 10 | 10 | yes |
| configured 5 | 5 | 5 | 5 | yes |
| configured 50 | 10 (clamped before binding) | 10 | 10 | yes |

**Subscription arm.** release.ts:1612-1619 `NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.account_id AND a.subscription_status = ANY(FULL_ACCESS…))`
is the exact complement of `!subscriptionGrantsFullAccess(await readAccountSubscriptionStatus(...))`
(:1314-1318, reader at :1751-1761 — same table, same PK predicate, no extra
filter). Boundary cases agree: `subscription_status` NULL → `NULL = ANY(...)` is
NULL → not true → excluded, and TS `includes(null)` → refused. No `accounts` row
→ `NOT EXISTS` true, and `readAccountSubscriptionStatus` → `undefined` → refused.
`trialing` is a member of the bound array, so it is never excluded — asserted
live at :1344.

`past_due` is correctly excluded: the release gate is
`subscriptionGrantsFullAccess`, which has never granted `past_due` (the grace
window belongs to `subscriptionAllowsDashboardRead` / `computePastDueRecoveryState`).
This is NOT the `publisherSubscriptionEligibleSql` predicate
(src/lib/shared/subscription-eligibility-sql.ts:19) and must not be — that one
adds past-due grace for the publisher lane.

### `subscriptionGrantsFullAccess` — implementation change is truth-table-identical

subscription-status.ts:85 `status !== undefined && ['active','trialing'].includes(status)`
vs the old `status === ACTIVE || status === TRIALING`. `Array.prototype.includes`
uses SameValueZero, which for strings is `===`; `undefined` and `null` are absent
from the array, so both are false under either spelling. Identical for every
input. 93 importers, `npx tsc --noEmit` clean, and the three suites that exercise
the predicate directly pass. **The blast-radius claim holds.**

### b) Both counters arrive on a zero-candidate tick

- `withheld` (:1642-1649) is an UNGROUPED aggregate → exactly one row always, and
  `COUNT(...) FILTER (...)` returns 0, never NULL, over an empty `eligible`.
- `LEFT JOIN candidates c ON TRUE` (:1655) keeps that row when `candidates` is empty.
- The guard at :1672-1674 drops it (`id`/`account_id`/`business_id` NULL, then
  `approval_window_open` NULL) so it never becomes a phantom batch.
- Both counts are read off `rows[0]` at :1684-1685, outside the loop.
- `withhold`'s `if (count <= 0) return` (:1116) keeps an idle tick at `{}` —
  proven live by "reports no withhold at all on a tick with no work due" (:1170),
  which asserts `withheldByReason` `toEqual({})`.
- Fully-excluded tick proven live by :1289 (`subscription: 1`, `released: 0`,
  `releasePhaseStoppedBy: null`).

### c) The `FILTER` casts and the `GROUP BY`

- `COUNT(DISTINCT account_id) FILTER (WHERE …)::int` parses with the cast bound to
  the whole aggregate (`func_application filter_clause` is a `c_expr`, then
  `TYPECAST`). Verified empirically, not just grammatically: the three counter
  cases assert exact integers against the live DB and pass.
- `account_capped` / `account_unentitled` are account-level facts computed per
  batch row, so every row of one account agrees and `COUNT(DISTINCT account_id)`
  counts accounts, matching `runAccountArm`'s per-account `withhold(…)` unit.
- `GROUP BY o.account_id, r.cap` is safe in both shapes. A duplicate
  `resolved_caps` row — which would split one account's count and defeat the arm
  — is unreachable twice over: uniqueness comes from the TypeScript `Map`
  (`resolved.set` at :1736, one entry per account by construction), and the DB
  side is backed by `auto_approval_policies_one_account_default`
  (supabase/migrations/074_trust_dial_veto_window.sql:74-76 — UNIQUE
  `(account_id, persona, action_class) WHERE location_id IS NULL`). The dropped
  `LIMIT 1` is therefore harmless.

### d) Empty-array bind — the case that proves it

**"reports no withhold at all on a tick with no work due"** (release.integration.test.ts:1170).
The shared `afterEach` deletes every `auto_approval_policies` row (:938) and that
case seeds none, so `capAccountIds` and `capValues` are both `[]` when the scan
runs. It passes and returns `withheldByReason: {}`, which requires
`unnest('{}','{}')` to yield ZERO rows (a single NULL row would put a
`r.cap IS NULL` group into `capped_accounts`, and the statement would still have
to execute at all). postgres.js sends an untyped empty array whose type the
explicit `::uuid[]` / `::int[]` casts resolve. Verified: yes, zero rows, and the
`COALESCE` default therefore applies to every account.

### e) The two readers of the account-default row select the SAME row

| predicate | `readResolvedAccountCaps` (release.ts:1729-1732) | `loadSolicitationAccountDefault` (solicitation-settings.ts:266-271) |
|---|---|---|
| `account_id` | absent (platform-wide by design) | `= ${accountId}::uuid` |
| `persona` | `= 'solicitation'` (literal) | `= ${POLICY_PERSONA_SOLICITATION}` = `'solicitation'` |
| `action_class` | `= 'sending'` (literal) | `= ${POLICY_ACTION_SENDING}` = `'sending'` |
| `location_id` | `IS NULL` | `IS NULL` |
| `LIMIT` | none | `LIMIT 1` |

Constants confirmed at src/lib/auto-approval/types.ts:62-63. The three shared
predicates are semantically identical; the differences are the deliberate
`account_id` omission and the `LIMIT 1` the unique index makes redundant.
**Same row.** Findings 1 and 2 above are about how that is DOCUMENTED and SPELLED,
not about which row is selected.

### f) Mid-tick staleness — what changes, and whether it matters

1. **Cap is now read at tick start, not per account after the scan.** An owner who
   changes `daily_send_cap` between the read and that account's gate is enforced
   at the tick-start number for that one tick. Bounded by the clamp (the enforced
   cap is <= 10 either way), self-correcting on the next 60s tick, and it cannot
   over-release past the platform ceiling or the per-tick budget. Does not matter.
2. **A policy row created mid-tick** is invisible for that tick (default 10 applies).
   Same bound, same recovery. Does not matter.
3. **One read now happens on ticks with no candidate accounts** — this is finding 4.
4. **The arm's safety argument changed shape.** The old bounding arm could only
   under-exclude *structurally*; the new one relies on the scan and the gate
   consuming the same number. They do (one local, one function), but nothing
   mechanical pins that — see the appendix. The deviations file names the trade.

### g) Intake `edge_cases` vs tests that would actually fail

All 9 `tests_to_add` titles exist verbatim (:1201, :1222, :1237, :1261, :1289,
:1304, :1320, :1344, and subscription-status.test.ts:78). Eight discriminate;
:1222 does not (finding 6). Per edge case:

| edge case | test | fails on regression? |
|---|---|---|
| capped AND lapsed → once, under `account_cap` | :1304 | YES — drop `AND NOT account_capped` (:1646) and `subscription` becomes 1, breaking `toBeUndefined()` |
| lapsed with `past_due` → excluded | :1320 | YES — also asserts the foreign rendered row survives and has no send job |
| `pending_payment` or `cancelled` → excluded | :1261/:1289/:1304 use `cancelled`; `pending_payment` untested | structurally covered (bound array + the lockstep pin), see appendix |
| `trialing` → NOT excluded | :1344 | YES — an arm that excluded it would report `subscription: 1` and release 0 |
| every candidate account lapsed → counter arrives, `stoppedBy` null | :1289 | YES |
| no work due → `{}` | :1170 | YES |
| lapses mid-drip → rows stay rendered, next tick after payment includes it again | :1320 covers the first half only | the resumption half is asserted nowhere — appendix |
| one lapsed account no longer starves a sibling | :1261 (`scanLimit: 1`, older `approved_at`) | YES — this is the ticket's actual defect |

### Intake field-by-field

Goal, `non_goals` (incl. amendment 1), `surface`, `db_touching`, `size`,
`risk`, `dependencies_added: []`, `verification_commands`, `rollback_plan`
and `observability` all match the diff. `allowed_edit_surface` respected
exactly — the only files touched are 8 of the 10 listed. Every stated invariant
holds: the candidate predicate is spelled once in `eligible`; `LEAST(configured, 10)`
appears nowhere in SQL; one policy read feeds both consumers; #11 gated on
`subscriptionGrantsFullAccess`; #15 intact (`sql` still an explicit parameter,
`ci:db-imports` strict pass); tenant-scope exact-match baseline bump 380 → 382;
`ci:static-policy` green with no new literal carve-out. `estimated_prod_lines`
280 vs 277 changed lines in `release.ts` — honest after deviation 3's correction.
Deviation 1's merge-order coupling to `refactor/616-fallow-complexity` is a real
pre-merge obligation: the baseline 382 must be re-derived after that branch lands.

### Nothing is terminalized for a newly excluded account

`runBatchArm`'s two destructive paths — `applyAutoDowngrade` (:1205) and
`applyJudgeSplit` (:1228) — both sit AFTER gate 5, so a lapsed account never
reached them before this branch either. Excluding it one step earlier changes no
row state, which :1320 asserts directly (`delivery_status` still `rendered`, zero
send jobs). Intake non-goal 3 satisfied.

## Low-confidence appendix (below the 80% bar)

- **subscription-status.ts:80 vs :85.** The docstring says `undefined` is handled
  because "the membership test gives that for free", but the code spells an
  explicit `status !== undefined &&`. The guard exists for the type checker
  (`includes` takes `string`), not for runtime. Harmless; the sentence slightly
  misdescribes its own line.
- **A second SQL spelling of the full-access set still exists.**
  `publisherSubscriptionEligibleSql` (subscription-eligibility-sql.ts:20) spells
  `IN (ACTIVE, TRIALING)` independently of `FULL_ACCESS_SUBSCRIPTION_STATUSES`. It
  is a DIFFERENT predicate (it adds past-due grace), so this is not the drift the
  new array guards — but a status added to full access now reaches release.ts
  automatically and that statement not at all. Pre-existing; out of scope.
- **Subscription arm race.** A payment landing between the scan (T0) and the gate
  (T1) leaves the account excluded for that tick, where previously the per-account
  read at T1 would have admitted it. One 60s tick of delay, no state change.
- **No mechanical pin that the arm and the gate share one cap map.** A future edit
  could call `readResolvedAccountCaps` twice, or pass a differently-derived map to
  `selectReleaseCandidates`, and over-exclusion would become reachable with every
  test still green. The old arm's "can only under-exclude" property needed no such
  pin. The deviations file argues the trade; nothing tests it.
- **`pending_payment`** is named in `edge_cases` but exercised by no case. An
  arm-only regression is unreachable (the array is the predicate's own
  implementation, and subscription-status.test.ts:78 pins the lockstep over every
  canonical status), so I do not treat this as a gap.
- **Edge case 7's resumption half** ("the next tick after payment includes it in the
  scan again") is asserted nowhere. Structurally true — the arm is a pure read and
  latches nothing — but one extra `setForeignSubscriptionStatus('active')` plus a
  second `cycle()` in :1320 would prove it.
