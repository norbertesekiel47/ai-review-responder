# Review wave round 2 (verification) — feat/owner-operator-run-a

Pinned: fork `c5e94e6ca7e3c4187854a67129b1651a8f80566e` · fix commit / head `eb21f55c2bf6b61c836ede6fc113e1d2caae3e08` · gate GREEN at head, fingerprint `a4f3d1e7…`.
Members: spec & correctness verification (fresh agent) · standards verification (fresh agent) · Codex adversarial — **resume failed** (`thread/resume: no rollout found for 01a09406…`; the companion's session is not resumable by `codex exec resume` on this machine), so no Codex round 2 ran; its two code findings (CA2, CA3) were verified by the spec axis and its other three were documented or rejected in round 1 · red-team round 2 scoped to the fix hunks (`docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/`, status OPEN_P0).
Full reports: `spec-correctness-round2.md`, `standards-maintainability-round2.md`, the red-team `findings.md`/`findings.json` (round 2 supersedes round 1 in place; round 1 is at `41f94b874`).

## Verification outcome

- Spec axis: SC1–SC7, CA2, CA3 all ADDRESSED with file:line evidence.
- Standards axis: SM1–SM7, SM9–SM12, SM15 all ADDRESSED; SM8, SM13a, SM14 confirmed left as triaged. `turns.ts` 742 → 510 lines; `reads.ts` 278 (new); `AgentTurnWorker.ts` 379 → 313.
- Red team: all five round-1 P0 mutants now KILLED (F1–F5); F6–F11 closed.

## New findings from round 2 and their verdicts

| # | Sev | Finding | Verdict | Disposition |
|---|---|---|---|---|
| R1 | P0 | `listProposalsForTurns` fake-covered: an always-empty map survives; transcript cards and `proposalSummaries` asserted nowhere | ACCEPT | Oracle gap, not a production defect. Fix: assert the conversation read's `turns[].proposals` and the snapshot's `proposalSummaries` against seeded proposals in `reads.integration` / `snapshot.integration`. Needs a code commit → round 3 authorization. |
| R2 | P0 | `projectOperatingRules.locationOverrideExists` has no non-mocked oracle | ACCEPT | Oracle gap. Fix: live case seeds a location override row and asserts `true`, and asserts `false` on the location without one; replace the `vetoWindowMinutes > 0` proxy (R4) with equality. Round 3. |
| R3 | P1 | `if (!voice)` terminal branch untested (= spec round-2 low #3) | ACCEPT | Unit case in `AgentTurnWorker.test.ts`. Round 3. |
| R4 | P1 | Range-shaped proxy `vetoWindowMinutes > 0` | ACCEPT | Folded into R2. |
| R5 | P1 | `context.test.ts` closed-list guard no longer closes the list | ACCEPT | Seed one turn so the fifth read runs; assert `toHaveLength(5)`. Round 3. |
| R6 | P1 | Stale plan citation `voice/route.ts:23` | ACCEPT | Cite the symbol. Round 3 (docs). |
| R7 | P1 | `updateVoiceConfig` returns `iso(updated_at)` while the token spelling is `updated_at::text` (= spec round-2 low #1) | ACCEPT | `RETURNING updated_at::text`; the writer's unit test asserts the text spelling. Round 3. |
| R8 | P2 | Absence-of-token proxies in new render tests | REJECT (recorded) | Same class as round-1 RT12; the positive assertions sit beside them. |
| R9 | P2 | New terminal path emits `logger.warn` only, no Sentry rule row | DEFER | Real, but identical to the five sibling terminal paths that pre-date the fix; belongs to Run A's go-live alerting adjudication as one decision (spec §14 item added at ship). |
| R10 | P2 | Status-narrowing throw branch untested | ACCEPT (cheap) | One unit case beside the narrowers. Round 3. |
| spec-r2 low #2 | low | `summary.facts.updatedAt` now serializes as Postgres text | DOCUMENT | Deliberate: it IS the **Version token** spelling Run B compares text-to-text; the DTO comment says so. No change. |
| standards-r2 lows (3) | low | `render.ts` gained a fourth concern; the ten-column SELECT spelled three times; `UnsupportedRow` map left in the handler | DEFER | Maintainability follow-ups for Run B, which reworks `render.ts` (Apply cards) and `proposals.ts` (lifecycle) anyway. Recorded in the deviations file. |

## Owner decision required (RISK = high, round cap reached)

Two P0s stand open after round 2. Both are test-oracle gaps (a mutant that forces an empty batched read or a wrong `locationOverrideExists` survives); neither is a defect in the shipped behavior at head. The fixes are seven small test/doc edits plus one `RETURNING updated_at::text` clause. A third red-team round needs an owner authorization recorded in the sidecar before `round-start` will open it (red-team SKILL.md § Preconditions 3).

Recommended: authorize round 3, scoped to the R1–R7/R10 fix hunks. Alternative: accept the two P0s as recorded oracle gaps and authorize shipping with them open, deferring the tests to Run B.
