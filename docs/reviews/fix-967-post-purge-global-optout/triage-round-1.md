# Triage — spec & correctness review, round 1

Branch `fix-967-post-purge-global-optout`. Full findings and low-confidence
appendix: `spec-correctness-review.md` in this directory. Verdicts below are
the orchestrator's, one line each, in the reviewer's severity order.

| # | Severity | Verdict | What was done |
|---|---|---|---|
| 1 | HIGH | **ACCEPT** | Confirmed independently: `checkFailedInboundEvents` (`checks.ts:274`) keys on `status='failed'`, so acking retired a pager and replaced it with a log nothing subscribes to. Added `reportUnattributedSuppression` — a Sentry `captureMessage` at `level:'warning'`, tagged `feature/event/source`, in its own try/catch. Precedent: `worker/ingress/stripe/subscription-updated.ts:154`, an ingress module doing exactly this. No second surface amendment needed. `CONTEXT.md` and the intake's `observability` field corrected to say the pager was traded, not merely retired. |
| 2 | MEDIUM | **ACCEPT** | Correct, and it contradicted the file's own pattern. `withAttribution` now returns a three-way `LaneOutcome` (`attributed` / `unattributed` / `ignored`) so the fallback reports AFTER the commit like the other four paths. A failing COMMIT can no longer emit `ledger_row_written: true` for a discarded row. |
| 3 | MEDIUM | **ACCEPT** | Verified: `grep failed_at worker/jobs/publisher/veto-window-gate.ts` returns nothing. The amendment now states the split explicitly — both lanes share `MIN(sent_at)`, the `failed_at IS NULL` arm is solicitation-only — and names why (this lane mails 25 real customers), leaving Reply-lane adoption as an open question the amendment does not decide. |
| 4 | MEDIUM | **ACCEPT** | Real test-strength gap on a locked intake invariant. Case 1 now feeds `  ${handle.toUpperCase()} ` and asserts both that the stored key is the lowercase handle and that the echoed form is not a second key. A plausibility-only replacement for `normalizeEmail` now fails. |
| 5 | LOW | **ACCEPT** | Correct hole. `readRecipients` no longer filters — it returns entries unfiltered so cardinality is measured on the raw payload, and a non-string sole entry throws its own error. Error wording moved from "recipient addresses" to "recipient entries" to stay accurate. Pinned by a second `captureThrow` in the multi-recipient case using `to: [addr, {…}]`. |
| 6 | LOW | **ACCEPT** | Added a 10th case, `an acked unattributed suppression event marks its inbound event processed`, driving the real `handleResendWebhook`. It is the ack-side twin of the existing 503 case and the only thing pinning the two retention claims in `user_visible_behavior`. |
| 7 | LOW | **ACCEPT** | Doc block reattached to `purgeContactChain`; `captureThrow` keeps its own. |
| 8 | LOW | **PARTIAL** | Behaviour kept, reasoning made explicit. The unscoped read and sweep rest on two conditions and the comment named only one; it now names both (the cross-process live-DB lock for concurrency, `fileParallelism: false` for sequencing) and states that a leaked null-account row SHOULD turn these cases red rather than hide inside a LIKE pattern. A leak in a no-expiry compliance ledger is not something to make quiet. |
| 9 | LOW | **REJECT** | `docs/superpowers/plans/…-intake.json` is the harness's own artifact, installed and committed by `scripts/feature-setup.sh` before any implementation edit. It is not scope drift, and `ci:feature-surface` passes. |

## Verified clean by the reviewer, recorded so a later round does not redo it

- All 9 original `tests_to_add` titles present verbatim; all 9 `edge_cases` implemented.
- The tenant-scope allowlist is snippet-keyed, so the line shifts do not break `ci:tenant-scope`.
- `ArchivalPoller` really does sweep `status='processed'` only — the retention claim holds.

## Round accounting

Round 1 of a maximum 3. No round 2 dispatched: every accepted finding is fixed
and re-verified by the gate, and re-reviewing unchanged code is the
over-reviewing this workflow's round protocol exists to prevent.
