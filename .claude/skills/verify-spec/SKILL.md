---
name: verify-spec
description: Audit a spec, plan, or launch-readiness doc against the actual codebase and emit an evidence-backed per-item verdict table plus an overall PASS/FAIL. Use when the user asks to verify, audit, or confirm that a spec/plan/checklist/launch doc was implemented, or asks "what's remaining" on a checklist. Verify-and-report only — it never implements fixes.
---

# Verify Spec Against Codebase

Audit-only skill. You verify and report; you do NOT implement, fix, or edit the
spec docs. The user decides what happens with the findings.

## Inputs

Use the spec/plan/checklist paths from the user's current request. If none are
given, ask which document(s) to verify — do not guess.

## Procedure

1. **Read the doc(s) and extract every verifiable claim** — checklist items,
   "must/should" statements, audit ticks, acceptance criteria. Number them.
   Ignore narrative prose with no testable assertion.

2. **Set up the incremental findings file** at
   `/tmp/verify-spec-findings-<docname>.md`. Append findings per item as you
   go — never accumulate the whole audit for one giant final message (large
   audits have hit output-token limits before).

3. **Verify each item against reality, not against other docs.** Evidence
   hierarchy, strongest first:
   - code inspection at a specific `file:line` (use `rg` to find symbols and
     callers, then inspect the source and tests directly)
   - `git log`/`git diff` showing the change landed on `main`
   - a passing test that pins the behavior
   - migration applied (check `.claude/reference/migrations-log.md` head)
   A tick in another doc is NOT evidence. Mark each item:
   - `VERIFIED` — concrete evidence found
   - `PARTIAL` — implemented but incomplete vs. the claim (say what's missing)
   - `MISSING` — no evidence of implementation
   - `STALE` — doc claims something the code contradicts (flag for doc fix)

4. **For audits over ~15 items, fan out**: split items into sections and
   dispatch one Explore subagent per section, each returning a compressed
   `item | status | evidence` block. Verify any surprising MISSING/STALE
   finding yourself before reporting it.

5. **Run the validation suite** (skip any the turn already ran):
   - `pnpm lint && pnpm typecheck && pnpm test`
   - if any item touches DB/schema: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
   - if any item touches analytics or flags: `pnpm ci:analytics-events && pnpm ci:static-policy`

6. **Emit the mandatory output contract.** The final message MUST end with:

   ```
   | # | Item | Status | Evidence |
   |---|------|--------|----------|
   | 1 | ...  | VERIFIED | src/lib/foo.ts:42 |

   Suite: lint PASS | typecheck PASS | test PASS (NNN) | audits PASS/SKIPPED

   VERDICT: PASS            # every item VERIFIED and suite green
   VERDICT: FAIL — <n> items remaining: <numbered list of MISSING/PARTIAL/STALE>
   ```

   No audit ends without a `VERDICT:` line. "Ran out of things to check" is
   not a verdict.

## Rules

- Evidence before assertions — never mark VERIFIED from memory or doc ticks.
- Report STALE doc ticks; do not silently fix them (verify-and-report only).
- If the working tree is dirty, say so up front — audit `main`/HEAD state and
  note which findings could be affected by uncommitted changes.
