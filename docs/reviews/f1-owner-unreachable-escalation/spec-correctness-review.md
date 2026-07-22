# F1 Owner-Unreachable Escalation — Spec & Correctness Review

**Scope:** `git diff main...HEAD` (merge-base `880435ba`) against the locked intake
contract `.feature/intake.json`. Review-only; no code changed.

**Verdict:** PASS. No finding reaches the ≥80%-confidence defect bar. The feature
implements every named behavior, violates no non-goal, upholds every invariant,
covers every named edge case with tests, ships every promised test, and stays
inside the (amended) allowed edit surface. Both intake verification commands pass
(`ci:tenant-scope` 405=405 baseline; `ci:rls-audit` static gate). All 76 changed-file
unit tests pass.

---

## 1. goal / user_visible_behavior

All five `user_visible_behavior` items are implemented, and nothing beyond them:

1. **`completion_reason='owner_unreachable'` marker** — `NotificationWorker.ts:77-80`
   calls `markOutboxOwnerUnreachable` only on `eligibility.reason === 'no_verified_enrollments'`,
   replacing the prior silent `markOutboxCompleted`. `outbox.ts markOutboxOwnerUnreachable`
   writes the marker via the shared attempt-guarded CAS.
2. **Durable `checkOwnerUnreachable` health finding** — `checks.ts:185-215`. Age FLOOR
   (`r.created_at < NOW() - make_interval(...)`), keyed off the LATEST completed
   send_notification reason, fires every cycle until resolved (no completion-time window).
3. **24h-deduped admin email** — `NotificationFailoverPoller.ts` `processOwnerUnreachable`
   via `tryClaimAlert(..., 'admin_notification_owner_unreachable', ...)`.
4. **Re-enqueue guarded by no-in-flight check** — advisory-locked `sql.begin` re-check
   with `in_flight` gate before the `INSERT INTO job_outbox`.
5. **`checkZeroDeliveryNotifications` de-conflation** — `checks.ts:156`
   `jo.completion_reason IS DISTINCT FROM 'owner_unreachable'`.

No unrequested behavior found. The all-failed and stale arms are byte-for-byte unchanged.

## 2. non_goals — all respected

- No new `responses.status` value; draft stays `pending_approval` (worker returns without
  status change; all predicates gate on `status = 'pending_approval'`).
- No owner-facing UI change — worker/poller/health only.
- Retry is poller-driven only; no hook into channel-enrollment verification.
- All-failed / stale arms and their `approval_request`-scoped predicates untouched.
- Moderation / auto-approval / subscription-guard / posting untouched.
- `review_escalations` not referenced.

## 3. invariants — each verified

- **Attempt-guarded marker CAS:** `markOutboxOwnerUnreachable` composes the shared
  `dispatchedRow(exec, id, attempt)` predicate — identical CAS to `markOutboxCompletedIfOwned`;
  0-row → `warnOutboxNoop`. Property test (`outbox.test.ts`) + live CAS test (integration
  Step 6b) both pass.
- **Single-source marker:** only `NotificationWorker` writes the marker; `checkOwnerUnreachable`
  and `processOwnerUnreachable` only READ `completion_reason`; neither re-derives channel
  eligibility in SQL.
- **Category disjointness:** owner-unreachable requires `NOT EXISTS approval_request delivery`;
  all-failed/stale both require `EXISTS approval_request delivery` (`NotificationFailoverPoller.ts:326-329, 442-447`).
  Mutually exclusive.
- **No-self-erase:** predicates anti-join on `nd.template = 'approval_request'`; the admin email
  writes a `admin_notification_owner_unreachable` template row, which cannot satisfy the anti-join.
  Encoded by integration test "still counts when only an admin-template delivery exists."
- **Self-clearing:** an `approval_request` delivery makes the NOT EXISTS false → row exits both
  surfaces, no marker reset. Integration test covers it.
- **Retry idempotency (at-most-once):** re-check + INSERT inside `pg_advisory_xact_lock`
  (`hashtext('send_notification_retry:'+id)`); candidate-level in-flight exclusion + locked
  `in_flight` re-check. Twice-run integration test asserts exactly one pending retry.
- **Admin-alert 24h dedup:** `tryClaimAlert` advisory-lock + 24h window, best-effort — same
  semantics as existing arms.
- **Current-state-not-sticky:** scalar subquery `ORDER BY jo.created_at DESC LIMIT 1` over
  `status='completed'` rows; `= 'owner_unreachable'` is NULL-safe (NULL/other reason → row
  excluded). A later NULL-reason completion supersedes. Integration test "clears when a later
  NULL-reason completion supersedes."
- **Tenant scope:** three health snippets + failover candidate/re-check snippets allowlisted
  under `background-global-scan`; `ALLOWLIST_BASELINE` bumped 395→405; `ci:tenant-scope` passes.
- **Age FLOOR not window:** confirmed `r.created_at < NOW() - interval` (not `completed_at`).

## 4. edge_cases — all handled/tested

Owner enrolls after unreachable (self-clear); owner never enrolls (bounded churn via in-flight
gate + BATCH_LIMIT 200 + 24h dedup); superseded/posted/archived excluded; subscription-skip /
all-flag-disabled NOT marked (`getEligibleChannels` returns a distinct reason or `ok:true` with
empty filtered list — neither hits the marker branch); brand-new draft suppressed until age floor;
stale worker CAS no-op; retried-then-all-failed re-routes to all-failed arm; `completion_reason`
nullable/additive. Each has a corresponding integration or unit assertion.

## 5. tests_to_add — all present

| Promised test | Location | Present |
|---|---|---|
| fast-check property: marker CAS attempt-guard | `outbox.test.ts` (200 runs) | ✓ |
| integration: checkOwnerUnreachable fires + no-self-erase | `checks.integration.test.ts` | ✓ |
| integration: self-clearing / supersession / archived / below-age / no-marker | `checks.integration.test.ts` | ✓ |
| integration: checkZeroDelivery excludes marked rows | `checks.integration.test.ts` | ✓ |
| unit: NotificationWorker branch → markOutboxOwnerUnreachable, no dispatch | `NotificationWorker.test.ts` | ✓ |
| integration/unit: failover arm re-enqueue + 24h dedup + at-most-once + disjoint + CAS | `NotificationFailoverPoller.{integration.,}test.ts` | ✓ |

Tests assert real behavior (real-Postgres delta assertions for predicates; mock-sql control-flow
for the poller branches, backed by the integration suite for the SQL itself).

## 6. allowed_edit_surface — clean

Every changed file is within the declared surface, including `scripts/ci/tenant-scope-allowlist.ts`
(added by the owner-approved amendment recorded in `.feature/intake.json` invariant + deviations
log). Migration numbered `083_*.sql`. No stray top-level dir or file.

## 7. Correctness — no defect found

- **`aggregate_id` correlation:** `checkOwnerUnreachable` / failover correlate send_notification
  rows via `jo.aggregate_id = r.id`. Confirmed the original enqueue
  (`job-outbox-helpers.ts:504-514`) inserts `aggregate_id = responseId`, so the subquery finds
  the right rows. (Note: `checkZeroDeliveryNotifications` correlates via `payload->>'response_id'`
  — a stylistic inconsistency, but both are correct since the two are equal for send_notification.)
- **NULL-safety:** `reviewer_name` coalesced (`row.reviewer_name ?? 'a customer'`) before
  `escapeHtml`; scalar-subquery `= 'owner_unreachable'` excludes NULL/other reasons in WHERE.
- **Advisory-lock transaction:** `sql.begin` returns `unreachable`; a commit failure throws →
  `continue` → no email (R3-C). Retry INSERT gated on `!in_flight` inside the lock.
- **Disjointness under retry:** a retried-then-failed draft acquires an `approval_request`
  delivery row → exits owner-unreachable, enters all-failed (correct routing).
- **Migration 083:** additive nullable TEXT, `lock_timeout 3s`, `IF NOT EXISTS`. No index —
  deliberately reuses migration 082 indexes (documented in the migration header). Reasonable;
  not a correctness issue.

Verification: `pnpm ci:tenant-scope` → passed (405/405). `pnpm ci:rls-audit` → static gate
passed. `pnpm vitest run` over the 4 changed test files → 76 passed.

---

## Appendix — low-confidence / non-blocking observations

These are NOT defects in the F1 change; recorded for completeness only.

1. **Pre-existing nullable `reviewer_name` in the all-failed/stale arms.** Those arms type
   `reviewer_name` as `string` and call `escapeHtml(row.reviewer_name)` without a coalesce,
   though `reviews.reviewer_name` is nullable (migration 001). If a NULL reviewer ever reaches
   those arms, `escapeHtml` would throw. This is pre-existing, unchanged by F1, and outside the
   edit surface; the NEW owner-unreachable arm handles it correctly (`?? 'a customer'`). Worth a
   separate follow-up, not this PR.
2. **Correlation-column inconsistency.** `checkOwnerUnreachable` uses `jo.aggregate_id`;
   `checkZeroDeliveryNotifications` uses `jo.payload->>'response_id'`. Both correct today; a
   future refactor could standardize on `aggregate_id` (indexed, no JSONB extraction).
3. **`checkZeroDeliveryNotifications` NOT EXISTS is blanket (any template), not
   `approval_request`-scoped** unlike the owner-unreachable predicate. Safe today because the
   `IS DISTINCT FROM 'owner_unreachable'` clause removes marked rows before the anti-join, and
   the admin-owner-unreachable email is only sent for marked rows. If a future template were ever
   written for a non-owner-unreachable zero-delivery draft, it could self-erase there — but that
   is not introduced here.
4. **Migration 083 omits the partial index named in `existing_patterns_to_follow`** — deliberate
   and documented (reuses 082 indexes); flagged only because the pattern reference mentioned it.
