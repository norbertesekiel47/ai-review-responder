# Migration 116 `refusal_events` — staging promotion evidence

Ship order steps 1–5 of `docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md`
§"Step 8". **Stopped at step 6 (owner merge approval).** No production database touched.

| | |
|---|---|
| Branch HEAD | `d51b645f` |
| PR | #1019 |
| Staging Supabase | `kubdiqdhqbhwmqfditeg` (RepWorth-staging) |
| Production Supabase | `udeyaqnvpojbwgoaxwdg` — **UNTOUCHED** |
| Migration file SHA-256 | `97b234f8f144608e17f3c59003f08beb24bcb74646f9373d7d814c5228a5f78c` |

## Step 1–2 — PR and CI

Draft PR opened, then `gh pr ready`. All six required checks accounted for **by name**:
`changes` pass · `lint` pass · `test` pass · `build` pass · `llm-eval` skipping ·
`deploy-install` skipping. Zero fail/cancel anywhere. `e2e` and `fallow` also passed.
PR head `d51b645f` equals the promoted tree.

> **Recorded because it nearly caused a false promotion.** The first CI watch reported
> "all green" while every required check was ABSENT — it only checked that nothing was
> pending. Root cause of the absence: the PR was `CONFLICTING`, and GitHub cannot build
> `refs/pull/N/merge` for a conflicted PR, so no `pull_request` run is ever created.
> Checks must be verified BY NAME. Absence is not a pass.

## Step 3 — staging DDL, verified by introspection

Applied with `psql -v ON_ERROR_STOP=1 -f supabase/migrations/116_refusal_events.sql`.
Output: `CREATE TABLE`, 13 × `COMMENT`, 3 × `CREATE INDEX`, `ALTER TABLE`, `COMMIT`.

Introspection (never `list_migrations`, which does not track this repo's `0xx` migrations):

| Property | Expected | Observed |
|---|---|---|
| columns | 12 | 12 ✓ |
| named CHECK constraints | 5 | 5 ✓ |
| indexes | 3 | 3 ✓ |
| RLS enabled | true | true ✓ |
| policies (deny-all ⇒ none) | 0 | 0 ✓ |

**C5 live-fire.** The row the locked #1001 schema ADMITTED — `refusal_code='winner'`
against `all_refusal_codes = ARRAY['different', NULL]` — was REJECTED by
`refusal_events_all_codes_pairing` on the real database. The `array_position(...) IS NULL`
and outer `IS TRUE` clauses work in production Postgres, not just in the local container.

## Step 4 — staging branch

`d51b645f` pushed to `staging` as a **fast-forward** (`2ffbaeb8..d51b645f`), no force needed.
`origin/staging` held nothing unique beforehand (0 ahead of main, 2 behind). Railway staging
worker deploy `78d5d8d9` triggered on that commit.

## Step 5 — smoke, against the real staging schema

Run inside ONE transaction and **rolled back**; nothing persisted (post-rollback
`SELECT count(*) FROM refusal_events` = 0).

1. Seeded both shapes under the staging account: one per-location `held_draft`, and one
   ACCOUNT-WIDE `autonomy_suspended` (`business_id IS NULL`, `occurred_at` 400 days old).
2. Issued the EXACT purge statement (`purge-stages.ts:444-447`) → **`DELETE 2`**. Both rows,
   including the account-wide one a business-joined delete would have left behind.
3. Issued the EXACT verification statement (`purge-verification.ts:631-635`) →
   **`violation_count = 0`**.

**What this proves:** the table, the purge `DELETE` and the verification `SELECT` are all
schema-compatible on the real staging database, and the account-wide row is removed.

**What it does NOT prove, stated plainly:** it exercises the SQL, not the deployed worker
binary running an end-to-end offboarding. A full `delete_data`-through-purge ride is
`docs/runbooks/owner-offboarding-staging-dry-run.md` §4.5, and it was NOT run here for a
concrete reason: staging holds exactly ONE account (`trialing`, 1 location, no offboarding),
so a real purge would destroy the staging environment's only tenant. Provisioning a
disposable account for a full ride is the correct next step if that end-to-end proof is
wanted before merge.

## Step 6 — STOP

Owner merge approval required. Production DDL (step 7) is the next action and has not begun.
