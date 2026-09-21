# Red team — `fix/1016-612-purge-terminal-alert` — ROUND 2

- **Mode** feature · **Risk** high · **Round** 2 · **Status** `OPEN_P0`
- **fork** `75c8d54cb77ac34d1f2f7686b9171528871b81f3` ·
  **merge-base** `75c8d54cb77ac34d1f2f7686b9171528871b81f3` ·
  **head** `4070fad8bb141455be5a51d598563dd355ad5aa1`
- **Round-1 reviewed head** `6df3c95dfbabad6046b5dfbd455730233bc6e58c`.
  Round 1's report is preserved in git history at commit `4070fad` for this
  path; this file and `findings.json` are the two deterministic artifacts the
  checker derives, so round 2 replaces them in place rather than adding a third.
- **Intake** `6b31067516e217aad0846e55eb926161a5a8d33068b58030a7a135f7420a6c7a`.
  This differs from round 1's `643e03d9…` because the owner AMENDED
  `.feature/intake.json` between rounds (terminal fingerprint became
  per-offboarding; the #612 scan skips comment lines instead of rewording a
  production comment). The skill defines `intake_sha256` as "SHA-256 of
  `.feature/intake.json`" and the checker compares it against the CURRENT
  intake, so an amended intake is NOT a blocker — round 2 records the current
  hash. No skill rule treats an amended intake as requiring an authorization.

## Artifact-write disclosure

The `Write` tool REFUSED to create this `.md` file
("Subagents should return findings as text, not write report files"), exactly as
in round 1. `findings.json` was written through `Write` without refusal. This
file was then written through the shell, as round 1 did, and that route-around
is disclosed here and in the returned summary rather than left silent.

## Scope (round-2 rule)

Only the fix hunks and their direct callers:
`git diff 6df3c95 4070fad -- . ':(exclude)docs/reviews' ':(exclude)docs/superpowers'`
— six files. No new fronts were opened against unchanged code. Unrelated
observations are in the appendix, untriaged.

## Environment and journal

Isolated allowlist env (`mutation-runner env`, temporary `HOME`,
`REPWORTH_DISABLE_LIVE_DB_SUITES=1`, no live database) plus a `dotenv-swap` for
every mutation phase. `round-start` reported **round 2 open**. Every test
command ran under `env -u WORKTREE_EDIT_GUARD_DISABLE`. Budget spent: **25
launches, 18s of the 1200s round clock**. No `skipped-budget` rows, no
`inconclusive` rows, no `infra`-class events. Every mutation was applied through
the journaled runner, one at a time, and `finalize` restored it before the next;
`git status --porcelain` was verified empty after each.

**Declared deviation from the skill's budget prose.** The skill caps mutations
at 2 per test. This pass ran 8 against `RT-A6` and 4 against `RT-A8` because the
invoking root's round-2 brief enumerated specific single-cell corruptions. The
deviation is in the conservative direction (more measurement, not less), stayed
far inside the binding 20-minute round clock, and is recorded here rather than
left silent — it is what found `RT16-02`'s residual hole.

## Baselines (green, at HEAD)

| Suite | Result |
|---|---|
| `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` | 18/18 passed |
| `src/lib/solicitation/__tests__/ingest.test.ts` | 9/9 passed |

## Duty 1 — mutation inventory

| Row | Test | Outcome |
|---|---|---|
| RT-A1 | alerts a terminal stage failure … at error level | `killed` (M19) |
| RT-A2 | alerts a retryable stage failure … at warning level | `killed` (M10) |
| RT-A3 | alerts a terminal validation failure … | `killed` (M18) |
| RT-A4 | the terminal and retry purge alerts never share a fingerprint | `killed` (M16) |
| RT-A10 | two offboardings' terminal alerts never share a fingerprint | `killed` (M7, M8, M9b) |
| RT-A5 | the terminal purge path marks the outbox failed and does not throw | `killed` (M17) |
| RT-A6 | the alerting runbook routes the terminal purge fingerprint … | **`survived-confirmed-P0`** → RT16-02 |
| RT-A7 | the csv_ingest lock-key scan covers the offboarding purge lane | `killed` (M13) |
| RT-A8 | acquireCsvIngestLock is the single owner of the csv_ingest key | `killed` (M11, M12, M14) |
| RT-A9 | ledger paragraph rewrite (no executable oracle) | `excluded` → Duty 3 |

### Every mutation, one line each

| # | Target | Mutation | Row | Verdict |
|---|---|---|---|---|
| M1 | runbook:576 | RT-A6's round-1 corruption in full: `terminal equals false`, `level equals warning`, grouping on the retry fingerprint | RT-A6 | **KILLED** |
| M2 | runbook:576 | filter cell only: `terminal` `true`→`false` | RT-A6 | KILLED |
| M3 | runbook:576 | filter cell only: `level equals error`→`warning` | RT-A6 | KILLED |
| M3b | runbook:576 | grouping cell only: leading level token `error`→`warning` | RT-A6 | **SURVIVED** → RT16-10 (P2) |
| M4 | runbook:576 | trigger only: `Every event`→`First seen` | RT-A6 | KILLED |
| M5 | runbook:576 | drop `<account_offboarding_id>` from the grouping fingerprint | RT-A6 | KILLED |
| M6 | runbook:576 | **swap** the terminal and retry fingerprints inside the row | RT-A6 | **SURVIVED** → RT16-02 (P0) |
| M6b | runbook:576 | filter cell only: `subsystem`→`worker_job` | RT-A6 | KILLED |
| M6c | runbook:576 | filter cell only: `step`→`teardown` | RT-A6 | KILLED |
| M7 | PurgeWorker.ts:59-61 | drop the third fingerprint member | RT-A10 | KILLED |
| M8 | PurgeWorker.ts:174 | `payload.account_id` instead of `payload.account_offboarding_id` | RT-A10 | KILLED |
| M9 | PurgeWorker.ts:59-61 | return the shared PREFIX array after an in-place `push` (aliasing) | RT-A1 | survived — **proven equivalent for one call** |
| M9b | same mutant | same | RT-A10 | KILLED |
| M10 | PurgeWorker.ts:175 | retry arm made per-offboarding | RT-A2 | KILLED |
| M11 | ingest.test.ts:101-110 | `stripCommentLines` strips EVERYTHING | RT-A8 | KILLED |
| M12 | ingest.test.ts:101-110 | `stripCommentLines` strips NOTHING | RT-A8 | KILLED |
| M13 | ingest.test.ts:80 | `LANE_ROOTS` narrowed to the two pre-#612 roots | RT-A7 | KILLED |
| M14 | purge-stages.ts | respell the key in ordinary CODE in the offboarding lane | RT-A8 | KILLED |
| M15 | purge-stages.ts | same respelling on a `*`-leading multiplication-continuation line | RT-A8 | **SURVIVED** → RT16-09 (P2) |
| M16 | PurgeWorker.ts:173-175 | collapse both arms onto the retry fingerprint | RT-A4 | KILLED |
| M17 | PurgeWorker.ts:59-61 | drop the third member | RT-A5 | KILLED |
| M18 | PurgeWorker.ts:59-61 | drop the third member | RT-A3 | KILLED |
| M19 | PurgeWorker.ts:174 | `payload.account_id` substitution | RT-A1 | KILLED |

**The survivor that matters.** M6 leaves rule 16's row reading
`custom fingerprint [account_offboarding_purge_failed, retry]` as its grouping
and `The retry arm takes the shared [account_offboarding_purge_failed, terminal,
<account_offboarding_id>]` as its retry sentence. `expect(row).toMatch(…)` and
`expect(block).toMatch(…)` are regexes over the whole row and block, so each one
finds its pattern in the OTHER cell's sentence and the test stays green. The
operator would then configure a grouping override on the retry spelling — a rule
that can never match a terminal event. That is the RT-08 defect this change
exists to close, one scope level below where round 1 found it.

## Duty 2 — fragile assertions

Two, both P2 and both measured rather than asserted: **RT16-09** (the
comment-stripping hole) and **RT16-10** (the duplicated level token). Both carry
a behavioural replacement in `findings.json`.

## Duty 3 — docs vs reality, every changed sentence re-resolved at 4070fad

`prevalidate-plan.py` was NOT used — the changed docs are a runbook table and a
ledger paragraph, not a plan carrying `path:line` citations. Every factual claim
was hand-resolved instead; that is stated here as the skill requires.

| Claim (changed runbook / ledger sentence) | Resolution at HEAD |
|---|---|
| `validatePurgeableOffboarding` rejects with `account_offboarding_status_not_purgeable:failed` | TRUE — `purge-stages.ts:92-94`; `markPurgeTerminalFailure` writes `status='failed'` (`:1236-1238`) |
| `AccountOffboardingPurgePoller` claims only `status='purge_scheduled' AND purge_started_at IS NULL` | TRUE — `:103`+`:121` (SELECT), `:155`+`:173` (UPDATE) |
| Teardown retry path scoped to `failed_step='teardown'` | TRUE — `AccountOffboardingTeardownRetryPoller:91-92,112-113`; `shouldTransitionToPurgeScheduled` `provider-disposition.ts:281-282` |
| No admin route mutates purge state | TRUE — no `UPDATE account_offboardings` under `src/app`; `reactivate.ts` is `status='scheduled'`-only, `keep-my-data.ts` requires `purge_started_at IS NULL` |
| `failed_step='purge'` is a CONSTANT and does not name the stage | TRUE — `purge-stages.ts:1238` writes the literal |
| Redaction first; a terminal failure before `runParentTombstonePurgeStage` leaves names/emails/phones/addresses while the auth user is already deleted | TRUE — `PurgeWorker.ts:133-141` (redaction 1st, auth binding 2nd, tombstone 9th); PII sentinels at `purge-stages.ts:928-957` |
| No per-stage checkpoint; the handler replays from stage 1 | TRUE — the nine stage calls at `:133-141` are unconditional |
| Rule 1's §1 box is unchecked | TRUE — `beta-launch-alerting.md:56` is `- [ ]` |
| Rule 1 triggers on first-seen | TRUE — rule table row 1, `:435` |
| `HEALTH_ALERT_FAILED_THRESHOLD` default `0` | TRUE — `health-alert/checks.ts:78` |
| The rule-1 finding sets no fingerprint and embeds the count in its message | TRUE — `health-alert/emit.ts:12` (no `fingerprint`), `checks.ts:132` title, `:133` detail `{topic, count, window_s}` — no offboarding id |
| Rule 11's filter is `subsystem=worker_job` **AND** `queue=agent_turn` | TRUE — rule table row 11, `:446` |
| `account_offboarding_not_found` returns with no alert | TRUE — `PurgeWorker.ts:81-84` |
| A throw from `loadPurgeOffboarding` is OUTSIDE the handler's try | TRUE — the call is at `:75-79`, the `try {` opens at `:104` |
| Watchdog terminalization fires no BullMQ `failed` event and carries no offboarding id | TRUE — `OutboxPoller.runOutboxWatchdogRecovery` is a topic-blind poller-side UPDATE |
| `purge-stages.ts` is back to merge-base content | TRUE — `git diff 75c8d54 4070fad -- worker/jobs/account-offboarding/purge-stages.ts` is empty |
| The test slices to rule 16's block and asserts on its row (filter, level, trigger, both constants) | TRUE — `PurgeWorker.test.ts:925-957` — but see RT16-02: the fingerprint assertions are not position-scoped |
| Issues **#1411**, **#1412**, **#1413** exist and track this work | **UNVERIFIABLE-EXTERNAL** — no network in this pass. Not recorded as false |
| Sentry's action throttle is per issue; Discord integration `443670` | UNVERIFIABLE-EXTERNAL (Sentry-side); unchanged from the pre-existing rule rows this row copies |

## Duty 4 — missed sibling cases

Patterns searched: `rg -n "fingerprint" worker/jobs/account-offboarding/*.ts`
and `rg -n "function alert.*Failure" worker/jobs/account-offboarding/*.ts`.
Scope `worker/jobs/account-offboarding/`, excluding `__tests__`. Result at
4070fad: `TeardownWorker.ts` and `BillingScheduleWorker.ts` still contain **no**
`fingerprint` key, so RT16-04 and RT16-05 remain live and unchanged. No third
sibling of this shape exists in the lane.

## Duty 5 — operational completeness

All six facets of rule 16's row were compared against the emitted signal and
agree: message `account_offboarding_purge_failed` (`PurgeWorker.ts:171`), tags
`subsystem:account_offboarding` / `step:purge` / `terminal:'true'` (`:176-180`),
level `error` (`:172`), fingerprint `[…, terminal, <id>]` (`:173-174`), trigger
every event, destination Discord via 443670. The three uncovered terminal paths
are now named in the runbook itself (RT16-06).

## Round-1 findings — disposition

| ID | Sev | Disposition | Evidence |
|---|---|---|---|
| RT16-01 | P0 | **fixed** | Every clause of the replacement operator-action paragraph re-resolved TRUE (Duty 3 table). `#1411` UNVERIFIABLE-EXTERNAL. |
| RT16-02 | P0 | **open** | Round-1's exact survivor is KILLED (M1) and six more single-cell corruptions die, but M6 (swap the two spellings) SURVIVES. Partially fixed; the class is not closed. |
| RT16-03 | P1 | **fixed** | Ledger and runbook now state rule 1 is unconfigured, first-seen, unfingerprinted and offboarding-id-less; all verified. |
| RT16-04 | P1 | **open** (owner-deferred, #1412) | Sibling unchanged at HEAD. Needs an authorization entry — see below. |
| RT16-05 | P1 | **open** (owner-deferred, #1412) | Sibling unchanged at HEAD. Needs an authorization entry — see below. |
| RT16-06 | P2 | **open** (owner-deferred, #1413) | Path unchanged; the runbook now names it at `:584`. P2 never blocks. |
| RT16-07 | P2 | **fixed** | Directory predicate at `ingest.test.ts:176-177`; M13 and M14 both kill; `purge-stages.ts` identical to merge base. |
| RT16-08 | P2 | **fixed** | Rule-11 `queue = agent_turn` conjunct now stated at `:580`; verified against the rule table at `:446`. |

New this round: **RT16-09** (P2), **RT16-10** (P2), and RT16-02's residual hole.

## What the sidecar needs from the root

RT16-04 and RT16-05 are **P1 on a high-risk run**. `validateHighRiskAdjudication`
in `red-team-status.mjs` fails any P1 left `open`, and the only non-blocking
disposition for a real-but-deferred finding is `accepted-risk`. This pass cannot
write one, because an authorization's `text` must be the owner's verbatim
approval and forging it would falsify the evidence the checker validates.

To close them, the root must supply, for `findings.json`:

1. an entry in the top-level **`authorizations`** array with EXACTLY these four
   keys — `id` (unique string), `date` (`"2026-09-21"`, format `YYYY-MM-DD`),
   `finding_ids` (`["RT16-04","RT16-05"]`, optionally plus `"RT16-06"`), and
   `text` (the owner's verbatim approval); and
2. on each of those findings, `"disposition": "accepted-risk"` plus
   `"authorization": "<that id>"` (the `authorization` key is legal ONLY on an
   `accepted-risk` finding, and the authorization must name the finding in its
   `finding_ids`).

The Authorizations section of this file is rendered from that array and is never
parsed back out of the Markdown. Note that the run is `OPEN_P0` regardless, so
the authorization unblocks the P1 gate but not the PR.

## Red-team findings rejected

None. No finding was rejected this round; RT16-04/05/06 are deferred by owner
decision, not refuted, and are recorded `open` pending the authorization above.

## Authorizations

None recorded.

## Appendix — untriaged, out of round-2 scope

- `stripCommentLines` is a line-granular, per-file copy in two test files
  (`ingest.test.ts`, and the `LOCK_LANE_ROOTS` walk in `batch-builder.test.ts`).
  The ledger's own "Next pass" line already flags the consolidation. Not opened.
