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
- State: `.feature/state.json` — phase set to plan_approved at this commit.
  Next step: 4 (execute) — T1 (eval suite) alone first, enforcement spot
  check, then T2, T3 serial per the plan.
