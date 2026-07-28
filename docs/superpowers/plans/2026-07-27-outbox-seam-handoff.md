# Outbox-seam handoff — 2026-07-27 (evening)

Supersedes `2026-07-27-post-sweep-handoff.md`. Written at `main` = `70d97e4b`.

The next session's job is **§3 — build `ci:outbox-seam`**. Everything above it is
context; §3 is a decided spec, not an open question.

---

## 1. State

- `main` = `70d97e4b`; `staging` fast-forwarded and pushed to match.
- **Migrations head 090**, applied to staging AND prod, verified by introspection
  on both. No migration in flight — the next migration ticket is unblocked.
- All autonomy flags remain OFF in prod.
- Arch-review counter at 0 (reset by #594); this session opened no new findings
  beyond those it closed.

## 2. What closed this session

| Issue | PR | What landed |
|---|---|---|
| #591 | #598 | Two worker suites moved onto the shared `sql` mock harness; both false comments deleted |
| #590 | #599 | `ci-audit-wiring` guard test; `ci:live-db-suites` wired into both gates; CLAUDE.md corrected |
| #592 | #600 | `exec` added to `SQL_TAG_NAMES`; new `sql-executor-tag-name` static-policy rule |
| #593 | #601 | Migration 090 — `solicitation_asks.evidence` discriminant enforced at write time |
| — | #602, #603 | 090 applied + verified on staging, then prod |
| #573 follow-up | #604 | `ci:live-db-suites` was auditing 49 of 54 suites; detection now keys on helper imports |

## 3. THE WORK: `ci:outbox-seam` (#568)

### Why this exists

#568 asked for a decision — "make the helper module the single owner (add a CI
audit failing on raw INSERTs outside it) **or** document which categories
legitimately bypass". #588 shipped neither. It shipped `job-outbox-status.ts` +
`ci:outbox-status`, which guards the in-flight **status vocabulary** — useful,
orthogonal, and not what was asked. #568 was then closed as decided.

The recorded justification also does not survive reading. The arch-review log
says a fragment seam "would have been actively wrong (a bind parameter inside
`ON CONFLICT … WHERE` defeats partial-index inference), so guarding the
vocabulary is the correct seam." The premise is true; the inference is not.
`enqueuePublishResponse` (`src/lib/shared/job-outbox-helpers.ts:243`) is a typed
helper that hand-spells both literals:

```sql
ON CONFLICT (topic, aggregate_id)
WHERE topic = 'publish_response' -- topic-audit-ignore: partial-index inference needs a literal
  AND status IN ('pending', 'dispatching', 'dispatched')
```

Partial-index inference rules out **one generic parameterized enqueue
function**. It says nothing about whether 28 call sites should hand-write their
own INSERT. Two questions got conflated.

The owner was then grilled on the real decision. §3.2 is their answer.

### 3.1 Measured ground truth

> **CORRECTED 2026-07-27 (later) — the table below was wrong; see §3.4.** The
> implementing session re-measured with the AST classifier it built. The tree
> had not moved; the original numbers were mis-derived. Read §3.4, not this
> table.

14 typed helpers in `src/lib/shared/job-outbox-helpers.ts`, covering 14 of the
32 `QUEUE_NAMES` topics. 28 production files write raw `INSERT INTO job_outbox`
(excluding the helper module itself):

| Category | Files | Status |
|---|---|---|
| set-based `INSERT … SELECT` fan-out | 9 | sanctioned — a single-row helper cannot express it |
| single-row, **no helper** for its topic | 18 | sanctioned — "do not backfill on spec" |
| single-row, **helper exists** | **1** | **violation** |

The one violation: `src/lib/onboarding/create-business.ts` hand-writes
`VALIDATE_PLACE_ID` while `enqueueValidatePlaceId` exists.

Fan-out files (9): `worker/ingress/stripe/shared.ts`,
`worker/ingress/zernio/zernio.ts`,
`worker/background/pollers/EngagementMonitorPoller.ts`,
`worker/jobs/DrainOwnerConnectWorker.ts`,
`worker/background/schedulers/{MonthlyImpact,RankingTracking,WeeklySummary}Scheduler.ts`,
`worker/background/pollers/NotificationFailoverPoller.ts` (has both shapes),
`src/app/api/auth/signup-status/route.ts`.

`NOTIFY_ADMIN` is the most-duplicated unhelpered topic — 5 raw sites:
`worker/jobs/zernio/zernio-ingest-shared.ts`,
`worker/jobs/zernio/ingest-failed-hook.ts`, `src/lib/reviews/process-review.ts`,
`worker/jobs/publisher/review-lookup.ts`, `worker/jobs/publisher/failed-hook.ts`.

### 3.4 What the AST classifier actually measured (supersedes §3.1)

Built and run as `ci:outbox-seam`. 28 production files, **38** `INSERT INTO
job_outbox` statements (§3.1 counted files, not statements):

| Category | Statements | Status |
|---|---|---|
| set-based `INSERT … SELECT … FROM` fan-out | 6 (in 5 files) | sanctioned |
| single-row, topic has **no** helper | 29 | sanctioned |
| single-row, topic **has** a helper | **3** | **violation** |

Two corrections, both in the direction §3.3 warned about:

- **Fan-out is 5 files, not 9.** §3.1 counted "contains `SELECT`" as fan-out.
  Four of its nine — `worker/ingress/stripe/shared.ts`,
  `NotificationFailoverPoller.ts`, `EngagementMonitorPoller.ts`,
  `src/app/api/auth/signup-status/route.ts` — are `INSERT … SELECT … WHERE NOT
  EXISTS` with **no FROM clause**, which insert at most one row. So is
  `enqueueValidatePlaceId`, a typed helper. Fan-out requires a row-producing
  top-level `FROM`.
- **3 violations, not 1.** `NotificationFailoverPoller.ts:261` and `:401` both
  write `SEND_NOTIFICATION`, which `enqueueSendNotification` owns. §3.1 missed
  them by classifying the whole file as fan-out.

Also: `NOTIFY_ADMIN` has **6** raw sites, not 5 — §3.1's list omitted
`worker/jobs/publisher/publisher-error-handlers.ts:303`. And 18 of the 32
QUEUE_NAMES topics have no helper (17 of those 18 have a raw site;
`SEND_OWNER_EMAIL` has none, its writers using the legacy
`notify_owner_*` literal aliases instead).

How the three were resolved:

- `create-business.ts:377` → calls `enqueueValidatePlaceId`. Its "the helper's
  dedup guard would be dead weight here" comment was a real argument for a
  negligible cost, and §3.2 decision 2 had already overruled it.
- `NotificationFailoverPoller.ts:261` → calls `enqueueSendNotification`, whose
  input widened by one optional `failover` field. Not speculative generality:
  `SendNotificationPayload` has always declared that field, so the helper was
  narrower than the payload it emits, and that gap is *why* the poller
  hand-wrote its own INSERT.
- `NotificationFailoverPoller.ts:401` → the one `outbox-seam-ignore`. It runs
  outside any transaction (no state change to be atomic with), so it cannot
  take a helper's `TransactionSql` at all, and it needs an in-flight dedup
  guard `enqueueSendNotification` deliberately does not carry.

### 3.2 Decisions (owner-confirmed — implement, do not relitigate)

1. **Enforce the carve-outs CLAUDE.md already documents.** Not full
   helper-ownership (would need ~18 new helpers plus a fan-out helper shape the
   current signature cannot express), not ratify-prose-only.
2. **Predicate:** a *single-row* raw `INSERT INTO job_outbox` for a topic that
   **has** a typed helper is a violation. Fan-out and no-helper topics stay
   legal. Fix `create-business.ts` in the same PR so the audit ships with an
   **empty allowlist** — the rule is true, not baselined.
3. **Helper coverage is DERIVED** from `job-outbox-helpers.ts`, never
   hand-listed. Accepted consequence: writing `enqueueNotifyAdmin` fails CI
   until all 5 raw `NOTIFY_ADMIN` sites migrate in that same PR. A topic never
   has two live enqueue owners.
4. **Escape hatch:** per-line `outbox-seam-ignore` pragma carrying a written
   reason, matching `ci:outbox-status` / `ci:outbox-topics` /
   `ci:reviews-status` / `ci:response-status`. Reason it exists: with no
   deferral, the rational move becomes *don't write the helper*, which freezes
   all 18 unhelpered topics permanently and makes the seam worse.
5. **Home:** new `scripts/ci/outbox-seam-audit.ts` + `ci:outbox-seam`, reusing
   `lib/sql-tag-scan` and `lib/ratchet-harness`. `ci:outbox-topics` is a poor
   host — its predicate is "file contains a raw topic *string literal*",
   returning a boolean per file; this needs per-INSERT topic extraction.

### 3.3 Implementation notes

- **Classify fan-out structurally (AST), not by regex.** A first pass at this
  used a lazy quantifier and confidently reported "0 fan-out" when the answer is
  9. Prove the classifier by planting one INSERT of each shape.
- **Self-exclude `job-outbox-helpers.ts`** — it contains INSERTs by definition
  (`static-policy-audit.ts`'s `SELF` is the precedent).
- **Wiring is forced.** `src/__tests__/ci-audit-wiring.test.ts` (#590) fails the
  build until `ci:outbox-seam` appears in BOTH `ci.yml`'s lint job and
  `lefthook.yml`. This guard cannot repeat #573's unwired-guard story.
- **CLAUDE.md invariant #2** needs one added line: helper-covered topics must
  use their helper, enforced by `ci:outbox-seam`. The existing "a topic with no
  helper (17 today — do not backfill on spec)" line stays true; correct the
  count to 18 if the measurement above still holds.
- **Open process question for the owner:** #568 is closed. Reopen it as this
  work's home, or file a fresh issue referencing it? The recommendation given
  was *reopen* — it is #568's actual resolution, and reopening keeps the record
  honest that it was closed without the decision being made.

## 4. The operating rule (unchanged, and it keeps paying)

**Prove each guard by breaking it. A passing run is not evidence a guard is
load-bearing.** Two of this session's four fixes were found *only* by breaking:

- **#592** — `ci:outbox-status` could not see `src/lib/shared/outbox.ts`, the
  module owning the very `job_outbox` predicates it guards. A planted broken
  status group passed on `main`, failed after.
- **#604** — `ci:live-db-suites` audited 49 of 54 suites, missing
  `batch-builder.integration.test.ts`, the file whose deadlock IS #573.

And one probe changed the work rather than confirming it: **#593's first
constraint did not fix the bug.** `evidence->>'decision' = status` yields NULL
when the key is absent, and a CHECK passes on NULL, so the exact #593 row still
got in. Caught before the migration touched any environment.

Corollary earned twice now: **a detector keyed on a literal that the codebase's
own helper abstracts away is blind and reports success.** #592 (`exec` vs
`SQL_TAG_NAMES`) and #604 (`TEST_DATABASE_POOL_URL` vs the live-DB helpers) are
the same bug. When writing `ci:outbox-seam`, key on the stable seam — derived
helper coverage and AST topic extraction — not on a string list.

Watch your probes too: two probes in this session were themselves wrong (a lazy
regex reporting 0 fan-out; renaming `acquireLiveDbLock` to
`acquireLiveDbLockRENAMED`, which still contains the substring being grepped).
A probe that fails to go red may be a broken probe, not a working guard.

## 5. Gotchas earned this session

- **A CHECK constraint rejects only FALSE — it PASSES on NULL.** `col->>'k' =
  other` is NULL when the key is absent. Use `IS NOT DISTINCT FROM`. This is in
  the `new-migration` skill's checklist and was still easy to walk into.
- **`git checkout --` during a probe reverts your own edits too.** Back probe
  targets up to the scratchpad and restore by copy, not by git.
- **A backtick inside a SQL comment nested in a JS template literal terminates
  the template.** Cost one parse error in `batch-view.integration.test.ts`.
- **`sql.json(null)` binds SQL NULL, not JSONB `'null'`.** To exercise
  `jsonb_typeof`, cast explicitly: `'null'::jsonb`.
- **The shared mock harness now records `inTransaction`** and exposes
  `isInTransaction()`, so a mocked collaborator can assert it ran inside the
  same transaction as the state change (invariant #2's actual claim).
- **`assertSchemaReady` gained a `constraints` requirement kind**, checking
  `convalidated` — a constraint left NOT VALID constrains new writes and proves
  nothing about existing rows. Needed because a constraint-only migration has no
  table/column/index to point at.

## 6. Open, not taken

- **#582** — `purge-stages.ts:256` deletes `contact_csv_uploads` without the
  `csv_ingest` advisory lock that `ingest.ts:128/507` take religiously.
  `ingest.ts:404` documents the hole in a comment. Same shape as #592 in data
  rather than CI. Bounded urgency: solicitation is flag-gated and unbuilt in prod.
- **#375** — open since 25 Jun, needs a rebase. *Upsert Sentry cron monitor so
  the dead-man check-in registers.* If the monitor was never upserted, the
  `HealthAlertPoller` dead-man switch has been non-functional in prod — and
  #587's replica-cardinality alerting rides on that poller. Highest-value
  unknown on the board after #568.
- **#581, #563** unchanged. Three Dependabot action bumps (#579, #424, #317).
- The arch review's standing question — whether #590's meta-audit closed the
  "checks that appear to run but exercise nothing" class — is now better
  evidenced but not answered. #604 found another instance *after* #590 landed,
  which is itself the answer's first data point.
