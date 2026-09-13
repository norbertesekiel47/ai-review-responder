# Feature inventory — Pathfinder 2026-09-12

Window `40e79e6a8..6edacd0b0`. **177 first-parent merges, 83 counting, 526
production files touched** (103 added, 66 deleted, 357 modified).

**The method change this window forced.** Every prior pass enumerated its
merges and charted most of them. At 177 merges and 526 files that is not a
pass, it is a census. This pass **themes first, then charts nine features**,
and states explicitly what it did not chart and why. A reader looking for a
merge that is not below should assume it was themed and not charted, not that
it was missed — the full 83-row table is in `SCOPE.md`.

---

## Boundary decisions the orchestrator made

1. **Theme A is charted as TWO features, not one.** The Admin split (#1213–#1229,
   the transport seam) and the legacy retirement (#1240–#1266) share a
   calendar and a ticket range but nothing structural: one is a request-path
   rewrite, the other is fourteen deletions. F2 and F3.
2. **Theme C is charted as ONE feature despite 16 merges and 362 files.**
   The Harbor redesign, the 223-file UX remediation and the InfoTip trio all
   write the same component tree behind one payload. Three diagrams would be
   the same diagram three times. F5.
3. **Theme D is charted as a DELTA, not a survey.** The 2026-08-26 pass
   charted this surface as five features (F1/F2/F3/F6/F7, 431 nodes). F6 here
   re-measures that pass's six findings and charts only what changed.
4. **Theme G (#1135, the agent-context split) is NOT charted.** It is 26 `src/`
   + 4 `worker/` files, but the production diff is 4 code lines against ~30
   files of comment-header pointers. It has no runtime path. Its content feeds
   `05-process-findings.md` §2 instead.
5. **Theme Z is charted as one feature (F9)** — Review QR is the window's only
   new public unauthenticated route, and the four owner-intake singletons ride
   with it because none of them has another home.

---

## Charted features (9)

| # | Feature | Theme | Merges | Nodes | Entry point |
|---|---|---|---:|---:|---|
| **F1** | **Owner Operator v1 Run A — the turn lane** | F | 1 | **119** | `src/app/api/operator/turns/route.ts:101` → `src/lib/agents/operator/turns.ts:90` → `worker/jobs/agent-turn/AgentTurnWorker.ts:317` |
| F2 | Admin API transport seam (CORS, bearer, dual-mode AAL2) | A | 6 | 73 | `src/proxy.ts:120` → `src/lib/auth/admin-mfa-gate.ts:52` |
| F3 | Legacy-admin retirement + the Admin API contract | A | 18 | 31 | `scripts/ci/admin-contract-audit.ts:144` · `src/app/admin/layout.tsx:15` |
| F4 | The Refusal ledger | B | 13 | 67 | `src/lib/refusals/write.ts:832`, `:1013` → `src/lib/refusals/read.ts:292` |
| F5 | Console / Harbor dashboard + the 160-finding UX remediation | C | 16 | 80 | `src/app/(authenticated)/layout.tsx:56` → `src/app/api/dashboard/route.ts:481` → `src/lib/dashboard/service.ts:129` |
| F6 | Marketing / landing rebalance | D | 10 | 68 | `src/components/sections/landing/LandingExperience.tsx:109` · `src/components/ui/SiteShell.tsx:34` |
| F7 | Owner offboarding, the purge lane, billing | E | 5 | 87 | `worker/jobs/account-offboarding/PurgeWorker.ts:34` → `purge-stages.ts` ×9 → `src/lib/account-offboarding/purge-verification.ts:40` |
| F8 | Outbox dispatch tick, the perf wave, worker health | H | 8 | 56 | `worker/background/pollers/OutboxPoller.ts:425` · `src/lib/responses/judge-health.ts:73` |
| F9 | Review QR and the analytics boundary | Z | 6 | 54 | `src/app/q/[businessId]/route.ts:60` · `src/lib/analytics/events.ts:86` |
| | **Total** | | **83** | **635** | |

> **Node counting, stated so the next pass does not "correct" it.** 635 is the
> sum of each chart's own count of **flow nodes** (numbered decision points,
> calls and terminals). It excludes mermaid subgraph titles and edge labels. A
> crude bracket-token grep across the nine files returns a higher number for
> the same reason the 2026-08-26 pass recorded (it counted 664 flow nodes and
> 760 bracket tokens). **Quote 635.**

## Not charted, with reasons

| | Why not |
|---|---|
| **#1135, the agent-context split** | 30 production files, **4 changed code lines**. Comment-header pointers into the new `.claude/rules/` layer. No runtime path to chart. → `05-process-findings.md` §2 |
| **The 17 governance-only merges** | Zero production files by the counting rule. They change what CI can see, so they are enumerated in `SCOPE.md` and their effect on the audit surface is in `00-health-baseline.md` §8 — but a flowchart of a skill file is not a flowchart |
| **The 77 docs/test-only merges** | Nothing to chart |
| **`e88935442` #1218 (Brand Asset Library, 17 `src/` files)** | The `src/` half is comment/pointer edits into `docs/brand-asset-library/`. Counted as a merge; folded into F6's theme |
| **The three comment-only counting merges** (#1147, #1136, #1070) | Zero code lines. #1070 is discussed in F7 because its 40 comment lines move a load-bearing correctness claim into the tree |

---

## Measured facts the duplication phase needs

### The window's shape is unlike every prior window

| Root | Files at HEAD | Lines at HEAD | Window Δ (prod files touched / net lines) |
|---|---:|---:|---|
| `worker/` | 195 | 40,114 | 30 / **+2,215** |
| `src/lib/` | 423 | 79,182 | 90 / **+9,727** |
| `src/app/` | 330 | 48,498 | 222 / **−3,750** |
| `src/components/` | 245 | 33,345 | 170 / **+2,709** |
| **Total** | **1,193** | **201,139** | **526 / +10,901** |

**`src/app/` net-shrank by 3,750 lines — the first time any production root
has shrunk across a Pathfinder window.** Sixty-six production files were
deleted, almost all of them the ten legacy admin pages (F3) and #1233's
landing-exploration removal (F6).

### Three subsystems are new or transformed since the 08-26 baseline

| | 08-26 | HEAD | Note |
|---|---|---|---|
| `src/lib/agents/` | 2 files / 1,189 lines | **13 files / 3,882** | Owner Operator added 11 files. Still no run-spine coupling (F1 §5) |
| `src/lib/refusals/` | did not exist | **3 files / 2,466** | `write.ts` alone is 1,162 |
| `src/lib/dashboard/` | not separately tracked | **15 files / 2,950** | The payload Run B was told to reuse (F5 §2) |
| `src/lib/solicitation/` | 30 files / 16,035 | **32 files / 16,787** | **+752 lines (+4.7%) — the slowest growth in four passes.** Still 2.9× the next-largest subsystem |

### Straddles to watch

- **`src/lib/notifications/delivery.ts`** (440 lines) is written by all six
  notice members and is the subject of H2. Five claim functions, no shared
  helper.
- **`src/app/(authenticated)/_styles/console.css`** is **3,261 lines**, the
  largest production file in the repo, up **+44%** from 2,262 at the 08-26
  baseline. Written by F5's three waves and F6's copy sweep.
- **`worker/jobs/account-offboarding/purge-stages.ts`** (1,261, up from 1,012)
  and **`src/lib/account-offboarding/purge-verification.ts`** (801, up from
  763) are a matched writer/verifier pair held together by 20 hand-typed
  literals (F7 §3).
- **`src/lib/auth/route-helpers.ts`** is the gate owner for both the Owner
  Operator routes (F1) and every owner API route, and Run B adds two more
  callers.
