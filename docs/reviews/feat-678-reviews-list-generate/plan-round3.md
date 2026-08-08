# Plan review — round 3 (verification-only, FINAL, codex, read-only)

**VERDICT: APPROVED** · 0 findings · dispatched via direct `codex exec --sandbox read-only --json`

Mandate (the D7 test): *if a subagent executes only the checkboxes of the owning
task — no appendix, no rationale paragraph, no deviations file — does the fixed
behaviour result?*

## Verification table

| # | Landed? | Evidence |
|---|---|---|
| F5 | YES | Task 3's checkbox queries the open flag and returns `idle` before exposing text (`plan:437,501,517`); Task 4 emits `draft_held` **without filtering** the draft (`plan:585,602,621`) |
| F8 | YES | Task 8 Step 4 explicitly edits the process-env baseline + both live reference files and requires `pnpm ci:process-env` (`plan:995,999`); all three in `allowed_edit_surface` (`intake:88`) |
| F9 | YES | Task 1 creates `generate-version.integration.test.ts` with live-schema conventions — no migration SQL, `assertSchemaReady` (`plan:103,109`) |
| Defect A | YES | Inside Task 5 Step 2b: `toCardRow` preserves orphan failure id, response id, posting error, superseded text, null posted fields (`plan:821,827`) — matches the existing mapper (`replies-view.ts:100`) and the card's predicates (`PastReplyCard.tsx:157,201`) |
| Defect B | YES | `held` defined as a sixth state, resolved on the **same non-null-draft branch** as `draft_ready`, before `generate` (`plan:753,761,777`); Task 7 renders it with no affordance + exhaustive switch (`plan:939`) |

## New consequences 1–4 — all confirmed

1. **`held` is reachable and total** — emitted (`plan:602`), consumed (`plan:779`), rendered (`plan:943`); branch order prevents fallthrough to `generate`.
2. **D6's inline `EXISTS` reasoning holds** — `hasOpenFlag` requires a transaction client and is documented as post-lock (`held-draft.ts:17,29`); the poller uses `sqlRead`, the list uses a LATERAL, and `held-draft.ts` is outside the surface (`intake:64`). **The inline predicate matches the helper's semantics exactly** (`held-draft.ts:35`).
3. **Orphan pagination claim verified** — sidecars are inside the main query's `LIMIT/OFFSET`, the unanswered count's `NOT EXISTS` includes them, `groupReplies` receives one array (`plan:611,656,672,821`).
4. **Test coverage** — all 52 mandated verbatim with homes in the list-query and card-state files (`plan:106,113,116`); the D8 titles directly pin orphan mapping and held-row rendering (`intake:143`).

## Noted, fixed after the review

Reviewer flagged the introduction's "five-way" wording as stale (`plan:7`, `plan:38`)
while correctly ruling it **not** grounds for REVISE — it does not change what the
checkboxes build. Corrected anyway to six-way (and the LATERAL count in the same
sentence from two to four), since a stale summary is how a later reader
reconstructs the wrong model.

No gate or test suite was run, per the verification-only constraint — consistent
with round 1's recorded lesson that a declined `verify-gate.sh` is never evidence.

## Round budget — closed

Plan review rounds: **3 of 3 used.** Verdict `APPROVED` on the final round, so no
owner adjudication is required (feature.md step 3.4 applies only to an unresolved
round-3 disagreement). Phase advances to `plan_approved`; step 4 dispatch follows
the order in the handoff.

## Arc across the three rounds

| Round | Verdict | What it caught |
|---|---|---|
| 1 | REVISE | 9 findings — the eval could pass while the feature was wrong (auto-approval regression, cross-tenant leak, duplicate jobs, duplicated orphan rows, fail-closed UI) |
| — | — | *(orchestrator, pre-round-2)* F3 was described but not applied |
| 2 | REVISE | F5/F8/F9 likewise described but not applied; 2 defects the fixes introduced (orphan mapping loss, no representable held state) |
| 3 | **APPROVED** | all fixes verified inside the executable steps |

The through-line — **four of nine round-1 fixes never reached a checkbox** — is
deviations **D7**, and it is a `/feature` workflow lesson rather than a #678 one.
Promote to lab-notes at step 8.
