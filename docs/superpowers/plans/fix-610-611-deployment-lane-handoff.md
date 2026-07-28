# Handoff — fix-610-611-deployment-lane

Written at the step 3→4 boundary. A resumed session needs **only** this file plus
the artefacts it points at. The grilling and review transcripts are not needed.

## State

| | |
|---|---|
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-610-611-deployment-lane` |
| Branch | `fix-610-611-deployment-lane` (off `main`) |
| HEAD | `f57e47d5` — docs only, **zero code written** |
| `.feature/state.json` phase | `worktree_ready` |
| Enforcement | **PARKED / DISARMED** — see "First action" |
| Step reached | 3 complete (plan locked + adversarially reviewed). **Step 4 not started.** |
| Blocking | **Human sign-off on the plan has NOT been given.** Ask before dispatching T1. |

## First action, before any edit

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-610-611-deployment-lane
mv .feature/intake.parked.json .feature/intake.json
bash scripts/arm-check.sh     # must print ARMED — if DISARMED, stop and report
```

The harness resets shell cwd between calls: prefix **every** Bash command with
`cd <worktree-root> &&`, and use absolute worktree paths in every Edit/Write.
An edit written to the parent checkout silently lands on `main`'s tree.

## Read these, in this order

1. `docs/superpowers/plans/fix-610-611-deployment-lane.md` — plan of record
   (revision 5). Design rationale, the 12-site call-site map, tickets T1–T5 with
   blocking edges, and the ship steps.
2. `docs/superpowers/plans/fix-610-611-deployment-lane-intake.json` — the locked
   contract. 26 surface globs, 38 promised test titles (verbatim — the gate
   matches them literally), 11 invariants, `open_questions: []`.
3. `.claude/CLAUDE.md` — architecture invariants #1, #13, #15 are the ones this
   work touches.
4. Glossary: `CONTEXT.md`. **deployment lane** is coined by T5 and is not in it
   yet; CLAUDE.md's "Environments & branches" section already uses *lane* for the
   preview/staging/production split — match that usage verbatim.

## Ground truth (verified live against Railway, 2026-07-28 — do not re-derive)

| | staging | production |
|---|---|---|
| `NODE_ENV` | `production` | **unset** |
| `RAILWAY_ENVIRONMENT_NAME` | `staging` | `production` |
| `SENTRY_DSN` | set | absent |

Production also lacks `ADMIN_NOTIFICATION_EMAIL`, `REDIS_QUEUE_URL`,
`STRIPE_WEBHOOK_SECRET`. The prod worker has never been deployed and already
cannot boot — this change adds correct failures to an unconfigured environment,
it does not break a working one.

## Decisions locked during grilling (do not re-litigate)

Eight, all recorded in the intake's `non_goals` / `invariants`. The three a
resumed session is most likely to second-guess:

- **Precedence for the lane name, union for the gate predicate.** #611's own
  suggested fix (`RAILWAY_ENVIRONMENT === 'production' || NODE_ENV === 'production'`)
  is wrong: staging sets *both* signals, so a `||` re-creates #610.
- **`worker/background/pollers/AccountOffboardingPurgePoller.ts` is NOT touched.**
  Its predicate carries a `VERCEL_ENV` term the union does not model;
  `AccountOffboardingPurgePoller.test.ts:459-462` pins that case. It is T4's one
  CI exemption. The underlying gap is filed as **#614**.
- **`isProductionLane()` is not built** — zero callers once the purge site left.

## Review history

Four adversarial rounds (codex agent `acd64394616f0edf6`, resumable via
SendMessage). All findings were verified independently before acceptance; several
corrected errors of mine. Rounds 2–4 each *removed* scope. Round 4 cleared the
destructive-path question and returned only statement-level defects — that is why
plan review stopped. **Do not open a fifth plan round**; the code still faces
step 6 and step 7.

## Budgets

- **Surface amendments: 1 of 2 used** (logger.ts + fastify-options.ts, round 1).
  A second amendment is step 5's abort trigger.
- Gate-fail rounds: 0 of 3.
- Estimated diff: ~545 lines / 22 files. Step 5 re-checks actual against this and
  warns above 2×.

## Next steps

1. Get human sign-off on the plan (not yet given).
2. `bash scripts/feature-state.sh set-phase executing`
3. Step 4: `superpowers:subagent-driven-development`. T1 first (no blocking
   edges); T2, T3, T5 may run in parallel after T1; T4 requires T2 **and** T3.
   Each subagent prompt must carry the CONTEXT.md glossary excerpt and its
   ticket's spec slice.
4. **After the first subagent returns**, diff `git status --porcelain` against
   `allowed_edit_surface`. Any out-of-surface path means enforcement did not bind
   for subagent tool calls — stop and report, do not dispatch further tasks.
5. Deviations go to `docs/superpowers/plans/fix-610-611-deployment-lane-deviations.md`.
6. Step 5 gate: `bash scripts/verify-gate.sh` (`--review` for the last run).
