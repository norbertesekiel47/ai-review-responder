# Spec & correctness review — feat/1012-refusal-auto-post-revoked

Fork `06a163f0` → head `7c9bd9cd`. Read-only. No tests run.

## Verdict

The production change is **correct against `.feature/intake.json` field by field**.
Every locked invariant holds in code, all 19 `tests_to_add` titles are present
VERBATIM in the two suites (verified programmatically — 0 missing), and the four
attack surfaces the brief named as highest-risk (caller-transaction, the five
no-op exits, the ladder substitute, the re-arm fixture) each discriminate a wrong
implementation. Findings are all in the **documentation and test-scaffolding**
layer; none change runtime behaviour.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| MEDIUM | `.claude/reference/arch-review-log.md:1444` | Durable row claims "Three adversarial plan rounds, fourteen findings"; the plan records ONE round (`plan.md:235`, R1-1…R1-8 + one self-correction = 9) and `plan.md:107` re-attributes the same seven added titles to "Round 2" that §8 attributes to round 1. |
| LOW | `worker/jobs/publisher/auto-policy-downgrade.ts:97` | The new comment contains the literal `FROM businesses`, so the pre-existing `auto-policy-downgrade-lock-order.test.ts:12` `body.indexOf('FROM businesses', anchor)` now resolves to the COMMENT (line 97), not the lock statement (line 109). Verified by executing the test's own resolution logic. |
| LOW | `.feature/intake.json` observability[2] | The staging reconciliation query is stated as an equality (`auto_post_revoked` rows == auto-policy revoked audit rows, per account); the branch's own `auto-policy-downgrade.integration.test.ts:533` proves it false under a re-downgrade (2 audit rows, 1 refusal row) because `ON CONFLICT DO NOTHING` is first-write-wins per response. |
| LOW | `worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts:601-612` | The test comment's stated kill mechanism ("an independently committed row is still on disk at the last assertion") is not what a private-connection implementation would produce: the deciding tx holds `businesses FOR UPDATE` and `refusal_events.business_id` FKs to it, so the private insert's `FOR KEY SHARE` blocks until the 40 s suite timeout. The test still goes RED — the described scenario does not. |
| LOW | `.claude/reference/arch-review-log.md:1444` | Row dated `2026-08-31`; current date is 2026-08-30 and every adjacent row is `2026-08-30`. |

---

## Attack log — what was checked and what held

### 1. The write must be on the CALLER's transaction — HOLDS

`writeRefusalEvent(tx, …)` receives the deciding `TransactionSql`
(`auto-policy-downgrade.ts:195`). The discriminating case is
`integration.test.ts:601`: it calls the `InTx` form inside `sql().begin`, reads
the row INSIDE that tx (guards against a silent no-write), then throws, then
asserts `readRefusalRows()` is `[]` on a separate connection **and** that the
response/audit/notification all rolled back.

A helper that opened its own connection cannot pass: `refusal_events.business_id`
FKs to `businesses` (migration 116) and the deciding tx holds that row
`FOR UPDATE`, so the private insert's RI `FOR KEY SHARE` blocks and the suite
times out. RED either way — see the LOW finding on the comment's stated
mechanism.

### 2. Five no-op exits — the list is COMPLETE

Traced every `return 'no-op'` in
`downgradeAutoApprovedResponseForManualReviewInTx`:

| # | line | guard | covered by |
|---|---|---|---|
| A | 89 | `!reviewId` (no review anchor) | `integration.test.ts:487` |
| B | 115 | `!lockedBusiness` | `unit.test.ts` "missing business" (D3 — unreachable live) |
| C | 130 | `!isDowngradeable` | `integration.test.ts:449` |
| D | 136 | `!ownsAttempt` (CAS lost) | `integration.test.ts:467` |
| E | 153 | `!downgraded` (guarded UPDATE) | `unit.test.ts` `updateReturns: []` |

There is exactly one path to the ledger write and it is straight-line after E.
No sixth exit, and no path where a Refusal is written without a decision. The
only decision-without-Refusal path is the kill switch, which is the contract.

### 3. D2 — the ladder substitute — VERIFIED, AND IT IS STRONGER

`resolveAccountIdFromBusiness` (`src/lib/approval/audit.ts:115-123`) really does
issue an unlocked `SELECT account_id FROM businesses`, called at
`audit.ts:230` from `insertAuditLogAutoPolicy`, so the plan's "statement count
unchanged" was indeed unsatisfiable.

The substitute **does fail if a rung is added**: `expect(sqlCalls.map(c => c.text))
.toEqual([...10 asymmetric matchers])` — `toEqual` over an array requires equal
LENGTH, so an 11th statement anywhere is red, not just a `businesses` one. The
`businessLocks` filter (`FROM businesses` + `FOR UPDATE`) pins exactly one and
asserts `/SELECT\s+id,\s*account_id/`. Two different mock account ids
(`BUSINESS_LOCK_ACCOUNT_ID` / `AUDIT_RESOLVED_ACCOUNT_ID`) make the source of the
key discriminating rather than tautological. Confirmed the queued ladder is
exactly 10 statements and matches the real emission order.

### 4. D4 — the re-arm helper — VERIFIED

`reArmForSecondDowngrade` (`integration.test.ts:168`) terminalises the spent
`PUBLISH_RESPONSE` outbox row, restores `status='approved' /
approval_method='auto_policy' / approved_at / approved_text / posting_error=NULL`,
and seeds a fresh `dispatched` row. Traced the two-different-reasons case
(`:539`): the second call passes anchor → business → downgradeable → CAS →
guarded UPDATE and genuinely reaches `refusal_events_subject_uniq`
`(refusal_source, subject_id) WHERE subject_id IS NOT NULL` (migration 116).
`judge_disabled`/`watchdog_unavailable` vs `policy_suspended`/`autonomy_paused`
differ in BOTH columns, so a `DO UPDATE` would fail twice; the `posting_error`
assertion proves the second downgrade actually happened rather than no-opping.

### 5. `occurred_at` equality — COMPARED INSIDE POSTGRES

`integration.test.ts:391-407` selects `refusal.occurred_at::text` and
`audit.created_at::text` in ONE SQL statement and compares the two strings in JS,
plus asserts `/\.\d{1,6}/` so the equality is not two zero-microsecond values
agreeing. `approval_audit_log.created_at` is `DEFAULT NOW()`
(`001_initial_schema.sql:469`) and `insertAuditLogAutoPolicy` does not write the
column (`audit.ts:232`), so both are `transaction_timestamp()`. No JS `Date`
round-trip. A site passing a JS `Date` loses µs (#520) and goes red.

### 6. `refusal_code` verbatim — DISCRIMINATING BOTH WAYS

`integration.test.ts:410` downgrades two responses with `judge_disabled` and
`judge_unhealthy` and asserts two distinct `refusal_code`s under one
`refusal_category` and one `posting_error`. Writing the CATEGORY
(`watchdog_unavailable`) or the MARKER
(`AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE`, which
`DOWNGRADE_MARKERS:31-32` shares between the two) collapses them and fails.
The unit loop (`every AutoPolicyDowngradeReason…`) additionally pins
`values[4] === reason` for all six members.

### 7. D1 — the seven negative-space titles — NONE ARE INERT

Each carries assertions that go red against a plausible wrong implementation:

* missing business / guarded-UPDATE-no-row (unit) — assert 0 `refusal_events`
  INSERTs **and** no `approval_audit_log` statement; catch a write hoisted above
  either guard.
* not-downgradeable / CAS-lost / no-review-anchor (live) — assert 0 rows **plus**
  the response, audit and notification state, so a no-op that silently mutated is
  also caught.
* kill switch — asserts all four pre-existing effects (`pending_approval`,
  `approval_method NULL`, `posting_error` marker, audit 1, notification 1, outbox
  `completed`) plus 0 rows; a kill switch that dropped the audit row fails.
* gate routing — source-shape regex over `judge-gate.ts` and
  `auto-policy-publish.ts`, with the union-coverage set equality as the closer.

The one honest caveat: the gate-routing case exercises files this diff does not
touch, so it is a pure regression pin for this branch.

---

## Contract conformance (field by field)

* **`invariants`** — all nine hold. `account_id` from the widened lock
  (`:107-112`), no second read (ladder length 10). `occurredAt:
  'transaction_time'` (`:211`). `subjectType: 'response'` / `subjectId:
  responseId` (`:209-210`). `refusalCode: reason` verbatim (`:203`). Write after
  `if (!downgraded)` (`:153` → `:195`). No `try/catch`. `src/lib/refusals/write.ts`
  untouched (confirmed absent from the diff). Standalone wrapper delegates to
  `InTx` (`:58`), one write site. `account_id NOT NULL` + deny-all RLS from 116.
* **`edge_cases`** — all eight have a matching test.
* **`non_goals`** — respected; `src/lib/approval/audit.ts` and
  `src/lib/refusals/**` are absent from the diff.
* **`allowed_edit_surface`** — no file outside the declared globs was changed
  (`.feature/**` and `docs/reviews/**` aside, both harness-owned).
* **`estimated_prod_lines: 90`** — actual production diff is 61 lines, 44 of them
  comment. Under estimate; no scope creep.
* **Schema constraints C1–C5** — the emitted row satisfies all five:
  `subject_type='response'` for `auto_post_revoked` (C1), subject whole (C2),
  `business_id NOT NULL` for a non-`autonomy_suspended` lane (C3),
  `refusal_code NOT NULL` (C4), `all_refusal_codes NULL` (C5).

---

## Low-confidence appendix (below the 80 % bar — not in the table)

* **`docs/…-deviations.md:107-111`** claims that a `vi.mock` specifier and an
  import specifier that disagree "mock DIFFERENT instances". Vitest resolves
  `vi.mock` targets to a module id, so `@/lib/refusals/vocabulary` and
  `./vocabulary` almost certainly share one mock. The style choice is still
  right; the stated reason is probably wrong. Not table-worthy because the
  behaviour is unaffected either way.
* **`unit.test.ts` "every AutoPolicyDowngradeReason…"** asserts
  `Object.keys(AUTO_POST_REVOKED_REFUSAL_CATEGORIES)` against a hardcoded ORDERED
  six-element list. `vocabulary.ts`'s own header says reordering is presentation
  only, so a benign reorder turns this red. Brittle-but-loud.
* **First-write-wins semantics** silently discard a genuinely distinct second
  decision (different reason, different category) for one response. This is
  contract-sanctioned (#1001's index, intake `edge_cases[3]`) and today there is
  no legitimate re-auto-approval path, so it is noted rather than raised. The
  observability consequence IS in the table.
* **Lock ladder**: the new `refusal_events` INSERT takes RI `FOR KEY SHARE` on
  `accounts` — checked whether that is a new edge. It is not:
  `approval_audit_log.account_id` FKs to `accounts` (migration 034) and its INSERT
  precedes the Refusal in the same tx, so the accounts lock is already held.
  `businesses` is already `FOR UPDATE` in the same tx. Consistent with
  `JudgeWorker.ts:111-116`'s documented "lane order ends at accounts". No
  deadlock edge introduced. Also confirmed no production `DELETE FROM businesses`
  exists, so this branch — the first writer to populate
  `refusal_events.business_id` — introduces no new FK-violation path.
* **`occurred_at` = transaction START**, not decision instant. Traced every
  downgrade call site (`auto-policy-publish.ts:561/572/602/615` via
  `LOCKED_GATE_CHECKS`, plus `applyJudgeGateInTx` at `:529`): all run in the gate
  ladder, before `resolvePreparationTarget`'s provider network call. Skew is a
  few queries. Within migration 116's sanctioned sentinel exception.
