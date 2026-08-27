# Health baseline — Pathfinder 2026-08-26

Measured at `1d9b251c`, clean tree. Window for deltas: `72dc58ac..1d9b251c`.

Counting rule: git-tracked `.ts .tsx .js .jsx .css .sql`, excluding any path
containing `__tests__`, `.test.`, or `.spec.`. `wc -l` counts physical lines,
so blanks and comments are included — see the caveat in §9.

---

## 1. Size by root — a NEW baseline

The 08-24 baseline recorded gates, lockstep and the counter, and **no size
metrics at all**. The 08-22 and 08-18 baselines record `fallow` health
percentages, not file or line counts. These four numbers are therefore a first
baseline. The window deltas beside them are independently measured.

| Root | Prod files | Prod lines | Window delta |
|---|---:|---:|---|
| `worker/` | 192 | 37,899 | 7 files, net **+477** |
| `src/lib/` | 389 | 69,455 | 18 files, net **+788** |
| `src/app/` | 357 | 52,248 | 14 files, net **+1,125** |
| `src/components/` | 227 | 30,636 | 48 files, net **+2,470** |
| **Total** | **1,165** | **190,238** | **87 files, net +4,860** |
| `supabase/migrations/` | 114 | — | 1 file, +119 |

**`src/components/` took 51% of the window's net production growth** — the
largest movement of any root, and the first pass where that is true.

## 2. Top production files by line count

| # | Lines | Path | Grew in window |
|---:|---:|---|---|
| 1 | 2,262 | `src/app/(authenticated)/_styles/console.css` | — |
| 2 | 2,039 | `src/lib/solicitation/dispatch.ts` | **+38 / −3** |
| 3 | 1,989 | `src/lib/solicitation/release.ts` | — |
| 4 | 1,793 | `src/app/(public)/_styles/island.css` | **+200 / −4** |
| 5 | 1,739 | `src/lib/solicitation/ask-generation.ts` | — |
| 6 | 1,334 | `src/lib/solicitation/approval.ts` | — |
| 7 | 1,180 | `src/lib/auto-approval/settings.ts` | — |
| 8 | 1,106 | `src/app/(authenticated)/_styles/settings.css` | — |
| 9 | 1,092 | `src/components/approval/approval-client.tsx` | — |
| 10 | 1,059 | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` | — |
| 11 | 1,057 | `worker/jobs/publisher/auto-policy-publish.ts` | — |
| 12 | 1,030 | `src/lib/solicitation/batch-view.ts` | — |
| 13 | 1,011 | `worker/jobs/account-offboarding/purge-stages.ts` | **+63 / −14** |
| 14 | 977 | `worker/index.ts` | **+13 / −0** |
| 15 | 976 | `src/lib/shared/job-outbox-helpers.ts` | **+86 / −0** |

**5 of 15 grew; none shrank; none is new.** Four of the top six are
`src/lib/solicitation/`.

## 3. Subsystem sizes — `src/lib/`

| Dir | Files | Lines |
|---|---:|---:|
| **`solicitation`** | **30** | **16,035** |
| `notifications` | 48 | 5,752 |
| `account-offboarding` | 21 | 4,820 |
| `shared` | 47 | 4,817 |
| `admin` | 24 | 4,344 |
| `reviews` | 19 | 3,356 |
| `auto-approval` | 10 | 2,807 |
| `payments` | 11 | 2,482 |

`src/lib/solicitation` is **2.8× the next-largest subsystem** and holds **23% of
all `src/lib/` production lines**.

> Worth naming beside it: **`src/lib/agents/` is 2 files / 1,189 lines**
> (`run-spine.ts`, `read.ts`). The run spine is an architectural invariant
> surface — every persona action is recorded through it — and it is 7% the size
> of the solicitation subsystem.

## 4. `src/lib/solicitation/` — the tracked series

| Point | Files | Lines |
|---|---:|---:|
| 08-22 SCOPE, as published | 24 | 14,426 |
| **HEAD `1d9b251c`** | **30** | **16,035** |
| Delta | **+6** | **+1,609 (+11.2%)** |

Window-only: 5 files touched, net +526; one new file (`attribution.ts`).
Carries ±2 file / ±28 line uncertainty — the 08-24 pass corrected the 08-22
figure but published no corrected absolute.

Test-to-production file ratio inside this directory: **1.73 : 1** (52 test
files against 30 production).

## 5. Subsystem sizes — `worker/jobs/`

| Dir | Files | Lines |
|---|---:|---:|
| `publisher` | 18 | 5,045 |
| `account-offboarding` | 11 | 2,820 |
| `response-generation` | 6 | 1,894 |
| `zernio` | 5 | 1,779 |
| `notification` | 7 | 959 |
| `billing` | 5 | 720 |
| `solicitation-batch` | 5 | 632 |
| `pending-post-notice` | 4 | 604 |

`worker/jobs/` totals 21,440 lines; **3,836 sit in top-level `*.ts` files**
outside any subfolder.

**`worker/jobs/solicitation-attribution/` is new in this window** (1 file, 194
lines), making **four** solicitation worker subdirectories: `-batch`, `-send`,
`-veto-notice`, `-attribution`.

### The notice family — SEED 3 ANSWERED

Six members, every one of them four files:

`notification/` (7 files, progenitor) · `auto-post-notice/` 4/454 ·
`escalation-notice/` 4/532 · `pending-post-notice/` 4/604 ·
`autonomy-suspended-notice/` 4/412 · `solicitation-veto-notice/` 4/521

**No seventh member landed.** Seed 3's escalation trigger did not fire. The
recommendation stays "extract", not "extract now".

## 6. Marketing surface — a NEW baseline

> The scope brief named `src/components/landing/`. **That path does not exist.**
> The real surface is `src/components/sections/landing/`. A grep keyed to the
> wrong path returns nothing silently. Corrected in SCOPE.md.

| Surface | Files | Lines |
|---|---:|---:|
| `src/components/sections/` (all) | 62 | 11,084 |
| — `sections/landing/` | 38 | 8,240 |
| — `sections/features/` | 13 | 1,277 |
| — `sections/how-it-works/` | 9 | 1,052 |
| — `sections/lead-intake/` | 2 | 515 |
| `src/app/(public)/_styles/` | 4 | 3,590 |
| `src/app/(public)/` (all) | 38 | 6,057 |
| **Marketing total** | **100** | **17,141** |

Window delta: 49 files, net **+2,998**.

**CSS is 7,952 of 17,141 lines — 46% of the surface.** Stated, not adjusted
away: CSS import order is itself a live architecture question in this pass.

`sections/landing/` is **one flat tier** — nine section folders plus nine shared
top-level files, no deeper nesting:

| Section | Files | Lines |  | Section | Files | Lines |
|---|---:|---:|---|---|---:|---:|
| `fleet/` | 5 | 1,560 |  | `footer/` | 3 | 606 |
| `hero/` | 3 | 750 |  | `watchdogs/` | 3 | 593 |
| `future/` | 3 | 735 |  | `problem/` | 3 | 361 |
| `tiers/` | 3 | 648 |  | `personas/` | 3 | 351 |
| `cta/` | 3 | 607 |  | | | |

Seven of nine follow an identical 3-file shape (`XSection.tsx` + `x-copy.ts` +
`x.css`). `problem/` and `tiers/` are **both new in this window**.

**The shared top-level tier — 9 files, 2,029 lines — is where the architecture
question lives:**

`landing-experience.css` 528 · `LandingExperience.tsx` 297 ·
`agent-flip-card.css` 280 · `carousel.tsx` 210 · `carousel.css` 192 ·
`agent-flip-card.tsx` 185 · `ambient-motion.tsx` 180 · `staged.tsx` 87 ·
`reveal.tsx` 70

Both files the arch log names as carrying **unguarded CSS import-order
dependencies** — `agent-flip-card.css` and `carousel.css` — are in this tier,
and `carousel.css` is new in this window.

## 7. Migrations

| Metric | Value |
|---|---|
| Head | **114** (`114_solicitation_attribution.sql`) |
| Files / range | 114 / `001`…`114` |
| Gaps | **none** |
| Duplicates | **none** |
| Added in window | 1 |

### Lockstep — VERIFIED against both live databases

Measured by direct introspection, not by reading commit messages.

| Object | Prod `udeyaqnvpojbwgoaxwdg` | Staging `kubdiqdhqbhwmqfditeg` |
|---|---|---|
| 114 columns on `solicitation_outreach` | **4 of 4** | **4 of 4** |
| 114 indexes | **3 of 3** | **3 of 3** |
| 113 indexes | **2 of 2** | **2 of 2** |

`6aba0c12` (#956) claims 114 is promoted to both. **The claim is true.**

078 standing exception, checked at the same time:

| Marker | Prod | Staging |
|---|---|---|
| `businesses.subscription_tier` nullable | **yes** | no |
| the two tier CHECK constraints | **0 of 2** | 2 of 2 |

Exactly the signature CLAUDE.md documents. **The exception is accurate and
unchanged.** No drift.

## 8. Gates

| Check | Result |
|---|---|
| `pnpm typecheck` | **PASS** |
| `pnpm lint` | **PASS** |
| All `ci:*` audits | **21 / 21 PASS** |

The audit count grew **20 → 21** in this window — `ci:env-registry` landed as
`ceaea650` / #961.

Audits run: `directory-map`, `outbox-status`, `static-policy`, `env-registry`,
`merge-ledger`, `db-imports`, `live-db-suites`, `pool-fanout`, `tenant-scope`,
`rls-audit`, `analytics-events`, `response-status`, `admin-aal2`,
`config-coverage`, `process-env`, `reviews-status`, `outbox-topics`,
`feature-surface`, `agent-config`, `outbox-seam`, `dropped-columns`.

## 9. Test surface

| Metric | Count |
|---|---:|
| `*.test.ts(x)` | **1,024** |
| — `*.integration.test.ts(x)` | **108** |
| — unit / component | 916 |
| Playwright `*.spec.ts` | 15 |
| Total test lines | **266,265** |

Test LOC exceeds production LOC (190,238) by **1.40 : 1**.

## 10. New production files in the window (16)

```
src/app/(authenticated)/dashboard/requests/AttributedReviews.tsx
src/app/api/dashboard/solicitation/attributed/route.ts
src/components/sections/how-it-works/HeroFlowArtifact.tsx
src/components/sections/landing/carousel.css
src/components/sections/landing/carousel.tsx
src/components/sections/landing/problem/{ProblemSection.tsx,problem-copy.ts,problem.css}
src/components/sections/landing/staged.tsx
src/components/sections/landing/tiers/{TiersSection.tsx,tiers-copy.ts,tiers.css}
src/lib/account-offboarding/purge-sentinels.ts
src/lib/solicitation/attribution.ts
supabase/migrations/114_solicitation_attribution.sql
worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts
```

**10 of 16 are marketing surface.** `ci:directory-map` passes, so every new file
under `worker/` and `src/lib/` shipped with its `docs/directory.md` row.

---

## 11. Known gaps

Stated so no reader mistakes silence for a clean result.

1. **`pnpm test` was not run.** The full suite needs the serialized live-DB
   project (108 suites) with `TEST_DATABASE_POOL_URL` + `DATABASE_POOL_URL`
   against a schema at head. **Test health at HEAD is unmeasured.** The 08-24
   baseline also skipped it.
2. **`ci:fallow:coverage` was not run** — it is fed by the `test` job's coverage
   artifact, which was not produced. CLAUDE.md is explicit that a bare `fallow
   audit` does not predict this gate in either direction.
3. **`wc -l` counts physical lines.** The arch log flags one lane file as
   "already 55% comment", so these counts systematically overstate executable
   size, most acutely in `src/lib/` and `worker/`. No executable-line
   measurement was taken.
4. **No prior root-level size baseline exists**, so §1 has no delta column
   against a previous pass — only against the window.
5. **CSS is counted as production** in `src/app/` and `src/components/`. This
   inflates the marketing surface by 46% relative to a TS-only count.
