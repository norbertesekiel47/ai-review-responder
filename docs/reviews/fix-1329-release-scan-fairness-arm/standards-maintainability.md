# Standards & Maintainability — fix/1329-release-scan-fairness-arm

- **Skill run:** `thermo-nuclear-code-quality-review` (invoked; not the `code-review` fallback).
- **Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1329-release-scan-fairness-arm`
- **Evidence SHA:** `383c34e93ad7221a1524858081bc4c4664293c6f` (HEAD) · fork point `eba43bcca` (== `origin/main` in this worktree, verified by `git rev-parse`).
- **Commands run (read-only):** `git diff/show`, `rg`, `pnpm -s typecheck` (PASS), `pnpm -s ci:tenant-scope` (PASS, 382/382), `pnpm -s ci:static-policy` (PASS), `pnpm -s ci:fallow` (**exit 1**), `pnpm -s ci:fallow:coverage` (PASS).
- `.feature/gate-status.json` records the full gate green at 09:26 on this tree.

## Verdict

No structural regression that should block. The core design decision — resolve the
cap in TypeScript and *bind* it into SQL rather than re-spell `LEAST(configured, 10)` —
is the right one, and it is the rare case where a branch got *deeper* (one platform-wide
read replaces N per-account reads, and the arm and the gate now consume one number).
The abstraction at the seam is sound: `ResolvedAccountCaps` is a real type, not a bag,
and one extra tick-wide field on `ReleaseArmContext` is not accretion.

What does not hold up is the **prose**. 169 of 272 added production lines are comment or
allowlist justification, and five distinct sentences in that prose are now false, name a
symbol that does not exist, or credit a clause that does not carry the behaviour. On a
module whose entire discipline is "the comment is the contract", that is the finding.
Two further items are substantive: a second owner of the default cap that the diff's own
comment says it avoided, and one new live-DB test that does not kill the mutant its
comment names.

## Findings

### M1 — `COALESCE(r.cap, DEFAULT_DAILY_SEND_CAP_ACCOUNT)` is a second owner of the default, contradicted by the diff's own comment

`src/lib/solicitation/release.ts:1603`

The branch's stated invariant is that `resolveAccountDailySendCap` is the single owner of
the enforced number. For the *clamp* that holds. For the resolver's **null branch** it does
not: SQL spells the default as the bare constant, while TypeScript 140 lines later
deliberately does not —

```
:1747  function resolvedCapFor(caps: ResolvedAccountCaps, accountId: string): number {
:1748    return caps.get(accountId) ?? resolveAccountDailySendCap({ dailySendCap: null });
```

…whose own docstring at `:1744-1746` reads *"spelled here rather than duplicated as a bare
constant, so the default has one owner too."* The statement above it is exactly that
duplication. `:1524-1526` then asserts the two agree (*"is that account's resolved cap by
the same resolver's null branch"*) — an assertion, not a derivation.

**Maintenance scenario.** Make the no-policy-row default anything other than
`DEFAULT_DAILY_SEND_CAP_ACCOUNT` (a tier-dependent default is the obvious next ask, and
`resolveAccountDailySendCap` is where it would go): `resolvedCapFor` follows, the SQL arm
does not, and the arm and the gate disagree about **every account with no policy row** — the
over-exclusion/starvation direction this whole branch says is the defect to fear.

**Remedy (one token).** Bind the resolver's output instead of the constant:
`HAVING COUNT(*) >= COALESCE(r.cap, ${resolveAccountDailySendCap({ dailySendCap: null })})`,
or hoist `const DEFAULT_RESOLVED_CAP = resolveAccountDailySendCap({ dailySendCap: null })`
at module scope and use it in both places — which also deletes `resolvedCapFor`, a helper
with exactly one caller (CLAUDE.md: "no abstractions for a single caller").

### M2 — `runAccountArm`'s isolation-unit docstring still names a read that no longer exists there, and the blast radius of that read moved

`src/lib/solicitation/release.ts:1275` (also `:1147`, `:1385-1386`)

> *"The ACCOUNT is the outer one, and it covers exactly the two gate reads below: **the cap
> read** and the subscription read are per-account questions, so a throw from either costs
> that account its tick and no one else's."*

There is no cap read in `runAccountArm` any more — `:1304` is a synchronous `Map` lookup
that cannot throw. The read moved to `:1406`, which sits **outside every `isolateItem`** and
inside `alertPhaseFailure('release', …)` at `:340`, and that sink rethrows. So a transient
failure reading the caps used to cost one account its tick and now costs the whole release
phase. That change is defensible (the caps are a precondition of the scan, which was always
outside isolation) — but the docstring that documents the isolation boundary was not
updated, so the one place a reader goes to learn the blast radius now states the old one.

Two smaller instances of the same staleness: `:1147` (*"`account` is re-seeded per account
from that account's cap read"*) and `:1385-1386` (*"`runAccountArm` re-seeds this from that
account's own cap read"*).

**Remedy.** Rewrite `:1273-1276` to name the two reads that are actually there
(`countAccountDispatchAttemptsToday` and `readAccountSubscriptionStatus`) and state in one
clause that the caps read is phase-level and fails the phase, not the account.

### M3 — the new "cap above the platform default" case does not detect the mutant its comment names

`src/lib/solicitation/__tests__/release.integration.test.ts:1222-1235`

```
await seedForeignCandidate(DEFAULT_DAILY_SEND_CAP_ACCOUNT);   // 10 attempts
await seedSolicitationPolicy(50, foreignAccountId());
const report = await cycle(sql(), { scanLimit: 1 });
expect(report.released).toBe(0);
expect(report.withheldByReason.account_cap).toBe(1);
```

The comment says this asserts the clamp *"through the ARM rather than the resolver's unit
test"*, and that *"an arm that used the STORED number would wait for 50 attempts and re-open
the starvation."* It does not catch that. With a stored-50 arm the foreign account is **not**
excluded, takes the only scan slot, reaches `runAccountArm`, resolves to 10 in TypeScript,
finds 10 attempts, and withholds `account_cap` — `released: 0`, `account_cap: 1`. Byte-identical
report. The fixture also picks exactly 10 attempts, which the *bounding* arm and the resolved
arm treat identically by construction, so the pre-#1329 arm passes it too.

Independent confirmation from the branch's own paperwork:
`docs/superpowers/plans/fix-1329-release-scan-fairness-arm-deviations.md` reverting the
`HAVING` to the constant produced **2 failures**, named as the gate-order test and
`excludes an account at its own sub-default cap` — this case is not among them.

What it *does* pin is that `resolveAccountDailySendCap` still clamps (drop the clamp and
`released` becomes 1) — i.e. a live-DB restatement of a resolver unit test.

**Remedy.** Add the competing candidate the sibling cases use: keep foreign at 10 attempts
with a configured 50, seed a primary candidate with a newer `approved_at`, `scanLimit: 1`,
and assert `released: 1`. A stored-number arm then yields `released: 0` and the case
discriminates.

### M4 — the docstring and the arch-review-log name a SQL object that does not exist

`src/lib/solicitation/release.ts:1517`, `:1571`; `.claude/reference/arch-review-log.md:2016`

> `:1517` *"`unentitled_accounts` binds `FULL_ACCESS_SUBSCRIPTION_STATUSES`…"*
> `:1571` *"…not over `capped_accounts`/`unentitled_accounts`"* — presented as a relation you could have counted over.
> arch-review-log row: *"`src/lib/solicitation/release.ts` (`unentitled_accounts` arm, …)"*

`rg unentitled_accounts` over the statement returns only the *column alias*
`unentitled_accounts_withheld`. The subscription arm is an inline correlated `NOT EXISTS`
producing the boolean `account_unentitled` (`:1613-1619`); there is no `unentitled_accounts`
CTE. `:1571`'s parallel construction with the real `capped_accounts` CTE is what makes this
mislead rather than merely misname — a reader greps for the sibling CTE and finds nothing.
The durable record (arch-review-log) carries the same non-existent symbol, which is the
defect class this checklist has accepted twice ("cite by symbol", and rows citing targets not
at HEAD).

**Remedy.** Say `account_unentitled` (the flag) in both places, or name the arm
`unentitled_accounts` and actually make it a CTE beside `capped_accounts` — the symmetry the
prose already claims.

### M5 — the single-owner move stopped one step short: the attempt-count predicate is still duplicated, and this diff removed the safety margin that made that tolerable

`src/lib/solicitation/release.ts:1601` vs `src/lib/solicitation/send-caps.ts:74`

The arm and the gate now share the cap *number* and still keep two hand-written spellings of
"dispatch attempts in the current UTC day":

```
release.ts:1601   WHERE o.queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
send-caps.ts:74     AND queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
```

They agree byte-for-byte at HEAD — verified. What changed is the consequence of a drift. The
deleted text said *"This is a bound, so a drift makes the arm weaker, never wrong."* The
replacement at `:1550-1555` says *"The two spellings must agree … a drift between them is a
silent disagreement about the same account."* Correct — and nothing enforces it. Under the old
bounding arm a drift could only under-exclude (safe); with an exact arm, an arm that counts
*more* rows than the gate over-excludes and starves an account that may send. The diff
removed the margin and left the duplication, then documented the hazard in prose.

**The code-judo move the branch missed.** `capped_accounts` already computes exactly the
number the gate re-queries per account. Split it in two and project the count:

```
account_attempts AS (SELECT account_id, COUNT(*)::int AS n FROM solicitation_outreach
                      WHERE queued_at >= … GROUP BY account_id),
capped_accounts  AS (SELECT a.account_id FROM account_attempts a
                      LEFT JOIN resolved_caps r ON r.account_id = a.account_id
                     WHERE a.n >= COALESCE(r.cap, <bound default>)),
eligible         AS (… , COALESCE(a.n, 0) AS attempts_today …)
```

`runAccountArm` then seeds `counters.account = cap - batch.attempts_today` with **zero**
queries, the second spelling disappears, `countAccountDispatchAttemptsToday`'s per-candidate
call is deleted (up to 50 statements per tick), and the "must agree" requirement becomes
unstateable rather than merely documented. The freshness objection is already conceded by
this diff: it moved the cap read from gate time to before the scan for exactly the same
one-read-per-cycle reason, and the module header (`:60-67`) says the overrun bound is
per-cycle re-reads, not point-in-time reservation.

### L1 — the row identity the docstring calls "the drift to watch" is spelled with literals on one side and constants on the other

`src/lib/solicitation/release.ts:1730-1732` vs `src/lib/auto-approval/solicitation-settings.ts:269-273`

`readResolvedAccountCaps`'s docstring (`:1720-1724`) makes the match load-bearing: *"The four
predicates are the account-default row's identity, and they match `loadSolicitationAccountDefault`
… Two spellings of one row's identity is the drift to watch here."* The two spellings then use
different tokens — `persona = 'solicitation'` / `action_class = 'sending'` here, versus
`persona = ${POLICY_PERSONA_SOLICITATION}` / `${POLICY_ACTION_SENDING}` there (exported from
`src/lib/auto-approval/types.ts:62-63`). Nothing ties them. Renaming either value is a grep
across two modules with two spellings. There is precedent for the literal form in this folder
(`src/lib/solicitation/auto-approval.ts:164`), which is why this is low and not medium — but a
docstring that elevates a duplication to "the drift to watch" should ship the spelling that
makes drift a compile error.

### L2 — the new lockstep pin asserts sequence while its comment and title claim membership

`src/lib/shared/__tests__/subscription-status.test.ts:82` vs `src/lib/shared/subscription-status.ts:55-57`

The constant's docstring: *"Order is `active` then `trialing` and **is not meaningful**; the
lockstep pin … asserts membership."* The pin's first assertion is
`expect([...FULL_ACCESS_SUBSCRIPTION_STATUSES]).toStrictEqual(admitted)`, where `admitted` is
`Object.values(SubscriptionStatus).filter(...)` — declaration order. Swap the two array
entries and a test titled *"holds exactly the statuses `subscriptionGrantsFullAccess` admits"*
goes red on a change the owning comment calls meaningless.

The `for` loop at `:83-87` already proves membership in both directions over every canonical
status, which is the whole claim. **Remedy:** delete the `toStrictEqual`, or compare sets.

### L3 — "the lane's query count per tick went DOWN" is false for the tick this module calls the designed steady state

`scripts/ci/tenant-scope-allowlist.ts:507`; `.claude/reference/arch-review-log.md:2016`
(*"a per-account query DELETED (the lane issues fewer statements per tick, not more)"*)

Before: 1 scan + N per-account cap reads, N = candidate accounts. After: 1 caps read + 1 scan,
unconditionally. N ≥ 2 → down. N = 1 → equal. **N = 0 → 1 → 2, up** — and `:1414-1418` of
release.ts says most ticks of a healthy ramp release nothing. Both claims are stated without
the condition, in a CI justification and in the durable architecture log.

**Remedy.** "Fewer statements on any tick with two or more candidate accounts; one more on an
idle tick."

### L4 — "Empty is the common case — no account has configured a cap" describes the wrong condition

`src/lib/solicitation/release.ts:1587-1588`

`readResolvedAccountCaps` inserts a map entry for **every** solicitation-sending policy row,
including rows with `daily_send_cap IS NULL` (resolved to the default at `:1736-1739`). The map
is therefore empty iff *no account has a solicitation sending policy row at all* — not iff no
cap is configured. Since a policy row is how the lane is enabled (`solicitation-settings.ts`),
the map is non-empty for every account running the lane. No behavioural consequence (the bound
10 and `COALESCE(…, 10)` agree), but the sentence teaches the next reader the wrong emptiness
rule for a bind whose size scales with enrolled accounts.

### L5 — the foreign-status restore is guarded in the weaker of the two hooks

`src/lib/solicitation/__tests__/release.integration.test.ts:942-945`

The added comment names the risk precisely (*"a leftover lapse would silently exclude the
foreign candidate from every later scan"*) and then places the restore at the **end of
`afterEach`**, behind eleven `DELETE`s under a 60 s timeout. The primary account's equivalent
is re-asserted in `beforeEach` (`:906`), so it survives a failing or timing-out cleanup; the
foreign one does not. Any throw or timeout in `:927-941` leaves every later case in the file
scanning with a cancelled foreign account — silently, because a missing candidate looks like
an idle tick, which is the exact confusion this ticket exists to remove.

**Remedy.** Move it beside `setSubscriptionStatus('active')` in `beforeEach`, or do both.

### L6 — run paperwork cites a symbol that has never existed, and a count the branch superseded

`docs/superpowers/plans/fix-1329-release-scan-fairness-arm-deviations.md:16-17`;
`docs/superpowers/plans/fix-1329-release-scan-fairness-arm-intake.json:56`

Both name `ENTRY_COUNT_BASELINE`. `rg` over `scripts/` returns zero hits — the symbol is
`ALLOWLIST_BASELINE` (`scripts/ci/tenant-scope-allowlist.ts:287`). Deviation 1 also states
*"one ADDED `accounts` entry … The count moves by +1"*; HEAD adds two entries and moves the
baseline 380 → 382. Deviation 1 predates deviation 2's re-decision, but it carries the merge-order
agreement with `refactor/616-fallow-complexity` and instructs the post-rebase baseline
re-derivation, so it is the document the next session reads — and its description of "ours" is
wrong about both the symbol and the delta.

### L7 — scaffold left in the intake by the mid-run design change

`docs/superpowers/plans/fix-1329-release-scan-fairness-arm-intake.json:56` (`test_seams`)

`test_seams` still lists *"`scanFile` (`scripts/ci/static-policy-audit.ts`) — the pure per-file
scanner the audit's unit suite calls."* Deviation 2 reverted that tripwire and the amendment
removed both `static-policy-audit*` paths from `allowed_edit_surface`; no test was added there
and the file is untouched by the diff. The seam entry is the last residue of the reverted plan.
(Production code is clean on this axis — no dead exports, no orphaned helper, `readAccountDailySendCap`
fully removed with no dangling production or directory-doc reference.)

### L8 — `pnpm ci:fallow` is now red: `selectReleaseCandidates` crosses the CRAP threshold

`src/lib/solicitation/release.ts:1581`

```
● High complexity functions (1)
  :1581 selectReleaseCandidates   10 cyclomatic  8 cognitive  109 lines   31.6 ! CRAP
✗ complexity: 1 finding · 9 changed files
```

Attributable to this diff. Cyclomatic went 8 → 10 (the second `rows[0]?.x ?? 0` at `:1687`);
back-solving fallow's coverage factor from the reported 31.6 (`10 + 10³k = 31.6 → k = 0.0216`)
puts the fork point at `8 + 8³·0.0216 ≈ 19.1`, comfortably under the default threshold of 30.
So the breach is new, not inherited.

**Not a CI regression:** `pnpm ci:fallow:coverage` — the variant that gates in ci.yml's `fallow`
job — is **green** ("complexity 0") with the real coverage artifact, and `ci:fallow` gates
nothing by design. Reported because the developer-facing sweep now fails for anyone who runs
it, and because the cheap fix is the same one that helps the file: extract the row→batch
projection loop (`:1671-1683`) into a named `toReleaseCandidateBatch`, which drops the function
under both the 60-line and the CRAP thresholds and separates "run the statement" from "narrow
its rows".

## Low-confidence appendix

Observations I would not stake 80% on as defects, or that are opinion rather than violation.

- **`:1586-1587` "how postgres.js can hand a Map to SQL at all"** — overstated. `sql.json(...)` +
  `jsonb_to_recordset`, and a `VALUES` list via `sql(rows)`, are both available; the repo uses
  `jsonb()`/`tx.json()` elsewhere. The parallel-array `unnest` choice is right and has house
  precedent (`src/lib/admin/business-summary.ts:159`); only "at all" is wrong.
- **`:1591` `accountCaps.get(id)!`** — an avoidable non-null assertion. `const capEntries = [...accountCaps];`
  then `capEntries.map(([id]) => id)` / `capEntries.map(([, cap]) => cap)` types cleanly with no `!`.
- **Deepening opportunity at the seam.** `selectReleaseCandidates(sql, scanLimit, accountCaps)`
  makes the *caller* responsible for an ordering rule stated only in prose (`:1403-1405`, "ONCE
  per tick and BEFORE the scan"). Folding `readResolvedAccountCaps` inside the scan and returning
  the map on `ReleaseCandidateScan` (which already carries derived data) makes the ordering
  unstateable and drops a parameter. Combined with M5 this is the shape I would want.
- **`GROUP BY o.account_id, r.cap` (`:1602`) is load-bearing, not a smell** — `r.cap` is not
  functionally dependent on a grouped primary key, so Postgres requires it; and the `Map` key
  guarantees one `resolved_caps` row per account, so no group can split. `GROUP BY o.account_id`
  with `HAVING COUNT(*) >= COALESCE(MIN(r.cap), …)` would be robust rather than merely correct,
  and would survive a future widening of the read's predicates.
- **`:1302-1303`** — *"Reaching here with a different one would mean the arm excluded an account
  this gate would have let send"* covers only one of the two directions of "different"; the other
  is the under-exclusion this ticket closes.
- **Test-helper asymmetry.** `seedCappedForeignCandidate` returns `SeededBatch` while
  `seedLapsedForeignCandidate` returns `{ batch, outreachId }`, over the same base helper.
  `seedForeignCandidate`'s `let outreachId = ''` sentinel plus destructuring-assignment inside the
  loop would read better as: loop the `queued` attempts, then `const { outreachId } = await
  seedOutreach({ batch, deliveryStatus: 'rendered', … })` outside it — no invalid-state initial value,
  no dependence on loop order.
- **Directory row.** `docs/directory/lib-solicitation-a.md:59` lists the governor-order trap for
  `release.ts` but neither fairness arm. `ci:directory-map` is presence-only and the row does not
  become false, so this is not a violation — but a scan-level governor that removes accounts from
  the candidate window is the kind of trap that row exists for, and there are now two of them.
- **File size.** `release.ts` 2000 → 2121 lines. No 1k threshold crossing (it was already double),
  but fallow puts 7 of its large functions in this one file (`runReleasePhase` 147 lines,
  `selectReleaseCandidates` 109). The lane's next PR should extract the scan family
  (`selectReleaseCandidates` + `readResolvedAccountCaps` + `resolvedCapFor` + the row types) into
  `release-candidates.ts` — the same move `release-phases.ts` already established in this folder.
- **Comment volume.** `selectReleaseCandidates`'s docstring is 89 lines (`:1492-1580`) for a
  109-line function, on top of a 76-line module header. The discipline is deliberate and mostly
  earns its keep; M1/M4/L3/L4 are the evidence that at this density the prose has outrun what a
  reviewer can keep true, which is an argument for splitting the module rather than for writing less.

## Checklist pass (`docs/reviews/finding-checklists/standards-maintainability.md`)

Every line checked against the diff. Matches found:

| Accepted class | This branch |
|---|---|
| comment states a FALSE mechanism / credits the wrong clause | M1, M2, L3, L4 (and the appendix's "at all") |
| a row/plan cites a symbol or line not at HEAD | M4 (`unentitled_accounts`), L6 (`ENTRY_COUNT_BASELINE`) |
| test comment promises a guarantee the assertion does not provide | M3, L2 |
| a test that cannot detect the mutation it exists for | M3 |
| counting claims that are wrong | L3, L6 |
| duplicate helper / second owner with no mechanical tie | M1, M5, L1 |
| test description omits or misstates what the executable asserts | L2 |
| negative assertion coupled to a private string | none found |
| accessibility / CSS classes | N/A (no UI surface) |

No match for: the `useMediaQuery`-style re-implementation class (no new hook or utility),
the pointer/hover classes, or the "second progress ledger" class.
