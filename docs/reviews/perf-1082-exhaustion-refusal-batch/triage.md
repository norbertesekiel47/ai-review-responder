# #1082 — review wave round 1, triage

Wave dispatched at HEAD `4f39fbd2`, fork `b9fb9601`. Five axes: spec &
correctness, standards & maintainability, async & transaction semantics,
red team, Codex adversarial-approach.

Full reports: `async.md`, `spec-correctness.md`, `standards-maintainability.md`
in this directory; `blast-radius.md`; red-team sidecar at
`docs/reviews/red-team/perf-1082-exhaustion-refusal-batch-63c82c/`.

The production diff was 87 changed lines, above the standards axis's 300-line
threshold only by risk class: `RISK = high` runs that axis unconditionally.

## Verdicts

| ID | Sev | Axis | Finding | Verdict |
|---|---|---|---|---|
| T1 | high | standards | The bound is `BATCH_CAP` 25, not `MAX_DATA_ROWS` 5,000 — rationale 200x too large in 4 places | **FIXED** — see D4 |
| T2 | P0 | red team | The `invocationCallOrder` "LOAD-BEARING" claim is false; plain concatenation is green | **FIXED** — see D5 |
| T3 | med | standards, spec, async | `recordOutreachWithheldRefusal` docblock still claims three call sites; two remain | **FIXED** — census corrected, and the keep-vs-inline decision recorded in the docblock |
| T4 | low | spec | `mockClear()` at the mapping test's phase boundaries is one-armed | **FIXED** — `clearRefusalCalls()` |
| T5 | P1 | red team | 8 `path:line` citations stale at HEAD; `prevalidate-plan.py` resolves files, not lines | **FIXED** — plan and intake now cite BY SYMBOL |
| T6 | P2 | red team | Intake observability claim conflates the job's Sentry issue with the settlement's own signal | **FIXED** — verified `deadLetterWholeBatch` catches and never rethrows |
| T7 | P2 | red team | "no holes" test title states a property its assertions do not | **FIXED** — the title's property asserted first and alone; the design pin split out and labelled |
| T8 | P1 | red team | The new abort test duplicates the pre-existing per-writer rollback case | **PARTLY ACCEPTED** — kept, comment now names the sibling and the two real differences (2 holes vs 1; a Postgres 22012 abort vs a JS throw) |
| T9 | med | Codex | N live kill-switch reads became one deferred read | **REJECTED** — see D6/R1 |
| T10 | med | spec | The unit suite is intermittently red at HEAD | **REJECTED** — see D6/R2 |
| T11 | low | async | `docs/directory.md` prose stale | **RAISED, NOT TAKEN** — outside `allowed_edit_surface`; follow-up filed |
| T12 | med | standards | Inline `recordOutreachWithheldRefusal`, now a pass-through | **REJECTED** — see D6 |
| T13 | med | Codex | No measurement; the lock window is still O(N) | **ACCEPTED, OWNER DECISION** — the owner chose a controlled staging drill over shipping on reasoning |
| T14 | high | Codex | A normal staging ride cannot reach `settleGenerationExhaustion` while `SOLICITATION_SEND_ENABLED` is off | **ACCEPTED, OWNER DECISION** — controlled drill, not a plain ride |

Reasoning for every rejection is in
`docs/superpowers/plans/perf-1082-exhaustion-refusal-batch-deviations.md`
§ D4-D6. No finding was skipped silently.

## The axis disagreement, and how it was settled

The standards axis derived the bound as 25 from `BATCH_CAP`. The async axis
re-derived it as 5,000 from the candidate window and wrote "no correction
needed" in the same wave. Neither axis settled it — the code did:

1. `holes` filters `ask.status = 'send'`.
2. `commitAskDecisions` writes `status: decision.decision`.
3. `evaluateBatch` keeps at most `BATCH_CAP` = 25 `send` decisions.
4. `AskDecision` is `send | withhold`; the sole `UPDATE solicitation_asks`
   sets `agent_run_id`, never `status`.

The async axis conflated *asks inserted* — up to 5,000, nearly all `withhold` —
with *asks carrying `status='send'`*, which is at most 25.

## What survived the wave unchanged

The code. Same-`tx` guarantee proven by type; self-conflict inside the one
statement unreachable because every `subject_id` is a fresh `uuidv7`; error
semantics, retry idempotency and the one-warning-per-disabled-episode budget
all unchanged; 7/7 non-goals, 11/11 edge cases and 7/8 invariants verified;
all nine production ledger call sites audited with zero missed loops; 13
mutations journaled and restored with a clean tree.
