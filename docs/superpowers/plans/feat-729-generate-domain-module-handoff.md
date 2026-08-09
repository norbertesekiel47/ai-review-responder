# feat-729 handoff

- Ticket: #729 (parent map #710 item 3 — do not re-litigate map decisions;
  D-H forbids a second auto-approval guard)
- Intake: `docs/superpowers/plans/feat-729-generate-domain-module-intake.json`
- Plan: `docs/superpowers/plans/feat-729-generate-domain-module.md` (module
  interface + route mapping table are LOCKED there)
- Deviations: `docs/superpowers/plans/feat-729-generate-domain-module-deviations.md`
  (D1: allowlist merge-order agreement with feat-719 — #729 lands first)
- Glossary: CONTEXT.md → **On-demand generation** (route + origin lane
  vocabulary; no glossary edit needed for this ticket)
- Characterization eval (must stay green, unchanged):
  `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts`
  `.../generate-version.integration.test.ts`
- State: `.feature/state.json` — phase **reviewed** (post step 7).
- Executed: T1 (eval suite, 9 RED → committed), T2 (module + route rewire,
  commit 1aa987ef), T3 (allowlist −3, baseline 412→409, commit 7557336b).
  Deviations D1–D3 + counted amendment A1 all ACCEPTed (see deviations file).
- Step 7: two-axis review round 1 → one shared finding (stale baseline
  narrative), fixed in b1887161; round 2 verification APPROVED. Reports +
  triage committed under `docs/reviews/feat-729-generate-domain-module/`.
- Gate GREEN twice (run 2 standard, run 3 `--review` with diff-coverage).
- Current step: 8 (ship, normal lane) — PR #733 open, watching CI, then
  merge + post-merge chores (ff main, ff staging, worktree cleanup,
  deviations promotion to lab-notes, document-feature, domain sweep,
  entropy counter).
