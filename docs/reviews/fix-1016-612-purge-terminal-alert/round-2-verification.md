# Round 2 — scoped verification, `fix/1016-612-purge-terminal-alert`

READ-ONLY. All evidence read from committed objects only
(`git show 4070fad…:<path>`, `git diff 6df3c95d 4070fad8`); the working tree was
never read (a red team is mutating it).

- ROUND1_SHA `6df3c95dfbabad6046b5dfbd455730233bc6e58c`
- FIX_HEAD `4070fad8bb141455be5a51d598563dd355ad5aa1`
- MERGE_BASE `75c8d54cb77ac34d1f2f7686b9171528871b81f3`

Fix diff (tests excluded from the count, `docs/reviews` excluded entirely):
8 files — `arch-review-log.md`, `beta-launch-alerting.md`, the deviations file,
the intake, `ingest.test.ts`, `PurgeWorker.ts`, `PurgeWorker.test.ts`,
`purge-stages.ts` (revert to merge-base).

---

## 1. ACCEPTED findings — addressed?

| Finding | Verdict | Evidence at FIX_HEAD |
|---|---|---|
| RT16-01 · Spec F1 — runbook prescribes a re-drive no code path can perform | **ADDRESSED** | `docs/runbooks/beta-launch-alerting.md:588` — the paragraph is now titled "**Operator action — there is no supported re-run.**" and enumerates the four blockers with correct code references (verified individually, §3 R25–R28). The re-drive instruction, the "re-run resumes" claim and the `terminal_at` warning are all gone. |
| RT16-02 · Codex A4 · Std S2 · Spec F2 — the doc pin pins the FILE, not the rule-16 row | **ADDRESSED** | `PurgeWorker.test.ts:288-294` (`rule16Block`), `:296-302` (`rule16TableRow`), `:937-958`. Filter, level (filter cell), grouping and trigger are asserted on the ROW; the retry fingerprint on the BLOCK. The RT-A6 survivor is structurally excluded: the slice starts at `**Rule 16` (runbook:572) and §1's bullet is at :362, so it can never be in the slice even in the degenerate EOF case. See §2 for what a single-cell corruption can still slip through. |
| Codex A1 — one shared terminal issue; per-issue throttle suppresses a second account | **ADDRESSED** | `PurgeWorker.ts:57` prefix, `:60-62` `purgeTerminalFingerprint()`, `:173-174` terminal arm takes `payload.account_offboarding_id`. Fresh array per call (spread, no aliasing of the exported `as const` prefix). Retry arm unchanged (`:175` `[...PURGE_RETRY_FINGERPRINT]`). One emitter (`alertPurgeFailure`, the file's only `captureMessage`, called at `:94` and `:155`). Terminal path still returns without throwing (`:99-101`, `:161-163`). Tests: `:921`, `:885` (implicit), `:921`, and the new two-offboarding test `:861-886`. |
| Std S1 — `PURGE_RETRY_FINGERPRINT` exported with no importer; docblock/ledger overstate | **ADDRESSED** | Both constants now have importers: `PurgeWorker.test.ts:268-269`, used at `:950` and `:954`. `git grep` at FIX_HEAD finds no exported fingerprint symbol without an importer. Docblock rewritten (`PurgeWorker.ts:36-56`) and its claim ("reads both of them back out of that rule's own block") is accurate. The arch-review-log line was rewritten too — but its new wording introduces a different false claim (§3 E2). |
| Std S4 — two live owners for three facts (§1 bullet and the rule-16 block) | **ADDRESSED** | `beta-launch-alerting.md:362-371`: the bullet is cut from 24 lines to identity + pointer ("Rule 16 below owns the exact configuration, the grouping rationale, the paths this signal does NOT cover and the response procedure"). Residual: the clause "and nothing retries it" (:370) is a one-clause restatement of the fact the block now owns (":588"). Acceptable as identity, worth a note. |
| Spec F3 — "a re-run resumes" / "`failed_step` says which stage stopped" are false | **ADDRESSED** | `beta-launch-alerting.md:588` now says "There is no per-stage checkpoint — the handler replays from stage 1" (true: `PurgeWorker.ts:104-146`) and "`failed_step='purge'`, which is a CONSTANT and does not name the stage, plus `last_error` … the only field that may name the stage" (true: `purge-stages.ts:1238-1239`). The inert `terminal_at` warning is deleted. |
| Spec F5 · RT16-03 — "rides rule 1" overstates it | **ADDRESSED** | `beta-launch-alerting.md:582` rewritten to "**What rule 1 would cover, and why it is not watching today**" and states all three correctives — box unchecked (runbook:56), no fingerprint (`health-alert/emit.ts:12-16`), count-bearing message (`health-alert/checks.ts:132`), first-seen trigger (runbook:436). All verified true. |
| RT16-08 — rule-11 reasoning incomplete | **ADDRESSED** | `beta-launch-alerting.md:580`: "rule 11's filter is `subsystem` equals `worker_job` **AND** `queue` equals `agent_turn`". Matches the rule-11 row at runbook:441. |
| Std S3 — assertion subsumed by the next | **ADDRESSED** | The bare `expect(runbook).toContain(PURGE_TERMINAL_FINGERPRINT[0])` is gone; `PurgeWorker.test.ts:937-958` has no subsumed assertion. |
| Std S5 · Std S6 — production comment reworded only to dodge a test regex | **ADDRESSED** | `git diff 75c8d54c 4070fad8 -- worker/jobs/account-offboarding/purge-stages.ts` is **EMPTY** — byte-identical to MERGE_BASE. The scan now strips comment lines (`ingest.test.ts:101-109`); `LOCK_KEY_CONSTRUCTION` at `:94` is unchanged from round 1. |
| Std S7 · RT16-07 — the width test pins one hard-coded filename | **ADDRESSED** | `ingest.test.ts:170-182`. Title "the csv_ingest lock-key scan covers the offboarding purge lane"; assertion is `laneSourceFiles().some(f => f.path.startsWith('worker/jobs/account-offboarding/'))`. It does prove the title: `walkLaneSources` (`:111-120`) recurses `worker/` and a hit under that prefix is only possible if the directory is walked. The absolute→relative→absolute round trip is gone (`:127-138` carries `absolutePath` alongside `path`; `:143` reads from it). Weakening accepted in triage: an exclusion that skipped `purge-stages.ts` specifically would now stay green. |

All eleven ACCEPT rows: **ADDRESSED**. None PARTIALLY, none NOT.

### Specific check (1) — the terminal fingerprint

- Third member is `payload.account_offboarding_id` — `PurgeWorker.ts:174`. It is
  sourced from the job payload, not the loaded row; `loadPurgeOffboarding`
  (`:75-79`) is called with the same id, so they cannot diverge in production.
  The new test at `:861-886` drives two different payload ids against one mocked
  row, which pins payload-sourcing specifically.
- Fresh array per call — `:61` `return [...PURGE_TERMINAL_FINGERPRINT_PREFIX, accountOffboardingId]`.
  The exported `as const` tuple is never mutated or handed out by reference.
  The retry arm likewise spreads (`:175`).
- Retry unchanged — `[PURGE_ALERT_MESSAGE, 'retry']` at `:58`, emitted at `:175`.
- One emitter — `alertPurgeFailure` (`:166-187`) is the only `Sentry.captureMessage`
  in the file; two call sites (`:94` validation, `:155` stage catch).
- No throw on the terminal arm — `:99-101` and `:161-163` both fall through / return.
- No export without an importer — `PURGE_TERMINAL_FINGERPRINT_PREFIX` and
  `PURGE_RETRY_FINGERPRINT` are both imported at `PurgeWorker.test.ts:268-269`
  and both used (`:950`, `:954`). The old `PURGE_TERMINAL_FINGERPRINT` symbol is
  fully renamed — no dangling reference outside the round-1 review reports.

### Specific check (4) — the #612 scan

- `stripCommentLines` (`ingest.test.ts:101-109`) drops exactly the lines whose
  `trimStart()` begins with `//`, `*`, or `/*`. Everything else is kept.
- **Yes, it can drop real CODE.** Any of these are dropped:
  `/* c8 ignore next */ const key = \`csv_ingest_${id}\`;` (leading inline block
  pragma — the most plausible real case), `*/ const key = 'csv_ingest_' + id;`
  (code after a closing `*/` on the same line), a generator method
  `*buildKey() { return \`csv_ingest_${id}\`; }`, and an operator-leading
  arithmetic/continuation line. This is a **false negative the fix introduced**
  into a guard whose only job is to catch a respelling, and the function's own
  docblock (`:98-99`) asserts the opposite bias. See N2.
- `purge-stages.ts` byte-identical to MERGE_BASE: **yes**, `git diff` empty.
- The live positive still survives stripping: `ingest.ts:490`'s construction is
  on a line starting with `await`, so the single-owner assertion
  (`ingest.test.ts:167`) still has its one true hit.
- Directory-prefix assertion proves its locked title — yes (see table row above).

---

## 2. Single-cell corruptions of the rule-16 row that still pass

Read off the regexes at `PurgeWorker.test.ts:941-958` against the row at
`beta-launch-alerting.md:576`:

1. **The grouping cell's configured LEVEL.** The row's "Level and grouping" cell
   opens `` `error`; custom fingerprint … ``. Change it to `` `warning`; custom
   fingerprint … `` and every assertion still passes: `:943`'s
   ``/level\s+equals\s+`error`/`` matches only the FILTER cell's phrase
   "level equals `error`", which is untouched. The operator would configure the
   rule at the wrong level and the pin stays green.
2. **The destination.** "the environment's existing Discord alerts channel via
   integration 443670" → any other integration id, any other channel, or email.
   No assertion touches the fourth cell beyond `/every event/i`.
3. **The throttle.** "action throttle 60 minutes per issue" → "6 minutes",
   "per project", or deleted entirely. Unasserted — and "per issue" is the exact
   property the Codex A1 fix is built on.
4. **The priority caveat.** "Do **not** filter on Sentry priority" → "Do filter
   on Sentry priority". Unasserted.
5. **Negating a filter facet.** The four filter regexes test presence only, so
   inserting "do not" before "filter tag `terminal` equals `true`" passes (the
   `not.toMatch(/`terminal`\s+equals\s+`false`/)` guard does not cover it).
6. **The row's retry fingerprint spelling** — conditionally. `:954` asserts on
   the BLOCK, not the row. Today `[account_offboarding_purge_failed, retry]`
   occurs exactly once in the block (inside the row), so a row corruption fails
   today; the moment that spelling also appears in the surrounding prose, the
   row's copy becomes unpinned.

The slice itself is sound: terminators are `\n**Rule ` (catches a future rule 17)
and `\n## ` (catches any h2). `**Rule 16` occurs exactly once in the file
(runbook:572) and the next `**Rule ` is rule 11 at :590, so the block is 18 lines,
not EOF. Even a degenerate EOF slice cannot re-admit the RT-A6 weakness, because
§1's bullet precedes the slice start. One latent gap: a `### ` heading would not
terminate the slice (`'\n### '` does not contain `'\n## '`).

---

## 3. DOC TRUTH — every sentence the fix added or changed

### `docs/runbooks/beta-launch-alerting.md`

| # | Claim | Verdict | Evidence at FIX_HEAD |
|---|---|---|---|
| R1 | §1 bullet: fingerprint `[…, terminal, <account_offboarding_id>]` at `error`, tags `subsystem:account_offboarding`/`step:purge`/`terminal:true` | TRUE | `PurgeWorker.ts:171-180` |
| R2 | "Emitted by `alertPurgeFailure` … called from both failure sites (validation and stage)" | TRUE | `PurgeWorker.ts:94`, `:155`, `:166` |
| R3 | "the offboarding lands `status='failed'`, `failed_step='purge'` and nothing retries it" | TRUE | `purge-stages.ts:1235-1238` + R25–R28 |
| R4 | "Rule 16 below owns the exact configuration, the grouping rationale, the paths this signal does NOT cover and the response procedure" | TRUE | runbook:572-590 contains all four |
| R5 | row: three-member fingerprint is "the whole grouping: one issue per terminally failed offboarding" | TRUE | `PurgeWorker.ts:60-62`, `:173-174` |
| R6 | row: "the action throttle opposite is per ISSUE, so a single shared terminal issue would suppress a second account's page for the rest of the hour" | UNVERIFIABLE-EXTERNAL | Sentry alert-rule semantics; internally consistent with the row's own "action throttle 60 minutes per issue" |
| R7 | row: "The retry arm takes the shared `[…, retry]` at `warning`, so a retry can never group with a terminal event" | TRUE | `PurgeWorker.ts:58`, `:172`, `:175` |
| R8 | row: "The event carries `account_offboarding_id`, `account_id` and the scrubbed error only" | TRUE | `PurgeWorker.ts:181-185`; scrub at `:93`, `:153` |
| R9 | "Both spellings are exported constants of `PurgeWorker.ts`" | TRUE | `PurgeWorker.ts:57-58` |
| R10 | "`PurgeWorker.test.ts` reads them back out of the table row above" | **FALSE** | the retry spelling is read out of the BLOCK (`PurgeWorker.test.ts:954` `expect(block)`), not the row; only the terminal spelling is row-scoped (`:949-951`) |
| R11 | "renaming either member, or corrupting that row's filter, level, grouping or trigger, turns red rather than silently unmatching the rule" | **FALSE** | the row's configured LEVEL (grouping cell) is unasserted — `:943` matches only the filter-cell phrase; the throttle value/scope and the destination are unasserted too (§2 items 1–3) |
| R12 | "the handler calls `markPurgeTerminalFailure` and `markOutboxFailed` and then RETURNS; it does not throw" | TRUE | `PurgeWorker.ts:99-101`, `:161-163` |
| R13 | "rule 11's filter is `subsystem` equals `worker_job` **AND** `queue` equals `agent_turn`, so it matches neither this handler's `captureMessage` nor any `captureException` from this queue" | TRUE | runbook:441 (rule-11 row); queue name `account_offboarding_purge` at `src/lib/shared/queue-names.ts:59` |
| R14 | "`checkFailedOutboxByTopic` … reports every failed topic above `HEALTH_ALERT_FAILED_THRESHOLD` (default `0`) inside `HEALTH_ALERT_FAILED_WINDOW_S`" | TRUE | `worker/background/pollers/health-alert/checks.ts:77-78`, `:120-134` |
| R15 | "the purge row does produce a `subsystem:health_alert` finding keyed `outbox_failed:account_offboarding_purge`" | TRUE | `checks.ts:130`; `health-alert/emit.ts:14`; `queue-names.ts:59` |
| R16 | "carrying a topic and a count and never the offboarding id" | TRUE | `checks.ts:133` — `detail: { topic, count, window_s }` |
| R17 | "Rule 1's own §1 box is **unchecked** — it is not configured" | TRUE | runbook:56 — `- [ ] **Sentry alert rule → Discord** for issues tagged `subsystem:health_alert`` |
| R18 | "the finding sets no fingerprint" | TRUE | `health-alert/emit.ts:12-16` — level/tags/extra only |
| R19 | "its message embeds the count (`N account_offboarding_purge job(s) exhausted retries…`)" | TRUE | `checks.ts:132` |
| R20 | "rule 1 triggers on **first seen**" | TRUE | runbook:436 |
| R21 | "it opens one issue per distinct count value and is silent for every repeat of a count it has already seen" | UNVERIFIABLE-EXTERNAL | depends on Sentry's default message-based grouping; a sound inference from R18+R19 |
| R22 | "`account_offboarding_not_found` marks the outbox row failed and returns with no alert at all" | TRUE | `PurgeWorker.ts:81-84` |
| R23 | "A throw from `loadPurgeOffboarding` happens OUTSIDE the handler's try, so it surfaces as an `attachJobFailureSink` `captureException`" | TRUE | `PurgeWorker.ts:75-79` vs the `try` at `:104`; sink attached to every queue at `worker/index.ts:572` |
| R24 | "a watchdog terminalization of the `job_outbox` row fires no BullMQ `failed` event and carries no offboarding id" | TRUE | `worker/background/pollers/OutboxPoller.ts:155-171` — a pure `UPDATE … status='failed'` with `last_error = 'Stale …  exceeded max_attempts'`, no capture, no job |
| R25 | "`validatePurgeableOffboarding` rejects the row (`account_offboarding_status_not_purgeable:failed`)" | TRUE | `purge-stages.ts:92-94` — `` `account_offboarding_status_not_purgeable:${row.status}` `` |
| R26 | "`AccountOffboardingPurgePoller` claims only `status='purge_scheduled' AND purge_started_at IS NULL`" | TRUE | `AccountOffboardingPurgePoller.ts:103`, `:121` (and `:155`, `:173`); the real predicate is narrower still, so the necessary condition stated is correct |
| R27 | "the teardown retry path (`AccountOffboardingTeardownRetryPoller`, `shouldTransitionToPurgeScheduled`) is scoped to `failed_step='teardown'`" | TRUE | `AccountOffboardingTeardownRetryPoller.ts:91-92`, `:112-113`; `src/lib/account-offboarding/provider-disposition.ts:282`. Attribution nit: `shouldTransitionToPurgeScheduled` lives in `provider-disposition.ts:277`, reached from the ADMIN route, not from that poller |
| R28 | "and no admin route mutates purge state" | **FALSE as written** (true in the intended scope) | `src/app/api/admin/offboardings/[offboardingId]/provider-disposition/route.ts:48` → `recordProviderDisposition` writes `account_offboardings.status` / `failed_step` / `last_error` (`provider-disposition.ts:182-190`) and can set `status='purge_scheduled'`. It cannot do so for a `failed_step='purge'` row (`:282`), so the load-bearing conclusion holds |
| R29 | "the purge is strictly ordered with the Stripe Customer redaction first" | TRUE | `PurgeWorker.ts:133` is the first stage |
| R30 | "a terminal failure before `runParentTombstonePurgeStage` leaves names, emails, phones and addresses in place while the auth user is already deleted" | TRUE | `PurgeWorker.ts:134` (auth) precedes `:141` (tombstone); confirmed by the in-file rationale at `:116-119` |
| R31 | "There is no per-stage checkpoint — the handler replays from stage 1" | TRUE | `PurgeWorker.ts:104-146` — no resume state read or written |
| R32 | "`failed_step='purge'`, which is a CONSTANT and does not name the stage" | TRUE | `purge-stages.ts:1238` |
| R33 | "`last_error` (already scrubbed), the only field that may name the stage that stopped" | TRUE | `purge-stages.ts:1239`; scrub at `PurgeWorker.ts:153` |
| R34 | "#1411" (recovery mechanism) | UNVERIFIABLE-EXTERNAL | GitHub, not checked (no external calls) |
| R35 | "#1412" (sibling workers) | UNVERIFIABLE-EXTERNAL | as above |
| R36 | "#1413" (uncovered paths) | UNVERIFIABLE-EXTERNAL | as above |

**Runbook: 36 claims — 28 TRUE, 3 FALSE (R10, R11, R28), 5 UNVERIFIABLE-EXTERNAL.**

### `.claude/reference/arch-review-log.md`, 2026-09-21 #1016 paragraph

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| E1 | "The retry arm now takes the shared `[…, retry]` and the terminal arm `[…, terminal, <account_offboarding_id>]` — one issue per terminally failed offboarding" | TRUE | `PurgeWorker.ts:57-62`, `:172-175` |
| E2 | "the test slices the file to rule 16's BLOCK and asserts on its table ROW — filter, level, trigger and BOTH exported constants" | **FALSE** | the retry constant is asserted on the BLOCK (`PurgeWorker.test.ts:954`), not the row; and "level" is only the filter-cell phrase, not the row's configured level (§2 item 1) |
| E3 | "a file-wide substring pin stayed green with that row corrupted to `terminal equals false` at `warning` on the retry fingerprint (red-team RT-A6)" | TRUE | `docs/reviews/red-team/fix-1016-612-purge-terminal-alert-e8cee7/findings.json:55` |
| E4 | "The terminal path still returns without a throw" | TRUE | `PurgeWorker.ts:99-101`, `:161-163` |
| E5 | "rule 1 is **unconfigured**, triggers on first-seen over an unfingerprinted count-bearing message, and the finding never carries the offboarding id — so it would fire once per distinct count, not per failure" | TRUE (final clause UNVERIFIABLE-EXTERNAL) | runbook:56, runbook:436, `emit.ts:12-16`, `checks.ts:132-133` |
| E6 | "The runbook now also states plainly that no re-drive mechanism exists … (#1411) and names the paths rule 16 does not cover (#1413)" | TRUE (issue numbers UNVERIFIABLE-EXTERNAL) | runbook:584, :588 |
| E7 | "#612: … skips COMMENT lines rather than having production prose reworded around it — so `purge-stages.ts` leaves the diff entirely" | TRUE | `git diff 75c8d54c 4070fad8 -- worker/jobs/account-offboarding/purge-stages.ts` is empty; `ingest.test.ts:101-109` |
| E8 | "widens to `src/lib` + `worker`, the same width as the `solicitation_batch` scan" | TRUE | `ingest.test.ts:80` vs `batch-builder.test.ts:841` — byte-identical |

**Arch-review-log: 8 claims — 7 TRUE, 1 FALSE (E2), plus 2 UNVERIFIABLE-EXTERNAL issue refs.**

### One-owner-per-fact

The trimmed §1 bullet (runbook:362-371) is identity + pointer and no longer
carries the grouping rationale, the sink rationale or the rule-1 comparison —
those live only in the block. Residual: "and nothing retries it" (:370) is a
one-clause restatement of the no-re-drive fact the block owns (:588). Not worth
a REVISE on its own; noted.

---

## 4. Defects the FIXES introduced

| ID | Sev | file:line | Finding |
|---|---|---|---|
| N1 | P2 | `docs/runbooks/beta-launch-alerting.md:578` (and `.claude/reference/arch-review-log.md:3`) | The runbook promises the pin turns red when the row's "filter, level, grouping or trigger" is corrupted. The row's **configured** level (the grouping cell's leading `` `error` ``) is not asserted — `PurgeWorker.test.ts:943` matches only the filter cell's phrase "level equals `error`" — and the throttle ("60 minutes per issue") and the destination ("integration 443670") are unasserted. This is the same class of overstated-pin claim as the accepted P0 (RT16-02/Std S2), reintroduced in the fix's own prose. Fix is one of: assert the grouping cell's level and the throttle/destination on the row, or narrow the sentence. |
| N2 | P3 | `src/lib/solicitation/__tests__/ingest.test.ts:96-109` | `stripCommentLines` drops any line whose trimmed form starts with `*` or `/*`, which includes real CODE: a leading inline block-comment pragma (`/* c8 ignore next */ const key = 'csv_ingest_' + id;`), code following a closing `*/` on the same line, a generator method (`*buildKey() { … }`), and operator-leading continuation lines. The docblock at `:98-99` claims the opposite bias ("errs toward a false positive rather than a missed respelling"), which is false for those lines. A false negative introduced into a guard whose whole purpose is catching a respelling. |
| N3 | P3 | `worker/jobs/account-offboarding/PurgeWorker.ts:60-62` | One Sentry issue per terminally failed offboarding means a systemic terminal failure (Stripe or DB outage across N offboardings) opens N issues, and with "Every event" + a per-ISSUE throttle that is N Discord notifications with no aggregate ceiling — the property the shared-issue design provided. Owner-decided trade; rule 16 (`beta-launch-alerting.md:576-578`) documents the benefit and never the cost, so the operator has no notice of the storm mode. |
| N4 | P3 | `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts:352-355` | `fingerprintPattern` interpolates the constants into a `RegExp` unescaped. Today's constants are snake_case so nothing over-matches, but a future member containing a regex metacharacter (`.`, `+`, `(`) would silently widen the pin instead of failing. |

No P0 and no P1 introduced. `purge-stages.ts` is byte-identical to MERGE_BASE;
`TeardownWorker.ts` and `BillingScheduleWorker.ts` are untouched by the diff.

---

## 5. REJECT verdicts — does the recorded reason hold?

- **Codex A5** (regex cannot see an equivalent string construction) — **holds**.
  `ingest.test.ts:89-93` now states the limit verbatim ("a key assembled by other
  string means … is NOT detected … not a proof of single ownership") and `:94` is
  unchanged. Caveat: the new comment-stripping widens the blind spot beyond
  "other string means" to some ordinary code lines (N2), which the narrowed
  comment does not mention.
- **Codex A2** (watchdog-terminalized purge carries no offboarding id) — **holds**.
  `OutboxPoller.ts:155-171` is pre-existing, untouched by the diff, and the
  runbook now names the path (`beta-launch-alerting.md:584`).
- **Codex A3 · Spec F4 · RT16-06** (`account_offboarding_not_found` and a
  `loadPurgeOffboarding` throw raise no rule-16 event) — **holds**.
  `PurgeWorker.ts:75-84` is unchanged from MERGE_BASE and the runbook names both
  paths (`:584`). Adding alerts there would be new alerting behavior the intake
  does not name.
- **RT16-04 · RT16-05** (`TeardownWorker`, `BillingScheduleWorker` share the RT-08
  shape) — **holds**. Neither file appears in
  `git diff 75c8d54c 4070fad8 --stat`; they are sibling defects outside the
  surface. Tracked in #1412 (UNVERIFIABLE-EXTERNAL).

---

## Appendix — untriaged observations (NOT findings; unchanged code or future risk)

- `rule16Block` (`PurgeWorker.test.ts:292`) does not terminate on a `### ` heading
  (`'\n### '` does not contain `'\n## '`). No `###` exists between rules today.
- `rule16Block`'s retry assertion is block-scoped; it is equivalent to a row
  assertion only while `[account_offboarding_purge_failed, retry]` occurs exactly
  once in the block (verified: it does, at runbook:576).
- The new two-offboarding test (`PurgeWorker.test.ts:861-886`) mutates
  `mockState.offboarding` between calls but leaves the row's own id as the first
  offboarding's; that is harmless and in fact strengthens the payload-sourcing
  pin, but it means the test would not catch a switch to `offboarding.id`.
- `ingest.test.ts:181`'s directory assertion would stay green if a future
  exclusion skipped `purge-stages.ts` while sibling files remained — the trade
  the triage explicitly accepted under Std S7.

---

**VERDICT: REVISE** — every ACCEPTED finding is addressed, but the fix's own
prose reintroduces the overstated-pin class the P0 was about: R10, R11 and E2 are
false doc claims (N1, P2), and N2 is a false-negative the #612 fix introduced
into the guard together with a docblock that asserts the opposite. All four are
small, local edits.
