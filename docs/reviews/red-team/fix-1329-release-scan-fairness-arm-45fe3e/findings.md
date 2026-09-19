# Red team — fix/1329-release-scan-fairness-arm, round 2

| | |
|---|---|
| Mode | feature (high risk, per the signed-off intake) |
| Fork / merge-base | `eba43bcca97325026a79cd3041cc25bf37e0c3f3` |
| Round-1 reviewed HEAD | `383c34e93ad7221a1524858081bc4c4664293c6f` |
| HEAD verified | `1d0e00b4018f4320fe7182362dfee4fdd704b448` |
| Intake sha256 | `536ec4a553947fab0964ce8afab6ebdcd866b843e34a251314e2038e6373202f` (the AMENDED intake, current on disk) |
| Round | 2 of 2 — the cap. `round-start` will refuse a third. |
| Budget spent | 276 s of 1200 s measured test time, 19 of 400 launches (one 120 s timeout included, see below) |
| Scope | the fix hunks `383c34e93..1d0e00b40` and their direct callers. Nothing else was opened. |
| Status | `OPEN_P0` (2 open P0, 1 open P1, 4 open P2; 8 of round 1's 9 findings fixed; one `inconclusive`/oracle row also forces `INCOMPLETE_ORACLE` below the P0) |

## Severity table — still open or newly introduced

| Severity | file:line | Finding |
|---|---|---|
| P0 | `src/lib/solicitation/release.ts:119` | **HEAD does not pass its own required gate.** `pnpm lint` fails: the fix left `DEFAULT_DAILY_SEND_CAP_ACCOUNT` imported with no remaining use |
| P0 | `src/lib/solicitation/release.ts:1832` | The RESTORED gate read `readAccountDailySendCap` has an entirely unpinned `WHERE`: dropping `location_id IS NULL` **and** dropping `account_id = …` each leave 66/66 green |
| P1 | `src/lib/solicitation/release.ts:1311` | F3 is only half fixed (recorded `inconclusive`/oracle, upholding round 1's class): the cap ENTRY gate still deletes whole with 66/66 green (the subscription half is genuinely closed) |
| P2 | `src/lib/solicitation/__tests__/release.integration.test.ts:64` | The new fifth delegating spy is outside the `beforeEach` re-arm contract, and `vi.clearAllMocks()` does not clear its `mockImplementationOnce` queue |
| P2 | `.claude/reference/arch-review-log.md:2016` | The rewritten row says the suite gains "+11 cases"; HEAD adds 13 executed cases |
| P2 | `src/lib/solicitation/release.ts:1810` | The new duplicate-row `throw` is a PHASE-level failure for a DB-impossible state, with no alerting rule row |
| P2 | `src/lib/shared/subscription-status.ts:56` | The constant's docstring still says the pin is "derived from the predicate" — the exact shape round 1 proved fake |

Full arbiter reasoning per finding, and the whole inventory, is in `findings.json`.

## Disposition of every round-1 finding

| Round-1 | Severity | Disposition | How it was re-measured |
|---|---|---|---|
| F1 gate cap source asserted by nothing | P0 | **fixed** | M1 reverts the gate to the platform constant → fails EXACTLY `releases only the remainder of a sub-default cap the account has partly spent` (1 of 66) |
| F2 self-referential lockstep pin | P0 | **fixed** | M2 drops `TRIALING` from the array → 4 of 18 fail, this pin among them |
| F3 both account gates unreachable | P1 | **open (half)** | M3 deletes the subscription gate → fails exactly the new lapse case. M12 deletes the cap ENTRY gate → **66/66 still green** |
| F4 "four predicates" false | P1 | **fixed** | Now "three", and constant-for-constant against `loadSolicitationAccountDefault` (`solicitation-settings.ts:268-274`) |
| F5 "fewer statements per tick" false | P1 | **fixed** | Reversed in all three places, and TRUE at HEAD: one statement more per tick |
| F6 caps-read row identity untested | P1 | **fixed** | M4 drops `location_id IS NULL` from the ARM read → fails exactly the new row-identity case. The GATE read's copy is R2, not a reopening |
| F7 deviations "+1" vs "+2" | P2 | **fixed** | "+2, 380 → 382"; `ALLOWLIST_BASELINE = 382` at `:287`; `ci:tenant-scope` agrees |
| F8 withhold-owner comment | P2 | **fixed** | The comment now names the scan, with the gate re-applying for a mid-tick lapse |
| F9 `pending_payment` had no case | P2 | **fixed** | `it.each(['pending_payment', 'cancelled'])`; M13 fails both, so neither is vacuous |

## The claim-by-claim attack

Every number below was produced in this pass. Baseline first: the live-DB suite
reports **66 cases, 66 passing** at HEAD under the isolated environment, so no
run in this round was a silent skip. The whole file runs in ~2 s, so each
mutation was measured against all 66 cases at once rather than one `-t`
selection — a superset of the per-case protocol, which also shows WHICH cases
die; every report was checked for `numTotalTests === 66` (18 for the status unit
file, 118 for the tenant-scope audit file).

**Claim 1 — F1, the gate cap source. CONFIRMED.** M1 is round 1's surviving M10
verbatim, and it now fails exactly the promised case. The fixture's two
defences are real and both matter: 3 attempts against a configured 5 keeps the
account OUT of `capped_accounts` (3 < 5), so the arm cannot stand in for the
gate, and `perTickBudget: 10` keeps `RELEASE_PER_TICK_BUDGET = 2` — which equals
the expected answer — from satisfying the assertion on its own.

**Claim 2 — F2, the self-referential pin. CONFIRMED.** M2 now fails 4 of 18,
including this case. The literal `['active', 'trialing']`, sorted, is an oracle
independent of a predicate implemented over the array, and the sorted comparison
means a reorder cannot red it — which is what the constant's docstring promises
about order.

**Claim 3 — F3, and the seam itself. HALF CONFIRMED, and the seam holds.**
M3 deletes the per-account subscription gate whole and fails exactly
`refuses an account that lapses after the tick has already scanned it`. On the
three seam questions asked of it:

- *Does the spy fire where the comment says?* Yes.
  `countAccountDispatchAttemptsToday` has exactly ONE call site in the whole of
  `src/` and `worker/` outside tests — `release.ts:1310`, between the committed
  candidate scan and `readAccountSubscriptionStatus` at `:1325`. Nothing else in
  the tick consumes it (`capacityExhausted` uses
  `countPlatformDispatchAttemptsToday`).
- *Is the `mockImplementationOnce` consumed by the account under test?* Yes —
  the case seeds one account and no foreign candidate, and the `afterEach`
  deletes every batch and policy owned by both accounts, so there is no second
  account for the single `Once` to land on.
- *Does it still pass for the RIGHT reason if case order changes?* Undecided,
  and recorded as R3 rather than claimed either way. The mechanism is measured:
  `@vitest+spy@4.1.7/dist/index.js:142-157` shows `mockClear()` — what
  `vi.clearAllMocks()` calls — leaving `config.onceMockImplementations`
  untouched, while only `mockReset()` empties it. So an unconsumed `Once` on
  this spy would survive `beforeEach` into the next case, and unlike the other
  four delegates this one is NOT re-armed there. Today it is always consumed, so
  the leak is latent; a shuffle probe
  (`--sequence.shuffle.tests --sequence.seed=424242`) also stayed 66/66, but the
  JSON reporter emits declaration order and I could not confirm the flag took
  effect, so that probe is reported as unconfirmed, not as evidence.

The half that is NOT fixed: M12 still deletes the cap ENTRY gate with all 66
green. Round 1 filed that as `inconclusive`/oracle on the grounds that
`capacityExhausted()` compensates, and round 2 UPHOLDS that class rather than
escalating it. The compensation covers the RELEASE decision but not the
REPORTED REASON — an
account that becomes both capped and lapsed mid-tick reports `subscription`
under the mutant where B6's locked order requires `account_cap`, and mid-tick
transition is precisely the window this branch now argues these gates exist for.
But the behaviour that distinguishes the mutant lies on a path NO case executes,
which makes this a claim about the oracle rather than a confirmed defect — hence
`inconclusive`/oracle, and hence F3 stays P1 rather than becoming a second P0.
Not a defect at HEAD; a gap where a case should be.

**Claim 4 — F6, row identity. CONFIRMED for the arm, BROKEN for the gate.** M4
kills. The throw is reachable-in-principle only if the schema allows a duplicate,
and it does not: migration `074:75-77` creates
`auto_approval_policies_one_account_default` UNIQUE on
`(account_id, persona, action_class) WHERE location_id IS NULL`, which is exactly
this read's predicate set. So M5 (deleting the throw) is `equivalent` with a
proof rather than a coverage gap — and the throw's blast radius is R5.

But the fix restored `readAccountDailySendCap`, giving the SAME row identity a
second spelling, and that one is asserted by nothing — **R2, and it is a P0**,
because both survivors are on a line every candidate account executes and
neither is equivalent. M6 drops its
`location_id IS NULL` — 66/66 green — which in production lets migration 091's
per-BUSINESS ceiling become the account's gate cap, arbitrarily chosen by a
`LIMIT 1` with no `ORDER BY`. M11 drops its `account_id = ${accountId}::uuid` —
also 66/66 green — which makes the gate read some other tenant's dial. Every
fixture is blind to both because the cases that seed two policy rows resolve
both to 10.

**Claim 5 — the doc claims. ALL RE-RESOLVED, four true, two new drifts.**
`prevalidate-plan.py` PASSES on the deviations file (3 citations, 0 unresolved;
1 commit, 0 stale). F4, F5, F7 and F8 all resolve TRUE at HEAD, with the
supporting citations in `findings.json`. Two claims the fix introduced do not:
the arch-review-log's "+11 cases" (measured: 53 `it(` at the merge-base, 64 `it(`
plus one two-parameter `it.each` at HEAD = 66 executed, so +13 executed / +12
declarations — R4), and `subscription-status.ts:56`, whose docstring still
describes the derived-from-the-predicate pin the fix deliberately replaced (R6).
One claim is approximate rather than wrong and is not filed: the deviations file
says `ALLOWLIST_BASELINE` is "~line 279" where it is 287; the tilde carries it.

**Claim 6 — the new surface the fixes introduced. THREE CONFIRMED, ONE DEFECT.**

- `capBindArrays` is covered, not merely moved: M8 empties its loop body and 2
  of 66 fail.
- The `COALESCE` default bound from `resolveAccountDailySendCap({ dailySendCap: null })`
  is asserted: M7 replaces it with the literal 50 and 2 of 66 fail. Round 1's
  surviving M15 is now killed in its new location.
- **`daily_send_cap IS NOT NULL` really does change no result, and the claim is
  PROVEN rather than assumed.** `resolveAccountDailySendCap({ dailySendCap: null })`
  returns `DEFAULT_DAILY_SEND_CAP_ACCOUNT` (`send-caps.ts:25`), which is the same
  value the `COALESCE` default binds, so a NULL-cap row entering the map as 10
  gives `COALESCE(10, 10)` where its absence gives `COALESCE(NULL, 10)`, and
  `GROUP BY o.account_id, r.cap` yields one group either way. Measured both
  directions: M10 removes the filter and all 66 pass (the equivalence), M9 flips
  it to `IS NULL` and 2 fail (the direction is still pinned).
- **The regenerated allowlist constants still match the live statements byte for
  byte.** `pnpm ci:tenant-scope` prints `passed — entries: 382 (baseline: 382)`
  at HEAD, and `scripts/ci/__tests__/tenant-scope-audit.test.ts` runs 118/118
  green. `ci:static-policy`, `ci:live-db-suites`, `ci:outbox-status`,
  `ci:directory-map`, `ci:db-imports` and `ci:rls-audit` all pass, and
  `pnpm typecheck` passes.
- **The defect: `pnpm lint` FAILS at HEAD (R1).** One error, and the fix caused
  it — `DEFAULT_DAILY_SEND_CAP_ACCOUNT`'s last two uses were the gate assignment
  and the arm's `COALESCE` default, both replaced, leaving only a prose mention
  at `:1555`. `lint` is a required check and `lefthook`'s pre-push hook runs the
  same command, so the branch cannot be pushed or merged as it stands.
  `.feature/gate-status.json` is stamped 09:26, before HEAD was written, so the
  fix commit was never gated.

## Duty 2 — fragile assertions

One found, filed as R3, and it is a SEAM fragility rather than an assertion on
incidental structure — hence P2. The five new cases were checked on the classic
shapes and are clean: their assertions are on `report.released`,
`report.withheldByReason.*` counters (including `toBeUndefined()` for the
zero-count guard), `delivery_status` and outbox row counts. The one count
assertion on rendered output —
`statuses.filter((s) => s === 'queued')).toHaveLength(2)` in the remainder case —
is a behavioural contract (the cap's remaining allowance), not an incidental
string count, and its comment records that the sequential loop is deliberate
under #773's admission chokepoint.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was RUN this time (it exists at
`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py`) and passes on the
deviations file. Everything else was hand-resolved; see claim 5 above and the
`reason` field of F4, F5, F7, F8, R4 and R6.

## Duty 4 — missed sibling cases

**One sibling found, and it is R2.** The pattern searched: a spelling of the
solicitation account-default policy row's identity
(`persona` + `action_class` + `location_id IS NULL`) outside the module that owns
the write. Scope: every `auto_approval_policies` read in `src/` and `worker/`.
Result: three spellings exist — `loadSolicitationAccountDefault`
(`solicitation-settings.ts:268-274`, the writer's own read, which also carries
`account_id`), `readResolvedAccountCaps` (pinned by the new case) and
`readAccountDailySendCap` (the one the fix restored, pinned by nothing). The
first two are correct and asserted; the third is the sibling, and it is inside
the fix hunks rather than an unrelated front.

Round 1's starvation-shape search is NOT re-run: nothing in the fix hunks adds or
changes a `LIMIT`-bounded scan, so that result stands as recorded.

Exclusions: Playwright/E2E specs and `supabase/migrations/` (per the skill;
migrations 074 and 091 were READ as schema evidence, never mutated).

## Duty 5 — operational completeness

Re-checked against the fix hunks only. The diff adds no `logger.*`, no
`captureException`, no Sentry signal and no new swallowed path — a `+`-line grep
of the changed `release.ts` for those four returns nothing. It adds ONE new
terminal path, the duplicate-row `throw`, and that is R5: phase-level rather than
account-level by design, unreachable while 074's index holds, and with no rule
row in `docs/runbooks/beta-launch-alerting.md` to surface it if the index ever
diverged between the two Supabase projects. The missing runbook coverage for this
phase is pre-existing and is not charged to this branch.

## Measurement protocol and restoration

All 19 launches went through `mutation-runner.mjs run` under a temporary `HOME`
with the dotenv files swapped for scrubbed copies, and the journal was finalized
after every mutation. One launch TIMED OUT at 120 s — a combined run that
included `scripts/ci/__tests__`, which is too heavy for one launch; it was split
and `tenant-scope-audit.test.ts` then ran alone in seconds, 118/118. That timeout
is charged in full to the budget, which is why 19 launches cost 276 s.

One trap worth recording for the next round on this module: the `candidates` CTE
predicate is spelled across two lines
(`WHERE NOT account_capped` / `AND NOT account_unentitled`), so a mutation
pattern written as the single-line form silently matches nothing. The runner
refused rather than producing a false survivor, but only because `mutate` failed
loudly.

`mutation-runner.mjs finalize` reports every journaled process group reaped, 0
unrestored mutations, `dotenv.open: false`, and `git status --porcelain` EMPTY —
no tracked modification and no untracked path — before the first byte of this
report was written. `.env.local` is the real file again. Nothing was staged or
committed by this pass; the orchestrator owns the finalizer and the commit.

## Authorizations

None. No finding is accepted-risk.
