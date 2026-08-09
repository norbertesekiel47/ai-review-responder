# feat-730-open-flag-consolidation — deviations log

Entries the plan did not anticipate, one per item. Step 6 triages each with
ACCEPT / RE-PLAN before review.

## Setup-time notes

- **[2026-08-09] Surface overlap with `feat-719-drip-dropped-column` on
  `scripts/ci/tenant-scope-allowlist.ts` — no entry collision, merge order
  agreed.** feat-719's diff touches only the `ONBOARDING_DRIP_CANDIDATES_SQL`
  constant (~line 130); #730 regenerates entries in the load-replies /
  dashboard / draft-status / agents-read regions (lines ~550–1300+, ~3040).
  Disjoint hunks. Agreed order: PR #740 merges first (CI-green, auto-merge
  armed since 11:17a); #730 rebases onto main before opening its PR if #740
  has landed by then. feat-719's deviations file was deliberately NOT
  updated: its PR is at the finish line and its worktree must stay clean for
  `feature-cleanup.sh` to sweep it — this file is the single record of the
  agreement.
