# Run D — standards and maintainability

Reviewer: native Codex `/root/run_d_standards_async_final` (also the independent async reviewer; these are two axis reports from one reviewer).

Pinned HEAD: `8b1c612b08d2b93208b4fbb7102f7d917ea9b9c2`.
Pinned fork/merge base: `a95478037fb662cae6ce2e4cc1eb89671016b492`.
Gate input: GREEN, fingerprint `7cc2dca733f1417ff888833d86ad14289a32e6484e9973d2f08f497a5cad65bb`, supplied by root; tooling was not rerun.

VERDICT: APPROVE

Actionable findings: none at the required 80% confidence threshold.

The review used the supplied Run D intake/diff brief, its final test-only addendum, and committed source read through `git show`. Every line of `docs/reviews/finding-checklists/standards-maintainability.md` was read and checked for applicable defect classes. The entry/context-layout instructions, worker and live-DB rules, directory ownership, plan, and deviations informed the assessment.

- Seam placement and locality: lifecycle reconciliation stays in the existing `turns.ts` owner. The poller owns dispatch budgets and terminal CAS selection; the domain helper receives the open transaction, winning stored outbox ID, and lease duration. There is no new lifecycle framework, production file, or dependency. Explicit-client phase exports follow the established watchdog integration seam and retain the actual production dispatch/acknowledgement path.
- Failure ownership: the worker's two existing release callers both consume the new discriminated outcome. Predecessor waiting delays only after `released`; transient failure suppresses retry only after `failed` and preserves the original scheduling error after `lost`. No new swallowed-error branch was found. The distinct async recovery defect is reported in `async.md`, not duplicated as a style finding.
- Test coupling and oracles: the integration cases use real PostgreSQL state, tenant fixtures and the existing abort helper, with fake transport/model boundaries. Tests inspect durable turn/outbox pairs and an intermediate dispatching heartbeat before acknowledgement can overwrite it. They do not replace lifecycle decisions with mocked SQL results. The final `8b1c612b` addendum correctly identifies sibling proposal IDs by distinct input tones and then asserts the stored reply's order against those identities; tied transaction timestamps no longer supply the ordering oracle.
- Naming, duplication and documentation: the failure token is added to the existing vocabulary and owner recovery wording. No new competing DB singleton, status owner, queue, or dependency was introduced. Checked checklist classes concerning circular test oracles, duplicated owners, inaccurate test mechanisms, and fragile row ordering; no additional actionable standards defect was established.

Limits: this was a source review, not a new test or browser verification run. No tracked files, provider state, or external systems were changed. Approval on this axis does not override the async report's requested correction.
