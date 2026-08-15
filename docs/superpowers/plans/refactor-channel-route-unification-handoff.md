# Handoff — `refactor-channel-route-unification`

**Current step:** 3 → 4 boundary. Plan locked pending the owner's round-3 call
(see "Open decision" below). Next action is step 4 (EXECUTE).

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification`
**Branch:** `refactor-channel-route-unification` (forked from `main` @ `682681ab`)

## Artifacts (read these, do not restate them)

| What | Path |
|---|---|
| Design of record | `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4 (Task 1 amends it in-branch) |
| Intake contract (drift detector) | `docs/superpowers/plans/refactor-channel-route-unification-intake.json` |
| Implementation plan | `docs/superpowers/plans/2026-08-15-channel-route-unification.md` |
| Plan review round 1 | `docs/reviews/refactor-channel-route-unification/plan-review-round-1.md` |
| Plan review round 2 | `docs/reviews/refactor-channel-route-unification/plan-review-round-2.md` |
| Glossary term coined | `CONTEXT.md` → **Channel actor** (written by Task 1, not yet on disk) |

## Lane

`classification: high` · `surface: backend` · `db_touching: false`

**Ship lane is deliberately NOT the RISK=high default.** Owner's call: run the
high-lane *controls* (adversarial plan review, third review axis at step 7) but
ship via the normal lane — PR straight to `main`, no staging ride — per spec §2,
which reasons that no worker, webhook, migration or billing surface is touched.
Step 8 must follow the RISK=normal path with the addition of a merge-approval
pause.

## Decisions locked during grilling (do not re-litigate)

1. **Flag/env modules move to `src/lib/notifications/channels/`**, not
   `api/_shared/channels/`. Reason: `whatsappEnvReady()` is consumed by
   `src/app/(authenticated)/settings/channels/page.tsx` — a *page* — so an
   `api/` home would recreate the same category error. The pure pass-throughs
   `isTelegramEnabled`/`isWhatsAppEnabled` are deleted in favour of
   `channelsTelegramEnabled`/`channelsWhatsappEnabled`, which those same files
   already import directly for WhatsApp.
2. **WhatsApp deep link: the owner's `/\D/g` strip wins.** The admin's
   `/^whatsapp:\+?/` left spaces/parens in the `wa.me` path — a second,
   unreported divergence beyond the §1 findings table.
3. **`ChannelActor.surface` is `'admin' | 'dashboard'`**, not the spec's
   `'admin' | 'owner'` — reuses `disconnectChannel`'s existing union so no
   translation layer is needed for the audit tag or cache label.
4. **`buildDeepLink`, `cacheLabel`, `endpoint` and `flagOff` are NOT config
   fields.** All four are derivable from `surface` + `channel` + action, leaving
   one 4-field `ChannelRouteConfig` shared by all three runners. A fifth field
   means the seam is wrong — re-plan rather than widen.

## Plan review history

Rounds 1 and 2 ran via `codex exec` (sandbox `read-only` / `workspace-write`).
**14 findings across both rounds, all accepted and fixed.** Round 1 returned
`VERDICT: REVISE` with 4 High + 6 Medium — every one an "eval can be green while
the feature is wrong" finding, which produced Task 2b. Round 2 returned
`VERDICT: REVISE`, confirming 8 of 10 closed but correctly rejecting two and
finding two defects the round-1 fixes had introduced (see the "Round-2
verification" block in the plan's Self-review section).

**Round 3 did not render a verdict** — the `codex exec` run hit the 10-minute
command cap without writing its report. Its six questions were factual rather
than judgment calls, so they were self-verified instead:

| Question | Result |
|---|---|
| `LOCK_STATEMENT` raw text under `strings.join('?')` | Correct — `SELECT pg_advisory_xact_lock(hashtextextended(?, 0))` |
| `expect(log).toEqual([lockedTx()])` exhaustive? | Correct — helpers are mocked, so the lock is the runner's only statement |
| `txState.depth` scoping (module-level, per-test `mkSql`) | Correct — reset in `beforeEach`, suites run sequentially in-file |
| Same `accountRow` returned for every query in `bindings.test.ts` | Harmless — only the accounts join's result is read |
| `disconnectChannel` mocked before `runChannelDisable` reaches it | Correct — module-level `vi.mock` |
| `vi.mock('node:crypto')` interception | **UNPROVEN — no precedent in this repo for mocking a `node:` builtin.** Mitigated: a wiring-guard test runs first, and a precedent-free fallback is documented in Task 2b Step 1. Failure mode is loud, not silent. |

**Codex session ids were not captured** — the round-1 JSONL carried no
`session.created` record and rounds 2–3 ran in text mode. Re-dispatch fresh
rather than attempting to resume a session.

## Open decision (blocks nothing; surfaced per the round-3 stop rule)

Round 3 produced no verdict. The owner's options are (a) accept the plan as-is on
the strength of rounds 1–2 plus the self-verification table above, (b) re-run
round 3 in the background before executing, or (c) drop the `node:crypto` spy in
favour of the documented fallback up front. Recorded as: **no reviewer
disagreement is outstanding** — only an unfinished confirmation.

## Task graph for step 4

```
T1 (docs+glossary) ──┐
T2  (eval: route + resolver tests) ──┤
T2b (eval: runner protocol + admin bindings) ──┤
                                     └─> T3 (flag/env + deep-links move)  [ALONE — enforcement spot check]
                                          └─> T4 (resolve-actor)
                                               └─> T5 (runners)
                                                    ├─> T6 (admin shims)   ┐
                                                    ├─> T7 (owner shims)   ├ parallel
                                                    └─> T8 (consumers+docs)┘
                                                         └─> T9 (full gate)
```

T1, T2, T2b are mutually independent. T3 blocks on all three — the eval must be
complete and red before implementation starts. T6/T7/T8 are file-disjoint.

## Non-negotiables for the executing agent

- The 6 admin route test files
  (`src/app/api/admin/channels/{telegram,whatsapp}/__tests__/{start,cancel,disable}.test.ts`)
  must stay **byte-for-byte unmodified**. New admin coverage goes in the sibling
  `src/app/api/admin/channels/__tests__/bindings.test.ts`. A gate command
  enforces this with `git diff --quiet`.
- Every Write/Edit path targets the worktree root, never the parent checkout.
- Prefix every Bash call with `cd <worktree-root> &&` — the shell cwd resets
  between calls in this harness.
- `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts`
  must RUN, not SKIP, with `TEST_DATABASE_POOL_URL` set before the PR (spec §7).
