# Plan review round 1 — Codex adversarial (step 3, RISK=high)

Codex session: 019f7dfa-a607-7481-a43b-b263459f3c0a. **VERDICT: REVISE** (4 blockers, 4 should-fix, 1 nit-sound).

## Triage (receiving-code-review discipline)

| # | Finding | Sev | Verdict | Action |
|---|---|---|---|---|
| 1 | `reservation.then(release)` leak-safety | nit | **ACCEPT (sound)** | none — confirmed correct |
| 2 | Timed-out probes accumulate reservations in postgres.js internal queue (30s admin poll, no single-flight) | blocker | **ACCEPT** | single-flight sampler: ≤1 outstanding reservation globally |
| 3 | `waitMs:1000` is a censored lower bound, not measured; probe includes TCP/TLS connect; idle_timeout 30s ≈ admin poll cadence → cold conn reads as saturation + probe can expand pool | should-fix | **ACCEPT** | add `timedOut` flag; label as "local checkout wait (≥)"; calibrate threshold on staging warm/cold; background sampler keeps conn warm |
| 4 | `DB_POOL_MAX=20` conflates 3 limits (app max vs Supavisor Max-Clients vs backend pool_size); worker concurrency ≠ DB checkouts; 30 Vercel instances ×(3+3)+22 = 202 > 200 | blocker | **ACCEPT** | gather real compute tier / pool_size / Max-Clients / observed peaks; add Vercel-instance budget; burst-drill = perf gate not capacity proof |
| 5 | `sqlRead` "lazy so no close" is a fragile permanent-negative; needs explicit shutdown ownership | should-fix | **ACCEPT** | add `sqlRead.end()` to `closeAllPostgresClients` (harmless no-op on worker; Vercel idle-reaps) |
| 6 | Moved routes fire 14/8/5-wide `Promise.all` waves = #505 wedge shape; `max:3` read pool undersized; #505 audit already lists these as catastrophic-if-wedged candidates; cache (45s, no dogpile, fail-open) contains not cures; `sqlRead` shares same Supavisor backend pool as `sql` (same URL/user/db/mode) so bulkhead isolates only LOCAL slots | blocker | **ACCEPT (approach-level → user decision)** | see fork below; ADR must state local-only isolation honestly |
| 7 | ADR 0007 ALREADY EXISTS (app_name flattening) + 0008 exists → next is 0009; AND ADR 0007 explicitly says #477 must NOT use `application_name` for attribution (Supavisor flattens to 'Supavisor') | blocker | **ACCEPT** | use ADR 0009; drop `application_name` attribution claim (keep only as harmless client intent, or drop) |
| 8 | Intake still needs formal amendment (pool-wait path, past-replies narrowing) — plan prose ≠ sign-off | should-fix | **ACCEPT** | intake already amended; getting explicit sign-off |
| 9 | `DB_READ_POOL_MAX` not added to `config/server.ts` schema; server.test only proves definedness not `.options` | should-fix | **ACCEPT** | add to config schema + surface; strengthen test to assert `.options` (max/timeout) per existing precedent |

No findings rejected — the review is strong and code-grounded.

## The #6 fork (needs user decision)

Reframe: the 14/8/5-wave `Promise.all`s ALREADY run on Vercel `sql` at `max:3` today, so a `max:3` `sqlRead` perpetuates a PRE-EXISTING #505-shape risk rather than introducing a new one — but "touching the pooling and leaving it undersized" is the wrong posture. Options presented to user; decision recorded on answer.

## Mechanical fixes applied regardless of #6 (round 2 plan)
#2 single-flight sampler · #3 timedOut/honest-label/calibrate · #4 capacity facts + Vercel budget · #5 closeAllPostgresClients owns sqlRead · #7 ADR 0009 + drop app_name attribution · #8 intake sign-off · #9 config schema + stronger tests.

## #6 decision (user, recorded)
**Right-size + narrow.** sqlRead max=8; MOVE only /api/dashboard/kpis (5-wave) + past-replies/draft-status (1) — fan-out <= pool, wedge-safe per #505 idiom. LEAVE on write sql: dashboard route (14-wave), aggregate (8), agent-team — owned by the #505 Vercel pipelining audit. ADR: local-slot bulkhead only, shared Supavisor backend.

## Capacity facts (Supabase MCP, 2026-07-19 — answers #4)
- prod (udeyaqnvpojbwgoaxwdg) + staging (kubdiqdhqbhwmqfditeg): **max_connections=60, superuser_reserved=3 => 57 usable backend conns. Micro compute tier. BOTH envs.**
- Current usage low: prod 12 total/1 active; staging 17 total/1 active/4 via Supavisor.
- **The 60-conn Postgres backend ceiling is the BINDING constraint** (sharper than the 200 Supavisor Max-Clients). Under transaction pooling, sum of ACTIVE transactions (worker<=20 + health 2 + Vercel active renders) must stay < 57. DB_POOL_MAX=20 plausibly safe but TIGHT; burst-drill must watch pg_stat_activity backend count, not just the app-side probe. Supavisor backend pool_size not SQL-queryable — confirm via Supabase dashboard during staging gate.
