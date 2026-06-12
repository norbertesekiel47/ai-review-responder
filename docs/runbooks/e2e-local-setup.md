# E2E local setup — test database + Playwright

How to run `pnpm test:e2e` locally the same way CI's `e2e` job does
(`.github/workflows/ci.yml`). Last verified: 2026-06-11.

## 1. Disposable test database (never point at dev/staging data)

```bash
docker run -d --name repworth-e2e-db \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  -p 5433:5432 postgres:16

# wait until ready (postgres restarts once during initdb — poll from the host)
until PGPASSWORD=test psql -h localhost -p 5433 -U test -d test -c 'SELECT 1' >/dev/null 2>&1; do sleep 1; done

# Supabase prerequisites (roles, auth.uid(), uuidv7 stub) + every migration
PGPASSWORD=test psql -h localhost -p 5433 -U test -d test -v ON_ERROR_STOP=1 -f scripts/ci/test-db-bootstrap.sql
for f in $(ls supabase/migrations/*.sql | sort); do
  PGPASSWORD=test psql -h localhost -p 5433 -U test -d test -v ON_ERROR_STOP=1 -q -f "$f"
done
```

(CI does the same via the shared composite action `.github/actions/test-db`.)

## 2. Run the hermetic suite

```bash
TEST_DATABASE_POOL_URL=postgres://test:test@localhost:5433/test \
ALLOW_E2E_DB_WRITES=true \
pnpm test:e2e --project=chromium
```

- `playwright.config.ts`'s `webServer` boots `pnpm dev` and points the app's
  `DATABASE_POOL_URL` at the test DB so seeded rows (approval tokens, etc.)
  are visible to the app under test.
- `ALLOW_E2E_DB_WRITES=true` is the second half of the `isE2eConfigured` gate
  in `e2e/seed.ts` — without it every DB-seeded spec self-skips.
- Locally your `.env.local` supplies the rest (Supabase URL, cookie secrets,
  flags). CI has no `.env.local`; the `e2e` job's env block carries the
  minimal equivalent set (dummy Supabase + `SESSION_COOKIE_SECRET` +
  `SELF_SERVE_SIGNUP_ENABLED=true`) — discovered empirically 2026-06-11; if a
  new server module reads a new env var at import time, add it there.

## 3. What runs where

| Spec group | CI (`e2e` job) | Locally |
|---|---|---|
| Hermetic seeded/token flows (approval, owner-channels, multi-location, zernio-connect redirect, admin runtime, …) | ✅ runs (chromium only) | ✅ runs |
| Owner-login flows (`remaining-scenarios`, `edit-replies-runbook`, `pricing-toggle`) | self-skip (no `E2E_OWNER_EMAIL`/`E2E_OWNER_PASSWORD`) | run if you set both against the test Supabase |
| Auth-funnel specs (`forgot-password`, `reset-password`, `signup-google`, `signup-password`) | hard-skipped — Supabase `auth.admin` harness pending (see `e2e/README.md`) | same |
| Owner-offboarding DB-backed lifecycle | quarantined — dynamic src/worker imports break under Playwright's transform (issue #283) | same |
| mobile-chrome project | not in CI (runtime budget) | `pnpm test:e2e --project=mobile-chrome` |

## 4. Auth harness (forgot/reset/signup-google) {#auth-harness}

The auth-funnel specs use `e2e/harness.ts` — a Supabase `auth.admin` wrapper
backed by the STAGING project. Two tiers:

**Base tier (4 specs — cross-portal anti-enumeration, mismatched-portal):**
staging Auth users + the local test DB. Safe by construction; unique emails
(`e2e-*@e2e.repworth.net`), `finally` cleanup.

```bash
export E2E_SUPABASE_URL=$STAGING_NEXT_PUBLIC_SUPABASE_URL
export E2E_SUPABASE_SERVICE_KEY=$STAGING_SUPABASE_SERVICE_KEY
# app under test must point at the SAME Supabase project:
export NEXT_PUBLIC_SUPABASE_URL=$E2E_SUPABASE_URL
export NEXT_PUBLIC_SUPABASE_ANON_KEY=$STAGING_NEXT_PUBLIC_SUPABASE_ANON_KEY
export SUPABASE_URL=$E2E_SUPABASE_URL
export SUPABASE_SERVICE_KEY=$E2E_SUPABASE_SERVICE_KEY
export SELF_SERVE_SIGNUP_ENABLED=true
TEST_DATABASE_POOL_URL=postgres://test:test@localhost:5433/test \
ALLOW_E2E_DB_WRITES=true \
pnpm test:e2e e2e/forgot-password.spec.ts e2e/reset-password.spec.ts e2e/signup-google.spec.ts --project=chromium
```

**Deep tier (4 specs — recovery callback, reset happy-path, link replay,
signup-google; explicit opt-in `E2E_AUTH_DEEP=true`):** the app reads `users`
through BOTH Postgres.js (`DATABASE_POOL_URL`) and supabase-js/PostgREST (the
Supabase project's own Postgres), so these only work when
`TEST_DATABASE_POOL_URL` points at the SAME database as `E2E_SUPABASE_URL` —
i.e. the **staging Postgres**. That seeds/cleans rows in shared staging state
(unique IDs, `finally` cleanup) — opt in deliberately, never in CI, and run
the residue check afterwards:

```bash
# additionally:
export E2E_AUTH_DEEP=true
export TEST_DATABASE_POOL_URL=$STAGING_DATABASE_POOL_URL   # ← staging DB, eyes open
# … same pnpm test:e2e invocation …

# residue check (expect 0):
node -e "const{createClient}=require('@supabase/supabase-js');createClient(process.env.E2E_SUPABASE_URL,process.env.E2E_SUPABASE_SERVICE_KEY,{auth:{persistSession:false}}).auth.admin.listUsers({perPage:200}).then(({data})=>console.log('e2e residue:',data.users.filter(u=>(u.email||'').includes('e2e-')).length))"
```

One caveat: the matched-role forgot-password spec submits the real form, so
the app fires one genuine `resetPasswordForEmail` → a single transactional
email to a non-existent `@e2e.repworth.net` address per run (bounces; accepted).

## 4b. Cleanup

```bash
docker rm -f repworth-e2e-db
```
