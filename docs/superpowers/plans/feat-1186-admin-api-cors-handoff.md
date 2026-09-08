# feat/1186 — handoff

Everything below is a POINTER. Nothing is restated; read the file.

## What this is

Ticket **#1186** — give `/api/admin/**` CORS: one owner in `src/proxy.ts`, an exact-origin
allowlist (`ADMIN_APP_ORIGINS`), and a `403 {"error":"origin"}` for anything else.
Layer **L1** of the admin split. RISK = high, SIZE = standard, SURFACE = backend.

## Read in this order

| # | File |
|---|---|
| 1 | `docs/adr/0026-admin-api-cors.md` — design of record, D1–D8, LOCKED |
| 2 | `docs/superpowers/plans/feat-1186-admin-api-cors-intake.json` — locked intake (sign-off INHERITED from the ticket per the orchestrator handoff §4) |
| 3 | `docs/superpowers/plans/feat-1186-admin-api-cors-plan.md` — the plan; §2 is the code shape, §5 the seventeen grilled deltas, §8 the three plan rounds |
| 4 | `docs/superpowers/plans/feat-1186-admin-api-cors-deviations.md` — DEV-1 … DEV-4, each with a verdict |
| 5 | `docs/superpowers/plans/2026-09-08-admin-split-orchestrator-handoff.md` §3 L1, §4 — where this ticket sits |
| 6 | `docs/context/core-accounts-channels-admin.md` — **Admin origin allowlist**, **Admin transport**, **Legacy admin portal** |

Amendment boxes win over their originals: ADR 0026 D4 over ADR 0024 D7; ADR 0026 D7 over
ADR 0025 D7.

## Fixed points

- Fork point / branch base: `origin/main` at `c2de39d8`. Worktree
  `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1186-admin-api-cors`,
  branch `feat/1186-admin-api-cors`.
- Codex plan thread `01a0802c-d198-7513-89b8-0e680c8b0368` — 3 rounds, APPROVED. Rounds 2
  and 3 RESUMED it. A branch review round resumes the ADVERSARIAL thread, not this one.
- Surface amendments: **0**. `tests_to_add` grew 19 → 40 as a deviations entry (DEV-2).
- Staging Vercel: project `rep-worth`, Custom Env `env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT`.
  `ADMIN_APP_ORIGINS` staging value `https://admin.staging.repworth.net`. **The production
  value `https://admin.repworth.net` is the OWNER's to set — this run must not.**
  `vercel env add` cannot set it (DEV-3); use the REST API or the Vercel MCP.

## Owner items carried out of the plan gate

1. **ADR 0026 § Context's "No cookie can travel cross-origin" is imprecise** — `SameSite` is
   a *site* control, and `admin.repworth.net` / `repworth.net` are same-site though
   cross-origin. The ADR's conclusion survives via `assertSameOrigin`, and this branch changes
   nothing about it. ADR-text correction, owner's call. See deviations DEV-4 and plan §5.
2. **The authenticated Legacy admin portal mutation is unverified.** No staging admin
   credentials in this session; plan round 3 accepted the stated blocker and recorded that
   its approval does not certify that journey. The owner or #1197's Gate B closes it.
