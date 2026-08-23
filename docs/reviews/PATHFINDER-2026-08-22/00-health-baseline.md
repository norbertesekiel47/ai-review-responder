# Pathfinder 2026-08-22 — health baseline

Captured by the orchestrator before any subagent work, via `npx fallow health`
on `main` at `74aee92a`.

## Headline metrics

| Metric | 2026-07-27 | 2026-08-10 | 2026-08-15 | 2026-08-18 | **2026-08-22** |
|---|---|---|---|---|---|
| Health score | 77 B | 77 B | 77 B | 77 B | **77 B** |
| Maintainability | 92.2 | 92.2 | 92.2 | 92.2 | **92.1** |
| Duplication | 1.7% | 1.3% | 1.1% | 1.1% | **1.1%** |
| Churn hotspots | 0 | 0 | 0 | 0 | **0** |
| Dead files | 0.3% | — | — | 0.3% | **0.3%** |
| Dead exports | — | — | — | — | **0.0%** |
| High-complexity functions | 153 | — | — | 122 | **119** |
| Large functions (>60 LOC) | — | — | — | 449 | **463** |
| LOC | — | — | — | 168,281 | **175,458** |

Deductions: hotspots -10.0 · unit size -10.0 · coupling -2.4 ·
maintainability -0.3 · dead files -0.1.
Avg cyclomatic 3.0 · p90 cyclomatic 7 · 5,950 functions analyzed.

**Reading: the code held its shape for a FIFTH consecutive pass**, across a
window that added a complete send lane (dispatch, poller, breaker, two
migrations) and rewrote three marketing pages. Duplication did not regress.
High-complexity count fell 122 → 119.

**The two numbers that moved, and what they mean.**
- **LOC +7,177** (168,281 → 175,458, +4.3%) while duplication held at 1.1% and
  high-complexity functions FELL. The window added volume without adding
  tangle. That is the healthy shape.
- **Large functions +14** (449 → 463) against maintainability −0.1. Marginal,
  but it is the only metric moving the wrong way, and it is the metric that
  carries the −10.0 unit-size deduction. Worth one look at whether the new
  functions are in the window's files.

## CRAP caveat — do not quote CRAP repo-wide

Istanbul coverage matched only **6,075 of 31,838 functions**; unmatched
functions are estimated from export references. Every `0% tested` annotation
in the report is an artifact of that gap, not a measurement. This is the
#581/#783 class the lab notes already record. The guard-integrity axis measures
tripwires by mutation instead, which is why that axis exists.

## Window files in the complexity / churn report

| File | Signal |
|---|---|
| `src/lib/solicitation/release.ts` | 3 commits, **1,903 churn**, 5 fan-in, **▲ accelerating** |
| `src/lib/solicitation/ask-generation.ts` | 4 commits, 1,783 churn, 6 fan-in, ─ stable |
| `src/lib/solicitation/approval.ts` | 7 commits, **1,772 churn**, **15 fan-in**, ▼ cooling |
| `src/lib/solicitation/batch-builder.ts` | 7 commits, 1,387 churn, **15 fan-in**, **▲ accelerating** |
| `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` | 4 commits, 1,358 churn, 2 fan-in, ▼ cooling |
| `src/lib/solicitation/batch-view.ts` | 9 commits, 1,308 churn, **17 fan-in**, ─ stable |
| `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` | 3 commits, 743 churn, **▲ accelerating** |
| `src/lib/solicitation/outreach.ts` | 4 commits, 714 churn, **18 fan-in**, ─ stable |
| `src/components/ui/SiteNav.tsx` | 14 commits, 805 churn, 10 fan-in, ▼ cooling |
| `src/components/sections/features/FeaturesContent.tsx` | 19 commits, **4,580 churn**, 2 fan-in, ▼ cooling |
| `src/components/sections/how-it-works/HowItWorksContent.tsx` | 21 commits, 2,731 churn, 3 fan-in, ▼ cooling |

Six rebrand components are **▲ accelerating** despite being new this window:
`WatchArtifact` (129 churn), `FeatWatchdogs` (191), `FeatVoice` (224),
`FeatGuardian` (174), `DraftArtifact` (168), `GateArtifact` (259),
`FeatGate` (301), `FeatInsights` (316), `RoadmapBand`.

## CORRECTED 2026-08-22 — the "absence" was a reading error, not a tool blind spot

**This section originally claimed `src/lib/solicitation/dispatch.ts` appears in
NONE of fallow's lists. That claim was FALSE and is retracted.** It was written
from the terminal renderer, which prints `● Large functions (10 shown, 463
total)` — ten of 463. `--top 463` does not expand that section. F2's agent caught
it; the orchestrator re-ran `npx fallow health --format json` and confirmed.

**`dispatch.ts` contributes SIX of the repo's 461 large functions:**

| line | function | line_count |
|---|---|---|
| 1553 | `runDispatchTx` | **202** |
| 1859 | `dispatchOutreach` | **143** |
| 1439 | `lockAndTriageOutreach` | 93 |
| 1103 | `commitSendTerminal` | 90 |
| 1780 | `reportNonSendOutcome` | 78 |
| 1328 | `commitWithhold` | 64 |

**`runDispatchTx` at 202 lines ranks 25th of 461 repo-wide.** `release.ts`
likewise contributes five (`runReleasePhase` 135, `selectReleaseCandidates` 79,
`terminalizeWedgedOutreach` 76, `releaseOutreachRow` 64, `runReleaseCycle` 62).

**What IS true, and it is the better finding.** For `dispatch.ts`:
`findings` = 0, `hotspots` = 0, `targets` = 0. Not suppressed — no solicitation
path appears in `.fallowrc.jsonc`'s `health.ignore`. The mechanism, measured
across all 121 findings, is that the `exceeded` field takes only these values:

```
crap: 66 · cognitive: 32 · cognitive_crap: 11 · all: 8 · both: 3 · cyclomatic: 1
```

**`line_count` never appears.** Fallow's complexity gate has **no unit-size axis
at all**. A function can be 202 lines and produce zero findings provided its
cyclomatic, cognitive and CRAP are each under threshold — and `runDispatchTx`
clears all three, because cognitive complexity penalises *nesting* and it is a
flat run of guard clauses.

**So `functions_over_60_loc_per_k` and `unit_size_profile` are reported as vital
signs — narrative metrics with no gate behind them — while `ci:fallow:coverage`
gates on CRAP. A 202-line flat orchestrator with high coverage is invisible to
the PR gate by construction, in any file, forever.** That is a property of the
gate configuration, not of `dispatch.ts`, and it is the thing worth ranking.

**Secondary:** `dispatch.ts` is 854 comment lines against 1,014 code lines —
**45.7% prose**. Any line-count judgement of it, by tool or by human, overstates
the code by roughly 2×. The same is true of `release.ts` (48.1%).

## Largest functions in the window

- `generateAsksForBatch` (`src/lib/solicitation/ask-generation.ts:913`) —
  **294 lines**, cognitive 43, third-largest function in the repo. Fallow's
  #7 refactoring target (`pri:18.2`, effort:high, confidence:high).
- `HowItWorksContent` (`src/components/sections/how-it-works/HowItWorksContent.tsx:172`)
  — **270 lines**, sixth-largest in the repo.
- `handleSolicitationResendEvent` (`worker/ingress/resend/solicitation-lane.ts:152`)
  — cyclomatic 8, 28 lines, flagged HIGH on CRAP only (0% matched coverage —
  see the caveat above; this is almost certainly an artifact).

## Fallow refactoring targets that touch this window

| ROI | pri | Target |
|---|---|---|
| 11.1 | 22.2 | `src/components/sections/features/useReveal.ts` — "split high-impact file (33 LOC), 12 dependents" |
| 6.1 | 18.2 | `src/lib/solicitation/ask-generation.ts` — extract `generateAsksForBatch` (cognitive 43) |

`useReveal.ts` at 33 LOC is **not** a split candidate on its face. Seed 18 in
`SCOPE.md` asks what that signal actually means before anything is proposed.

## Source

Full report retained at
`<scratchpad>/fallow-health.txt` (2,196 lines — not committed;
regenerate with `npx fallow health`).

**Do not use this as the PR gate.** The gate is `ci:fallow:coverage` fed by the
`test` job's `pnpm test:coverage`, and a bare `fallow health` does not predict
it in either direction (#783; lab-notes "fallow coverage input is DB-complete").
