# Spec & correctness review — `feat-695-import-consent-block-reason` (round 1)

Scope: `git diff 6a1af53d..HEAD`. Contract: `.feature/intake.json` (verified byte-identical
to `docs/superpowers/plans/feat-695-import-consent-block-reason-intake.json`).
Read-only review. No source file was edited.

**VERDICT: PASS** — the diff faithfully implements the intake contract. Three Low
findings, all documentation/test-harness hygiene; zero correctness defects, zero
behavioural drift, zero surface drift.

---

## Evidence executed (not inferred)

| Command | Result |
|---|---|
| `npx vitest run` on the 4 changed unit suites | 4 files / 99 tests passed |
| `npx vitest run worker/jobs/zernio/__tests__/ worker/jobs/notification/__tests__/ …checks.test.ts` | 16 files / 221 passed, 1 skipped (live-DB) |
| `npx vitest run` both integration suites **with `TEST_DATABASE_POOL_URL` set** | 2 files / 14 tests passed against live Postgres |
| `pnpm typecheck` | clean |
| `pnpm ci:static-policy` | passed (1123 files) |
| `pnpm ci:outbox-status` | passed |
| `pnpm ci:outbox-seam` | passed |
| `pnpm ci:live-db-suites` | passed |
| `pnpm ci:db-imports` | passed (strict) |
| `pnpm ci:tenant-scope` | passed — 414 entries, baseline 414 (unchanged) |

Note for the caller: `resolveTestDatabaseUrl()`'s `.env.local` fallback did **not**
fire in this worktree — both integration suites reported `TEST_DATABASE_POOL_URL unset
— SKIPPED` until the variable was exported explicitly. Worth knowing before trusting a
bare `npx vitest run` on a live-DB suite here.

---

## 1. The seven highest-risk properties

### 1.1 The #679 data-loss window stays closed — **PASS**

`worker/jobs/zernio/job-eligibility.ts:200-219`. The entire body is one
`sql.begin(async (tx) => …)`. Inside it: `SELECT ${importConsentStateSql(tx)} … FROM
businesses b WHERE b.id = … FOR UPDATE`, then `markOutboxCompletedWithReason(tx, …)`
on the **same `tx` handle**. Lock order business-before-outbox, unchanged. The reason
write replaced `markOutboxCompleted(tx, …)` in place — it did not move, and no second
statement was added outside the transaction.

Proven, not asserted: the forced-race test
(`worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts:378-528`) still
holds its tripwire — `acceptanceWasBlockedByTheGuard` must be `true`, which is only
possible if the `businesses` `FOR UPDATE` spans the completion write. It passed
against live Postgres in this review.

### 1.2 `owner_unreachable`'s persisted wire value — **PASS**

- Emitted UPDATE is byte-identical apart from the bind source:
  `SET status='completed', completed_at=NOW(), completion_reason=${reason}` with the
  same `dispatchedRow(exec, outboxId, attempt)` WHERE fragment
  (`src/lib/shared/outbox.ts:140-149`).
- `OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE` is untouched at
  `src/lib/shared/outbox-completion-reason.ts:5`.
- Same attempt-guarded CAS (same shared `dispatchedRow`), same `hasAttempt && count===0`
  warn gate.
- Both poller readers unchanged: `worker/background/pollers/health-alert/checks.ts:228`
  region and `worker/background/pollers/NotificationFailoverPoller.ts:199,236`.
- `scripts/ci/tenant-scope-allowlist.ts` untouched; `ci:tenant-scope` reports the
  identical 414-entry baseline.
- Pinned by execution, not compilation:
  `NotificationFailoverPoller.integration.test.ts:353` writes and reads the real column
  against live Postgres — it passed.

One deliberate delta: the 0-row warn **label** is now
`markOutboxCompletedWithReason(owner_unreachable)` instead of
`markOutboxOwnerUnreachable`. Behaviour identical; see appendix A1.

### 1.3 `checkOwnerUnreachable` cannot see the new value — **PASS**

Both `completion_reason` readers are topic-scoped:

- `checks.ts` `checkOwnerUnreachable` — correlated subquery has
  `jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}`.
- `checks.ts` `checkZeroDeliveryNotifications` (the
  `completion_reason IS DISTINCT FROM 'owner_unreachable'` predicate) — same topic filter
  in its outer `WHERE`.
- `NotificationFailoverPoller.ts:199` and `:236` — same topic filter in both the
  candidate query and the in-transaction re-validation.

`import_consent_blocked` is only ever written on `zernio_initial_backfill` rows, so no
existing reader can observe it. A repo-wide grep confirms exactly three non-test
`completion_reason` readers (`checks.ts`, `NotificationFailoverPoller.ts`,
`outbox.ts`), all accounted for.

### 1.4 `guardZernioJobEligibility`'s three skips still leave the column NULL — **PASS**

`job-eligibility.ts:93` (missing row), `:102` (archived), `:117` (subscription) all
still call plain `markOutboxCompleted`. Backed by an added negative assertion in
`src/lib/shared/__tests__/outbox.test.ts:86`
(`expect(…text).not.toContain('completion_reason')` on `markOutboxCompleted`), and by
the 29 plain-writer assertions deliberately left alone in `ZernioBackfillWorker.test.ts`
(deviations D6).

### 1.5 Fail-closed preserved — **PASS**

`job-eligibility.ts:208` — `if (row?.state === 'accepted') return { kind: 'proceed' };`
is the only proceed path. Everything else, including `row === undefined` →
`reason = 'missing'`, falls through to log + complete + `{ kind: 'skipped' }`. No throw,
no `markOutboxFailed`, no retry. Pinned by the unit suite's five block cases and by four
live-Postgres cases (declined / derived-expired / live-pending / accepted).

### 1.6 Superseded-attempt CAS — **PASS**

The reason write composes the same `dispatchedRow` fragment, so a stale attempt matches
0 rows. Two independent pins: the fast-check property test
(`outbox.test.ts:204-236`, 200 runs, sweeping every vocabulary member × attempt ×
actual-attempts × dispatched-or-not, asserting `warn` is called exactly when
`typeof attempt === 'number' && !rowMatches`), and the live-Postgres CAS test
(`NotificationFailoverPoller.integration.test.ts:353` — stale `attempt-1` leaves
`status='dispatched', completion_reason=null`; `attempt` wins).

### 1.7 No bare string literal for a completion reason — **PASS**

Repo-wide grep for `'owner_unreachable'` / `'import_consent_blocked'` outside `docs/`
returns only: the constant's own definition + its comment, prose in `CONTEXT.md` /
migration 083 / poller comments / `tenant-scope-allowlist.ts` comment, one pre-existing
finding-key literal (`checks.test.ts:245`, a `HealthFinding.key`, a different
vocabulary), and the sanctioned wire-value test at `outbox.test.ts:200-201`. No
executable site spells a reason. See appendix A2 for a note on the second literal in
that one test.

---

## 2. Intake field-by-field

### `goal` — PASS
Both halves delivered: ADR 0016 (`docs/adr/0016-import-consent-enforcement-locus.md`,
142 lines, Status / Context / Decision / **Alternatives considered** / Consequences —
the section `existing_patterns_to_follow` said to add) and the durable marker.

### `non_goals` (9) — ALL HELD

| # | Non-goal | Verdict |
|---|---|---|
| 1 | No trigger / CHECK / migration on `job_outbox` | PASS — `supabase/` untouched |
| 2 | No change to proceed/skip decision, `sql.begin`, `FOR UPDATE`, `importConsentStateSql` | PASS — only the writer call changed |
| 3 | No per-state reason values | PASS — one member; per-state stays in the log line |
| 4 | No poller / Sentry / PostHog | PASS — nothing reads the marker in code |
| 5 | No `/admin/jobs` rendering | PASS — `src/app/**` untouched |
| 6 | No reason on `guardZernioJobEligibility`'s three skips | PASS — §1.4 |
| 7 | No change to `owner_unreachable` persisted value / readers / allowlist | PASS — §1.2 |
| 8 | No backfill of historical rows | PASS — no data migration; ADR states the NULL caveat |
| 9 | No modification of `worker/__tests__/helpers/mock-sql.ts` | PASS — not in the diff |

### `user_visible_behavior` — PASS
No UI, no notification, no API shape change: `src/app/**` and `src/components/**` are
absent from the diff. The only new behaviour is the operator-visible marker, exactly as
named. One un-named operator-visible delta (a `console.warn` label) is in appendix A1.

### `invariants` (6) — ALL HELD
Mapped to §1.1 (inv. 1, 4), §1.5 (inv. 3), §1.2 (inv. 5), §1.7 (inv. 6). Invariant 2
(single-owner `importConsentStateSql`): the fragment call at `job-eligibility.ts:202` is
unchanged and nothing in the diff re-spells the derived-expiry predicate in SQL,
PL/pgSQL, or a migration — the `derived-expired` integration test drives it through the
real fragment.

### `edge_cases` (7) — ALL GENUINELY HANDLED

1. **Superseded attempt** — §1.6. Handled + double-pinned.
2. **Missing `businesses` row** — `job-eligibility.ts:210` (`row?.state ?? 'missing'`)
   falls into the same marked completion. Pinned by
   `job-eligibility.test.ts:388` which also asserts the log line carries
   `reason: 'missing'` (the only record in this case).
3. **Guard-first-then-accept interleaving** — the marker lands on the *old* row id; the
   acceptance's fresh row is a new INSERT that never touches `completion_reason`. The
   live race test asserts `runnable[0].id !== handRowId` and
   `runnable[0].status === 'pending'`, so the fresh row is provably not the marked one.
   (It does not additionally assert the fresh row's `completion_reason IS NULL` — see
   appendix A4; the property is structural, not conditional.)
4. **`pending` refusal later accepted** — nothing rewrites a completed row's reason;
   the semantic ("records that a refusal happened, not current state") is documented in
   ADR 0016 Consequences, `CONTEXT.md`, and the guard docblock at `job-eligibility.ts:183-190`.
5. **`checkOwnerUnreachable` predicate unperturbed** — §1.3, verified by reading both
   readers' topic filters.
6. **Legacy rows keep NULL and the ADR must say so** — ADR 0016 §"Operator query, and
   its limits" says it explicitly, with a `created_at >= '<deploy timestamp>'` bound in
   the query itself. PASS.
7. **Every other topic keeps NULL** — only two call sites write a reason
   (`NotificationWorker.ts:70` for `send_notification`, `job-eligibility.ts:215` for
   `zernio_initial_backfill`).

### `allowed_edit_surface` — NO DRIFT

All 16 changed paths map to a declared entry. `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`
(the D6 sixth file) is covered by the `worker/jobs/zernio/__tests__/**` glob, so it
consumes no amendment; `NotificationFailoverPoller.integration.test.ts` is the declared
D1 amendment (1 of 2). Nothing was edited outside the surface.

### `tests_to_add` (14) — ALL PRESENT VERBATIM, ALL CAN FAIL

Verified by exact-string grep, then by reading each body:

| # | Title | Location | Falsifiable? |
|---|---|---|---|
| 1 | `markOutboxCompletedWithReason completes the dispatched row and stamps the supplied completion_reason` | `outbox.test.ts:170` | Yes — asserts `completed_at = NOW()`, `completion_reason`, reason bind, id bind, swept over every vocabulary member |
| 2 | `… guards on the dispatched attempt so a superseded attempt stamps no reason` | `outbox.test.ts:204` | Yes — fast-check, 200 runs; warn-count assertion is exact (`toHaveBeenCalledTimes(n)`), so both a missing and a spurious warn fail |
| 3 | `… warns and swallows a 0-row update rather than throwing` | `outbox.test.ts:238` | Yes — `resolves.toBeUndefined()` + warn called once + message contains the reason |
| 4 | `OUTBOX_COMPLETION_REASON preserves the persisted owner_unreachable wire value` | `outbox.test.ts:194` | Yes — the sanctioned constant-to-literal pin |
| 5 | `… preserves owner_unreachable against live Postgres and rejects a superseded attempt` | `NotificationFailoverPoller.integration.test.ts:353` | Yes — real column read, stale-then-winning attempt |
| 6 | `NotificationWorker still stamps owner_unreachable through the generalized reason helper` | `NotificationWorker.test.ts:417` | Yes — asserts the FULL call tuple incl. `attempt = 7` from an explicit payload, so an argument-order slip fails |
| 7 | `guardImportConsent completes a refused backfill row with completion_reason import_consent_blocked` | `job-eligibility.test.ts:370` | Yes — D5's `mockMarkOutboxCompletedWithReason` call-count assertion is what makes it able to fail |
| 8 | `… stamps import_consent_blocked for a businesses row that does not exist` | `job-eligibility.test.ts:388` | Yes — same D5 assertion + the `reason: 'missing'` log pin |
| 9 | `… writes the block reason inside its own consent transaction` | `job-eligibility.test.ts:406` | Yes — `inTransaction === true` sampled at call time; fails if the write leaves `sql.begin`. Title correctly narrowed (D2) to the claim the harness can support |
| 10 | `… stamps no completion_reason when consent is accepted` | `job-eligibility.test.ts:428` | Negative regression pin — holds before and after by design (D5 explains; correct not to force red) |
| 11 | `… persists completion_reason=import_consent_blocked … for a declined import` | `job-eligibility.integration.test.ts:534` | Yes — live Postgres, `toEqual` on the `{status, completion_reason}` pair |
| 12 | `… for a derived-expired import` | `:555` | Yes — live, drives the real CASE arm |
| 13 | `… for a live pending import` | `:579` | Yes — live |
| 14 | `… leaves completion_reason NULL … when consent is accepted` | `:601` | Yes — live; asserts `status='dispatched'` too, so a spurious completion fails |

The D5 precedent (a title that could not fail) was checked against every one of the 14,
not just the three it named. #10 is the only title that cannot go red, and that is
correct and documented — it is a negative pin, and forcing it red would mean asserting
something false.

Pair-assertion quality is good: #11-#14 use one `toEqual` on the `{status, reason}`
pair rather than two independent assertions, so "completed WITHOUT a reason" fails —
the helper docblock at `job-eligibility.integration.test.ts:199-206` states exactly this
rationale.

### `dependencies_added` / `verification_commands` / `open_questions` — PASS
Empty as declared; `package.json` untouched.

### `rollback_plan` — VERIFIED ACCURATE
Migration 083 (`supabase/migrations/083_outbox_owner_unreachable.sql`) is
`ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS completion_reason TEXT` — nullable, no
CHECK, no enum. So historical `'import_consent_blocked'` rows really are inert after a
revert, and no reader interprets them (§1.3). No flag, no env var, no backfill.

### `observability` — PASS
The operator query in ADR 0016 carries the `created_at >= '<deploy timestamp>'` bound
and the explicit "NULL does not universally mean genuine import" caveat. Both stated
regression signals are real and checkable.

---

## 3. Blast-radius caller analysis

The input file lists importers heuristically; below is the **semantic** check per
changed file. Typecheck (clean) covers signature breaks; this covers behaviour.

### `src/lib/shared/outbox-completion-reason.ts` — 12 importers

Change is **purely additive**: one new key plus a new exported type. No existing member
renamed or re-valued. Consumers split into three classes:

- **Writers** (`outbox.ts`, `NotificationWorker.ts`, `job-eligibility.ts`) — reviewed
  individually below.
- **Readers** (`checks.ts`, `NotificationFailoverPoller.ts`) — both bind
  `OWNER_UNREACHABLE` only, both topic-scoped to `send_notification`. A new member on a
  different topic is invisible to them (§1.3). **No behaviour change.**
- **Test importers** (7) — all pass; `checks.test.ts` and `checks.integration.test.ts`
  were not modified and still pass, which is the strongest available evidence that the
  health-alert readers are untouched.

One risk this file's additivity creates and the branch handled: the new member is swept
into two tests via `Object.values(OUTBOX_COMPLETION_REASON)`
(`outbox.test.ts:173` and `:209`), so a future third member is automatically exercised.

### `src/lib/shared/outbox.ts` — 76 importers

`markOutboxOwnerUnreachable` was **deleted**, not deprecated. The only remaining
reference repo-wide is the historical note in its successor's docblock
(`outbox.ts:121`) — verified by grep. Of the 76 importers, exactly **two** ever
referenced it (`NotificationWorker.ts` and the failover poller's integration suite);
both were migrated. The other 74 import `markOutboxCompleted` / `markOutboxFailed` /
`extractOutboxHandle` / `recordOutboxTransientError` / `isTerminalAttempt` /
`errorMessage` / `lockDispatchedOutboxAttemptIfOwned`, none of which changed signature
or behaviour. `markOutboxCompleted`'s emitted SQL is unchanged and now has a negative
assertion pinning that it stays reasonless (`outbox.test.ts:86`).

**The one caller class typecheck could not have caught**, and which the branch found the
hard way (D6): suites that **mock** `src/lib/shared/outbox` with a factory. A factory
omitting the new export makes the named import a throw-on-access proxy. I enumerated
every such mock:

| Mock site | Reaches `guardImportConsent`? | Has the new export? | Verdict |
|---|---|---|---|
| `ZernioBackfillWorker.test.ts:58` | yes | yes | fixed at D6 |
| `job-eligibility.test.ts:97` | yes | yes | OK |
| `NotificationWorker.test.ts:46` | n/a (worker calls it) | yes | OK |
| `ZernioReviewIngestWorker.test.ts:44` | no — ingest lane never calls the consent guard | no | **safe**: access-time proxy, never accessed |
| `zernio-ingest-shared.test.ts:6` | no | no | safe |
| `ingest-failed-hook.test.ts:23` | no | no | safe |
| `NotificationWorker-telegram.test.ts:74`, `bounced-skip.test.ts:60`, `NotificationWorker.whatsapp.test.ts:92`, `dispatch-enrollment-account-scope.test.ts:70` | reach `handleSendNotification` but not the `no_verified_enrollments` branch | no | safe — all four pass |

All 16 files in that directory pair were executed in this review; none regressed.

### `worker/jobs/notification/NotificationWorker.ts` — 6 importers

Only the internal call changed (`NotificationWorker.ts:70`); the exported
`handleSendNotification` signature and every observable effect are identical. Five of
the six importers are test suites, all executed and passing; the sixth is
`worker/index.ts` (registration only). The `no_verified_enrollments` branch still
early-returns without dispatching, and still skips `markOutboxCompleted`.

### `worker/jobs/zernio/job-eligibility.ts` — 4 importers

- `ZernioBackfillWorker.ts` — the only `guardImportConsent` caller. It consumes
  `{ kind }` only; the marker is a side effect on a row the worker has already stopped
  touching on the skip path. Its "leaves `completed_at` untouched" and "mints no run
  row" assertions still pass.
- `ZernioReviewIngestWorker.ts` — imports `guardZernioJobEligibility` only, whose three
  skips are untouched (§1.4). **Structurally cannot reach consent code** — the
  separate-function design the spec mandates.
- Two test suites, both passing.

**Blast-radius conclusion: no caller relied on the old behaviour.** The one class the
map does not surface — suites that mock rather than import — was enumerated above and is
clean.

---

## 4. Deviations D1–D7 — verdicts spot-checked, none factually wrong

- **D1** (surface amendment for the failover integration suite): confirmed the file
  imported the deleted symbol; the retarget bought the only live-Postgres pin on the
  persisted wire value. Verdict stands.
- **D2** (retitle): confirmed `mock-sql.ts:104-110` invokes the `begin` callback with the
  same mock object, so an executor-identity assertion genuinely cannot fail. The
  narrowed title matches the `inTransaction` evidence, and the stronger property is
  covered by the live forced-race test. Verdict stands.
- **D3** (three added titles): all three exist, all three execute against live Postgres.
  Verdict stands.
- **D4** (estimates not raised): measured buckets are inside the 2× trigger. Not
  re-litigated.
- **D5** (three assertions added because the eval could not fail): confirmed the exact
  mechanism — `completionCalls` is shared by both recorders and
  `IMPORT_CONSENT_BLOCKED` is `undefined` pre-T2, so `toBe(undefined)` matched the plain
  recorder's absent `reason`. The added `mockMarkOutboxCompletedWithReason` call-count
  assertion is the fix and it is the file's own convention. Verdict stands, and I
  applied the same falsifiability test to all 14 titles.
- **D6** (sixth reference site): mechanism confirmed above. Verdict stands.
- **D7** (ADR cited by filename): `CONTEXT.md` carries the path. Verdict stands.

---

## 5. Findings

| Severity | file:line | Finding |
|---|---|---|
| Low | `worker/jobs/zernio/job-eligibility.ts:165` (also `worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts:41,44,293,449,521`) | The guard's own docblock still says the fix is "issuing `markOutboxCompleted` on the SAME `tx`", and the live-race suite's tripwire **failure message** (`:521`) still reads "…across its consent read and its markOutboxCompleted" — for a call site this same commit changed to `markOutboxCompletedWithReason`. Failure scenario: the tripwire fires in CI, an engineer greps `markOutboxCompleted` inside `guardImportConsent` and finds nothing. All six lines are inside `allowed_edit_surface`, and the branch updated the identical sentence in `.claude/CLAUDE.md` and `CONTEXT.md` — so the omission is inconsistency, not scope. Standard: CLAUDE.md "one authoritative owner per fact" / clean every cross-reference in the same change. |
| Low | `worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts:334` | Four new tests read and write `job_outbox.completion_reason` (added by migration **083**), but `assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT])` asserts only migration 100. The sibling suite asserts `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE` (`NotificationFailoverPoller.integration.test.ts:176`) and the constant already exists (`schema-ready.ts:203`). Failure scenario: a test DB provisioned without 083 fails these four with an opaque `column "completion_reason" does not exist` instead of the loud, actionable message the convention exists to produce. Standard: CLAUDE.md — live-DB suites **assert** their schema so a behind-head DB fails loudly. (Linear migration history makes 100⇒083 in practice, hence Low.) |
| Low | `docs/directory.md:964` and `.claude/reference/review-ingestion.md:223` | Both still state that `guardImportConsent`'s body runs `sql.begin` + `FOR UPDATE` + **`markOutboxCompleted(tx, …)`**; `review-ingestion.md:215` likewise says only "complete the outbox row", omitting the marker. `docs/directory.md` is the code map for the changed file and `.claude/reference/review-ingestion.md` is where `.claude/CLAUDE.md` routes an agent for this exact subsystem. Both are outside `allowed_edit_surface`, and neither the plan nor the deviations file acknowledges them — so no process on this branch owns the fix. (`docs/currents.md:226` and `docs/progresstracking.md:1830` carry the same stale sentence but are named targets of the step-8 `document-feature` sweep; `docs/directory.md` is not.) |

No High or Medium findings.

---

## Appendix — low-confidence observations (deliberately NOT in the table)

**A1. The 0-row warn label changed.** `outbox.ts:148` now emits
`markOutboxCompletedWithReason(owner_unreachable) no-op for …` where it previously
emitted `markOutboxOwnerUnreachable no-op for …`. Behaviour is identical and no in-repo
consumer greps the old string (verified). It follows from the sanctioned rename, and
`outbox.test.ts:239-240` argues the reason belongs in the label. Flagging only because
it is an operator-visible string change not named in `user_visible_behavior`, and an
*external* log-based alert (Railway/Sentry saved search) keyed on the old label would go
quiet with no error. I have no evidence such an alert exists.

**A2. A second bare literal inside the one sanctioned test.** `outbox.test.ts:201` adds
`expect(OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED).toBe('import_consent_blocked')`
alongside the sanctioned `owner_unreachable` pin at `:200`. On the natural reading the
intake's exception is scoped to *that test*, so this is compliant. Worth noting only
that the exception's stated justification — detecting a renamed value that strands
historical rows — does not apply to a member with no historical rows, so this line is a
freebie rather than the property the carve-out was granted for.

**A3. `docs/currents.md:722` and `docs/progresstracking.md:892`** still name the deleted
export `markOutboxOwnerUnreachable` in their F1-era "the new shape" inventories. Both
files are named targets of the step-8 `document-feature` sweep, so this is deferred by
design rather than missed. Listed so the sweep has the exact lines.

**A4. Edge case 3 could be pinned one assertion tighter.** The forced-race test proves
the surviving runnable row is a *different* id and is `status='pending'`, which already
makes "the fresh row looks pre-refused" impossible. Adding
`completion_reason IS NULL` on that row would state the edge case in its own terms. The
property is structural (a fresh INSERT never sets the column), so this is preference,
not a gap.

**A5. `.claude/reference/lab-notes.md` is in the surface but unchanged.** The deviations
file names a durable lesson worth promoting ("when a call site swaps writers, grep for
suites that MOCK the module, not just for importers of the removed symbol" — D6). That
is a step-8 promotion decision, not a branch defect; noted so it is not lost.
