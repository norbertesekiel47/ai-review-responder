# Red team — fix/1329-release-scan-fairness-arm, round 1

| | |
|---|---|
| Mode | feature (high risk, per the signed-off intake) |
| Fork / merge-base | `eba43bcca97325026a79cd3041cc25bf37e0c3f3` |
| HEAD verified | `383c34e93ad7221a1524858081bc4c4664293c6f` |
| Intake sha256 | `bfe3236bcda6324ceeea3df52eb28918f3c869e4a2bf65b8ac8430d38b908197` |
| Round | 1 of 2 |
| Budget spent | 36 s of 1200 s measured test time, 19 of 400 launches |
| Status | `OPEN_P0` (2 open P0, 4 open P1, 3 open P2; 3 `inconclusive`/oracle rows also force `INCOMPLETE_ORACLE` below the P0) |

## Severity table

| Severity | file:line | Finding |
|---|---|---|
| P0 | `src/lib/solicitation/release.ts:1305` | The per-account cap gate's use of the per-tick resolved map is asserted by nothing — reverting it to the platform constant leaves all 61 cases green, and lets a sub-default-capped account release past its configured cap |
| P0 | `src/lib/shared/__tests__/subscription-status.test.ts:77` | The new "lockstep pin" cannot fail on the drift it exists to catch; its only live assertion is an array ORDER its own docstring disclaims |
| P1 | `src/lib/solicitation/release.ts:1314` | Both account-level gates in `runAccountArm` are now unreachable from every test — each deletes whole with 61/61 still green |
| P1 | `src/lib/solicitation/release.ts:1726` | False docstring claim: `readResolvedAccountCaps` is said to carry "four predicates" matching `loadSolicitationAccountDefault`; it carries three |
| P1 | `.claude/reference/arch-review-log.md:2016` | False unconditional claim (repeated at `scripts/ci/tenant-scope-allowlist.ts:507`): "the lane issues fewer statements per tick, not more" |
| P1 | `src/lib/solicitation/release.ts:1734` | The new platform-wide read's row-identity predicate is untested and the query has no deterministic tie-break |
| P2 | `docs/superpowers/plans/fix-1329-release-scan-fairness-arm-deviations.md:35` | Stale count: deviation 1 says the tenant-scope entry count "moves by +1"; at HEAD it moves by +2 |
| P2 | `src/lib/solicitation/release.ts:1196` | Unchanged comment the diff moved out from under: it names `runAccountArm` as the owner of the `subscription` withhold, which is now the scan |
| P2 | `src/lib/solicitation/__tests__/release.integration.test.ts:1318` | The intake edge case naming `pending_payment` has no case; only `cancelled` and `past_due` are exercised |

The full text of each finding, with its arbiter reasoning, is in `findings.json`.
What follows is the evidence and the negative results.

## What the central claim survived

**The claim under test:** both fairness arms in `selectReleaseCandidates` are
EXACT — each excludes exactly the accounts its per-account gate would refuse,
never more.

Over-exclusion is very well covered, and I could not break it:

- Inverting the entitlement predicate (`NOT EXISTS` -> `EXISTS`, M5) fails **23 of
  61** cases. An arm that excluded entitled accounts could not ship.
- Lowering the cap arm's default (`COALESCE(r.cap, 50)`, M2b) fails 2; bypassing
  the clamp in the resolve loop (M19) fails 1; making the cap join inner (M18)
  fails 2; removing `AND NOT account_unentitled` (M3) fails 3.
- B6 precedence is genuinely pinned: removing `AND NOT account_capped` from the
  second count (M4) fails 2, including the locked gate-order case.
- The two counters are separated, not aliased: removing either the first
  `FILTER` (M14, 5 failures) or the `withhold(report, 'subscription', ...)` call
  (M13, 6 failures) is caught.

**The branch's secondary claim is CONFIRMED by re-measurement, not taken on
trust.** Reverting the cap arm's `HAVING` to the platform constant (M1) fails
exactly two cases — `excludes an account at its own sub-default cap from the
candidate scan` and the locked `evaluates the governors in the fixed order ...` —
with the gate-order fixture unchanged (the diff adds only a comment to it). That
matches the deviations file word for word.

**Where the claim is not actually load-bearing in the tests:** the arm is exact,
but nothing asserts that the GATE consumes the same number (P0 #1). The arms and
the gate agreeing is the intake's third invariant, and it is the one invariant
with no test behind it.

## Measurement protocol, and one deliberate deviation

The whole live-DB file runs in ~2 s under the isolated environment, so every
mutation was measured against **all 61 cases at once** rather than a single `-t`
selection. That is a superset of the per-case protocol and strictly stronger
evidence — it shows which cases die and which do not — but it means
`assert-one-test` was not used; instead every run was checked for
`numTotalTests === 61` (18 for the unit file), so a silently-skipping suite could
never read as a survivor. All runs went through `mutation-runner.mjs run` under
`--tmp-home` with the dotenv files swapped for scrubbed copies, and the journal
was finalized after every mutation.

One mutation was discarded as invalid rather than counted: M2's first attempt
matched the identical `COALESCE(r.cap, ...)` string in the docstring at
`release.ts:1525` before the statement at `:1603`, so it changed only a comment
and "survived" for a tooling reason. M2b re-targeted the `HAVING` line and
killed. Worth recording as a trap: the docstrings in this module quote their own
SQL verbatim, so a mutation pattern must anchor on the SQL keyword.

## Duty 2 — fragile assertions

One found, and it is P0 #2 (`subscription-status.test.ts:77`): an order
assertion, `toStrictEqual` against a predicate-derived list, on a value whose
docstring says the order is not meaningful.

The eight new integration cases were checked and are **clean** on this axis. Their
assertions are on report counters (`withheldByReason.account_cap === 1`,
`.subscription === 1`, `toBeUndefined()` for the zero-count guard),
`report.released`, `delivery_status`, and outbox row counts — all behavioural
contracts, none incidental structure. The `toBeUndefined()` assertions are the
right shape here, because "no work was withheld" and "zero withheld" are the two
states `withhold`'s zero-count refusal exists to separate.

## Duty 3 — docs vs reality

`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was **not used**;
every citation was hand-resolved against HEAD and the results are below.

Resolved TRUE at HEAD:

- `src/lib/auto-approval/solicitation-settings.ts:292` — `upsertSolicitationAccountDefault`
  is declared on that exact line and its INSERT writes `daily_send_cap`.
- `src/lib/auto-approval/types.ts:78` — `DailySendCapSchema = z.number().int().min(1).max(50).nullable()`,
  so 1..9 is storable (module-private `const`, which the deviations do not claim otherwise).
- `src/lib/auto-approval/solicitation-settings.ts:193` — the readiness gate's
  `runtimeEnabled: solicitationSendEnabled() && solicitationAutoApprovalEnabled()`,
  with `autopilotAvailable: tierGrantsAutopilot(...)` on the next line.
- The door: `src/app/api/settings/auto-approval/route.ts:132` (`PATCH`) -> `:57`
  `patchAutoApprovalSettings` -> `src/lib/auto-approval/settings.ts:271`
  `applySolicitationMutation`.
- The Owner Operator reaches the same module: `src/lib/agents/operator/apply.ts:511`
  calls `patchAutoApprovalSettingsInTransaction` (`settings.ts:229`), which calls
  `applySolicitationMutation` at `:271`. The deviations name
  `patchAutoApprovalSettings`, the sibling entry point — same module, so the claim
  holds.
- `readAccountDailySendCap` is DELETED and has no remaining caller anywhere in
  the worktree.
- `scripts/ci/tenant-scope-allowlist.ts` — the `RELEASE_CANDIDATE_SCAN_SQL`
  constant matches the statement at `release.ts:1592-1656` including both new
  arms, and `ALLOWLIST_BASELINE` moves 380 -> 382 with exactly two added entries.
  The arch-review-log row's "+2 entries, 380 -> 382" is correct.
- The intake's nine promised test titles all exist: 8 in the integration suite, 1
  in the unit suite. 61 and 18 case counts re-measured green.

Resolved FALSE or stale: the "four predicates" docstring (P1), the "query count
goes DOWN" claim in two places (P1), deviation 1's "+1" (P2), and the
`runBatchArm` ownership comment (P2).

## Duty 4 — missed sibling cases

**Zero siblings. The search was sound and found nothing; no sibling was invented.**

Pattern searched: an ordered `LIMIT`-bounded scan whose rows are later refused by
an **account-level** gate that writes no state (the starvation shape #1329
closes).

Scope: every `ORDER BY` + `LIMIT` scan in `src/lib/solicitation/release.ts`
(`:444` `selectOpenSendBatches`, `:560` `selectWedgedSendingOutreach`, `:952`
`selectSendWindowElapsedBatches`, `:1024` `selectExpiredBatches`, `:1786`
`selectRenderedOutreach`), plus `src/lib/solicitation/auto-approval.ts:528`
`selectAnchorCandidates`, plus every `LIMIT ${...}` site in `src/lib/solicitation/`.

Result and why each is not a sibling:

- The four peer sweeps (P1/P2/P3/P5) consult no account-level entitlement or cap
  gate at all — `subscriptionGrantsFullAccess` appears in `release.ts` only at
  `:1315`, and `resolveAccountDailySendCap` only on the candidate path — so there
  is no gate after them to starve anyone.
- `selectAnchorCandidates` (P4.5, the Veto anchor scan) has no `ORDER BY` at all
  and no downstream account gate; `decideAutoApproval`'s account-level ladder
  (`auto-approval.ts:106`) runs at approval time, not after this scan.
- `runBatchArm`'s auto_policy re-check (`release.ts:1205`) IS account-level, but
  it WRITES state (`applyAutoDowngrade`) rather than leaving the batch a
  perpetual candidate, so a refused account's work leaves the candidate set
  rather than holding it.
- `releaseBatchRows`'s `capacityExhausted()` is the running-counter gate, inside
  the account, not a scan-level refusal.

Exclusions recorded: Playwright/E2E specs (fragile-assertion review only) and
`supabase/migrations/` (per the skill; the DB is provisioned before the run).

## Duty 5 — operational completeness

Nothing to report, and the search is recorded so the absence means something.

The diff adds **no** Sentry signal, no `logger.*` call and no new terminal or
swallowed failure path — a `+`-line grep of the changed `release.ts` for
`logger.`, `captureException`, `reportCaught` and `Sentry` returns nothing.
`withheldByReason.subscription` is a counter on an existing report line, not an
alert. `docs/runbooks/beta-launch-alerting.md` has no rule row mentioning the
release cycle or any withhold counter, which is a PRE-EXISTING state this diff
neither creates nor worsens, so it is not raised as a finding here.

## Restoration

`mutation-runner.mjs finalize` reports all 19 journaled process groups reaped, 0
unrestored mutations, `dotenv.open: false`, and
`git status --porcelain --untracked-files=no` is EMPTY. The only untracked path is
`docs/reviews/fix-1329-release-scan-fairness-arm/` (the implementer's
blast-radius note), which predates this pass. `.env.local` is the real file
again. Nothing was staged or committed by this pass.

## Authorizations

None. No finding is accepted-risk.
