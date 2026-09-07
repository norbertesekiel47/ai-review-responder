# Evidence — `TRIAGE_ENABLED` staging flip (ordered autonomy go-live, step 1)

Campaign: begin the ordered autonomy flip (design doc §8.4) at its first step.
The order is fixed: `TRIAGE_ENABLED` → `ESCALATION_ENABLED` → `JUDGE_ENABLED` +
`GOVERNOR_ENABLED` → `AUTO_APPROVAL_ENABLED` → `AUTOPILOT_PURCHASABLE`, staging
before production at every step. Procedure: the `flag-flip` skill.
Precedent: `2026-08-24-solicitation-send-mode-staging-flip.md`, whose P3 row is
the last written record of the staging autonomy matrix and which **this file
supersedes for `TRIAGE_ENABLED` only**.

**This flip was requested by the owner and is staging-only.** Production was
proposed and deliberately declined in the same exchange — see "Production: not
touched, and why" below.

## Environment

| Item | Value |
|---|---|
| Environment | **staging only** |
| Worker | `repworth-worker` @ Railway env `staging` (`58c06358-…9a10`) |
| Supabase (staging) | `kubdiqdhqbhwmqfditeg` |
| Supabase (prod) | `udeyaqnvpojbwgoaxwdg` — **NEVER touched by this campaign** |
| Git at flip | `origin/main` = `origin/staging` = `51ced257` |
| Worker deployment before flip | `34110030` on `51ced257` (created 07:26 UTC by the staging fast-forward) |
| UTC | 2026-09-07 07:35 UTC |
| Posture | One flag, one environment. No prod env var changed. No secret appears in this doc — names and set/unset only. |

## Preflight

| # | Check | Result | UTC |
|---|---|---|---|
| P1 | `TRIAGE_ENABLED` read paths enumerated | ✅ **worker-only** — `worker/jobs/response-generation/triage.ts:52` is the sole `triageEnabled()` caller. No `src/app` reader, so Railway alone; there is no Vercel half to forget | 07:30 |
| P2 | Ordering (skill step 2) | ⚠️ `TRIAGE_ENABLED` is FIRST in the order, so nothing precedes it. Staging-before-production is satisfied by this flip being staging | 07:31 |
| P3 | Coupling review (skill step 3) | ✅ No ON-direction coupling. The documented coupling is the OFF direction (disabling triage weakens the auto-approval triage veto), which does not apply here | 07:31 |
| P4 | Staging review corpus | ⚠️ **0 reviews**, 0 rows with `triage_severity`, 0 `api_costs` rows at endpoint `review-triage` — triage has never run in this environment | 07:32 |
| P5 | Prior staging proof | ✅ historical only — `2026-07-21-agentic-staging-copilot-autopilot-e2e-evidence.md` ran `TRIAGE_ENABLED=true` on real reviews. That predates the 2026-08-24 flip-off | 07:33 |
| P6 | Cost exposure | ✅ nil today. One ~200-max-token `gpt-4o-mini-2024-07-18` call per NON-POSITIVE review; with 0 reviews the path never executes | 07:33 |

## The flip

| # | Action | Result | UTC |
|---|---|---|---|
| F1 | Set `TRIAGE_ENABLED=true`, Railway env `staging`, service `repworth-worker` | ✅ API confirmed `{environment: staging, variableNames: [TRIAGE_ENABLED]}` | 07:35 |
| F2 | Exact value (skill step 4) | ✅ literal `true` — worker boot rejects `TRUE`/`1`/`yes` | 07:35 |
| F3 | Redeploy | ✅ deployment `a69f533d` SUCCESS on `51ced257`. Both it and `34110030` show `REMOVED` now — superseded at 07:43 by `0cf194a4` on `1a0bd218`, an unrelated `main` merge. Env vars persist across deploys, so the flag survives that supersession | 07:37 |
| F4 | Worker boot | ✅ `Worker listening`, `deployment_lane=staging`, `lane_source=RAILWAY_ENVIRONMENT_NAME`. No error-level lines | 07:37 |

## Verification: INCOMPLETE — read it before trusting this flip

Skill step 5 requires verifying the value after writing. **That verification did
not succeed.** What exists is a platform write receipt plus a clean boot, NOT a
read-back of the live value. Three paths were tried and all three are closed:

| Path | Outcome |
|---|---|
| Read Railway variables back | **Blocked** in the operating session — the call returns plaintext secrets |
| Worker boot log | **Insufficient** — `worker/index.ts:604` prints only `Telegram`, `WhatsApp`, `SelfServeSignup`, `ZernioPublishing`. **No autonomy flag is printed at boot** |
| Behavioural proof | **Impossible today** — P4: 0 reviews in staging, so no triage can execute |

Treat `TRIAGE_ENABLED` in staging as **set but unproven**. The first
non-positive review ingested into staging is what converts this to proof: expect
one `api_costs` row at endpoint `review-triage` and a non-null `triage_severity`
on the review. Until then, do not cite this file as evidence the lane works.

> **Follow-up worth filing:** the boot flag line omits every autonomy flag
> (`TRIAGE`, `ESCALATION`, `JUDGE`, `GOVERNOR`, `AUTO_APPROVAL`). Those are the
> flags most in need of an audit trail, and their absence is the direct cause of
> the verification gap above. Adding them to `worker/index.ts:604` would make
> every future autonomy flip self-verifying from the boot log alone.

## Production: not touched, and why

`TRIAGE_ENABLED` and every other autonomy flag remain **off in production**.
Flipping production was offered and declined. The blockers are recorded here so
the next reader does not re-derive them:

- **Staging cannot yet prove the step** (P4) — promoting an unproven step is what
  the staging-first rule exists to prevent.
- **§8.4 gates are open** — Owner UAT pending; the prod WS8 cutover has not run;
  migration 078 is deliberately absent from prod pending that cutover.
- **`launch-flag-readiness.md` posture**: "Nothing here flips a flag — every prod
  flip is the owner's call."

Production corpus at the time of this flip: 1 account, 1 location, 0 reviews,
0 responses, 0 `auto_policy` rows, 0 judge verdicts, 0 auto-approval policies.

## Resulting staging autonomy matrix

Supersedes the P3 row of `2026-08-24-solicitation-send-mode-staging-flip.md` for
`TRIAGE_ENABLED` only. Every other value below is carried forward from that file
or from a later recorded flip — **none of them was read back in this campaign**,
so re-derive by introspection rather than citing this table as current.

| Flag | Staging | Source |
|---|---|---|
| `TRIAGE_ENABLED` | **`true`** | this flip (F1), unproven per Verification |
| `ESCALATION_ENABLED` | `false` | 2026-08-24 P3; next in the order, and inert without triage |
| `JUDGE_ENABLED` | `true` | #633 flip 2026-08-25; corroborated live — a `judge_sweep` heartbeat row exists and ages under one **Poller cadence** |
| `GOVERNOR_ENABLED` | `false` | 2026-08-24 P3 |
| `AUTO_APPROVAL_ENABLED` | `false` | 2026-08-24 P3 |

## Next step

`ESCALATION_ENABLED` in staging. It is inert without triage, so it gains nothing
until a review actually flows. Ingest a non-positive review into staging first,
confirm the triage row and the `review-triage` cost row, then continue the order.
