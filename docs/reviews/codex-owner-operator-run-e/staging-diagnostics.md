# Run E staging Undo diagnosis

The approved staging campaign on `da87399c317d89f85ca8076a6dc1643c4c8995cc` exposed a release blocker after the local review gate. This incident record is separate from the frozen adversarial reports because their measured evidence must remain intact. It does not declare the new candidate verified or the incident resolved.

At 2026-09-15T09:22:07.379987Z, synthetic Salon turn `01a0a45f-8470-752a-8e23-1c43e9486596` for “Undo my last change for Salon.” failed with `model_output_invalid`. Both OpenAI completions passed structural validation and failed one semantic check. No proposal or settings write followed. Existing warnings contain only `reason_count: 1`, which cannot distinguish completion prose, scope, or reference errors. Actual button-driven Restore and stale-plan protection had passed. The exact cause remains unconfirmed.

## Root adjudication

ACCEPT E-STAGING-1: the required natural-language Undo journey failed. Preserve that failure and investigate before release. ACCEPT E-DIAGNOSTICS-1: add only closed semantic rejection codes to the existing warning so the next authorized staging request yields an actionable reason without retaining raw model output, owner text, or model-controlled reason suffixes. This changes diagnostics only; prompt, validator decisions, attempts, cost recording and settings writes remain unchanged.

The implementation stays in existing `render.ts`, `model-call.ts` and their tests. An independent Codex review found that the first draft's array would be dropped by the shared logger sanitizer. The corrected warning joins closed codes into a scalar. Its integration assertion observes actual emitted JSON through `console.warn`, with the real logger and sanitizer, rather than replacing the logger. The shared sanitizer is unchanged.

Reviewer `/root/run_e_settings_targets` approved the corrected four-file diagnostic diff for commit and staging diagnosis. Focused verification: 29 tests across the render/model-call suites passed; retained local log `/private/tmp/run-e-diagnostics-focused.log`. The corrected candidate's `pnpm build` passed, with log `/private/tmp/run-e-diagnostics-corrected-build.log`. The earlier build of the array draft is historical and does not verify the corrected tree.

## Existing authority and evidence limits

The owner's scoped E second-pass approval and its retained design expressly permit root adjudication of a required later code correction within the same round and cap. The original round-2 journal remains at 776 launches out of 1,600; all previous admissions and measurements remain immutable. No third round, counter reset, silent pin replacement, extra provider probe, or production Operator enablement is authorized here.

The final red-team report on the earlier measured candidate is historical evidence for that candidate. It cannot certify this diagnostic candidate or a later fix. Final release needs an explicit finite continuation admission, affected-case reconciliation and fresh verification under the existing cumulative cap. Intermediate staging diagnosis uses the already authorized staging operation after focused checks, build and independent review; it is not a merge approval or a claim that the final release gate is green.
