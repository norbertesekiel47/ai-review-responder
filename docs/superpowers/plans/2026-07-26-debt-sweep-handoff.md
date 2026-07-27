# Debt sweep handoff — 2026-07-26 (post-#565)

Continues `2026-07-26-post-528-handoff.md` §"Next efforts" item 2. Covers the
sweep from PR #583 (#565 bundle) through #573, #567, and the #568 decision.

---

## 1. Three PRs are open, green, and unmerged

All CI checks pass on each. They were not merged because the merge action was
denied by a permission classifier in the working session — merging is a manual
step for the owner.

| PR | Branch | What | Checks |
|---|---|---|---|
| #584 | `docs/565-labnotes-promotions` | Lab-notes promotions + arch counter 4 → 5 | 14/14 pass |
| #585 | `fix/573-live-db-suite-ddl-deadlock` | #573 fix — run-time migration DDL removed from live-DB suites | 14/14 pass |
| #586 | `fix/567-single-replica-guard` | #567 — single-replica CI rule + boot identity signal | 13/13 pass |

```bash
gh pr merge 584 --squash --delete-branch
gh pr merge 585 --squash --delete-branch
gh pr merge 586 --squash --delete-branch
git checkout main && git pull --ff-only
git checkout staging && git merge --ff-only main && git push origin staging
```

**Merge-order note.** #584 and #585 both append to the tail of
`.claude/reference/lab-notes.md`; whichever lands second needs a trivial
tail merge (distinct sections, no semantic overlap). #585 and #586 both edit
`.claude/CLAUDE.md` but at deliberately different anchors — no conflict
expected.

**This handoff file rides on #584.**

---

## 2. Architecture review is DUE

`.claude/reference/arch-review-log.md` now reads **5 merges** since the last
pass, which is the ≥ 5 threshold. Not started — scheduling is the owner's call.
The log records the scope the pass should cover: the map-#528 completion wave,
plus the disposition of the 2026-07-24 findings (S1/S2 closed by #565, S3/S4
shipped as built, **R1 closed by #586**, **R2 decided — see §5**), plus the two
measurement-integrity items #581 and #582.

---

## 3. #573 — CLOSED by PR #585 (root cause was not the filed hypothesis)

**Root cause.** Eight live-DB suites re-applied migration SQL in `beforeAll`.
That DDL takes `AccessExclusiveLock` on `agent_runs` / `solicitation_*`; a
sibling suite holding ordinary row locks on the same relations in the opposite
order deadlocks against it, and Postgres picks the victim — which is why the
failure moved between suites and between tests within a suite.

**Why gate-only.** vitest's `integration`-project serialization
(`fileParallelism: false` + `groupOrder`) is a **per-process** guarantee.
`scripts/verify-gate.sh:70` launches the intake's `verification_commands` in
parallel with the main `test` row, and #565's intake declared two
`pnpm test …integration.test.ts` commands → three vitest processes on one DB.

**Two claims in the issue were false** and are corrected in issue comments:
`integration-lifecycle.test.ts` self-hydrates `.env.local`, holds no lock, and
misses the `*.integration.test.ts` glob; and CI *does* run these suites — it
never saw the deadlock because it runs a single vitest process.

**Differential (reproducible):** same two suites in one process 0/4; two
processes 3/6; gate-shaped three processes 5/6 → **0/8 after the fix**.

**Second bug found and fixed:** the 074 shape suite committed an unconditional
re-apply, reverting 088's widening of `agent_outcomes_outcome_kind_check` and
leaving the shared test DB **below head** for every suite after it. Masked for
as long as it existed because batch-builder re-applied 088 every run.

**New durable pieces:** `assertSchemaReady` + the migration→objects map
(`src/lib/shared/__tests__/helpers/schema-ready.ts`), `pnpm test:db:setup`,
`ci:live-db-suites`, and `helpers/live-db-lock.ts` (renamed from
`feature-543-database-lock`).

---

## 4. #567 — CLOSED by PR #586

Railway docs settled the shape: `numReplicas` is only reachable nested under
`deploy.multiRegionConfig.<region>`; config-as-code **overrides the dashboard**;
and Railway injects a per-replica id but **no replica count**, so no process can
assert it is alone. Scaling up starts a new replica *without* redeploying the
existing one, so the new replica's boot is the observable event.

Shipped: a `ci:static-policy` `railway-replicas` rule (both key spellings plus
the TOML table-header form), and `worker/config/replica-identity.ts` logging +
Sentry-tagging `replica_id`/`deployment_id` at boot. **Two `replica_id`s under
one `deployment_id` is the signal.**

Deliberately not built: an active singleton lease that refuses to boot as a
second replica — it risks crash-looping on a benign deploy overlap. The trade is
recorded in the scaling backlog.

---

## 5. #568 — DECIDED, NOT IMPLEMENTED (this is the next task)

Fully grilled with the owner; every branch resolved. **Do not re-litigate — build it.**

### Why R2 as filed does not hold

Inventory of every production `INSERT INTO job_outbox`:

| Finding | Count |
|---|---|
| Raw-written topics with **no helper at all** | **17 of 20** |
| Raw-written topics where a helper exists (real bypass) | 3 |
| "Same enqueue written twice, identically" | **0** |

All three bypasses are deliberate: `DrainOwnerConnectWorker.ts:56` is a
set-based `INSERT … SELECT` a per-row helper cannot express;
`create-business.ts:377` carries a comment saying the helper's dedup guard is
dead weight there; `NotificationFailoverPoller.ts:261,401` need a
`failover: { reason }` payload field and their own in-flight guard that
`enqueueSendNotification` (a plain INSERT) does not provide.

### The real drift, with precedent

`('pending', 'dispatching', 'dispatched')` is hand-written at **~30 TS sites**
(8 of them *inside* `job-outbox-helpers.ts`) and **~19 migration sites**, with
**no named constant**. Migration **018 exists solely** to rebuild
`idx_jo_sync_reviews_inflight` because 004 shipped it missing `'dispatching'`.
This drift has already bitten this repo once.

It cannot simply be parameterized: a bind parameter inside an `ON CONFLICT`
predicate breaks partial-index inference (CLAUDE.md's byte-for-byte gotcha).

### Locked decisions

1. **New file `src/lib/shared/job-outbox-status.ts`** exporting
   `OUTBOX_IN_FLIGHT_STATUSES = ['pending','dispatching','dispatched'] as const`.
   Standalone vocabulary module mirroring `queue-names.ts`, so a CI script can
   import it without pulling in the 694-line helper module's postgres deps.
2. **New `scripts/ci/outbox-status-audit.ts` + `pnpm ci:outbox-status`.** Rule:
   any `job_outbox` status group must equal the canonical set
   (whitespace-normalized — migration 080 writes it unspaced; member order is
   significant). The audit derives its expected set from the constant, never
   re-types it.
3. **Escapes.** Per-line `-- outbox-status-audit-ignore` (SQL) /
   `// outbox-status-audit-ignore` (TS), mirroring `ci:response-status`. For
   migrations — which are **immutable, hook-enforced** — exceptions live in a
   file allowlist inside the audit, with a reason each:
   - `004_sync_reviews_dedup_constraint.sql` — superseded by 018, which rebuilt
     the index to cover `dispatching`.
   - `065_archival_watchdog_indexes.sql` — `idx_jo_recovery` is post-dispatch by
     design; `pending` excluded deliberately.
4. **Scope:** `src/` + `worker/` + `supabase/migrations/`.
5. **No call-site refactor.** All ~26 SQL sites stay byte-identical — required
   for `ON CONFLICT` index inference, and it keeps the change zero-behavior-risk.
6. **No "raw INSERT is banned" audit.** Instead document the three sanctioned
   raw categories and codify the de facto forward rule in CLAUDE.md and the
   `outbox-pattern` skill:

   > Enqueue via a typed helper for a NEW single-row topic. Raw
   > `INSERT INTO job_outbox` is sanctioned for: set-based `INSERT … SELECT`
   > fan-out; a dedup/payload variant the helper does not model; a topic with no
   > helper (17 today — do not backfill on spec). The in-flight status set is
   > guarded by `ci:outbox-status`.
7. **Close #568** with the above as the answer of record.

### Two implementation risks to handle during the build

- **False positives from co-located groups.** A template mentioning `job_outbox`
  may also filter a joined table's status, e.g.
  `('approved','edited','awaiting_owner_connect')` (11 occurrences repo-wide).
  Bind the check to the job_outbox alias rather than flagging any `status IN`
  inside the template; verify against the current tree before shipping.
- **Whitespace and ordering.** Postgres compares parsed expressions, so spaced
  and unspaced forms are equivalent — normalize whitespace, but treat member
  order as significant, and confirm no current site is order-divergent.

Reuse `scripts/ci/lib/sql-tag-scan.ts` and the ratchet harness; structure
mirrors `scripts/ci/response-status-audit.ts`.

---

## 6. Loose ends worth a ticket

- **A local `verify-gate.sh --review` needs three exports, not one.** With only
  `TEST_DATABASE_POOL_URL` set, four integration suites fail with
  `ECONNREFUSED …:5432`. CI sets `DATABASE_POOL_URL` too. Correct local setup:

  ```bash
  export TEST_DATABASE_POOL_URL=postgresql://…@localhost:5499/test_ws4
  export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
  export ALLOW_E2E_DB_WRITES=true
  ```

  With all three, the integration project is 49/51 files and 298 tests passing.
- **`migration-056-account-offboarding.integration.test.ts`** — 2 deny-all RLS
  assertions fail locally, reproduced identically on `origin/main`. A
  local-bootstrap artifact (the stub `authenticated` role), not a regression.
  Unticketed.
- **#581 / #582** remain open and are inputs to the architecture review.
