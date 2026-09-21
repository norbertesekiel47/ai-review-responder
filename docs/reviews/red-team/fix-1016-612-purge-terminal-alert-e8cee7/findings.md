# Red team — `fix/1016-612-purge-terminal-alert`

| | |
|---|---|
| Mode | feature (step 7 review wave) |
| Run id | `feature-fix-1016-612-purge-terminal-alert-e8cee7` |
| Fork / merge-base | `75c8d54cb77ac34d1f2f7686b9171528871b81f3` (both; `origin/main` is a direct ancestor) |
| HEAD | `6df3c95dfbabad6046b5dfbd455730233bc6e58c` |
| Intake sha256 | `643e03d921a6c9a7224520cbe16aa696a6aa136ed4b7d7ac57534dca8412f1cd` |
| Risk | high |
| Round | 1 |
| Status | **OPEN_P0** |

## 0. Preconditions and re-derived evidence

- Worktree clean at a committed SHA before the run (`git status --porcelain` empty, tracked and untracked).
- `mutation-runner.mjs watchers` → none.
- `mutation-runner.mjs round-start` → round 1 open, 20 min budget.
- SHAs re-derived independently and identical to the ones handed to this pass.
- Gate fingerprint re-checked at HEAD: `gate-fingerprint.mjs check` exits 0,
  `3e275281022855bdb68fe01bfa6966d8a5aa63a677ed53ad63d33308c7bba247`.
  `.feature/gate-status.json` records `passed: true`, `mode: "full"`, every check `PASS`
  except `reclassify` (`WARN`).
- All 7 `tests_to_add` titles found verbatim in the tree
  (`PurgeWorker.test.ts:734/755/774/794/818/847`, `ingest.test.ts:138`) and all 7 run green
  individually at HEAD under the scrubbed environment.
- Environment isolated by allowlist (`env --tmp-home`, no `--test-db`;
  `REPWORTH_DISABLE_LIVE_DB_SUITES=1`), dotenv swapped for each measurement cycle. No live
  database was provisioned or touched; no in-scope candidate needed one.
- Measured cost: 23 launches, ~17 s of the 1200 s round budget. Nothing skipped.

## 1. Inventory (Duty 1 — hand-mutation)

Direction A is the six added `PurgeWorker.test.ts` cases plus the two `ingest.test.ts` cases
(one new, one whose helper `laneFilesBuildingTheLockKey` was rewritten and whose `LANE_ROOTS`
was widened). Direction B walks the four behaviour-affecting production hunks — the two
exported fingerprint constants, the `fingerprint` key added to `alertPurgeFailure`, the
constant-extracted message, and the widened #612 scan — plus the rule-16 block in
`docs/runbooks/beta-launch-alerting.md`, which is the artifact the doc-pin test claims to
hold. Every hunk reaches a covering candidate; none is uncovered.

| id | candidate test | mutation applied | outcome |
|---|---|---|---|
| RT-A1 | `alerts a terminal stage failure with the terminal fingerprint at error level` | `PurgeWorker.ts:158` ternary swapped (`terminal ? RETRY : TERMINAL`) | killed |
| RT-A2 | `alerts a retryable stage failure with the retry fingerprint at warning level` | `PurgeWorker.ts:157` level ternary swapped (`terminal ? 'warning' : 'error'`) | killed |
| RT-A3 | `alerts a terminal validation failure with the terminal fingerprint` | `PurgeWorker.ts:79` validation call site forced to `alertPurgeFailure(job.data, safeMessage, false)` | killed |
| RT-A4 | `the terminal and retry purge alerts never share a fingerprint` | `PurgeWorker.ts:158` whole `fingerprint:` key deleted (the literal pre-#1016 defect) | killed |
| RT-A5 | `the terminal purge path marks the outbox failed and does not throw` | `PurgeWorker.ts:147` `markOutboxFailed` → `markOutboxCompleted` | killed |
| RT-A6 | `the alerting runbook routes the terminal purge fingerprint the worker sends` | rule 16's row (`beta-launch-alerting.md:589`) corrupted: fingerprint → `[…, retry]`, filter → `terminal equals false`, level → `warning` | **survived-confirmed-P0** (RT16-02) |
| RT-A7 | `the csv_ingest lock-key scan covers the offboarding purge lane` | `ingest.test.ts:80` `LANE_ROOTS` narrowed back to `['src/lib/solicitation','worker/jobs/csv-ingest']` | killed |
| RT-A8 | `acquireCsvIngestLock is the single owner of the csv_ingest advisory-lock key` | `purge-stages.ts:295` `acquireCsvIngestLock(tx, business.id)` replaced with a hand-spelled `pg_advisory_xact_lock(hashtext(...))` over the same per-business key, in CODE | killed |
| RT-A9 | (no test) `purge-stages.ts:258-266` comment reword | — | excluded: comment-only hunk, no covered production line; the same file's code surface is measured by RT-A8 |

Second mutations worth recording, beyond the one charged to each row:

- RT-A4 also killed by `PURGE_RETRY_FINGERPRINT = [MESSAGE, 'terminal']` (both constants made
  equal); RT-A2 killed by the same mutant.
- RT-A1 also killed by deleting the `fingerprint` key.
- RT-A6 **is** killed by the opposite-direction mutation: respelling
  `PURGE_TERMINAL_FINGERPRINT`'s second member to `'terminated'` in `PurgeWorker.ts:46` turns
  it red. The pin is real in the code→doc direction and absent in the doc→code direction —
  that asymmetry is finding RT16-02.
- RT-A7's narrowing mutant leaves RT-A8 **green**, which reproduces the exact #612 defect the
  widened scan closes. The widening is load-bearing.

### Arbiter confirmation for the survivor (RT-A6)

The mutant rewrites rule 16's table row so the configured Sentry rule would filter on
`terminal equals false` at level `warning` and group on
`[account_offboarding_purge_failed, retry]` — i.e. it routes the retry issue and is
permanently silent for the terminal one, which is precisely the RT-08 failure this change
exists to close. That is not an equivalent mutation: it inverts the rule's meaning. Nor is it
on a branch the test never executes — the test reads the whole file at
`PurgeWorker.test.ts:850` and asserts on it. It survives because
`expect(runbook).toContain('[account_offboarding_purge_failed, terminal]')` is a file-wide
substring check and the identical string also occurs at `beta-launch-alerting.md:364` in the
§1 checklist bullet, so the assertion is satisfied by the prose regardless of what the rule
row says. Confirmed P0.

## 2. Fragile assertions (Duty 2)

- `PurgeWorker.test.ts:852-856` — three whole-file `toContain` calls standing in for "the
  runbook row and the worker agree". See RT16-02.
- `ingest.test.ts:146` — `expect(laneSourceFiles()).toContain('…/purge-stages.ts')` is an
  absence-of-gap proxy: it proves one known holder is inside the scan, not that the scan
  covers every holder. Recorded as RT16-07 (P2); the wider shape is inherited from
  `batch-builder.test.ts:841` and is the repo's existing convention.
- No exact rendered-output string counts and no order assertions without an ordering contract
  were found in the changed tests. `PurgeWorker.test.ts:810` (`toHaveLength(2)`) counts two
  deliberate invocations and `:813` guards the vacuous-equality case explicitly — sound.

## 3. Docs vs reality (Duty 3)

`prevalidate-plan.py` run against both changed docs. `docs/runbooks/beta-launch-alerting.md`
→ **PASS** (0 unresolved citations). `.claude/reference/arch-review-log.md` → 13 issues,
**all** in pre-existing historical entries (`csv-ingest/failed-hook.ts:94`, `CONTEXT.md:75`,
`BusinessDetailClient.tsx:33`, four unresolvable commit ids, …). None is in the new
2026-09-21 paragraph, which carries no `path:line` citations. Not a finding on this branch.

Every factual claim in the new prose was re-resolved by hand against HEAD:

| Claim | Verdict |
|---|---|
| fingerprint `[…, terminal]`, level `error`, tags `subsystem:account_offboarding` / `step:purge` / `terminal:true` | TRUE — `PurgeWorker.ts:156-163` |
| `alertPurgeFailure` is one function called from both failure sites | TRUE — `PurgeWorker.ts:79` (validation), `:140` (stage); no other emitter in the lane |
| offboarding lands `status='failed'`, `failed_step='purge'`, `last_error` scrubbed | TRUE — `purge-stages.ts:1238-1248` |
| "nothing retries it" | TRUE (and see RT16-01) |
| terminal branch RETURNS, so BullMQ emits no `failed` event and `attachJobFailureSink` never fires | TRUE — `PurgeWorker.ts:146-148`; the sink is attached to every worker at `worker/index.ts:572` |
| rule 11 filters `subsystem:worker_job` and matches `captureException` | TRUE but incomplete — RT16-08 |
| `markOutboxFailed` leaves `job_outbox.status='failed'`; `checkFailedOutboxByTopic` reports `outbox_failed:account_offboarding_purge` with `subsystem:health_alert` | TRUE — `checks.ts:115-135`, `emit.ts:14`, topic literal `queue-names.ts:59` |
| the topic list is open since #1378 | TRUE — `checks.ts:120-126` has no allowlist |
| threshold/window env names `HEALTH_ALERT_FAILED_THRESHOLD` / `_WINDOW_S` | TRUE — `worker.ts:144-145`; defaults `0` / `3600`, and the filter is `count > threshold`, so a single failure does fire |
| "rule 1's own box is still unchecked" | TRUE — `beta-launch-alerting.md:56` is an unchecked box |
| rule 16 is the next free rule number | TRUE — highest existing is rule 15 (`:522`) |
| integration `443670`, every-event + 60-min throttle | TRUE — matches rules 12/13/15 verbatim (`:465`, `:475`, `:531`) |
| `LOCK_LANE_ROOTS = ['src/lib','worker']` at `batch-builder.test.ts:841` | TRUE, byte-identical width |
| purge-stages comment would trip the widened guard unless reworded | TRUE — the `LOCK_KEY_CONSTRUCTION` regex matches the quote-terminated prefix form |
| **"a re-run resumes rather than double-destroys; re-drive it only after the underlying cause is fixed"** | **FALSE** — RT16-01 |
| **ledger: "the failed outbox row rides rule 1 as an aggregate count"** | **misleading** — RT16-03 |

## 4. Missed siblings (Duty 4)

Pattern searched: every `Sentry.captureMessage(` call site under `worker/` and `src/lib/`
(31 sites enumerated, tests and mocks excluded), narrowed to handlers whose terminal branch
alerts with a **constant** message, sets **no** fingerprint, and then `markOutboxFailed` +
`return` without throwing — the RT-08 shape.

Two exact siblings, both in the same lane, both untouched by this change:

- `worker/jobs/account-offboarding/TeardownWorker.ts:333-351` (`alertTeardownFailure`, message
  `account_offboarding_teardown_failed`, `level: terminal ? 'error' : 'warning'`, no
  fingerprint). Terminal branches at `:88-93` and `:123-129` return after `markOutboxFailed`.
  → RT16-04.
- `worker/jobs/account-offboarding/BillingScheduleWorker.ts:159-177`
  (`alertBillingScheduleFailure`, message `account_offboarding_billing_schedule_failed`).
  Terminal branches at `:69-74` and `:129-135`. → RT16-05.

Exclusions recorded: sites whose message is interpolated and therefore already split by
Sentry's default grouping (`subscription-updated.ts:163`, `cost-reconcile.ts:59`,
`circuit-breaker.ts:197`, `generate-draft.ts:77`, `health-alert/emit.ts:12`); sites that throw
rather than return; and `src/lib/refusals/write.ts`, whose constants are already exported and
doc-pinned. Not fixed here — reported for follow-up, per the boundary.

## 5. Operational completeness (Duty 5)

All six facets of rule 16 compared statically against the emitted signal. Signal identity,
filter, level, grouping and destination match the code. The threshold/cadence facet
(`Every event, action throttle 60 minutes per issue`) follows the established precedent and
correctly avoids the first-seen trap the rule's own prose diagnoses.

Two gaps:

- The **destination action** facet is wrong in substance — RT16-01.
- `handleAccountOffboardingPurge`'s `offboarding not found` terminal path
  (`PurgeWorker.ts:66-69`) raises **no** Sentry alert at all: it marks the outbox failed and
  returns. It is covered only by rule 1's aggregate count, which is unconfigured.
  Pre-existing, not added by this diff → RT16-06 (P2).

## 6. Findings

| id | sev | at | finding | disposition |
|---|---|---|---|---|
| RT16-01 | P0 | `docs/runbooks/beta-launch-alerting.md:597` | Rule 16's operator action prescribes a re-drive that no code path can perform | open |
| RT16-02 | P0 | `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts:852` | The doc pin pins the FILE, not the rule row: rule 16's fingerprint, tag filter and level can all be inverted and the test stays green | open |
| RT16-03 | P1 | `.claude/reference/arch-review-log.md:3` | Ledger asserts present-tense rule-1 coverage for a rule that is not configured and whose trigger is first-seen | open |
| RT16-04 | P1 | `worker/jobs/account-offboarding/TeardownWorker.ts:338` | Sibling RT-08 shape, unfixed: constant un-fingerprinted alert on a returning terminal branch | open |
| RT16-05 | P1 | `worker/jobs/account-offboarding/BillingScheduleWorker.ts:164` | Same sibling shape in the billing-schedule offboarding worker | open |
| RT16-06 | P2 | `worker/jobs/account-offboarding/PurgeWorker.ts:66` | Terminal `account_offboarding_not_found` path raises no Sentry signal at all | open |
| RT16-07 | P2 | `src/lib/solicitation/__tests__/ingest.test.ts:146` | The new #612 guard is an absence-of-gap proxy on one hard-coded path | open |
| RT16-08 | P2 | `docs/runbooks/beta-launch-alerting.md:593` | "rule 11's `subsystem:worker_job` filter" reasoning is narrowly true but incomplete | open |

### RT16-01 — P0 — the documented operator remediation cannot be performed

`beta-launch-alerting.md:597` reads: *"The purge is idempotent and strictly ordered with the
Stripe Customer redaction first, so a re-run resumes rather than double-destroys; re-drive it
only after the underlying cause is fixed, and never by hand-editing `terminal_at` or the
outbox row."*

Re-resolved against HEAD:

1. `markPurgeTerminalFailure` (`purge-stages.ts:1238-1248`) writes `status='failed'`,
   `failed_step='purge'`. It does **not** set `terminal_at`.
2. `validatePurgeableOffboarding` (`purge-stages.ts:92-94`) rejects every status other than
   `'purge_scheduled'`, returning `account_offboarding_status_not_purgeable:failed`. So
   re-enqueuing the outbox row does not resume the purge — it re-enters validation, fails
   non-terminally on attempt 1, burns its retries and terminalizes again.
3. `AccountOffboardingPurgePoller` (`:103`, `:155`) only ever selects
   `status = 'purge_scheduled'`.
4. The **only** writer that can return a row to `'purge_scheduled'` is
   `applyProviderDisposition`, and `shouldTransitionToPurgeScheduled`
   (`src/lib/account-offboarding/provider-disposition.ts:281-282`) refuses unless
   `row.failed_step === 'teardown'`. A purge-stage failure writes `'purge'`.
   `src/app/api/admin/offboardings/[offboardingId]/provider-disposition/route.ts` is the only
   admin write route on an offboarding; there is no retry action.

There is therefore **no mechanism, automatic or operator-facing, to re-drive a terminally
failed purge**. The sentence also forbids the two levers it names while naming no working one,
and the `terminal_at` half describes a field this path never writes. On a page whose own next
sentence says the account still holds live PII, this is a false claim an operator would act on
mid-incident. The honest row either documents the exact state change that unblocks a re-drive,
or says plainly that a terminal purge failure is currently unrecoverable without a manual DB
edit.

### RT16-02 — P0 — the runbook pin is one-directional

Measured, not argued. `PurgeWorker.test.ts:852-856` asserts three whole-file `toContain`s.
Mutating `PURGE_TERMINAL_FINGERPRINT`'s member to `'terminated'` turns the test red (code→doc
direction works). Mutating rule 16's row at `beta-launch-alerting.md:589` so the rule filters
`terminal equals false` at level `warning` and groups on
`[account_offboarding_purge_failed, retry]` leaves the test **green**, because the string it
looks for still occurs at `:364` in the §1 checklist prose. The intake's invariant — *"The
fingerprint values in the runbook row are byte-identical to the constants the worker sends. A
test pins them"* — is not enforced. Behavioural replacement: extract the rule-16 table row
(match the line containing the rule name) and assert the fingerprint, the `terminal` tag value
and the level **within that row**, so the assertion is about the rule and not about the file.

### RT16-03 — P1 — the ledger overclaims rule-1 coverage

`.claude/reference/arch-review-log.md:3`: *"`checkFailedOutboxByTopic` has an open topic list,
so the failed outbox row rides rule 1 as an aggregate count"*, used to argue the ticket's
premise was "already half-closed". Rule 1 (`health-alert → discord`) is **unconfigured** — its
§1 box at `beta-launch-alerting.md:56` is unchecked — so nothing is delivered today. Its
trigger is also *issue is first seen* (`:449`), and the emitted title embeds the count
(`checks.ts:132`), so a second failure at the same count is not a new issue and does not
re-fire — the same first-seen trap rule 16's own prose diagnoses. The runbook self-corrects in
the same sentence ("rule 1's own box is still unchecked"); the ledger, which is the durable
layer, does not.

### RT16-04 / RT16-05 — P1 — two unfixed RT-08 siblings

Reported for follow-up only; not in this change's scope and not fixed here.
`alertTeardownFailure` and `alertBillingScheduleFailure` are byte-for-byte the same shape
`alertPurgeFailure` had before this change: one constant message, a
`terminal ? 'error' : 'warning'` level, no fingerprint, and a terminal branch that
`markOutboxFailed`s and returns. Each therefore collapses its retry warnings and its terminal
error into one Sentry issue, and a first-seen rule on either can only fire on an early retry.
Both are on the `delete_data` / `cancel_only` offboarding lane, so both are deletion- or
billing-obligation signals.

### RT16-06 — P2 — an unalerted terminal path

`PurgeWorker.ts:66-69`: a missing offboarding row marks the outbox failed with
`account_offboarding_not_found` and returns, raising no Sentry event. The same shape exists at
`TeardownWorker.ts:76` and `BillingScheduleWorker.ts:57`. Pre-existing; recorded because rule
16 now claims to be the page for a terminal purge failure and this terminal path is outside it.

### RT16-07 — P2 — the #612 guard is a proxy

`ingest.test.ts:146` asserts one hard-coded path is inside the scanned set. A future holder of
the `csv_ingest` lock outside `src/lib` or `worker` would leave both the new test and the
single-owner assertion green. Inherited from `batch-builder.test.ts:841`; the ledger's own
"Next pass" line already flags the shared-helper consolidation.

### RT16-08 — P2 — incomplete reasoning in the rule-16 prose

`beta-launch-alerting.md:593` explains that rule 11 cannot cover this signal because its
`subsystem:worker_job` filter matches `captureException`, not this handler's `captureMessage`.
True, but rule 11 (`:459`) also filters `queue equals agent_turn`, so it could never match the
offboarding queue for any event type. The stated reason is the weaker of the two.

## Authorizations

None. No finding on this run is accepted-risk.

## Restoration

`mutation-runner.mjs finalize` run after each measurement and again at the end: every
journaled mutation `restored`, `dotenv.open: false`, all 23 supervisor process groups reaped.
`git status --porcelain --untracked-files=no` is empty; `git status --porcelain` shows only
this run's two report artifacts.
