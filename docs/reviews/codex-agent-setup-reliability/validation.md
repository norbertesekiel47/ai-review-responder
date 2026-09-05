# Agent setup reliability review

## Scope

The setup audit asked for reliable Codex guards, consistent feature lanes,
reversible intake preparation, native review/usage handling, focused context
loading, and accurate MCP discovery. This change implements the repository
portion of that audit. Machine-local memory observer fixes and explicit-only
personal skill settings are installed separately and are not vendored here.

## Standards review

Independent reviewer `setup_standards_review` reviewed all 25 files in
`3fc20680...53550b4c` against AGENTS, project working rules, feature rules, and
hook maintenance guidance. No actionable standards or maintainability findings.

## Correctness review

Independent reviewer `setup_spec_review` found one incomplete routing fix:
an armed small/high resume could enter execution without plan approval.
**ACCEPT:** remove that resume shortcut and reject
`worktree_ready -> executing` in the guarded transition wrapper. The new
behavioral regression checks refusal with unchanged state, then allows execution
after `plan_approved`. No other concrete omissions or regressions were found.

## Local validation

Validation used independent dependencies in the sibling worktree, rebased onto
`3fc20680`, with no modifications to application behavior:

- Clean `pnpm build`: passed using the normal Turbopack build command.
- Full `REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test`: 13,941 passed, 1,142 skipped.
  Live database suites are intentionally excluded from that local result; CI
  provides the database-backed gate.
- Focused runtime and lane tests after the review fix: 41 passed.
- The earlier guard follow-up also reproduced concurrent file deletion and
  verified that changed content never receives a stale green cache entry.

GitHub CI and local pre-push checks are the final merge gates. Hook changes need
review in Codex's `/hooks` UI; fresh tasks load new MCP/skill metadata.
