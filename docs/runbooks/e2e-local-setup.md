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

## 4. Cleanup

```bash
docker rm -f repworth-e2e-db
```
