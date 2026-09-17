# fix-1176 — handoff

- Branch / worktree: `fix-1176-client-role-grant-sweep` at `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1176-client-role-grant-sweep`
- Fork point: `889c8be6e`
- Lane: standard · high · backend (armed, runtime claude)
- Intake (locked, owner sign-off 2026-09-16): `docs/superpowers/plans/fix-1176-client-role-grant-sweep-intake.json`
- Plan: `docs/superpowers/plans/fix-1176-client-role-grant-sweep-plan.md` (review appendix at the end)
- Deviations: `docs/superpowers/plans/fix-1176-client-role-grant-sweep-deviations.md`
- Glossary excerpt: none — no domain term is involved (database privilege posture only).
- Follow-up tickets: #1300 (registry split + recurrence guard), #1301 (older suite rebuilds).

## Codex sessions

| Round | Kind | Session id | Brief / report |
|---|---|---|---|
| plan 1 | full, cold | `01a0adb0-dc33-7372-ae5a-4e580e36636f` | `.feature/codex/plan-round-1-brief.md`, findings table in `.feature/codex/plan-round-1.log` |
| plan 2 | verification, resumed | same | `.feature/codex/plan-round-2-delta.md`, `.feature/codex/plan-round-2-report.md` |
| plan 3 | verification, resumed | same | `.feature/codex/plan-round-3-delta.md` — APPROVED |
| branch 1 | adversarial, cold | `01a0adcc-3ce1-7bd2-8f56-8ede960e87ee` | `.feature/codex/branch-adversarial-brief.md`, `docs/reviews/fix-1176-client-role-grant-sweep/adversarial.md` + findings table in `.feature/codex/branch-adversarial.log` |

## Progress

- T1 (failing suite) committed `10a10ff91`; T2 (migration 122 + log) committed `3be6bd34d`; ledger line `e791f2bb1`.
- Review gate GREEN at `e791f2bb1` (fingerprint written).
- Branch review round 1: spec, standards, adversarial returned; triage in `docs/reviews/fix-1176-client-role-grant-sweep/triage.md`. Red team BLOCKED by #1302 (deviation D6).

## Owner decisions carried

1. Three tickets; this run is ticket one only.
2. Revoke TRUNCATE, REFERENCES, TRIGGER, MAINTAIN from anon/authenticated on every public table; REVOKE ALL on the twenty deny-all tables.
3. Remove those four rights from the owning role's default table privileges; default DML stays.

## Shipping boundaries still owed to the owner

Commit/push are authorized inside the workflow. Remote migration (staging, then production) and merge each need explicit approval at step 8.

## Phase cost

(filled at step 8)
