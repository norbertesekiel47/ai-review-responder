# Run E: proposed release verification exception

Status: PROPOSED ONLY. No approval is inferred and no merge is authorized by this document.

## Exact scope

For feature PR #1293 at `fb66d15dd1297927f4fe9aaee0dc1c682d01e3a4`, accept its completed required GitHub checks and previously completed local verification of identical application/test code in place of a fresh green local wrapper after the final report-only commit. This would permit the already authorized feature merge and documentation closeout to proceed. It would not declare the current local gate green, alter its fingerprint, modify tests/timeouts, change guard scripts, or grant further adversarial rounds. Record the exception and failed attempts permanently in release evidence. Any further application/test/configuration changes invalidate this exception.

## Evidence

- The complete local wrapper passed at parent `ba0c65bb3a3665ed10a6441d27917802819ad4c1`: all 44 rows, including the acknowledged estimate warning, build, coverage, and local database checks. Database suite: 16,218 passed and 11 skipped.
- The only diff from that parent to the proposed release is the two final adversarial report files: 195 insertions, 7 deletions. Application code, tests, dependencies, and test configuration are identical.
- Current-head GitHub CI run 34962247726: required changes, lint, test, llm-eval, and build passed; deploy-install was validly skipped. The optional Fallow audit failed on the disclosed eight complexity findings and two clone groups.
- Current-head E2E run 34962247838 passed (30 tests, 54 skipped); React Doctor run 34962247896 passed.
- Normal pre-push hooks passed, including 3,594 affected tests and 1,693 guard tests (6 guard skips).
- Final adversarial report is CLEAR: 802 supervised launches in approved round 2, 401 restored pairs, 12 findings fixed, none open. No additional rounds are requested.
- Staging journeys, backend checks, migration lockstep, synthetic fixture cleanup, and unchanged production Operator flag evidence are complete, with the documented qualifications retained.

## Failed attempts and remaining uncertainty

The first current-head local suite had four timeout failures (14,899 passed, 1,316 skipped); its remaining wrapper checks were stopped and archived. An unchanged focused coverage rerun passed all 27 tests in the two affected files.

The second current-head local suite, with one worker, had ten timeout failures across four files (14,893 passed, 1,316 skipped; 1,280.09 seconds). All ten failure messages explicitly report test timeouts. The primary suite completed with exit 1; the remaining wrapper checks were stopped and archived. Heavy host memory compression and approximately 15.8 GB of used swap were observed. This supports an environmental explanation but does not prove every timeout's cause.

Archives: `/private/tmp/run-e-release-gate-timeouts-fb66d15d/` and `/private/tmp/run-e-release-gate-one-worker-fb66d15d/`. Existing gate status/fingerprint remain historical and must not be presented as current green evidence.

## Requirement being excepted

`.agents/skills/feature/SKILL.md` section 6.5 requires: "Re-run the wrapper gate last, so the fingerprint regenerates over the committed report, then transition."

The proposed exception concerns only that final report-commit local gate requirement. Required GitHub branch protections, truthful reporting, review findings, production flag restrictions, and all other release requirements remain applicable. If a mechanical workflow guard cannot represent the approved exception without falsifying evidence, report that limitation rather than fabricating a successful check.

## Alternative

Preserve all work, free host memory (for example, restart the Codex application), and resume the unchanged local gate afterward. This requires another full run with uncertain duration and is not guaranteed to remove the timeouts.
