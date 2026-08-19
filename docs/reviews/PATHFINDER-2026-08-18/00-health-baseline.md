# Pathfinder 2026-08-18 — health baseline

Captured by the orchestrator before any subagent work, via `npx fallow health`
on `main` at `c29258a4`.

## Headline metrics

| Metric | 2026-07-27 | 2026-08-10 | 2026-08-15 | **2026-08-18** |
|---|---|---|---|---|
| Health score | 77 B | 77 B | 77 B | **77 B** |
| Maintainability | 92.2 | 92.2 | 92.2 | **92.2** |
| Duplication | 1.7% | 1.3% | 1.1% | **1.1%** |
| Churn hotspots | 0 | 0 | 0 | **0** |
| Dead files | 0.3% | — | — | **0.3%** |
| High-complexity functions | 153 | — | — | **122** |
| LOC | — | — | — | **168,281** |

**Reading: the code held its shape for a fourth consecutive pass**, across a
window that added an entire send lane, five approval verbs, two migrations and
a three-tier design system. Duplication did not regress. High-complexity
function count fell from 153 (2026-07-27) to 122.

Deductions: hotspots -10.0 · unit size -10.0 · coupling -2.3 ·
maintainability -0.3 · dead files -0.1. Large functions: 449 total.

## CRAP caveat — do not quote CRAP repo-wide

Istanbul coverage matched only **6,378 of 31,082 functions**; unmatched
functions are estimated from export references. Every `0% tested` annotation
below is an artifact of that gap, not a measurement. This is the #581/#783
class the lab notes already record. The guard-integrity axis measures
tripwires by mutation instead, which is why that axis exists.

## Window files in the complexity/churn report

| File | Signal |
|---|---|
| `src/lib/solicitation/approval.ts` | 5 commits, **1,516 churn**, 12 fan-in, ─ stable |
| `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` | 3 commits, **1,351 churn**, 2 fan-in, **▲ accelerating** |
| `src/lib/solicitation/batch-builder.ts` | 7 commits, **1,387 churn**, 12 fan-in, **▲ accelerating** |
| `src/lib/solicitation/batch-view.ts` | 8 commits, 1,267 churn, **17 fan-in**, ─ stable |
| `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` | 3 commits, 743 churn, **▲ accelerating** |
| `src/lib/solicitation/ingest.ts` | 6 commits, 790 churn, 13 fan-in, ▼ cooling |
| `worker/ingress/resend.ts` | 17 commits, 874 churn, 7 fan-in, ▼ cooling |

`closeBatchIfSettled` (`src/lib/solicitation/outreach.ts:317`) is **133 lines**
at cyclomatic 9 / cognitive 11 — the single largest unit in the window's hot
path, and the one every approval verb calls.

`generateAsksForBatch` (`src/lib/solicitation/ask-generation.ts:921`) is
**294 lines**, third-largest function in the repo.

## Source

Full report retained at
`/private/tmp/claude-501/-Users-norbertesekiel-Developer-startups-RepWorth/b0eb68b8-a1e5-4b36-a476-dce778a761a5/scratchpad/fallow-health.txt`
(2,193 lines — not committed; regenerate with `npx fallow health`).
