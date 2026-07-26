# Evidence — Solicitation watch-mode staging flip (map #528 destination)

**Date:** 2026-07-26 ~00:40 UTC · **Environment:** staging only · **Flag:** `SOLICITATION_WATCH_ENABLED=true`

## What was flipped, where

| Surface | Where | Value | Set by | Verified |
|---|---|---|---|---|
| Railway staging worker (`repworth-worker`, env `staging`) | service env var | `true` | #544 session (recorded in its ride commits) | `railway variables` shows `SOLICITATION_WATCH_ENABLED=true` (2026-07-26) |
| Vercel staging custom env | project env var | `true` (encrypted) | #544 session (~2h before promotion) | `vercel env ls staging` lists the var |

No `NEXT_PUBLIC_*` companion exists (invariant #13; `ci:static-policy` enforced).
The flag is NOT an autonomy flag — watch-mode takes no public action — so the
§8.4 ordered go-live sequence does not apply. **Production remains OFF/unset.**

## Deploy that carried it live

- `staging` branch reset onto `main` at `464426c5` (squash-merge protocol,
  precedent: #472 map) — force-with-lease push, 2026-07-26 00:37 UTC.
- Railway staging worker deploy: **SUCCESS**; boot log clean
  ("readiness cure complete — background loops staggered, workers resumed"),
  poll cycles nominal, zero boot errors.
- Vercel staging deploy: **Ready** (git-sourced `target:staging`).

## Migrations at this point (staging AND prod, lockstep verified by introspection)

084, 085, 086, 087, 088, 089 — all present in both projects. Prod head = 089.

## What this means

Wayfinder map #528's destination is reached: both probes (Competitor Delta
digest line + Voice Report Card) are on `main`, and the Solicitation agent is
live on staging in watch-mode — real batches from owner-uploaded CSV
candidates, per-candidate send/withhold decisions with evidence, nothing sent.

## Remaining smoke (needs an SSO-authenticated browser — owner)

External curl cannot pass Vercel SSO on staging. Owner UI pass when convenient:
1. `/dashboard/requests` renders (Requests nav visible in sidebar + mobile bar).
2. Upload a small CSV at `/dashboard/requests/contacts` → report renders,
   batch appears after the build job (funnel hero, verbatim withhold chips,
   no star ratings anywhere).
3. Opening the batch writes `reviewed_at` (visible in the digest/analytics lane).

## Production flip

Deliberately NOT done. Rides the production bring-up (§8.4 posture); when it
happens: set the var on prod Railway worker + Vercel production env, redeploy,
same smoke. No ordering dependency on the autonomy flags.
