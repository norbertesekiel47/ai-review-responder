# feat #624 — spine lifecycle + fan-out primitives: deviations log

Dated entries for anything the plan did not anticipate. One entry per surprise.

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
