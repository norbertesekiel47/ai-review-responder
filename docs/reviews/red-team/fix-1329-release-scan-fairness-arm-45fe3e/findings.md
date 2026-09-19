# Red team — fix/1329-release-scan-fairness-arm, round 3

| | |
|---|---|
| Mode | feature (high risk, per the signed-off intake) |
| Fork / merge-base | `eba43bcca97325026a79cd3041cc25bf37e0c3f3` |
| Round-1 reviewed HEAD | `383c34e93ad7221a1524858081bc4c4664293c6f` |
| Round-2 reviewed HEAD | `1d0e00b4018f4320fe7182362dfee4fdd704b448` |
| HEAD verified | `7cca32f7ee0c6aa2828b7b7e6a9ddaf8933627a3` |
| Intake sha256 | `536ec4a553947fab0964ce8afab6ebdcd866b843e34a251314e2038e6373202f` (unchanged since round 2) |
| Round | 3 of 3, on the recorded owner grant `owner-1329-third-round`. No fourth round. |
| Budget spent | 14 s of 1200 s measured test time, 9 of 400 launches |
| Scope | VERIFICATION ONLY: the fix hunks `1d0e00b40..7cca32f7e` and the five mutants the orchestrator re-measured itself. No new front was opened against unchanged code; one out-of-scope observation is in the appendix, untriaged. |
| Status | `CLEAR` — 15 of 16 findings `fixed`, 1 P2 `open` by owner choice (R5). Round 3 upheld every disposition it re-measured and added one new P1 (R7), fixed in this sidecar. |

## Round 3 — what was re-measured, and the verdict

Every one of the five orchestrator-claimed mutant kills was re-applied
INDEPENDENTLY at `7cca32f7e` and each one fails at least one case, and the case
named. Rows `rt3-01` … `rt3-08` in `findings.json` carry the per-mutant evidence.

| Claim | Mutant | Verdict |
|---|---|---|
| R1 — dead import gone, `lint` exits 0 | none needed | **HOLDS.** `pnpm run lint` (`eslint .`) exits 0; targeted `npx eslint` on all three changed files exits 0; `pnpm typecheck` exits 0. `DEFAULT_DAILY_SEND_CAP_ACCOUNT` is still exported at `send-caps.ts:16` and still used by `send-caps.ts:25-26`, `AutoApprovalClient.tsx:1281-1282` and three test files; `release.ts` retains only the prose mention at `:1559`. `no-unused-vars` is repo-wide, so "nothing else imports a name it no longer uses" is covered by the same green run. |
| R2 claim A — dropping `account_id` fails `ci:tenant-scope` | M-A | **HOLDS.** Baseline: 382 entries, baseline 382, exit 0. Under M-A: exit 1, one finding, `src/lib/solicitation/release.ts: auto_approval_policies: missing account_id or business_id scope`. |
| R2 claim B — dropping `location_id IS NULL` fails the new location-override case | M-B | **HOLDS.** `assert-one-test` confirmed exactly one executed test; it failed (`expected +0 to be 1`). The fixture seeds the override ALONE — `beforeEach` deletes every policy row for the owned accounts (`:964`) and the case inserts one location-scoped row (`:1314`) and never calls `seedSolicitationPolicy` — so `LIMIT 1` is not a coin flip, and the case cannot pass for a wrong reason. |
| F3 — deleting the cap ENTRY gate now fails the new order case | M-C | **HOLDS.** 1 of 68 fails, exactly `names the cap, not the subscription, when both fail after the tick has scanned` (`expected undefined to be 1`, `:1392`). No third path: the other 67 stay green, which independently proves the comment's claim that deleting the gate changes no send — `capacityExhausted()` covers the zero remainder — and that the gate owns only B6's reported reason. |
| The interleaving seam | two test-level mutants | **HOLDS, with one correction to how it was described.** Ordering verified in source: `release.ts:1306-1309` awaits `readAccountDailySendCap` BEFORE `countAccountDispatchAttemptsToday`. Wrong-moment (a) removing the sibling → `expected +0 to be 1` at `:1390`; wrong-moment (b) sibling kept but the spy guarded to the PRIMARY account → `expected undefined to be 1` at `:1393`, verbatim the "the gate had already read 10 and released" the case records as measured. **Correction:** only the CAP case needs the sibling. `refuses an account that lapses after the tick has already scanned it` (`:1571`) fires the seam on its OWN count and is correct to, because the subscription read FOLLOWS the count — and `findings.json` never claimed otherwise (its sentence is scoped to F3's case). |
| R3 — the `beforeEach` `mockReset()` stops an unconsumed `mockImplementationOnce` leaking | none needed | **HOLDS.** Read against the installed spy: `@vitest/spy@4.1.7/dist/index.js:142-157` — `mockClear()` (which `vi.clearAllMocks()` calls, `:474`) resets only the call registers; `mockReset()` sets `config.onceMockImplementations = []` at `:155`. The re-arm order in the hook is `mockReset()` then `mockImplementation(actual)`, which is correct. |
| Gate cap source (F1) | M-D | **HOLDS.** 2 of 68 fail, including `releases only the remainder of a sub-default cap the account has partly spent` (`expected 4 to be 2`, `:1432`). |
| Status pin (F2) | M-E, M-E2 | **HOLDS in both directions.** M-E (drop `TRIALING`) reds the pin — 4 of 18 fail. M-E2 (reorder, behaviour-preserving) leaves 18 of 18 green, so F2's *fragility* half is closed too, not just its blindness half: the assertion `.sort()`s the array (`subscription-status.test.ts:84`). |
| Subscription gate (F3's other half) | M-F | **HOLDS.** 1 of 68 fails, exactly `refuses an account that lapses after the tick has already scanned it` (`expected 1 to be +0`, `:1598`). |

### The three rewritten prose claims, re-resolved at HEAD

| Claim | Verdict |
|---|---|
| arch-review-log row: "the release integration suite (53 → 68 executed cases)" | **TRUE.** At the merge-base `eba43bcca` the file has 53 `it(` and zero `it.each` → 53 executed. At `7cca32f7e` it has 66 `it(` plus one `it.each` of two parameters (the second `it.each` match is inside a comment at `:907`) → 68, and the reporter measured `numTotalTests: 68`, 68 passing. R4 is correctly `fixed`. |
| `FULL_ACCESS_SUBSCRIPTION_STATUSES` docstring: the pin asserts membership "against LITERALS, deliberately not against the predicate" | **TRUE.** `subscription-status.test.ts:84-87` compares the sorted array to the literals `['active','trialing']`; the predicate loop at `:90-94` is a SECOND, separate assertion, and `:97-101` refuses the three non-members by name. R6 is correctly `fixed`. |
| `readAccountDailySendCap` docstring: "`LIMIT 1` is not a tie-break" because migration 074's partial unique index admits at most one row | **TRUE.** `supabase/migrations/074_trust_dial_veto_window.sql:75-77` — `CREATE UNIQUE INDEX … auto_approval_policies_one_account_default ON auto_approval_policies (account_id, persona, action_class) WHERE location_id IS NULL`. The docstring's "four predicates" is also right for THIS read (account_id, persona, action_class, `location_id IS NULL`) — the "three predicates" of F4 belongs to `readResolvedAccountCaps`, which omits `account_id`. Both guard claims in the same docstring were measured above and both hold. |

## Severity table — still open, newly introduced, or corrected in round 3

| Severity | file:line | Finding |
|---|---|---|
| P1 | `docs/reviews/red-team/fix-1329-release-scan-fairness-arm-45fe3e/findings.json:6` | **NEW (R7), fixed in this sidecar.** The third-round authorization committed at `7cca32f7e` fails the checker's own schema — no `date`, no `finding_ids` — so `red-team-status.mjs` exited 1 and the `reviewed` transition could not run. Not the stale head binding the round-3 brief named as the only failure: `intake_sha256` already matched, and `head_sha` was one of three defects. The Markdown Authorizations section also still said "None" while the JSON array carried the grant. |
| P2 | `src/lib/solicitation/release.ts:1810` | **R5, `open` by owner choice.** The duplicate-row `throw` in `readResolvedAccountCaps` is a PHASE-level failure for a state migration 074's partial unique index makes impossible, and it has no alerting rule row. Unchanged in round 3. |

Every other finding (F1–F9, R1–R4, R6) is `fixed`, and round 3 re-measured the
five the owner grant names plus R1, R3 and R4 — all upheld. Full arbiter
reasoning per finding, and the whole 24-row inventory, is in `findings.json`.

## Rounds 1 and 2 — evidence preserved verbatim

Everything from here to "Authorizations" is ROUND 2's report, kept unaltered
because the owner grant scopes round 3 to verification and says it "preserves
earlier evidence". Its SHAs, case counts and dispositions are round 2's; where
round 3 corrected one, the correction is in the tables above and in
`findings.json`.

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

## Round 2 — measurement protocol and restoration

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

### `owner-1329-third-round` — 2026-09-19

Findings in scope: F1, F2, F3, F6, R1, R2, R3. No finding is `accepted-risk`;
this grant authorizes a verification ROUND, not the acceptance of a finding.

Verbatim:

> Question: Round 2's P0 fixes have no independent verification, and the sidecar is bound one commit behind (1d0e00b4) while HEAD has moved. How do we close the review? Options offered: authorize a THIRD ROUND so a fresh pass re-binds the sidecar to HEAD and independently attacks the five fixes the orchestrator measured itself; ship with those orchestrator measurements as the evidence and leave the reviewed phase unset; or stop and hand over the state.
> Owner: Authorize a third round.
> Scope: verification only, over the round-2 fix hunks and the five mutants the orchestrator re-measured (gate cap source, status pin, subscription gate, location override, cap entry gate). It re-binds the sidecar to current HEAD, preserves earlier evidence, and grants no fourth round.

This section is RENDERED from `findings.json`'s `authorizations` array and is
never parsed back out of this Markdown.

## Round 3 — measurement protocol and restoration

Nine launches, 14 s of measured test time of the 1200 s round budget, all through
`mutation-runner.mjs run` under a temporary `HOME` with `NODE_ENV=test`, `CI=true`
and `MOCK_EXTERNAL_APIS=false` (matched to `.env.local` and to CI, where `true`
short-circuits transport) and `TEST_DATABASE_POOL_URL`/`DATABASE_POOL_URL` pinned
to the validated localhost test database. Every mutation went through
`mutation-runner.mjs mutate`, so each is journaled with its original blob OID
before the write; every mutated file was restored by named-path `git checkout --`
immediately after its measurement, and `git status --porcelain` was verified
EMPTY before the first byte of this round's report was written. The journal is
left FINALIZABLE with nine `applied` entries whose working blobs already equal
their journaled originals — the orchestrator owns `finalize`, which will mark them
`restored`; `red-team-status.mjs` reports those nine journal rows as its only
remaining issues and no schema, binding or count error.

Two deviations from the standard protocol, both recorded rather than silent:

1. **`watchers` was overridden after a direct check.** It reported PID 89820
   (`next-server v16.3.0`) as "serving this worktree". It is not:
   `lsof -a -p 89820 -d cwd` resolves its cwd to a DIFFERENT checkout outside
   this worktree, and `findWatchers` matches `ps -Ao pid=,command=` by command
   substring with no working-directory scope. The precondition as WRITTEN ("no
   process is serving or watching this worktree") is true; only the detector's
   claim is over-broad. See the appendix.
2. **No `dotenv-swap`.** The live-DB release suite resolves its database through
   `.env.local` on disk, and the scrubbed replacement carries only
   `MOCK_EXTERNAL_APIS` and `TEST_DATABASE_POOL_URL` — a missing variable would
   have made every row `inconclusive`/`oracle` and blocked the round. The process
   env was still the runner's allowlist, and `MOCK_EXTERNAL_APIS=false` matches
   both `.env.local` and CI, so baseline and mutant ran under identical
   environments. No mutant touched a provider call site.

## Appendix — out of scope, untriaged

Round 3 is verification-only, so these are recorded without a finding id and
without a disposition. Neither is in the fix hunks.

- `.agents/skills/red-team/scripts/mutation-runner.mjs` (`findWatchers` /
  `cmdWatchers`) — the watcher precondition matches the whole host's process
  table by command substring and never compares a working directory, so any
  `next dev` / vitest watcher anywhere on the machine aborts a red-team round on
  this worktree with the message "a process is watching or serving **this
  worktree**". Safe direction, but it makes a true precondition unverifiable by
  the tool and pushes the judgement onto the agent. A cwd check (`lsof -a -p
  <pid> -d cwd`) would resolve it.
- `src/lib/solicitation/__tests__/release.integration.test.ts:2691` —
  `spies.enqueueSolicitationSend.mockRejectedValueOnce(...)` is the same class R3
  closed for the fifth spy, on a spy the `beforeEach` re-arms with
  `mockImplementation` only. If that case ever stops consuming its override, it
  leaks into the next case. Pre-existing and unchanged by this branch.

---

## Orchestrator note, after round 3 (not part of the pass)

Written by the run's orchestrator, and kept HERE rather than in
`docs/reviews/fix-1329-release-scan-fairness-arm/triage.md` for a mechanical
reason worth recording: `red-team-status.mjs` binds this sidecar to a HEAD and
then requires that the tree at HEAD differ from it in **these two files only**.
Appending the round-3 narrative to the triage record moved the tree and broke the
binding, so that append was reverted and the narrative lives in the one artifact
the checker permits to change. Step 7.5's "order is load-bearing" is exactly this:
everything except the sidecar must be committed BEFORE the last round opens.

### Two corrections to the orchestrator's own statements

1. **The round-2 commit message is imprecise.** It says both mid-tick cases "drive
   the change from a SIBLING account's count". Only the CAP case does, and must:
   `runAccountArm` awaits the cap read before the attempts count, so that case
   cannot use its own count. The LAPSE case correctly fires on its own count,
   because the subscription read FOLLOWS the count. Round 3 caught the
   over-generalisation; this sidecar's own text was already scoped correctly.
2. **The round-3 dispatch brief was wrong** to tell the pass that
   `red-team-status.mjs` "currently fails only on the stale head binding".
   `intake_sha256` already matched, and the authorization entry's missing `date`
   and `finding_ids` were a second and third defect — which the pass then found
   and fixed as R7. A claim about what a checker reports is worth what the last
   run of it showed, and that brief's claim was older than its evidence.

### Why a third round existed at all

Rounds are capped at two. Round 2 found two P0s in round 1's fixes; fixing them
moved HEAD past the pass that reviewed it, which makes the sidecar stale by
construction. The runner's own comment names the trap: without a grant, the only
ways out are to leave a known defect unfixed or to hand-edit `head_sha` — "an
evidence file rewriting its own provenance". The owner granted the round
(`owner-1329-third-round`), recorded here before it opened, and it verified the
five fixes the orchestrator had only measured itself. None was corrected downward.
