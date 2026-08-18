# #872 Ask withdrawal — staging ride evidence (2026-08-18)

Branch `feat-872-ask-withdrawal` · PR **#883** · staging commit `1377e45d`
Staging Supabase `kubdiqdhqbhwmqfditeg` · prod Supabase `udeyaqnvpojbwgoaxwdg`
(prod named here only to record that it was NOT touched).

**Read the last section before treating this ride as complete — one half of it
was blocked and is deliberately left undone rather than faked.**

## 1. Migration 109 → staging Supabase — DONE, verified by introspection

Applied ahead of the code, per the lockstep rule (staging first).

| Step | Result |
|---|---|
| Pre-flight | staging carried 108's constraint: `owner_excluded` present, `owner_withdrawn` **absent**, **0** rows with `disposition_reason='owner_withdrawn'` — so the widening was a no-op for existing data |
| Apply | `psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/109_outreach_owner_withdrawn_disposition.sql` over the **direct 5432** connection → `BEGIN / SET / ALTER TABLE / ALTER TABLE / COMMENT / COMMIT`, exit 0 |
| Verify (a) | `owner_withdrawn` occurs **exactly once** in `pg_get_constraintdef` |
| Verify (b) | it sits **inside the `cancelled` arm** |
| Verify (c) | `md5(pg_get_constraintdef(oid))` on staging **equals** the same hash on the local DB at head: `8208d8da29574095f0219084632f2d6a` |

Verification is schema introspection, never the Supabase migration ledger
(`list_migrations` does not track RepWorth's `0xx` files — `new-migration`
skill, lab note 2026-06-20).

**Production: NOT applied.** It goes in at promotion, in lockstep with the #883
merge. `.claude/reference/migrations-log.md`'s 109 entry now records the staging
application and the pending prod one; its **LOCAL-ONLY** marker is removed.

## 2. Code → staging — DONE

`git push origin feat-872-ask-withdrawal:staging` was a **fast-forward**
(`origin/staging` `dd868c92` → `1377e45d`); no force, nothing discarded.

| Surface | Evidence |
|---|---|
| Railway staging worker | `GET https://repworth-worker-staging.up.railway.app/api/health` → **HTTP 200** `{"status":"ok","service":"worker","uptime_seconds":200}` at 10:32:28 UTC. The push landed 10:27:33 UTC, so a ~200 s uptime is this deploy's boot, not the previous one — the worker booted the new tree with its startup env assertions passing. |
| Vercel staging | Deployment `dpl_E7L8tL3cEgFsu4usLVYCTR9fUxoX` created for `githubCommitRef: staging`, sha `1377e45d`. `GET https://staging.repworth.net/` → **HTTP 302** (redirect to auth), the expected unauthenticated answer for the app root. |
| Vercel preview (the PR's own) | `dpl_DJhcTCJPz8CS2hkqxxtJDANRRtRk`, sha `1377e45d`, state **READY**. |

The withdrawal path is a Next.js route plus a Postgres write; it enqueues no
job and involves no worker handler, so worker health here is stack-health
evidence rather than feature evidence.

## 3. What was NOT done — the data-level smoke (BLOCKED, not skipped)

**A seeded end-to-end withdrawal was never executed against staging.** Two
routes to it were attempted and both were refused by this environment's
permission classifier:

1. Running the real suite against staging —
   `TEST_DATABASE_POOL_URL=<staging> pnpm vitest run
   src/lib/solicitation/__tests__/approval.integration.test.ts` (all 46 cases,
   16 of them `withdrawAsk`). Refused: pointing a test suite at a remote
   database. The refusal is reasonable and was **not** worked around — a
   hand-rolled seeding script achieving the same effect would have been the
   same act with less safety, so it was not written.
2. Reading the Railway deploy record through the Railway MCP. Also refused;
   the HTTP health check above is the substitute.

A UI smoke was not attempted either: staging owner sign-in is an emailed OTP
and no staging test-account credentials exist locally, so there is no
non-interactive path to an authenticated owner session.

### What stands in its place

- The same 46-case suite, including every `withdrawAsk` case, **passes locally
  against a database provisioned to the identical head**, and §1's hash
  comparison proves the two constraints are byte-identical. What the staging
  run would add is confirmation on Supabase's own Postgres build and pooler,
  not on different schema.
- `scripts/verify-gate.sh --review` is GREEN on this exact tree (28 checks;
  integration suite RAN; `promised-tests` 18/18; `diff-coverage` ≥ 80 %).

### How to close the gap (choose one; ~5 minutes)

- **Preferred** — allow the suite against staging for one run:
  ```
  U=$(grep '^STAGING_DATABASE_URL=' .env.staging.local | cut -d= -f2- | tr -d '"')
  TEST_DATABASE_POOL_URL="$U" DATABASE_POOL_URL="$U" DATABASE_URL="$U" \
    pnpm vitest run src/lib/solicitation/__tests__/approval.integration.test.ts
  ```
  Safe by audit: every `DELETE` in the suite and in `live-db-tenant.ts` is
  scoped to the tenant it seeds (`business_id` / `account_id` / row id); there
  is no `TRUNCATE` and no unscoped delete. Staging held **0** solicitation
  rows before this ride (batches / asks / outreach all 0), so the suite has
  nothing of anyone else's to touch.
- **Or** — a UI pass on `https://staging.repworth.net` once the send-lane flags
  are on and a batch is approved: withdraw one row → "Withdrawn. N messages
  left to send." → withdraw the last → settled mode; a repeat tap answers 200.

**Owner's call.** The blocked step is the only outstanding item in step 8
before the merge pause; the migration half of the ride — the genuinely
irreversible half — is done and verified.
