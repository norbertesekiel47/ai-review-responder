# SEC-1 correction verification — #1190

Reviewed head: `83184894ee71e895fd1b91fa8f3c0869cfd89859`.
Prior reviewed head: `6c42b8050acdeac698171a57d26b56d4fcbd8fcf`.
Scope: the SEC-1 filesystem guard correction and its direct callers/fixtures in `scripts/ci/admin-contract-audit.ts` and `scripts/ci/__tests__/admin-contract-audit.test.ts`. All code and checklist evidence came from immutable git objects. `pnpm agent:rules .feature/review-staging/security-verification.md` returned `none` before this report was authored.

**SEC-1 is fixed.** The sole accepted defect class in the pinned security checklist—regeneration following symlinked output ancestors—was checked against this correction.

- `scripts/ci/admin-contract-audit.ts:215–223` checks both repository-relative ancestors, `docs` and `docs/admin-api`, with `lstat`. Symbolic links and existing non-directories are rejected. The checks precede generation at line 224 and both CLI branches, including enumeration/removal at line 227, artifact writes at line 228, and audit reads at lines 235–236. Only `ENOENT` is tolerated, preserving first-generation directory creation.
- `scripts/ci/admin-contract-audit.ts:42` also checks the directory passed to the traversal itself before `readdir`. The direct `auditContractFiles` caller at line 62 therefore rejects a linked root; the existing child-entry guard remains in place at line 51.
- `scripts/ci/__tests__/admin-contract-audit.test.ts:105–120` covers both linked locations and both CLI modes in isolated temporary directories. Each case asserts failure, the symlink diagnostic, and unchanged external sentinel content. These cases directly exercise the original cleanup failure without touching real application directories.
- The direct-audit fixture at test lines 53–55 puts the alias in a separate temporary container, so a symlink entry inside the target cannot accidentally satisfy the regression assertion. Test lines 123–134 cover existing non-directory output locations and preservation of their contents in both modes. The normal generation fixture at lines 87–102 starts without the output directories and retains successful creation, audit, drift and regeneration coverage.

No unresolved SEC-1 issue remains within the specified correction scope. No unrelated review fronts or other-axis conclusions were imported. This is source verification; no tests, gates, application/runtime modules, process operations, cleanup scenarios, or git mutations were executed. The feature lead owns the reported full-gate execution evidence.

APPROVED
