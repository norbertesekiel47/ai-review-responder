# #898 Solicitation send governors — staging ride evidence (2026-08-21)

Branch `feat-898-solicitation-send-governors` · PR **pending** · 898 code landed
on `staging` as `fd539b36`, staging head at smoke time `c29a377e`.
Staging Supabase `kubdiqdhqbhwmqfditeg` · prod Supabase `udeyaqnvpojbwgoaxwdg`
(prod named here only to record that it was **NOT** touched).

**Read section 5 before treating this ride as complete — the admin-surface half
is blocked behind Vercel SSO and is deliberately left undone rather than faked.**

## 1. Migration 110 → staging Supabase — DONE, verified by introspection

The code rode staging on 2026-08-19; the migration did not follow until
2026-08-21. Section 4 shows what that two-day gap proved, which is the most
useful thing in this document.

| Step | Result |
|---|---|
| Pre-flight | staging carried 109's constraint — `owner_withdrawn` present, `no_postal_address` **absent**; `solicitation_send_breaker` and `bounce_kind` **absent**; **0** rows in `solicitation_outreach` |
| Apply | Supabase MCP `execute_sql`, the file's own single `BEGIN` / `SET LOCAL lock_timeout` / `COMMIT`, no error |
| Verify (a) | `withheld` arm carries `no_postal_address` and `postal_address_mismatch` **once each** |
| Verify (b) | the other four arms, the member order within them and the outer `IS TRUE` wrapper are **byte-for-byte** 109's |
| Verify (c) | `to_regclass('public.solicitation_send_breaker')` resolves; table holds **0** rows |
| Verify (d) | `bounce_kind` is `text`; both new CHECKs (`_check`, `_pairing`) exist |
| Verify (e) | `idx_solicitation_outreach_sent_at` and `solicitation_send_breaker_one_open` both present |
| Verify (f) | RLS **enabled** with **0** policies — deny-all, the 096 posture |
| Verify (g) | `md5(pg_get_constraintdef(oid))` on staging **equals** the local test DB at head: `3e644c28c60a3d6135ed3eea7acee224` |

Verification is schema introspection, never the Supabase migration ledger
(`new-migration` skill, lab note 2026-06-20).

The no-backfill claim held as predicted: `solicitation_outreach` was empty, so
the widened CHECK was a no-op for existing data.

**Production: NOT applied.** It rides the #898 promotion to `main`, in the same
change window as that merge. `.claude/reference/migrations-log.md`'s 110 entry
now records the staging application and the pending prod one; its **LOCAL-ONLY**
marker is removed, which re-arms `migration-immutability-guard.sh` on the file.

## 2. Latch smoke — 9 assertions, all passed

Run as one `DO` block against staging: every assertion `RAISE`s on failure, so
completion is the proof. Synthetic trip rows only — no `solicitation_outreach`
rows were fabricated, because the latch table's only FK is `reset_by → users`.

| # | Assertion | Result |
|---|---|---|
| S0 | table empty before the smoke | PASS |
| S1 | a trip insert opens exactly one trip | PASS |
| S2 | the module's **exact** `ON CONFLICT ((reset_at IS NULL)) WHERE reset_at IS NULL` is a **no-op** on a second breach | PASS |
| S3 | the same insert **without** `ON CONFLICT` raises `unique_violation` (23505) | PASS |
| S4 | a partial reset (`reset_at` only) raises `check_violation` (23514) | PASS |
| S5 | a **blank** `reset_note` raises `check_violation` | PASS |
| S6 | a complete reset (`reset_at` + `reset_by` + non-blank note) closes the trip | PASS |
| S7 | the reset frees the one-open slot, so a later breach can trip again | PASS |
| S8 | `MAX(reset_at)` is readable and no longer `-infinity` — the reset floor moved | PASS |
| S9 | cleanup: both synthetic rows deleted, table back to **0** rows | PASS |

S2 is the one worth naming: the `ON CONFLICT` target is inferred from the
partial index byte-for-byte, and a mismatch does not fail to compile — Postgres
raises at runtime, on the **second** breach. This ran the real clause against
the real index.

S6/S7 together are the recovery proof the round-2 review was about: before the
two-floor fix a reset was arithmetically unreachable.

**Staging carries no fake trip.** Final state: `breaker_rows = 0`,
`open_trips = 0`.

## 3. Read model — runs clean on the real staging schema

`readBreakerWindow`'s exact statement, executed against staging:

```
sends = 0 · hard_bounces = 0 · complaints = 0
```

Below `BREAKER_MIN_SENDS` (100), so `classifyBreach` returns null and the
breaker does not trip. That is the correct answer for a database with no send
worker (#899 builds it).

## 4. The poller path — proved by the two-day migration gap

The most useful evidence here was accidental. The 898 code was live on the
staging worker while the staging database was still pre-110, so
`checkSolicitationSendBreaker` was querying a table that did not exist.

`HealthAlertPoller` ticks, Railway deploy `6253e5bc` (commit `c29a377e`):

| Tick (UTC) | `Health alert findings` logged | Reading |
|---|---|---|
| 15:34, 15:39, 15:44, 15:49, 15:54 | **yes, every tick** | pre-110 — the breaker check threw and degraded to its `health_check_error:solicitation_send_breaker` warning finding |
| 15:59, 16:04 | **none** — `Run complete` and idle heartbeats only | post-110 — the check returns null cleanly |

Migration 110 was applied between 15:54 and 15:59, and the findings stopped
exactly there. That is a live proof of **both** halves of the round-1 fix:

1. **The try/catch isolation held.** A missing table is exactly the class of
   failure that used to take the whole cycle down and discard the nine findings
   collected before it. The worker never crashed and never lost a tick.
2. **The real read model runs on the real schema** — end to end through the
   deployed worker, not through a test harness.

No `error`-level log names the breaker after 15:54, and no trip was written.

## 5. What was NOT done — the admin surface (BLOCKED, not skipped)

`/admin/solicitation` and `POST /api/admin/solicitation/breaker/reset` were
**not** exercised through the UI. Staging sits behind **Vercel SSO**: every path
returns `302 → vercel.com/sso-api` (pages) or `401` (API), and a control probe
of a deliberately non-existent path returned the **same** codes. So the probe
proves nothing about route existence either — it is not partial evidence, it is
no evidence, and it is recorded that way.

Reaching them needs a browser session that is signed into Vercel SSO **and** the
staging app **and** stepped up to AAL2. What remains unproven on staging:

- the page renders the open-trip snapshot,
- the route's blank-note rejection (**400**) — note the database half of this is
  proved by S5 above,
- the double-submit answer (**409 `not_tripped`**),
- the actor being taken from the session rather than the request body.

All four are covered by unit tests in the green gate
(`src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts`). The
exposure is bounded: **#900** ships the send-path consumer, and until it lands
nothing reads the breaker on the send path, so an unreachable reset button
cannot halt or release real mail.

## 6. Prod — untouched

No statement was executed against `udeyaqnvpojbwgoaxwdg` during this ride.
Prod sits one migration behind staging until the #898 promotion window closes.
This is a **pending lockstep**, not a standing exception; the only standing
exception remains 078.
