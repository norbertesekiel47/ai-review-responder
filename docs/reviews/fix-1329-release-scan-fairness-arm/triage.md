# fix/1329 — review wave round 1, triage verdicts

Wave dispatched at fork point `eba43bcca`, reviewed HEAD `383c34e93`, four axes in
parallel. Fixes landed in one pass after all four returned, per the read-the-whole-
table rule — two axes proposed opposite changes to the same line, and fixing
either alone would have been wrong.

Production diff measured for the standards threshold: 578 lines (added+deleted,
non-test) — well past it, so that axis was owed on size as well as on RISK=high.

## The cross-axis conflict, resolved first

| Axis | Proposal for `runAccountArm`'s cap source |
|---|---|
| Standards (medium, `release.ts:1601`) | Finish the de-duplication: project `attempts_today` from the scan's CTE and delete the per-account `countAccountDispatchAttemptsToday` call |
| Codex adversarial (P2, `release.ts:1304`) | The opposite: stop serving the gate from the tick's snapshot at all, because a snapshot cannot authorize a send |

**Codex wins, and standards' proposal is REJECTED.** The two reads are not
redundant copies of one question. `readResolvedAccountCaps` is a DISCOVERY bound:
it decides which accounts may occupy the 50-row candidate window, and it needs
every account's number in one statement. The per-account gate is the
AUTHORIZATION: nothing downstream re-checks the cap — `resolveAccountDailySendCap`
and `countAccountDispatchAttemptsToday` appear nowhere outside `release.ts`, so the
releaser is the single chokepoint (amendment B3) — and an owner contracting the
dial mid-tick must bind at the gate, not one tick later. Taking the standards
suggestion would have deepened the regression Codex found.

Both lag directions are safe, which is why the snapshot is still correct for the
arm: a snapshot that is HIGH hands the account to a gate that refuses it, and one
that is LOW delays the account a single tick, after which the next snapshot
carries the new number. A single owner of the CALCULATION does not require a
single OBSERVATION of mutable data.

Cost of taking Codex's side, stated rather than hidden: the lane now issues ONE
statement more per tick, not fewer. Three documents claimed the opposite and are
corrected (`tenant-scope-allowlist.ts`, `arch-review-log.md`, the deviations file).

## Red team — 2 P0, 4 P1, 3 P2

| Finding | Verdict | Evidence |
|---|---|---|
| **P0** gate's cap source asserted by nothing (reverting to the constant left 61/61 green; cap 5 + 3 attempts would release 7) | **ACCEPT, FIXED** | New case `releases only the remainder of a sub-default cap the account has partly spent`. Re-measured: the mutant now fails exactly that case (1 failed / 65 passed). The fixture needs `perTickBudget: 10` — the default `RELEASE_PER_TICK_BUDGET` is 2, which is also the expected answer, so on the default the BUDGET satisfied the assertion and the cap gate could still be deleted. The first cut reported `per_tick_budget`; caught by the test failing, not by reading it |
| **P0** lockstep pin cannot fail on the drift it names (dropping `TRIALING` from the array passed) | **ACCEPT, FIXED** | The expectation derived from `subscriptionGrantsFullAccess`, which is now implemented OVER the array, so both sides moved together. Membership is now asserted against literals — an independent oracle — and the predicate-agreement loop is kept. Re-measured: the same mutant now fails 4 tests |
| **P1** both per-account gates unreachable from every test | **ACCEPT, FIXED** | The cap gate is reached by the P0 case above. The subscription gate is reached by `refuses an account that lapses after the tick has already scanned it`, which lapses the account inside the only window that reaches it — after the scan, before the gate — using a fifth delegating spy on `countAccountDispatchAttemptsToday`. Re-measured: deleting the gate whole now fails exactly that case. The test is also the ARGUMENT for keeping the gate rather than deleting it as unreachable |
| **P1** "four predicates" false (three; `account_id` deliberately absent) | **ACCEPT, FIXED** | Corrected in `release.ts` and in the allowlist reason. Independently raised by the spec axis |
| **P1** "fewer statements per tick" false | **ACCEPT, FIXED** | Now false in the other direction too, after the Codex fix. Corrected in all three places with the reason |
| **P1** the caps read's row-identity predicate untested; a location override could become the account's cap | **ACCEPT, FIXED** | Migration 091's column comment confirms a location-override row carries a per-BUSINESS ceiling, and the CHECK admits one, so the predicate is load-bearing. New case `reads the account-default policy row, never a location override`. The Map build now THROWS on a duplicate `account_id` rather than silently keeping the last row — migration 074's partial unique index makes a duplicate impossible, so it is a broken invariant, not a value to choose between |
| **P2** deviations count `+1` where it is `+2` | **ACCEPT, FIXED** | Also `ENTRY_COUNT_BASELINE` → `ALLOWLIST_BASELINE` (the symbol does not exist), in the deviations file and the intake |
| **P2** comment names `runAccountArm` as the `subscription` withhold owner | **ACCEPT, FIXED** | It is now the scan, with the gate re-applying for a mid-tick lapse |
| **P2** intake edge case names `pending_payment` with no case | **ACCEPT, FIXED** | `it.each(['pending_payment', 'cancelled'])` |

## Codex adversarial — REVISE, 2 P2

| Finding | Verdict |
|---|---|
| Snapshot at the gate changes when a contraction takes effect | **ACCEPT, FIXED** — see the conflict section above |
| Enumerating two refusals does not establish starvation freedom: a mid-drip `auto_policy` batch held by a failed auto condition still holds its slot until 72h expiry | **ACCEPT as PRE-EXISTING, scope narrowed** — verified at `release.ts:1854`: `applyDowngradeSplit` returns `held` whenever `sending_started_at !== null`, changing no state, so the batch stays a candidate every tick. That is #900's hold path, untouched here. Every claim on this branch is already scoped to ACCOUNT-level refusals; the residual is now named explicitly in the scan docstring and the arch-review-log row, and filed as a follow-up. A general fix needs a cursor or rotation, which is a different ticket |

Codex's remaining observations were recorded, not actioned: the per-account-LIMIT
and materialized-view alternatives (it agreed neither is justified here), the
`unnest`/`GROUP BY` plan question (it declined to assert a defect without
`EXPLAIN (ANALYZE, BUFFERS)` evidence, and so do I), and B6's precedence living in
two encodings (real maintenance obligation, covered by the overlapping-refusal
case, not worth blocking).

## Spec & correctness — no behavioural defect, 6 low

Independently ruled out over-exclusion for both arms across all five cases put to
it, proved both counters survive a zero-candidate tick, confirmed the
`subscriptionGrantsFullAccess` rewrite has an identical truth table across 93
importers, and identified which existing case proves the empty-array bind
(`reports no withhold at all on a tick with no work due`, via the `afterEach` that
deletes every policy row).

Three of its six are the same findings red team and standards raised (predicate
count, the `COALESCE` second owner, the non-discriminating cap test) — **ACCEPT,
FIXED**. Its two remaining: the bare `'solicitation'`/`'sending'` literals are now
`POLICY_PERSONA_SOLICITATION`/`POLICY_ACTION_SENDING` (**FIXED**), and the
unbounded caps read is now filtered to `daily_send_cap IS NOT NULL` (**FIXED**) —
provably result-identical, since a NULL stored cap resolves to the same default an
absent row gets.

## Standards & maintainability — no blocking structural regression, 13 findings

Beyond the rejected de-duplication and the shared findings above:

| Finding | Verdict |
|---|---|
| `COALESCE(r.cap, ${DEFAULT_DAILY_SEND_CAP_ACCOUNT})` is a second spelling of the resolver's null branch, contradicting `resolvedCapFor`'s own docstring | **ACCEPT, FIXED** — the default is now bound from `resolveAccountDailySendCap({ dailySendCap: null })` itself |
| Docstring names a CTE `unentitled_accounts` that does not exist | **ACCEPT, FIXED** — it is an inline `NOT EXISTS` projecting `account_unentitled`; corrected in `release.ts` and the log row |
| The isolation-unit docstring describes two gate READS, one of which became a lookup; and the new caps read sits outside every `isolateItem` | **ACCEPT, FIXED** — the first half self-resolved when the gate read was restored. The second is now stated where the read happens: it is a PHASE-level input like the breaker and ceiling reads, so a throw fails the tick, which is the right blast radius |
| `ci:fallow` exit 1: `selectReleaseCandidates` CRAP 31.6 against a 30 threshold (gating `ci:fallow:coverage` green) | **ACCEPT, FIXED** — the bind-array preparation moved to `capBindArrays`, built in one pass over `entries()` so the two arrays cannot drift and no non-null assertion is needed. `ci:fallow` is exit 0 |
| `toStrictEqual` order-couples a pin whose constant disclaims order | **ACCEPT, FIXED** — sorted comparison |
| "Empty is the common case — no account has configured a cap" named the wrong condition (the map held a row per policy row, including NULL caps) | **ACCEPT, FIXED** — true as written now that the read filters `IS NOT NULL` |
| Foreign-status restore sits at the END of `afterEach` behind 11 DELETEs | **ACCEPT, noted** — the restore is idempotent and the next `beforeEach` re-asserts the primary; left as is rather than reordering a shared hook on a high-risk branch |
| Extract `release-candidates.ts` from the 2121-line file | **REJECTED for this branch** — a new file needs a `docs/directory` row and, worse, the tenant-scope allowlist is FILE-KEYED, so all seven release entries would be re-keyed in the same PR that `refactor/616-fallow-complexity` is already touching (deviation 1's merge order). Recorded as named debt |

## Named debt carried by this branch

1. The candidate window is not generally starvation-free — batch-level holds still
   occupy slots (Codex P2, pre-existing, filed separately).
2. `release.ts` is 2121 lines and `selectReleaseCandidates` is its most complex
   function. The extraction is justified and deferred for the allowlist re-key
   collision above.
3. B6's gate precedence is encoded twice: the scan's `FILTER (… AND NOT
   account_capped)` and the per-account gate order. Covered by the
   overlapping-refusal case.

## Round 3 — owner-granted, verification only

Round 2 found two P0s in round 1's fixes. The orchestrator fixed them and
re-measured each mutant itself, but `round-start` refuses a third round without a
recorded owner grant — the runner's own comment explains why: a round-2 finding
whose fix touches the tree makes the sidecar stale by construction, and the only
ways out without a grant are to leave a known defect unfixed or to hand-edit
`head_sha`, "an evidence file rewriting its own provenance". The owner granted the
round (`owner-1329-third-round`, recorded in the sidecar before it opened).

**Result: all 14 `fixed` dispositions HOLD, independently re-measured. None was
corrected downward.** Each of the five mutants fails exactly the case named for
it, plus a behaviour-preserving reorder mutant confirming the status pin is no
longer order-fragile.

It also found **one new P1 — in the orchestrator's own paperwork.** The
authorization entry failed the checker's schema (no `date`, no `finding_ids`), so
`red-team-status.mjs` had been failing on three defects, not the one the dispatch
brief claimed. Recorded as R7 and fixed. The lesson is the same one this branch
keeps relearning: a claim about what a checker reports is worth exactly as much as
the last time someone ran it.

### Two corrections to the orchestrator's own statements

1. **The round-2 commit message is imprecise.** It says both mid-tick cases "drive
   the change from a SIBLING account's count". Only the CAP case does, and must:
   `runAccountArm` reads the cap before it counts attempts, so that case cannot use
   its own count. The LAPSE case correctly fires on its own count, because the
   subscription read FOLLOWS the count. The sidecar never claimed otherwise — its
   sentence is scoped to F3. Recorded here rather than by rewriting history.
2. **The dispatch brief for round 3 was wrong** to say `red-team-status.mjs`
   "currently fails only on the stale head binding". `intake_sha256` already
   matched, and the authorization schema was a second and third defect.

### Two protocol deviations round 3 recorded, both accepted

- `watchers` aborted on a `next-server` process. Round 3 resolved its cwd with
  `lsof` to a DIFFERENT checkout, so the precondition as written was true and only
  the detector is over-broad (`findWatchers` matches `ps` output by command
  substring with no cwd scope). Overridden after that direct check; filed in the
  report appendix as tooling debt, not a finding against this branch.
- No `dotenv-swap`: the live-DB suite resolves its database from `.env.local` on
  disk, so a scrubbed replacement would have made every row `inconclusive/oracle`.
  Process env stayed the runner allowlist with `MOCK_EXTERNAL_APIS=false` matching
  both `.env.local` and CI, and no mutant touched a provider call site.

## Pre-merge obligation

`ALLOWLIST_BASELINE` 382 was derived at `eba43bcca`. `refactor/616-fallow-complexity`
merges first (deviation 1) and re-keys three entries without moving the count, but
the number must be RE-DERIVED after that merge rather than reused — evidence
produced before a rebase is stale by construction.
