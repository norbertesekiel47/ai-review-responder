# Review — spec & correctness (async/operations lens)

- **Axis:** spec-correctness, with the async/operations lens
- **MERGE_BASE:** `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **HEAD_SHA:** `6df3c95dfbabad6046b5dfbd455730233bc6e58c`
- **Read discipline:** every source line below was read from the committed SHA
  (`git show <sha>:<path>`, `git grep <pat> <sha>`). The working tree was not
  read except `.feature/` and `docs/reviews/finding-checklists/`.

## Measured diff (`git diff --numstat MERGE_BASE HEAD_SHA`)

| bucket | files | +added | -removed |
|---|---|---|---|
| **Production code** | `worker/jobs/account-offboarding/PurgeWorker.ts`, `worker/jobs/account-offboarding/purge-stages.ts` | **23** | **4** |
| **Docs / operator prose** | `docs/runbooks/beta-launch-alerting.md` (+41), `.claude/reference/arch-review-log.md` (+2) | **43** | 0 |
| Plan artifacts (intake + deviations) | 2 files | 198 | 0 |
| Tests | `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` (+143/-1), `src/lib/solicitation/__tests__/ingest.test.ts` (+28/-10) | 171 | 11 |

Code bucket 23 added / 4 removed against `estimated_prod_lines: 25` — inside the
band. The deviations file's "27 lines of code" is added+removed, not added; both
readings are inside the band, no discrepancy.

Every changed path is inside `allowed_edit_surface` (the ledger file arrived via
the owner-approved surface amendment recorded in the deviations file).

---

## Part 1 — DOC-TRUTH table

Each factual claim in the +41 lines of operator prose, re-resolved against code
at `HEAD_SHA`. Runbook line numbers are at `HEAD_SHA`.

| # | Claim (runbook line) | Verdict | Evidence at HEAD_SHA |
|---|---|---|---|
| D1 | §1:365 tags `subsystem:account_offboarding`, `step:purge`, `terminal:true` | **TRUE** | `worker/jobs/account-offboarding/PurgeWorker.ts:159-163` — `tags: { subsystem: 'account_offboarding', step: 'purge', terminal: String(terminal) }` |
| D2 | §1:363 / R16:589 fingerprint `[account_offboarding_purge_failed, terminal]` at level `error`; retry arm `[…, retry]` at `warning` | **TRUE** | `PurgeWorker.ts:34,46,47,157,158` |
| D3 | §1:366 / R16:589 emitted by `alertPurgeFailure`, "one function, called from both failure sites (validation and stage)" | **TRUE** | Only two call sites: `PurgeWorker.ts:79` (validation) and `:140` (catch block); one definition at `:151` |
| D4 | §1:368 the offboarding lands `status='failed'`, `failed_step='purge'` | **TRUE** | `purge-stages.ts:1233-1248` `markPurgeTerminalFailure` sets `status='failed', failed_step='purge'` |
| D5 | R16:597 `last_error` "(already scrubbed)" | **TRUE** | `PurgeWorker.ts:75,145` pass `scrubOffboardingErrorForStorage(...)` into `markPurgeTerminalFailure`; scrubber at `src/lib/account-offboarding/scrub-error.ts:14-24` |
| D6 | §1:369 "nothing retries it" | **TRUE** | `AccountOffboardingPurgePoller.ts:99-140` claims only `status='purge_scheduled' AND purge_started_at IS NULL AND terminal_at IS NULL`; the only auto re-drive in the lane is `TeardownRetryPoller`, scoped `failed_step='teardown'` (allowlisted SQL, `scripts/ci/tenant-scope-allowlist.ts:2557`) |
| D7 | §1:377 / R16:593 terminal branch "marks … and then RETURNS rather than throwing, so BullMQ emits no `failed` event" | **TRUE** | `PurgeWorker.ts:84-86` and `:146-147` — `markPurgeTerminalFailure` → `markOutboxFailed` → fall off the end of the catch; no `throw` after either |
| D8 | R16:593 `attachJobFailureSink` "is attached to this queue's Worker like every other" | **TRUE** | `worker/index.ts:551` registers `ACCOUNT_OFFBOARDING_PURGE` in `workersByQueue`; `:566-573` loops every entry and calls `attachJobFailureSink(worker, queueName)` |
| D9 | R16:593 "rule 11's `subsystem:worker_job` filter matches the sink's `captureException`, not this handler's `captureMessage`" | **TRUE** (incomplete) | `job-failure-sink.ts:69` tags `{ subsystem: 'worker_job', queue, topic }`; runbook:459 rule 11 filter is `subsystem = worker_job` **AND** `queue = agent_turn`. The sentence is true; it omits that the `queue` conjunct alone would already exclude this queue even if the handler *did* throw. See F4. |
| D10 | R16:595 `checkFailedOutboxByTopic` "reports every failed topic above `HEALTH_ALERT_FAILED_THRESHOLD` inside `HEALTH_ALERT_FAILED_WINDOW_S` — the topic list is open since #1378" | **TRUE** | `worker/background/pollers/health-alert/checks.ts:104-135` — no topic predicate, `GROUP BY topic`, `.filter(r => r.count > cfg.failedThreshold)`; the #1378 open-list comment is at `:96-113` |
| D11 | R16:595 `HEALTH_ALERT_FAILED_THRESHOLD` default `0`, window default in play | **TRUE** | `checks.ts:78` `failedThreshold: num(cfg.HEALTH_ALERT_FAILED_THRESHOLD, 0)`; `:77` `failedWindowS: num(…, 3600)` |
| D12 | R16:595 the purge outbox row's finding key is `outbox_failed:account_offboarding_purge` carrying `subsystem:health_alert` | **TRUE** | Topic value: `src/lib/shared/queue-names.ts:59` `'account_offboarding_purge'`, written as `topic` at `src/lib/account-offboarding/outbox.ts:235-243`; key format `checks.ts:130`; tag `worker/background/pollers/health-alert/emit.ts:14` |
| D13 | R16:595 the finding "does ride rule 1" | **PARTIALLY TRUE** | Rule 1 (runbook:449) triggers on **"issue is first seen"**, and `emit.ts:11-16` sets no fingerprint — grouping falls back to the message, which is `` `${count} ${topic} job(s) exhausted retries and failed in the last ${window}s` `` (`checks.ts:131`). A repeat failure producing the same count re-uses the issue and never re-fires a first-seen rule. See F5. |
| D14 | R16:595 "rule 1's own box is still unchecked" | **TRUE** | runbook:56 `- [ ] **Sentry alert rule → Discord** for issues tagged \`subsystem:health_alert\`` |
| D15 | R16:589 "Do **not** filter on Sentry priority — CONFIG-1 established that a level alone does not reliably classify" | **TRUE** | runbook:391-393 (CONFIG-1 verified 2026-06-24): a `warning`-level `captureMessage` "does not reliably classify as high-priority" |
| D16 | R16:589 "custom fingerprint … which is the whole grouping" | **TRUE** | Sentry semantics: an explicit `fingerprint` array without the `{{ default }}` token fully replaces the grouping input, for `captureMessage` as for `captureException`. `PurgeWorker.ts:158` passes a bare two-member array — no `{{ default }}`. |
| D17 | R16:589 the filter "tag `terminal` equals `true` **AND** level equals `error`" is expressible as a Sentry issue-alert filter | **TRUE** | Sentry issue alerts expose both "The event's level is equal to `<level>`" and "The event's tags match `<key>` `equals` `<value>`" as *If* conditions, combinable under **all**. Nothing in the emitted event blocks either: `level` is a first-class field (`PurgeWorker.ts:157`) and `terminal` is a tag, not an extra (`:162`). |
| D18 | R16:589 "Default title (the message)" | **TRUE** | A custom fingerprint changes grouping, not the title; the title stays the `captureMessage` message string `account_offboarding_purge_failed` (`PurgeWorker.ts:34,156`) |
| D19 | R16:589 "The event carries `account_offboarding_id`, `account_id` and the scrubbed error only — never an owner name, email, address or review text" | **TRUE** | `PurgeWorker.ts:165-169` — `extra` has exactly those three keys; the error string is scrubbed (D5) |
| D20 | R16:591 "The two spellings are exported from `PurgeWorker.ts` and a test pins them against this file, so renaming either side turns red" | **FALSE for the retry spelling** | `PURGE_TERMINAL_FINGERPRINT` is imported and pinned (`PurgeWorker.test.ts:266,855,856`). `PURGE_RETRY_FINGERPRINT` has **no importer anywhere in the repo** (`git grep` at HEAD returns only its declaration at `PurgeWorker.ts:47` and its use at `:158`); renaming `'retry'` leaves runbook:589's `[account_offboarding_purge_failed, retry]` stale and every test green. See F2. |
| D21 | R16:597 "strictly ordered with the Stripe Customer redaction first" | **TRUE** | `PurgeWorker.ts:118` `runStripeCustomerRedactionPurgeStage` is the first awaited stage; docblock `:96-117` states the D5 inversion |
| D22 | R16:597 "a terminal failure before `runParentTombstonePurgeStage` leaves names, emails and addresses in place" | **TRUE** | `PurgeWorker.ts:126` — the tombstone stage is second-to-last; `:101-105` "the stage that actually replaces names, emails, phones and addresses with sentinels" |
| D23 | R16:597 "The purge is idempotent … so a re-run resumes rather than double-destroys" | **UNVERIFIABLE / misleading** | No per-stage checkpoint exists — a re-run re-enters at `runStripeCustomerRedactionPurgeStage` and replays every stage; "resumes" has no referent in the code. Stage-level idempotence is asserted in no test, lab note or ADR I could find. See F3. |
| D24 | R16:597 "re-drive it only after the underlying cause is fixed" | **FALSE (no mechanism)** | No code path can re-drive a `failed`/`failed_step='purge'` row. See F1 for the full chain. |
| D25 | R16:597 "never by hand-editing `terminal_at` or the outbox row" | **TRUE but inert** | `markPurgeTerminalFailure` never writes `terminal_at` (`purge-stages.ts:1238-1248`), and migration 056's `account_offboardings_terminal_status_check` (`supabase/migrations/056_account_offboarding.sql:80-84`) *forbids* a non-NULL `terminal_at` while `status='failed'`. The two columns that actually block a re-claim — `status` and `purge_started_at` — are not named. Folded into F1. |
| D26 | R16:597 "`status='failed'`, `failed_step='purge'` and `last_error` … say which stage stopped" | **PARTIALLY TRUE** | `failed_step` is the literal constant `'purge'` on every terminal purge failure (`purge-stages.ts:1241`) and names no sub-stage; only `last_error`'s free text may or may not name one (e.g. `supabase_delete_user_failed:…` does, a bare Stripe transport message does not). The per-provider step columns (`stripe_step`, `zernio_accounts_step`, `location_archival_step`) are teardown state, not purge stages. See F3. |
| D27 | R16:599 "§4's standard: a rule is unproven until it has been seen to deliver" | **TRUE** | runbook:900 "Each rule is unproven until you have seen it deliver"; restated :112, :1252 |
| D28 | R16:589 destination "the environment's existing Discord alerts channel via integration 443670" | **TRUE within the document** (Sentry side not checkable read-only) | Same integration id as rules 11/12/13 (runbook:459, 465, 475) |
| D29 | §1:378-379 / R16:593 "one failure, one report" is the owner's decision | **TRUE** | Matches `non_goals[0]` of the locked intake verbatim |

**Totals: 29 claims — TRUE 22, PARTIALLY TRUE 3 (D13, D23-adjacent D26, D9 incomplete), FALSE 2 (D20, D24), UNVERIFIABLE 1 (D23), TRUE-but-inert 1 (D25).**
Counted for the summary line as **TRUE 23 / FALSE 2 / UNVERIFIABLE 4** (D9, D13, D23, D26 grouped as unverifiable-or-overstated).

---

## Part 2 — Findings (≥ 80 % confidence)

### F1 — P2 — `docs/runbooks/beta-launch-alerting.md:597` — the runbook's only operator action ("re-drive it") names an action no mechanism in the repo can perform

**Contract field:** `goal` ("a complete rule that routes that terminal issue"),
`risk_reasons[1]` ("a wrong … rule row fails silent").

**Evidence at HEAD_SHA:**
1. `purge-stages.ts:1233-1248` — `markPurgeTerminalFailure` leaves the row at
   `status='failed'`, `failed_step='purge'`, `purge_started_at` still set (the
   poller stamped it at claim time, `AccountOffboardingPurgePoller.ts:146`),
   `terminal_at` still `NULL`.
2. `AccountOffboardingPurgePoller.ts:99-103,146-160` — both the SELECT and the
   claim UPDATE require `status = 'purge_scheduled' AND purge_started_at IS NULL
   AND terminal_at IS NULL`. A terminally failed row matches neither.
3. The one auto re-drive in this lane is `TeardownRetryPoller`, scoped
   `status='failed' AND failed_step='teardown'`
   (`scripts/ci/tenant-scope-allowlist.ts:2557`), and
   `docs/runbooks/owner-offboarding-staging-dry-run.md:293-295` states the
   policy explicitly: "A `failed` row whose `failed_step = 'teardown'` is
   **not** terminal-by-policy" — i.e. `failed_step='purge'` is.
4. No admin surface mutates purge state: `src/app/api/admin/offboardings/` holds
   a read route and a `provider-disposition` route only;
   `src/app/api/admin/jobs/route.ts` exports `GET` alone.
5. Even hand-re-driving the outbox row (which the same sentence forbids) is a
   no-op loop: `validatePurgeableOffboarding` (`purge-stages.ts:88-91`) returns
   `account_offboarding_status_not_purgeable:failed`, so the handler re-enters
   the terminal branch and re-fires the same `error` alert.
6. `terminal_at` — the field the sentence warns against editing — is not even
   settable while `status='failed'`: migration `056_account_offboarding.sql:80-84`
   `CHECK ((status IN ('purged','churned','reactivated') AND terminal_at IS NOT
   NULL) OR (status NOT IN (…) AND terminal_at IS NULL))`.

**Failure scenario.** A staging/prod purge exhausts its three attempts on a
transient Stripe outage. Rule 16 fires, the operator opens the runbook, fixes
the outage, and is told to "re-drive it … never by hand-editing `terminal_at` or
the outbox row." There is no button, route, poller or documented SQL to do so —
the same paragraph's own §1 twin says "nothing retries it" (runbook:369). The
account keeps live PII (D22) indefinitely while the runbook reads as though a
recovery path exists. This is the deletion obligation the rule was added to
protect.

**Minimum fix inside the allowed surface:** say what is true — that the purge
lane has no re-drive today, that recovery requires a deliberate, recorded
operator intervention (resetting `status` to `purge_scheduled` and
`purge_started_at` to `NULL` under the shared-Stripe-customer caveat), or that
the re-drive path is owed as a follow-up ticket. Name `status` and
`purge_started_at` instead of `terminal_at`.

---

### F2 — P2 — `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts:848-857` — the doc-pin test passes with the operator-facing filter wrong, and never pins the retry fingerprint

**Contract field:** `invariants[2]` — "The fingerprint **values** (plural) in the
runbook row are byte-identical to the constants the worker sends. A test pins
them." `tests_to_add[5]`.

**Evidence.** The whole test body is three substring checks against a
1,300-line file:

```
expect(runbook).toContain('account-offboarding-purge-terminal → discord');
expect(runbook).toContain(PURGE_TERMINAL_FINGERPRINT[0]);
expect(runbook).toContain(`[${PURGE_TERMINAL_FINGERPRINT.join(', ')}]`);
```

Nothing constrains adjacency, so all three can be satisfied by text scattered
across three different rules. Concretely, each of these mutations of the runbook
keeps the whole suite green while making the configured Sentry rule wrong:

- flip runbook:589's filter to `tag terminal equals false` and `level equals
  warning` → the operator builds a rule that fires on every *retry* and never on
  the terminal event, which is defect RT-08 restored through the document;
- swap runbook:589's grouping cell to `[account_offboarding_purge_failed, retry]`
  — the third assertion is still satisfied by the §1 bullet at runbook:363-364,
  which carries the terminal bracket form;
- delete the entire §1 checklist bullet (runbook:362-384) — no assertion touches it;
- change the trigger from "Every event" to "first seen" — unasserted, and the
  rule's own prose (runbook:591) argues at length that first-seen is the bug.

`PURGE_RETRY_FINGERPRINT` is exported at `PurgeWorker.ts:47` and has **no
importer anywhere at HEAD** (`git grep PURGE_RETRY_FINGERPRINT 6df3c95d` → the
declaration and `PurgeWorker.ts:158` only). The two other tests hand-spell
`['account_offboarding_purge_failed', 'retry']`, so renaming the member renames
it on both sides and leaves runbook:589's `[account_offboarding_purge_failed,
retry]` silently stale — the exact mode the describe-block comment
(`PurgeWorker.test.ts:725-731`) claims the pin exists to prevent.

**Minimum fix:** slice the runbook to rule 16's block first (e.g. between the
`**Rule 16 —` heading and the next `**Rule `), then assert the terminal
fingerprint, `PURGE_RETRY_FINGERPRINT.join(', ')`, the `error` level, the
`terminal` / `true` filter pair and the every-event trigger *within that slice*.

---

### F3 — P3 — `docs/runbooks/beta-launch-alerting.md:597` — two soft claims in the operator-action paragraph over-state what the row and the re-run give the operator

**Contract field:** DOC-TRUTH (every claim true at HEAD).

- "a re-run **resumes** rather than double-destroys" — there is no checkpoint:
  `PurgeWorker.ts:118-129` re-enters at stage 1 unconditionally. The defensible
  claim is *idempotent replay*, and even that is asserted by no test, lab note or
  ADR I could locate. As written it tells the operator the system remembers where
  it stopped; it does not.
- "`status='failed'`, `failed_step='purge'` and `last_error` say **which stage**
  stopped" — `failed_step` is the constant `'purge'` for every purge failure
  (`purge-stages.ts:1241`); only `last_error`'s free text may name a stage, and
  a transport-level message (the branch's own fixture, `'stripe connection
  error'`) names none.

**Failure scenario.** The operator reads "resumes", assumes the earlier stages
will be skipped, and re-drives under a half-understood failure; or hunts for a
per-stage value in `failed_step` that is never there.

---

### F4 — P3 — `worker/jobs/account-offboarding/PurgeWorker.ts:66-68` — two terminal paths in the same handler emit no rule-16 event, while §1:362-369 presents rule 16 as *the* page for a terminal purge failure

**Contract field:** `user_visible_behavior[0]`, observability completeness
(async lens).

1. **`offboarding not found`** — `PurgeWorker.ts:66-68` calls
   `markOutboxFailed(…, 'account_offboarding_not_found', …)` and returns with no
   `alertPurgeFailure` call. No `captureMessage`, no BullMQ `failed` event (it
   returns), so no `attachJobFailureSink` either. Only the rule-1 aggregate sees
   it, subject to F5.
2. **A throw from `loadPurgeOffboarding`** (`PurgeWorker.ts:60-64`) is *outside*
   the try/catch at `:94`. A transient DB fault that survives all three attempts
   produces an `attachJobFailureSink` `captureException` tagged
   `subsystem:worker_job, queue:account_offboarding_purge` — and **no built rule
   routes it**: rule 11 (runbook:459) is `subsystem = worker_job` **AND**
   `queue = agent_turn`. The event exists in Sentry but reaches no Discord channel.

Neither path is introduced by this branch, but the branch is the one that makes
the operator-facing promise. The §1 bullet's unqualified "A terminal purge
failure is an **unmet deletion obligation**" reads as total coverage.

**Minimum fix inside the allowed surface:** one clause in rule 16 naming the
uncovered paths and what does see them (rule 1 aggregate / the sink's untriaged
issue), or route the `not_found` branch through `alertPurgeFailure`.

---

### F5 — P3 — `docs/runbooks/beta-launch-alerting.md:595` — "does ride rule 1" overstates the aggregate half: rule 1 is a first-seen rule over an unfingerprinted, count-bearing message

**Contract field:** DOC-TRUTH; deviation D1 of the branch (whose whole point was
that the aggregate half is real).

**Evidence.** `emit.ts:11-16` sets **no** fingerprint, so grouping falls back to
the message; the message is `` `${count} ${topic} job(s) exhausted retries and
failed in the last ${window}s` `` (`checks.ts:131`), which embeds the count.
Rule 1's trigger (runbook:449) is **"issue is first seen"**. Consequences: the
first `1 account_offboarding_purge job(s) …` event opens an issue and pages; the
*second* identical-count failure lands in that same issue, is not first-seen and
does not page. So the aggregate half pages once per distinct count value, ever —
not "per failure".

The prose's conclusion (rule 16 is required, the two are complements) is
unaffected; the overstated half is the reassurance that something is watching
today. Note also that rule 1 is unbuilt (D14), which the prose does say.

---

## Part 3 — #612 half (lock-key scan widening)

**Verdict: sound.** Specifics checked at HEAD_SHA:

- **Walk width.** `ingest.test.ts:80` `LANE_ROOTS = ['src/lib', 'worker']` is
  byte-identical to `batch-builder.test.ts:841` `LOCK_LANE_ROOTS`, the precedent
  named in `existing_patterns_to_follow[2]`.
- **What the walk skips.** `walkLaneSources` (`ingest.test.ts:88-97`) skips
  directories named `__tests__` **only**, and takes files ending `.ts` but not
  `.test.ts`. Identical to `walkLockLaneSources`
  (`batch-builder.test.ts:847-856`). Neither `src/lib` nor `worker` contains a
  vendored, generated or `node_modules` subtree at HEAD, so the wider walk picks
  up no third-party text; the only widening risk is prose false positives inside
  first-party files, which is exactly what the `purge-stages.ts` reword handles.
- **Single-owner assertion is at least as strong.** `laneFilesBuildingTheLockKey`
  (`ingest.test.ts:110-114`) applies the *same* `LOCK_KEY_CONSTRUCTION` regex
  (`ingest.test.ts:86`, unchanged) to a strict superset of files and the
  assertion is still `toEqual(['src/lib/solicitation/ingest.ts'])`
  (`:135`). `git grep -E "csv_ingest_(\$\{|['\"\`])" 6df3c95d -- src/lib worker`
  returns exactly that file (`ingest.ts:490`) plus the test's own comment lines,
  confirming the assertion is not vacuous and not over-matching.
- **The new coverage test is non-vacuous.** `ingest.test.ts:138-146` asserts
  `laneSourceFiles()` contains `worker/jobs/account-offboarding/purge-stages.ts`
  — a path unreachable under the old `['src/lib/solicitation',
  'worker/jobs/csv-ingest']` roots, so reverting either the root widening or the
  `laneSourceFiles` extraction turns it red. It proves the purge lane is
  *scanned*; it deliberately does not prove the lock is *taken* there (that is
  `batch-purge-concurrency.integration.test.ts`'s job, per #637).
- **Reworded comment keeps its meaning.** `purge-stages.ts:258-269`: the old
  text argued "via `acquireCsvIngestLock` rather than a hand-spelled
  `hashtext('csv_ingest_' || id)` … two derivations of one key is how a lock
  silently stops contending"; the new text keeps both halves verbatim, replacing
  only the literal key spelling with "`hashtext()` over the same per-business
  key", and adds why the spelling was removed. No claim lost. `invariants[5]`
  ("acquireCsvIngestLock stays the only file that constructs the csv_ingest
  key") holds.

---

## Part 4 — Async / operations lens (checks that came back clean)

- **`isTerminalAttempt` can never mis-classify the *last* attempt as `retry`.**
  `src/lib/shared/outbox.ts:211-216` returns
  `attemptsMade >= max || attemptsMade + 1 >= max`. Both disjuncts are
  inclusive, so whichever base BullMQ uses for `attemptsMade` inside the
  processor (0-based as the branch's fixtures assume, or 1-based), the final
  attempt always satisfies the predicate. The failure direction is the opposite
  one — an *early* attempt classified terminal under a 1-based `attemptsMade` —
  which is pre-existing, shared by every outbox worker in the repo, and outside
  this intake (`edge_cases[2]` freezes the predicate). No path exists where a
  final failure is fingerprinted `retry` and never pages.
- **Fingerprint array is copied per call.** `PurgeWorker.ts:158` spreads
  (`[...(terminal ? … : …)]`), handing Sentry a fresh array each time; the two
  `as const` constants are never passed by reference and cannot be mutated by
  the SDK or by a later scope processor.
- **Stale-attempt path unchanged.** `PurgeWorker.ts:133-136` still returns
  silently on `isStaleOutboxAttemptError` with no alert, as `edge_cases[1]`
  requires.
- **No `any`, no new dependency, no flag, no migration, no new file, no
  `NEXT_PUBLIC_*`.** Invariants #10, #13, #15 untouched; `purge-stages.ts` still
  takes `sql` as a parameter.

---

## Part 5 — Weakened checks (`git diff MERGE_BASE HEAD_SHA -- '*test*'`)

**Removed / skipped / loosened: none.**

- `src/lib/solicitation/__tests__/ingest.test.ts` — the only refactor.
  `laneFilesBuildingTheLockKey` was split into `laneSourceFiles()` (collect) +
  a filter. The single-owner assertion at `:135` is **unchanged in text and
  strictly stronger in reach** (superset of files, same regex, same expected
  array). No `it.skip`, no `it.todo`, no assertion deleted. 10 removed lines are
  the old comment block and the old function body.
- `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` — +143/-1; the
  single removed line is the import statement, replaced by a wider one. All six
  new cases are additions.

**"Can the new tests pass while the promised behavior is wrong?"**

| test | verdict |
|---|---|
| terminal stage failure → terminal fingerprint at `error` | No — pins level, fingerprint members and `terminal:'true'` together |
| retryable stage failure → retry fingerprint at `warning` | No — same shape on the other arm |
| terminal validation failure → terminal fingerprint | No — drives the `:79` call site specifically (`teardown_completed_at: null`) |
| terminal ≠ retry fingerprint | No — the `Array.isArray` presence guard at `PurgeWorker.test.ts:799` explicitly closes the "two `undefined`s compare equal" vacuity, which is the #1016 defect itself. Good defensive work. |
| terminal path marks outbox failed and does not throw | No for what it pins (exactly one capture, terminal fingerprint, `markOutboxFailed` args, no `markOutboxCompleted`) |
| **the alerting runbook routes the terminal purge fingerprint** | **Yes — see F2.** Four named runbook mutations leave it green. |
| the csv_ingest lock-key scan covers the offboarding purge lane | No — the asserted path is unreachable under the pre-change roots |

**Compromises this change makes that the deviations file does not already name:**

1. The doc pin is a whole-file substring check, not a rule-scoped one, and does
   not cover the filter, the level, the trigger or the destination (F2). The
   deviations file records three other compromises but not this one; the
   describe-block comment at `PurgeWorker.test.ts:725-731` in fact asserts the
   opposite ("renaming either side turns red").
2. `PURGE_RETRY_FINGERPRINT` is an exported symbol with zero importers — it
   exists only to be documented, and nothing enforces that documentation (F2).
3. The operator-action paragraph promises a re-drive the repo cannot perform
   (F1) and a "resume" that does not exist (F3); neither is recorded as an
   accepted gap.
4. Rule 16's coverage claim is silent about the two unalerted terminal paths in
   the same handler (F4).

---

## Appendix — non-actionable observations (below the reporting bar or out of scope)

- **Best-effort ordering.** `.claude/rules/worker-layout.md:23` requires
  best-effort work *after* a primary side effect to carry its own try/catch.
  Here `alertPurgeFailure` runs *before* the durable marks (`PurgeWorker.ts:140`
  then `:146-147`), so a throw inside it would skip both
  `markPurgeTerminalFailure` and `markOutboxFailed` and strand the row
  (`purge_started_at` set ⇒ never re-claimable). `Sentry.captureMessage` is
  effectively non-throwing and the ordering is untouched by this branch, so I am
  not raising it as a finding — but the branch was the natural moment to wrap the
  call, and it did not.
- **Validation-path retry arm untested.** `invariants[0]` names both paths ("on
  the catch-block path **and** on the validation-error path"). The retry arm of
  the validation path has no case; inequality there follows structurally from the
  single `alertPurgeFailure(…, isTerminalAttempt(job))` call, so the invariant
  holds, but it is proven by construction rather than by a test.
- **`account_offboarding_purge_cancelled` would page as terminal.** A validation
  failure with that reason takes the same `error` + terminal fingerprint as a
  real fault, and rule 16's text would tell the operator to treat a
  deliberately-cancelled purge as an unmet deletion obligation. I believe it is
  unreachable — `keep-my-data.ts` admits only `purge_started_at IS NULL` and the
  poller stamps `purge_started_at` inside the claim transaction — so I am not
  raising it.
- **Rule 16 sits between rules 15 and 11 in §1a-do.** The file's block ordering
  is already non-monotonic (12, 13, 14, 10, 15, **16**, 11), so this matches the
  existing state rather than degrading it.
- **Rule 16 is a prose block, not a row in the numbered table at runbook:449-459.**
  This matches the precedent the intake names (`operator-retained-veto-invariant`
  = rule 12, `safety-review-failed-closed` = rule 14), both of which are blocks
  with a four-column six-facet table and a §1 checkbox. Compliant.
- **`docs/directory.md` / `ci:directory-map`** — no new production file, so no
  row is owed.

---

**VERDICT: REVISE** — two P2 findings (F1: the runbook's only operator action
names a mechanism that does not exist; F2: the doc-pin test leaves every
operator-facing facet of rule 16 unpinned and never pins the retry fingerprint).
The core behavior change — the terminal/retry fingerprint split, its levels, its
tags, the one emitter, the no-throw terminal branch — is correct, on-contract and
well tested, and the #612 half is sound.
