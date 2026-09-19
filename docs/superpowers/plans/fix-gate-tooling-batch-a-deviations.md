# Deviations — fix/gate-tooling-batch-a

Entries a subagent or the root writes when the plan did not anticipate something.
Each needs a resolved **Verdict:** ACCEPT or RE-PLAN before step 7.

## T1 (#1108) — the fix breaks `scripts/ci/__tests__/gate-rows.test.ts`, a file outside T1's edit surface

T1's mandate is exactly three files: `scripts/gate-promised-tests.sh` (create),
`scripts/ci/__tests__/gate-promised-tests.test.ts` (create),
`scripts/verify-gate.sh` (modify). The plan's T1 section and the intake's
`allowed_edit_surface` both omit `scripts/ci/__tests__/gate-rows.test.ts`.

That file's `describe('promised-tests title discovery', ...)` block
(`scripts/ci/__tests__/gate-rows.test.ts:185-268`) extracts the OLD
`grep -rqF "$TITLE" ...` line out of `verify-gate.sh` via regex and re-runs it
against fixtures — the exact line T1 is required to delete and replace with
`promised_title_found "$TITLE" src worker scripts tests`. After T1's required
change, `pnpm vitest run scripts/ci/__tests__/gate-rows.test.ts` regresses:

- `promised-tests discovers promised corpus titles under tests/llm-eval` —
  FAILS: `GREP_LINE` is now `undefined` (its own designed tripwire: "the
  promised-tests grep line moved or was renamed").
- `keeps discovering titles under the roots it already searched` — FAILS for
  the same reason (`${GREP_LINE}` interpolates as the string `undefined` in
  the spawned bash command).
- `still reports a genuinely unwritten title as missing` — still reports
  green, but vacuously: the spawned command becomes
  `TITLE=...; undefined && echo FOUND`, which errors before `echo`, so the
  assertion (`stdout` does not contain `FOUND`) holds for the wrong reason.

Verified at this task's HEAD with the T1 changes applied and nothing else
touched: `Test Files 1 failed (1)`, `Tests 2 failed | 16 passed (18)`.

T1 did not edit `gate-rows.test.ts` and is not requesting permission to. The
row this describe block exercises now lives in `scripts/gate-promised-tests.sh`
and is covered end-to-end by the new
`scripts/ci/__tests__/gate-promised-tests.test.ts` (8/8 passing, including a
`verify-gate.sh row wiring` case that greps for `gate-promised-tests.sh` and
`promised_title_found` rather than the old inline grep). Suggested resolution
for whichever task/step owns `gate-rows.test.ts`: delete the stale
`describe('promised-tests title discovery', ...)` block (its subject moved to
`gate-promised-tests.sh`/`gate-promised-tests.test.ts`), or repoint its
`GREP_LINE` extraction at the new `promised_title_found "$TITLE" ...` line
and drop the now-meaningless `--include`/root assertions that duplicate the
new suite.

**Verdict:** _(pending — needs sign-off from whoever owns
`scripts/ci/__tests__/gate-rows.test.ts` before step 7; not resolved by T1)_

