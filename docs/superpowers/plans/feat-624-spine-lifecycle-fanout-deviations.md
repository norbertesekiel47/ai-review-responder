# feat #624 — spine lifecycle + fan-out primitives: deviations log

Dated entries for anything the plan did not anticipate. One entry per surprise.

## Step 6.5 read-back — triage verdicts (2026-07-29, all 16 entries)

Every entry read end to end and verdicted. **16 ACCEPT, 0 RE-PLAN** — no entry
invalidates a locked intake decision, so the abort criteria do not apply.

Evidence backing the ACCEPTs on the four T1 blockers: the final gate run has all
7 live-DB integration suites PASS against a **freshly re-provisioned** test DB
(dropped and rebuilt bootstrap + 001…091), so their fixes are proven against
current schema rather than against a hand-patched database.

| # | Entry | Verdict |
|---|---|---|
| 1 | 12 missing promised titles in tasks reported DONE | **ACCEPT** — closed in `140a2889`; count is now 52/52 and the check runs per task |
| 2 | Two gate rows fail for harness self-races | **ACCEPT** — same class as entry 16, root-caused and fixed there |
| 3 | T1's new table reds an existing offboarding suite | **ACCEPT** — T8 closed it; `table-disposition.test.ts` verified green |
| 4 | 091 rejects every unapproved batch (BLOCKER) | **ACCEPT** — inner `IS TRUE` on both arms; 091 suite green |
| 5 | 091 dropped D19 Correction 2 from the persona CHECK (BLOCKER) | **ACCEPT** — exclusions merged; promised title 15 green |
| 6 | 088 shape suite silently reverts 091's widening (BLOCKER) | **ACCEPT** — fixed in `b9ad24a6`; 088 and 091 suites both green in either order |
| 7 | 091 not re-runnable, contrary to its own header | **ACCEPT** — §3 guarded `DO` block; three consecutive applies proven |
| 8 | T1 overrides `auth.uid()` in a rolled-back tx to exercise RLS | **ACCEPT** — sound: DDL/GRANTs are transactional, suite holds the cross-process lock, assertion is meaningful in both directions |
| 9 | T2: only one malformed gap-analysis ref is inside Appendix A | **ACCEPT** — correctly scoped; the second ref is off-surface. **Carries an open follow-up** (see below) |
| 10 | T2 added a second ADR 0014 consequences bullet | **ACCEPT** — B11 cited a record that did not exist; writing it where B11 points is the fix, no new semantics |
| 11 | T5 reads the disposition source off `agent_runs.error` | **ACCEPT** — the union's only writer is `failSolicitationBatchRun`; single owner, read in SQL, no new JSONB parse site. Pins a caller ordering that #628/#630 must honour |
| 12 | T1 never registered `solicitation_outreach` in `TENANT_TABLES` | **ACCEPT** — registered; coverage proven real by negative control (perturb the snippet → audit reds) |
| 13 | T7 ships `(sql)` not the planned `(sql, cfg)` | **ACCEPT** — an unused parameter carried to satisfy prose is worse than the deviation; threshold keeps one owner |
| 14 | T7's first pass proved shape but not that the predicate matches a row | **ACCEPT** — closed with a live-DB case seeded through the spine writer; two discrimination probes both red |
| 15 | Surface amendment #1 (`src/lib/approval/__tests__/**`) | **ACCEPT** — owner-approved; carve-out claims verified against `071:51` / `071:17-18` / `transitionRunToTerminal`; pin test still bites |
| 16 | The verify gate was racing itself (2 self-colliding commands) | **ACCEPT** — provisioning and duplicate-build commands removed; 16 failing rows → 1 |

### The one open follow-up, carried deliberately

Entry 9 owes a one-line cosmetic fix to line 13 of
`docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` (a
malformed nested-backtick reference that splits a path across two code spans).
That file is not on the allowed edit surface and the content is purely cosmetic,
so it is **not** being fixed here rather than widening the surface a second time.

### Two things carried out of #624 that are NOT #624's to fix

Restated here so the review agents do not re-raise them as new findings:

1. **Migration 088 has a live NULL hole.**
   `solicitation_asks_status_reason_consistency` admits `('withhold', NULL)` —
   that arm evaluates to NULL and a CHECK accepts NULL. Proved empirically. 091
   is immune (`IS TRUE` throughout); the asks table is not. Pre-existing,
   deliberately out of scope, worth its own ticket.
2. **`checks.integration.test.ts` self-heals migration 083** with an inline
   `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `beforeAll` — the exact
   "apply, don't assert" pattern #573 outlawed, and invisible to
   `ci:live-db-suites` because it uses no `.unsafe(`. Found by T7, pre-existing,
   off-surface. Worth a ticket **and** an audit-coverage gap to close.

## 2026-07-29 — the first gate run exposed 12 missing promised titles in tasks reported DONE

**What happened.** The first `scripts/verify-gate.sh` run on this branch (after T1–T4
landed) reported `promised-tests FAIL` with **30** missing titles. 18 belong to the
unbuilt T5–T8 and are expected. **The other 12 belong to tasks already reported
complete**, and that is the finding:

- **10 are migration-shape titles T1's suite never implemented.** The 091 suite has 16
  `it(...)` titles; the intake promises 26 for the migration. The gap is exactly the
  titles added when the intake was **re-signed** during round 1 (48 → 52 titles,
  `tests_to_add` 33 → 40): `solicitation_batches rejects an approved batch with no
  approval method`, `… rejects a halted batch with no halt reason`, `… accepts a batch
  closed by generation_failed before approval`, `solicitation_outreach rejects a null
  disposition_reason for every reason-bearing delivery status`, `… requires a null
  disposition_reason for a sent row`, `… rejects a queued row carrying a
  body_redacted_at stamp`, `… rejects reusing an attempt_no for the same ask`, `…
  rejects an attempt_no of zero`, `auto_approval_policies rejects the reply persona
  paired with the sending action class`, `… rejects a reply row with a 60 minute veto
  window`.
- **1 is T3's**: `the send_batch_closed step is attributed to the solicitation persona`.
- **1 is T4's**: `deriveRunDisplayState applies the unchanged stalled threshold to
  review_handler runs`.

**Why it happened, and it is the same mistake twice.** In T3 and T4 the *assertion*
exists — `send_batch_closed`'s attribution is asserted inside `attributes pipeline steps
to the personas the design doc names`, and the review_handler non-change is asserted
inside `stalledThresholdMsForKind returns the 48-hour default for every other run kind`.
Folding an assertion into a neighbouring test satisfies the behaviour but **not the
contract**: the gate matches promised titles *verbatim*, and a title that exists only as
a line inside another test is invisible to it. T1's gap is the same failure one step
earlier — the suite was written against the pre-re-signing title list and never
re-reconciled after the intake changed underneath it.

**The lesson worth keeping:** "the assertion is covered" is not the bar. Re-read
`tests_to_add` from `.feature/intake.json` at the *end* of each task and diff it against
the titles actually written — the intake is a moving target across review rounds, and a
task that started before a re-signing is stale by definition.

**Owed.** 10 titles in the 091 shape suite, 1 in `run-spine.test.ts`, 1 in `read.test.ts`.
None require production-code changes — the behaviour they name is already implemented and
(for the 10) already constrained by the migration.

## 2026-07-29 — two gate rows fail for harness self-races, not for defects

Both reproduce on a clean tree and neither is a code problem. Recording them because a
future run will hit them again and read them as regressions.

- **`extra-pnpm-build-` FAIL while `build` PASSES.** `pnpm build` appears both as the
  gate's own `build` row and in the intake's `verification_commands`, so the gate runs it
  twice **concurrently**. The second invocation dies on Next's own guard: `Another next
  build process is already running.` The `build` row is the trustworthy one.
- **`extra-pnpm-test-src-lib-shared---tests---migra` FAIL: `relation
  "solicitation_asks" does not exist`.** `pnpm test:db:setup` is also in
  `verification_commands`, and it **drops schema `public`** before re-applying every
  migration. The gate ran it in parallel with the live-DB migration suites, so those
  suites queried a database mid-rebuild. Proven a race, not a regression: run standalone
  immediately afterwards, `migration-091` + `migration-088` are **23/23**.

**Recommendation for the intake, not applied here** (it is a signed contract, and
changing it is the owner's call): `pnpm test:db:setup` is a *provisioning* step, not a
verification command — it mutates the shared resource every other row reads. It should be
removed from `verification_commands` and run once before the gate, or the gate needs to
serialize it ahead of everything else. Leaving it in guarantees a red row on every future
run, which trains the reader to ignore red.

## 2026-07-29 — T1's new table immediately reds an existing offboarding suite (expected, owned by T8)

`src/lib/account-offboarding/__tests__/table-disposition.test.ts` fails with
`expected [ 'solicitation_outreach' ] to deeply equal []`. That suite asserts every
directly account-linked table created by a migration has a disposition classification;
091 added `solicitation_outreach` and nothing has classified it yet. This is precisely
T8's "inventory" deliverable, so it is pending work rather than a defect — but it means
**the branch carries a known-red suite from T1 until T8 lands**, and anyone bisecting in
between should not treat it as new breakage.

## 2026-07-29 — T1 found migration 091 rejects every unapproved batch (BLOCKER)

**What happened.** While seeding fixtures for the T1 shape suite, the natural
batch insert that `solicitation_batches` has taken since 088 —

```sql
INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
VALUES (…)
```

— was rejected by `solicitation_batches_approval_consistency`. Re-running the
existing `migration-090-solicitation-ask-evidence.integration.test.ts` against
the at-091 test DB reproduces it: the suite's `beforeAll` fails with

```
PostgresError: new row for relation "solicitation_batches"
violates check constraint "solicitation_batches_approval_consistency"
```

**Why.** 091's `IS TRUE` totality wrapper is correct, but two conjuncts inside
the wrapper compare a boolean against a *nullable* predicate, so the whole
conjunction collapses to NULL and `IS TRUE` then turns that NULL into a
rejection — the opposite of the intended effect.

- `(approved_by_user_id IS NOT NULL) = (approval_method = 'owner')`
  With no approval: `FALSE = NULL` → NULL.
- `(halted_by IS NOT NULL) = (halt_reason IN ('owner_veto','owner_halt','admin_halt'))`
  With no halt: `FALSE = NULL` → NULL.

Proven directly:

```
approval_arm_all_null | halt_arm_all_null | approval_arm_fixed | halt_arm_fixed
 f                    | f                 | t                  | t
```

Net effect: a `solicitation_batches` row is representable **only** if it is both
approved and halted. Every batch the 088 batch-builder writes is now rejected.
This is a production-breaking regression in a migration already merged to the
feature branch, not a test problem.

**Required fix (migration `091_send_mode_spine_lifecycle.sql`, outside T1's
allowed edit surface).** Make each right-hand predicate NULL-safe; nothing else
changes, and no legal row's verdict moves:

```sql
--  solicitation_batches_approval_consistency
AND (approved_by_user_id IS NOT NULL) = (approval_method IS NOT DISTINCT FROM 'owner')

--  solicitation_batches_halt_consistency
AND (halted_by IS NOT NULL) = ((halt_reason IN ('owner_veto', 'owner_halt', 'admin_halt')) IS TRUE)
```

This is the same NULL-safety move 090 made with `IS NOT DISTINCT FROM`, applied
one level further in: `IS TRUE` protects the *outer* disjunction, but an inner
`boolean = nullable-predicate` needs its own guard.

`solicitation_batches_send_ordering`, `auto_approval_policies_persona_consistency`
and `solicitation_outreach_status_reason_consistency` were checked for the same
class of hole and are clean (their nullable operands sit behind `IS NULL OR …`,
or the columns involved are `NOT NULL`).

### APPLIED 2026-07-29 (resume) — both arms carry the inner `IS TRUE`

Landed verbatim in the idiom below. Live definitions confirmed by
`pg_get_constraintdef` after re-provisioning; the 090 suite this defect broke is
back to 15/15 and the 091 suite is 16/16. The hook block described below was
lifted by launching the resume session with `MIGRATION_GUARD_DISABLE=1` — the
guard's own documented escape hatch for a premature log bump, approved by the
map owner. Everything from here down is the original analysis, kept for the
record.

### Resolution 2026-07-29 — NOT APPLIED (migration file hook-blocked); audit re-done and confirmed

The fix could not be written: `.claude/hooks/migration-immutability-guard.sh`
blocks every Edit/Write to `supabase/migrations/091_*.sql` because
`migrations-log.md` records `Current head: **091**` while staging/prod are in
lockstep at **090** — the "premature log bump" case the guard's own escape hatch
(`MIGRATION_GUARD_DISABLE=1`) names. That hatch is a launch-time env var, not
something a repo edit can set, and changing `.claude/settings.json` is a
configuration change no agent instruction authorises. Reported upward instead.

**The patch, in the idiom to use** — one guard applied consistently to both
arms (inner `IS TRUE`), rather than the mixed `IS NOT DISTINCT FROM` / `IS TRUE`
sketched above. `IN` has no NOT-DISTINCT form, so an inner `IS TRUE` is the only
spelling that covers both sites identically, and it is the idiom 091's own
header note already declares file-wide:

```sql
--  solicitation_batches_approval_consistency
AND (approved_by_user_id IS NOT NULL) = ((approval_method = 'owner') IS TRUE)

--  solicitation_batches_halt_consistency
AND (halted_by IS NOT NULL)
    = ((halt_reason IN ('owner_veto', 'owner_halt', 'admin_halt')) IS TRUE)
```

**Re-audit of every other CHECK 091 adds — the "clean" claim above holds, but
one arm is clean for a subtler reason than stated.**

- `solicitation_batches_send_ordering` — conjunct 2,
  `sending_started_at IS NULL OR sending_started_at >= approved_at`, DOES
  evaluate to NULL (when `sending_started_at` is set and `approved_at` is NULL).
  It is nonetheless safe: that is exactly the state conjunct 1 already returns
  FALSE for, and `FALSE AND NULL` is FALSE, not NULL. So the row is rejected on
  conjunct 1's authority and no legal row's verdict moves. Not "clean because
  its operands sit behind `IS NULL OR …`" — clean because the NULL is
  unreachable except behind a FALSE sibling.
- `solicitation_outreach_status_reason_consistency` — arms 2–5 yield NULL for a
  NULL `disposition_reason`, and the `IS TRUE` wrapper converting that to a
  rejection is the intended behaviour (a reason-bearing status with no reason
  must be rejected; the suite asserts all four). A satisfied arm still short-
  circuits the disjunction to TRUE, so no legal row is caught.
- `solicitation_outreach_body_presence` — every operand is `IS NULL` /
  `IS NOT NULL` or the `NOT NULL` `delivery_status`. Genuinely three-valued-free.
- `auto_approval_policies_persona_consistency` — `persona`, `action_class` and
  `veto_window_minutes` are all `NOT NULL` (074), and the columns Correction 2
  adds are tested with `IS NULL`. Clean before and after that change.
- Single-predicate CHECKs (`channel`, `source`, `moderation_status`,
  `delivery_status`, `attempt_no`, `veto_window`, `daily_send_cap`, the two
  `agent_runs` domains, `agent_outcomes_outcome_kind_check`) — each is one `IN`
  over a `NOT NULL` column, or already guarded `IS NULL OR …`.

Only the two arms named in this entry carry the hole.

**What T1 did about it.** T1's edit surface is exactly two test files, so the
migration was left untouched and the blocker is reported upward. So the suite
could be written and verified against the intended semantics, the two corrected
CHECKs were applied to the **local test database only** (not to any repo file):

```sql
ALTER TABLE solicitation_batches DROP CONSTRAINT solicitation_batches_approval_consistency;
ALTER TABLE solicitation_batches ADD  CONSTRAINT solicitation_batches_approval_consistency CHECK (…);
-- same shape for solicitation_batches_halt_consistency
```

`pnpm test:db:setup` reverts that patch, so the local DB will go back to the
broken shape until the migration file itself is fixed. Fixing the migration and
re-provisioning is the follow-up.

## 2026-07-29 — migration 091 dropped D19 "Correction 2" from the persona CHECK (BLOCKER for promised title 15)

**What happened.** Promised test title 15 —
`auto_approval_policies rejects a solicitation row carrying auto_approve_min_star`
— cannot pass. Probed directly against the at-091 test DB:

```
INSERT INTO auto_approval_policies (…, persona, action_class, veto_window_minutes, auto_approve_min_star)
VALUES (…, 'solicitation', 'sending', 60, 5);
→ solicitation+min_star ACCEPTED
```

**Why.** `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md`
D19 Correction 2 specifies the cross-persona CHECK as:

```sql
CHECK ( (persona = 'reply'        AND daily_send_cap IS NULL)
     OR (persona = 'solicitation' AND auto_approve_min_star IS NULL
                                  AND daily_auto_post_cap IS NULL
                                  AND veto_window_minutes IN (30, 60)) )
```

with the rationale spelled out in the spec: *"Otherwise rows carry a star
threshold for an agent that does not read stars — inert nonsense that reads as
intent."* 091's `auto_approval_policies_persona_consistency` implements only the
`action_class` + `veto_window_minutes` halves and drops all three cross-column
exclusions (`auto_approve_min_star`, `daily_auto_post_cap`, `daily_send_cap`).

**Required fix (migration `091_send_mode_spine_lifecycle.sql`, outside T1's
allowed edit surface).** Merge the spec's exclusions into 091's existing arms —
this cannot reject an existing row, since `daily_send_cap` was added by 091 and
is NULL everywhere:

```sql
ADD CONSTRAINT auto_approval_policies_persona_consistency CHECK (
  (
    (persona = 'reply'
      AND action_class = 'posting'
      AND veto_window_minutes IN (15, 30)
      AND daily_send_cap IS NULL) OR
    (persona = 'solicitation'
      AND action_class = 'sending'
      AND veto_window_minutes IN (30, 60)
      AND auto_approve_min_star IS NULL
      AND daily_auto_post_cap IS NULL)
  ) IS TRUE
);
```

**Status.** Not patched into the local test DB — the sandbox denied the ad-hoc
DDL, and T1 stopped rather than working around it. Title 15 is therefore RED
until the migration carries the clause. The test is written against the
spec-correct behaviour so it goes green the moment the migration is fixed.

### APPLIED 2026-07-29 (resume) — all three exclusions merged into the persona CHECK

Landed verbatim, `IS TRUE` wrapper kept, with the spec's rationale carried into
the migration's own comment so the "why" travels with the constraint. Promised
title 15 is now green — the 091 suite is 16/16, the sole red is gone. Everything
from here down is the original analysis, kept for the record.

### Resolution 2026-07-29 — NOT APPLIED (same migration-file hook block); "cannot reject an existing row" VERIFIED

The prescribed CHECK above is correct as written and should be applied verbatim
(keeping the `IS TRUE` wrapper). Blocked by the same migration-immutability
guard described under the first entry.

The claim that it cannot reject a row that exists today was checked against
migration 074 rather than assumed, and **holds**:

- `daily_send_cap` is added by 091 itself (`ADD COLUMN IF NOT EXISTS
  daily_send_cap SMALLINT`, no default) — NULL on every pre-existing row, so the
  reply arm's `daily_send_cap IS NULL` is satisfied by construction.
- 074 pins the reply lane at `persona IN ('reply')`, `action_class IN
  ('posting')` and `veto_window_minutes IN (15, 30)` (074 lines 48–56), so every
  pre-091 row satisfies the other three reply conjuncts.
- The solicitation arm's new exclusions (`auto_approve_min_star IS NULL`,
  `daily_auto_post_cap IS NULL`) are unreachable for existing rows: 074's
  `persona IN ('reply')` means no `persona = 'solicitation'` row can exist yet.

Confirmed empirically: with the local test DB carrying 091's *shipped* persona
CHECK, title 15 is the single red case in the 091 suite (15/16 pass).

## 2026-07-29 — the migration-088 shape suite silently reverts 091's spine widening (BLOCKER)

**What happened.** Running `migration-088-solicitation-batch-executor.integration.test.ts`
against the at-091 test DB leaves the shared database **back at 088** for three
constraints. Catalog state immediately after that suite ran:

```
agent_runs_kind_check                → ARRAY['review_handler','weekly_insights','solicitation_batch','solicitation_ask']   -- 'solicitation_send_batch' GONE
agent_runs_kind_subject_type_pairing → four arms, no IS TRUE wrapper                                                       -- 091's arm + totality GONE
agent_outcomes_outcome_kind_check    → ten kinds                                                                           -- 'solicitation_sent','review_attributed' GONE
```

**Why.** That suite's `beforeAll` does `db.unsafe(readMigration088Sql())` twice
and **commits**. 088 unconditionally drops and re-adds those constraints at its
own (narrower) definitions. This is precisely the hazard CLAUDE.md documents:
*"a committed re-apply of an OLD migration silently reverts a later one on the
shared DB"* — migration-shape suites must "roll back any unconditional
re-apply", and this one does not. `ci:live-db-suites` allowlists the file and
checks only that it holds the cross-process lock, not that it rolls back.

**Consequences.**
- Whether `migration-091-send-mode-spine.integration.test.ts` passes now depends
  on vitest's file ordering — a textbook flake, and 091 is the first migration
  that gives 088's re-apply something to destroy.
- 088's own suite is additionally now **stale**: line ~158 asserts
  `agent_runs_status_check` contains `ARRAY['running','completed','failed']`,
  which 091 legitimately widens with `'cancelled'`. That assertion belongs to
  091's suite now (title 3 owns it) and must be updated or removed in 088's.

**Required fix (outside T1's allowed edit surface).** Wrap the 088 re-apply in a
transaction that rolls back, per the documented rule, and retarget its
`agent_runs_status_check` expectation at 091's four-state array.

### Resolution 2026-07-29 — FIXED and verified

`migration-088-solicitation-batch-executor.integration.test.ts`:

- `beforeAll` no longer applies any migration SQL. The double-apply moved into
  its own test, `re-applies migration 088 idempotently and leaves the shared
  database untouched`, which runs **both** applies and every catalog assertion
  that depends on them inside one `db.begin()` that always rolls back via a
  `RollbackAfterReapply` sentinel — the idiom the 091 suite already uses for its
  RLS probe, and the same always-rollback discipline 077/078 get from their
  suite-wide `BEGIN` / `ROLLBACK`. Idempotency coverage is preserved, not
  dropped: the second apply must still resolve without throwing.
- The test asserts 088's own narrower shape *in-transaction* (four-member
  `kind_check`, a pairing with no `solicitation_send_batch`, an outcome-kind
  domain without `solicitation_sent`), then asserts after rollback that all four
  spine definitions equal the values captured before it — the shared DB is
  byte-identical to how it was found.

**Two corrections to the analysis above.**

1. **088 does not touch `agent_runs_status_check` at all.** Its comment says so
   and its own static-SQL test already asserts it (`expect(migrationSql).not
   .toMatch(/(?:DROP|ADD) CONSTRAINT … agent_runs_status_check/)`). So the
   re-apply reverts **three** constraints, not four — `agent_runs_kind_check`,
   `agent_runs_kind_subject_type_pairing`, `agent_outcomes_outcome_kind_check`.
   The status enum was never in the reverted set.
2. **The stale line-158 assertion is therefore a separate defect from the
   revert, and retargeting it at 091's four-state array would be the wrong
   fix** — it would make 088's suite re-assert a fact 091's suite already owns
   (title 3) and force an edit to this file on every future widening of a
   constraint 088 does not own. Instead: the live assertion is now a
   non-narrowing check (the three 088-era states are still members), and the
   stronger claim — that a re-apply of 088 leaves the status enum *exactly*
   where it found it — is asserted inside the rolled-back transaction, where it
   is a real behavioural proof rather than a snapshot of head.

**Proof.** With the three constraints restored to 091's widened text on the
local test DB, `pnpm test src/…/migration-088-….integration.test.ts` → 7/7 pass,
and `pg_get_constraintdef` afterwards still matches `solicitation_send_batch` /
`solicitation_sent` on all three (`t`, `t`, `t`). Before the fix the same run
left all three reverted. The 091 suite then ran **after** the 088 suite and
reached 15/16 — every failure-mode this entry describes is gone, and the single
remaining red is title 15 (the persona CHECK, second entry above).

## 2026-07-29 — migration 091 is not re-runnable, contrary to its own header

**What happened.** Applying the checked-in 091 file a second time fails:

```
psql:supabase/migrations/091_send_mode_spine_lifecycle.sql:79: ERROR:
  cannot drop constraint solicitation_asks_account_business_id_uniq on table solicitation_asks
  because other objects depend on it
DETAIL: constraint solicitation_outreach_ask_tenant_fk on table solicitation_outreach
        depends on index solicitation_asks_account_business_id_uniq
```

**Why.** §3's `DROP CONSTRAINT IF EXISTS solicitation_asks_account_business_id_uniq`
is unconditional, but §5 then creates `solicitation_outreach` with an FK that
*references* that unique. On any second run the FK already exists and blocks the
drop. The file's header claims "Additive and re-runnable"; it is additive but
not re-runnable, and the whole thing is inside one `BEGIN`/`COMMIT` so a failed
re-run rolls back cleanly rather than half-applying.

**Impact.** `pnpm test:db:setup` applies each migration exactly once, so this
does not bite provisioning. It bites any deliberate re-apply — the pattern 088's
shape suite uses, and the "apply it twice, expect a clean no-op" check that WS4's
plan established for migration-shape suites.

**Required fix (outside T1's allowed edit surface).** Guard the drop so it is a
no-op once the dependent FK exists — e.g. drop the outreach FK first and re-add
it after, or make §3 conditional on the constraint being absent. Then either
correct the header or restore genuine re-runnability.

### APPLIED 2026-07-29 (resume) — §3 is now a guarded `DO` block, and re-runnability is PROVEN

The `DO`-block below landed verbatim. **The proof this entry said was owed by
whoever lands the patch is now discharged**: after `pnpm test:db:setup` took the
DB to head, `psql -f 091_send_mode_spine_lifecycle.sql` ran twice more against
the same database, both reaching `COMMIT` with exit 0 (three applies total). The
header's "Additive and re-runnable" claim is now true as written and needs no
correction. Everything from here down is the original analysis, kept for the
record.

### Resolution 2026-07-29 — NOT APPLIED (same migration-file hook block); patch and full re-run audit below

The implementation plan specified this as a **guarded add**, not a
drop-and-re-add, so the migration deviated from its own plan. §3 becomes 088's
`pg_constraint` `DO`-block idiom verbatim (088 lines 23–36, the guard for
`agent_runs_account_business_id_uniq`) — a clean no-op once the constraint
exists, so the dependent FK is never disturbed:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'solicitation_asks'::regclass
      AND conname = 'solicitation_asks_account_business_id_uniq'
  ) THEN
    ALTER TABLE solicitation_asks
      ADD CONSTRAINT solicitation_asks_account_business_id_uniq
      UNIQUE (id, account_id, business_id);
  END IF;
END
$$;
```

**Rest-of-file scan for the same pattern — §3 is the only occurrence.** Every
other `DROP` in 091 is safe on a second apply:

- The `agent_runs` / `agent_outcomes` / `solicitation_batches` /
  `solicitation_outreach` / `auto_approval_policies` drops are all CHECK
  constraints. Nothing can depend on a CHECK, so `DROP … IF EXISTS` followed by
  `ADD` is a clean cycle. (The re-`ADD`s revalidate existing rows, which is
  fine: each new domain is a superset of what the table already holds.)
- `solicitation_outreach_ask_attempt_uniq` is a UNIQUE constraint, but no FK
  references `(ask_id, attempt_no)`, and the partial index
  `solicitation_outreach_one_live_per_ask` is an independent index, not a
  dependent of it. Safe.
- `DROP POLICY IF EXISTS solicitation_outreach_owner_select` — policies have no
  dependents.
- Everything else is `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
  or `CREATE [UNIQUE] INDEX IF NOT EXISTS`.

With §3 guarded, the header's "Additive and re-runnable" claim becomes true and
needs no correction. Re-runnability could **not** be proven here (`psql -f` twice
requires the fixed file); that proof is owed by whoever lands the patch.

## 2026-07-29 — T1 exercises RLS by overriding `auth.uid()` inside a rolled-back transaction

**Context.** Promised test title 12 requires a *direct authenticated owner read*
of `solicitation_outreach`, not a policy-text introspection. No existing suite
does that: the local bootstrap (`scripts/ci/test-db-bootstrap.sql`) stubs
`auth.uid()` to `NULL::uuid` and grants the `authenticated` role nothing, so
`owner_account_id()` is always NULL and every owner policy denies vacuously — a
test written against that would pass without proving anything.

**What T1 does.** Inside one transaction that always `ROLLBACK`s, the suite
`CREATE OR REPLACE`s `auth.uid()` to return the seeded owner's `auth_id`, grants
`SELECT` on `solicitation_outreach` + `users` to `authenticated` (real Supabase
grants these by default; the local bootstrap does not), then `SET LOCAL ROLE
authenticated` and reads. Postgres DDL and GRANTs are transactional, so the
rollback restores the bootstrap stub exactly.

**Why it is safe.** The suite holds the cross-process `acquireLiveDbLock`, so no
sibling live-DB suite can observe the in-transaction `auth.uid()`. The
assertion is meaningful in both directions: it proves the clean row IS visible
and the `moderation_high` withheld row is NOT — a vacuous deny would fail it.

## 2026-07-29 — T2: only ONE of the two malformed gap-analysis references is inside Appendix A

**What happened.** T2 is told to fix "the two malformed nested-backtick
references to the gap analysis that Appendix A carries". The malformed pattern

```
`docs/research/2026-07-28-send-mode-executor-gap.md (branch `research/send-mode-executor-gap`)`
```

occurs **twice in the spec file**, but only once inside Appendix A:

- `2026-07-28-send-mode-executor-approval-design.md:1238` — inside Appendix A.
  **Fixed** in the extracted ADR (`docs/adr/0014-send-mode-spine-lifecycle.md`)
  as `` `…-gap.md` (branch `research/send-mode-executor-gap`) ``.
- `2026-07-28-send-mode-executor-approval-design.md:13` — the spec's own opening
  paragraph, **outside** Appendix A. Not fixed: the executor-approval spec is not
  on T2's allowed edit surface (ADR 0014, the amendments doc, `CONTEXT.md`, this
  file), and a docs-only task must not silently widen its surface.

**Follow-up owed.** A one-line cosmetic fix to line 13 of
`docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md`, same
shape as the ADR's. It renders wrong today — the nesting splits the path across
two code spans — but no semantic content is affected.

## 2026-07-29 — T2 added a SECOND ADR 0014 consequences bullet, for the purge/lock contract

**What happened.** The T2 brief names one Consequences bullet to add (the revised
G10). B11 as specified, however, asserts that *"ADR 0014 records that an
in-flight send must be visible to purge in committed state"* — and Appendix A
carries no such statement, so writing B11 verbatim would have cited a record that
does not exist.

**What T2 did.** Added that bullet to ADR 0014 as well, grounded in the plan's own
T8 resolution (`plan:571-587`), which explicitly assigns that record to ADR 0014.
It states the transaction-scope limit of `pg_advisory_xact_lock` across a provider
call, the committed-`sending` visibility requirement, the advisory-before-row
ordering, and that closing the race is #630's obligation under B11. No new
semantics — it is the same contract T8 and B11 already state, written where B11
points.

## 2026-07-29 — T5: `generation_failed` / `gate_closed` are read off `agent_runs.error`, which pins a caller ordering

**What happened.** The plan pins `closeBatchIfSettled`'s signature to
`{batchId, accountId, businessId}` but names the `generation_failed` and
`gate_closed` disposition sources only as "the batch run's
`SolicitationBatchRunFailure` arm" and "D6's dispatch gate" — neither of which
is a `solicitation_batches` column, and neither of which the pinned signature
carries.

**What T5 did.** Both are arms of the closed `SolicitationBatchRunFailure` union
(`run-spine.ts:495`), and `failSolicitationBatchRun` is their only writer — it
persists `{code: …}` to `agent_runs.error`. That makes the send parent's
`error->>'code'` the single existing owner of the fact, so `closeBatchIfSettled`
reads it there rather than taking a new parameter. Read in SQL (`->>`), so this
adds no JSONB field-to-parser site.

**The contract this pins, documented at the function.** The failing lane records
the failure on the **send parent** run in the same transaction, *before* calling
`closeBatchIfSettled`. It is correct in both orderings — the `gate_closed` test
reads the code off a still-running parent and proves the mapping writes `failed`;
the `generation_failed` test uses an already-terminal parent and proves the
disposition is still derived correctly while the transition no-ops. **#628/#630
must honour that ordering**, or their batches close as `exhausted`→`completed`.

**Why the third union arm is safe to ignore.** `build_failed` has no entry in the
D14 precedence table and falls through to `exhausted`. That is correct by
construction, not by luck: `build_failed` attributes the *build* run
(kind `solicitation_batch`), never the send parent (kind
`solicitation_send_batch`), so `parentErrorCode` can never observe it — and a
batch that failed to build has no send parent at all, which the
`no_send_parent` guard catches first.

## 2026-07-29 — T1 never registered `solicitation_outreach` in `TENANT_TABLES`; T6 found it

**What happened.** T6 could not land the `tenant-scope-allowlist.ts` entry its own
brief mandates, because `solicitation_outreach` is absent from `TENANT_TABLES`
(`scripts/ci/tenant-tables.ts`) while both its siblings — `solicitation_batches`
and `solicitation_asks` — are present.

**Why that is worse than a missing entry.** `findUnusedAllowlistEntries` only
marks an entry used when its table is in `TENANT_TABLES`, so adding the entry
alone makes `ci:tenant-scope` fail with *"unused tenant scope allowlist entry"* —
proved empirically. More importantly, both `ci:tenant-scope` and `ci:rls-audit`
derive their coverage from that list, so **since T1 landed, every audit run has
passed vacuously over the new table**: the gate was green about a table it was
not looking at.

**This is the exact failure the round-1 plan gate caught.** Finding 6 required
"register the table in `scripts/ci/tenant-tables.ts`", the plan assigns it to T1
(`plan.md:261`), and the risk table asserts *"Registered in `TENANT_TABLES` in
T1; `ci:tenant-scope` + `ci:rls-audit` are in the gate's verification commands,
and now actually cover it"* (`plan.md:622`). T1 shipped without it and its
verification run reported those audits clean — which they were, over nothing.

**Resolution.** Both files are on the feature's declared `allowed_edit_surface`,
so this is closing declared scope, not widening it. Landed in T6's task: the
`TENANT_TABLES` registration, the ArchivalPoller allowlist entry, and the
`ALLOWLIST_BASELINE` 407 → 408 bump, in one commit — with a negative check
(remove the entry, confirm the audit goes red) proving the coverage is real
rather than nominal.

**The generalizable lesson.** "Audit passes" is not evidence that an audit
*covers* the thing under test. A registration-driven audit needs a negative
control — remove the exemption, watch it fail — before its green is worth
anything. T1's verification list ran both audits and learned nothing from them.

## 2026-07-29 — T7 ships `checkStalledSendBatches(sql)`, not the planned `(sql, cfg)`

**What the plan says.** `checkStalledSendBatches(sql, cfg)` returning a
`HealthFinding | null`.

**What shipped.** `checkStalledSendBatches(sql)`. The threshold is owned by
`stalledThresholdMsForKind` (T4), not by `HealthAlertConfig`, so `cfg` would have
been an unused parameter. Making it env-tunable instead would require a new
`HEALTH_ALERT_*` key in `src/lib/config/worker.ts` plus a registry entry in
`.claude/reference/env-vars.md` — both outside T7's edit surface, and neither
asked for.

**Why it is the right call, not just the cheap one.** This check is the only one
in the registry whose threshold is a **construction bound** rather than an ops
dial: a send batch is bounded at ≤10 days by the 7-day approval window plus the
72-hour send window, and 11 days is one day past that. There is no operational
reason to tune it — a different value would mean the bound itself changed, which
is a code change. If we ever do want it tunable, the default must still be
sourced from `stalledThresholdMsForKind` so the 11-day number keeps one owner.

**Accepted by the orchestrator:** an unused parameter carried only to satisfy a
signature written in prose is worse than the deviation.

## 2026-07-29 — T7's first pass proved the finding's shape but not that the predicate matches a row

**What happened.** T7 landed with mock-`sql` coverage only, and flagged it
itself: the suite proved the `HealthFinding` shape, the null cases, the
shared-constant sourcing and the single-row bound — but not that
`kind = 'solicitation_send_batch' AND status = 'running'` matches anything a real
writer produces.

**Why that gap mattered more than usual.** Every literal in that predicate is
vocabulary introduced by this same ticket — the kind came from T3, the
`agent_runs` status set was widened in T1 — and a mocked `sql` accepts a typo'd
kind or an unreachable status literal without complaint. The failure mode is
**silence**: a health check whose predicate matches nothing is indistinguishable
from a healthy system, and nobody notices an alert that never fires until the
incident it existed to catch. That is the same "silent no-op dressed as a running
poller" hazard the plan names for T6's sweep, with more consequence because this
one is the alerting path.

**Resolution.** The existing live-DB `checks.integration.test.ts` was extended to
seed a real send-batch run **through the spine writer** (`startOrGetSolicitation
BatchRun`) rather than a hand-rolled INSERT — so the test also proves the kind the
predicate matches is the kind the writer actually emits, which is exactly what a
mock cannot tell you. Age is seeded in SQL (`NOW() - make_interval(...)`), never
by round-tripping a JS `Date`.

**The generalizable lesson, and it is the second instance in this ticket.** A
green check is not evidence of coverage. T1's audits passed over a table that was
not registered; T7's mock suite passed over a predicate that had never met a row.
Both were caught only by a negative control — break the thing, watch the test go
red. Treat "did I prove this fails when it should?" as part of done, not as extra
credit.

## 2026-07-29 — surface amendment #1: `src/lib/approval/__tests__/**`

**Why.** T5's `closeBatchIfSettled` calls `recordStep`/`completeRun`, which makes
`src/lib/solicitation/outreach.ts` a spine writer. The anchor-pairing contract
(`src/lib/approval/__tests__/outcome-anchor-pairing.test.ts`) requires every
spine-writing file to be declared, and that file was outside the declared
surface. The tripwire fired exactly as designed.

**Resolution, owner-approved.** `outreach.ts` was added to `CALLER_ALLOWLIST` and
`NON_REVIEW_SUBJECT_CALLERS`. Its subject is a `solicitation_batch`, never a
review, so the reviews-first lock law does not apply — but the contract had to
say so explicitly rather than by omission.

**Its lock footprint is strictly narrower than the existing weekly carve-out**,
and that was verified rather than asserted: it INSERTs no `agent_runs` /
`agent_outcomes` row; `agent_run_steps` FK-references only `agent_runs`
(`071:51`), so the step INSERT's implicit FK `FOR KEY SHARE` lands on the run row
the tx already holds `FOR UPDATE`; and `transitionRunToTerminal`'s
`UPDATE agent_runs SET status = …` changes no FK column, so Postgres takes no new
key-share. `agent_runs` does FK to `accounts`/`businesses` (`071:17-18`) — which
is why the "no parent-row lock at all" claim depends on there being no run
INSERT, and why it must be re-checked if one is ever added.

**The pin test kept its teeth.** Removing the carve-out fails both the pairing
check and the pin — verified by negative control.

**Amendment count: 1.** A second surface amendment trips the abort criteria in
`.claude/commands/feature.md` step 5.

## 2026-07-29 — the verify gate was racing itself: two self-colliding verification commands

**What happened.** The first full gate run after T5–T8 came back with 16 failing
rows, including `test database is behind head — missing schema objects` and
`agent_runs missing from pg_class`. Read naively, that is a migration or schema
defect in this ticket. It was not.

**Root cause.** `scripts/verify-gate.sh` backgrounds every check with `&` (`:44`)
and waits (`:125`) — all `verification_commands` run in **parallel**. Two intake
entries cannot survive that:

- **`pnpm test:db:setup`** runs `DROP SCHEMA IF EXISTS public CASCADE`
  (`scripts/test-db-setup.sh:45`). The gate was dropping the test schema
  concurrently with its own 7 live-DB suites. It also "passed" while doing so,
  which is what made the failure look like it lived somewhere else. It is a
  **provisioning** step, not a verification — CLAUDE.md specifies running it once
  after a migration lands.
- **`pnpm build`** duplicates the gate's own `build` row. Two concurrent
  `next build` invocations; Next refuses the second with "Another next build
  process is already running." The gate's own `build` row passed every time while
  the duplicate failed — a tell that was visible from the very first run and
  initially misread as flake.

**Effect of removing both:** 16 failing rows → 1.

**The remaining `test` row is gate-load flakiness, not a defect.** 6 of its 7
failures are 5000ms timeouts, the failing *set changes between runs*
(`confirm`/`lead-intake` one run; `stripe-activation-enqueue`/`webhook-dedup`/
`generate-responses` the next), and none of those files is on #624's surface.
Evidence: standalone `pnpm test` is fully green (766 files / 9791 tests / 0
failures), and the five files the gate failed pass in **877 ms** when run
directly. The gate runs the full suite concurrently with ~20 other checks plus a
`next build` and 7 live-DB suites on one machine.

**Lesson worth carrying past this ticket.** A parallel gate must not contain a
command that mutates the shared resource other commands read, and must not
duplicate a row it already owns. Both defects presented as failures in unrelated
code, which cost real diagnosis time. Worth a follow-up on `verify-gate.sh`:
either serialize destructive commands or reject them from
`verification_commands` outright.
