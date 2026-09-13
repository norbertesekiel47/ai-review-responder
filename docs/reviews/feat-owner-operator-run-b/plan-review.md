# Plan review ledger — feat/owner-operator-run-b

Plan: `docs/superpowers/plans/feat-owner-operator-run-b-plan.md`. Reviewer: Codex (`grill-me-codex/scripts/runner.py`, read-only sandbox, CLI-default model). Raw artifacts: `~/.claude/grill-codex/run-b-2026-09-12/` (outside the repo). Every round was pre-validated mechanically (`prevalidate-plan.py`: PASS at every dispatch) and counted with `feature-state.sh incr-round plan`.

**Outcome: loop closed at round 3; owner lock 2026-09-12 substitutes for APPROVED** (feature.md §3 step 4). No disagreement remained: every finding across the three rounds was accepted and fixed in the plan; the round-3 finding was a defect introduced by a round-2 fix.

| Round | Kind | Verdict | Findings | Disposition |
|---|---|---|---|---|
| 1 | plan-skeptic (fresh; brief = failability / cited artifacts / invariants) | REVISE | 11 (RB-01…RB-11: 4 high, 7 medium) | all ACCEPTED; 10 test titles added to the intake |
| 2 | verification (fresh — round 1 left no resumable session) | REVISE | 7 (RB2-01…RB2-07: 1 high, 5 medium, 1 low), all introduced by round-1 fixes | all ACCEPTED |
| 3 | verification (resumed round-2 session `01a0960d-4387-7f72-be06-e1d2f82c8a0c`) | REVISE | 1 (RB3-01, medium, introduced by the RB2-04 fix) | ACCEPTED; 1 test title added; loop closed |

## Round 1 — plan-skeptic (11 accepted)

The runner recorded this round as `failed`: the worktree's Codex Stop hook blocked Codex's turn on the red baseline gate (`feature-surface` cannot match before T0), after which Codex emitted a final JSON with an empty findings list. The complete structured review was recovered from the event log (`round-1-findings.json` in the artifacts dir). No session id was recorded, so round 2 started fresh.

| # | Sev | Finding | Fixed in |
|---|---|---|---|
| RB-01 | high | strict five-field `VoiceStateSchema` rejects real Run A rows, which carry `updatedAt` in `before`/`after` | T1 Step 5 (`StoredVoiceStateSchema` accepts and drops `updatedAt`), T1 Step 16, T7 Steps 1–2 (production builders) |
| RB-02 | high | poll deadline unreachable when a fetch never settles | T3 Step 6 (independent deadline timer + abort), T3 Step 4 |
| RB-03 | high | Refresh plan took the composer scope, not the stored location | T3 Step 6 (`send(text, locationId)`, `refreshPlan(turn)`), T4 Step 6 |
| RB-04 | high | card rendered array fields as counts, hiding same-count replacements | T4 Step 4 (`VoiceStateDetail`, item diff), T4 Step 1 |
| RB-05 | medium | lost-response retry minted a new `clientTurnKey` | T3 Step 6 (`PendingSubmission`, verbatim retry), T3 Step 4 |
| RB-06 | medium | segments without `text` (status, scope_check) not rendered; proposal placement lost | T3 Step 6 (exhaustive `TurnBody`), T3 Step 4 |
| RB-07 | medium | failures and requested capabilities not durable across reload | T2 Step 3 (`listUnsupportedForTurns`), T2 Step 19, T3 Step 6, T3 Step 4 |
| RB-08 | medium | latest-conversation load not adopted; start-over refetched the old transcript | T3 Step 6 (adopt id, `fresh` flag, resume unfinished turn), T3 Step 4 |
| RB-09 | medium | first-time owner got 404, no summary or connect CTA | T2 Step 19 (nullable `conversation`, empty view), T2 Step 20–21 |
| RB-10 | medium | repeat Apply after location archival lost the stored Receipt | T1 Step 14 (proposal status branched before the location refusal), T1 Steps 12, 16 |
| RB-11 | medium | four test-body defects (regex, mock name, `UPDATE` vs `FOR UPDATE`, harness export) | T3 Steps 10–11, T2 Step 17, T1 Step 12, T7 Step 2, T0 Step 6 |

Titles added (all in the intake `tests_to_add`): worker-produced proposals render and apply successfully · operator times out while a poll request remains unresolved · Refresh plan preserves the original instruction and location after scope changes · proposal previews expose exact fact replacements before approval · retry after a lost POST response resumes the original turn · operator renders every stored segment kind in order · terminal failures and requested capabilities survive reload and subsequent turns · loaded conversations retain identity and starting over stays empty · first-time owner receives a scoped summary and connection CTA before sending · repeat Apply after location archival returns the original receipt without writes.

## Round 2 — verification (7 accepted)

| # | Sev | Finding | Fixed in |
|---|---|---|---|
| RB2-01 | high | T2 Step 19's consolidated replacement omitted the `unsupported` read RB-07 added | T2 Step 19 |
| RB2-02 | medium | `mockGetConversation` (undefined) referenced twice | T2 Step 17 |
| RB2-03 | medium | nullable `conversation` left unguarded `.id` reads in `reads.integration.test.ts` | T2 Step 21 (`conversationOrThrow`) |
| RB2-04 | medium | unfinished-turn discovery ran only when `conversationId` was null | T3 Step 6 (adoption and discovery separated) |
| RB2-05 | medium | start-over test clicked before the timeout state existed | T3 Step 4 |
| RB2-06 | medium | router mock changed identity per render → effect loop | T3 Step 4 (hoisted stable router) |
| RB2-07 | low | "Cleared" shown for a null before value when the proposal sets a value | T4 Step 4 (`side`) |

## Round 3 — verification, resumed (1 accepted; loop closed)

| # | Sev | Finding | Fixed in |
|---|---|---|---|
| RB3-01 | medium | the resumption callback captured `turnId === null`; a delayed conversation GET could replace a freshly submitted turn in state and URL | T3 Step 6 (`activeTurnIdRef`, `loadEpochRef`, abort on POST), T3 Step 4 (title "a delayed conversation response never replaces a newly submitted turn") |

Coverage claimed by Codex at round 3: all seven round-2 corrections verified; RB3-01 introduced by the RB2-04 correction. Limitations: no execution (read-only); the red baseline gate was not investigated (it is the pre-T0 `feature-surface` row and the local `ADMIN_APP_URL` e2e row — see the deviations file).

## Root's own review before round 1

Ratified P3–P10 as drafted. Reversed two: V3/P1 (page path → `/dashboard/operator`, owner decision) and V4/P2 (nav test in the existing suite). Fixed one defect: `recordTerminal`'s UPDATE lacked a `status = 'pending'` predicate.
