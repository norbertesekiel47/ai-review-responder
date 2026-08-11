# Pathfinder 2026-08-10 — feature inventory (Phase 0, boundaries approved)

Scope: the entropy window (~24 merges since the 2026-07-27 pass), not the whole
repo. Boundaries proposed by the discovery agent from code + CONTEXT.md +
CLAUDE.md, approved by the orchestrator with two adjustments noted below.

| # | Feature (glossary term where one exists) | Entry points | Core files |
|---|---|---|---|
| F1 | **Review import** (CONTEXT.md:27) | `ZernioBackfillWorker.ts:78` `selectImportWindow`; `process-review.ts:519` `importReview` | `worker/jobs/zernio/*`, `zernio-ingest-shared.ts:51` (`liveIngestCutoff` owner) |
| F2 | **Import consent / Import offer** (CONTEXT.md:28-29) | `import-consent.ts:193` `importConsentStateSql`; `import-offer/route.ts:139`; `job-eligibility.ts:192` `guardImportConsent` | `src/lib/reviews/import-consent.ts` (725 LOC single owner), `import-offer-view.ts`, `ImportOfferBanner.tsx` |
| F3 | **On-demand generation** (CONTEXT.md:33) | `reviews/[reviewId]/generate/route.ts:145`; `past-replies/draft/route.ts:266`; two `draft-status` GETs | `on-demand-generate.ts`, `past-replies/_shared/*`, drawer/panel components |
| F4 | **Reviews list** (CONTEXT.md:32) | `reviews/history/page.tsx:25`; `load-replies.ts:87`; `replies-view.ts:114/:136` | `src/lib/past-replies/*`, `PastRepliesClient.tsx`, card components |
| F5 | Held-draft seam (invariant #4; no glossary term) | `held-draft.ts:57/:73/:38` | one 79-line file, **12 non-test consumers** |
| F6 | **Content-freshness gate** + persist boundary (CONTEXT.md:117-119) | `persist.ts:88` `persistResponseAndNotify`, `:79` `hasStaleReviewContent` | `worker/jobs/response-generation/*` |
| F7 | Solicitation suppression & unsubscribe (CONTEXT.md §97-111, eight locked terms) | `suppression.ts:75/:226`; `unsubscribe.ts:320/:396`; `worker/ingress/unsubscribe.ts:76` | `src/lib/solicitation/*`, `(public)/u/**` |

**Orchestrator adjustments:**
1. **F5 is a cross-cutting seam, not a feature** — its own header enumerates four
   consumer categories that must NOT consolidate onto it. It gets a seam chart
   (drawn by the orchestrator from the discovery evidence), and no unification
   proposal may assign it a single feature owner.
2. **F7 confirmed in scope but architecturally disjoint** — shares zero files,
   tables, or helpers with F1–F6 (verified). Its flowchart documents the window;
   cross-feature duplication analysis treats any F7↔F1-F6 similarity as
   *structural coincidence* unless a shared seam is shown.

**The two read stacks (the pass's centerpiece, fully mapped by discovery):**
- **Stack A** `src/lib/kpi/service.ts` (404 LOC) — Review-time anchored, correct
  per ADR 0019, **zero consumers** (verified three ways: `useDashboardData.ts:130`
  builds `/api/dashboard` only; repo-wide grep, zero `.tsx`/`e2e` hits;
  `service.ts` has exactly one non-test importer — its own route).
  `src/lib/kpi/types.ts` is NOT orphaned — 9 importers of the window vocabulary.
- **Stack B** `src/lib/dashboard/{service,aggregate-service,aggregate-queries}.ts`
  — everything owners see (`ReputationHeroBand` etc. via `DashboardContent.tsx:351`),
  still `detected_at`-anchored throughout (`service.ts:454-543`,
  `aggregate-queries.ts:164-214`); no `LEAST(` anywhere.

**Boundary violations carried to Phase 2 (discovery evidence):**
1. `process-review.ts:16` (F1/live-ingest) imports `editRepliesEnabled` from F4's flag module
2. `load-replies.ts:10-13` (F4) imports and serializes F3's regen-budget state
3. `api/dashboard/past-replies/**` URL tree carries the pre-#671 name CONTEXT.md lists under _Avoid_; `draft-status`/`draft/**` under it are pure F3
4. **Two near-identical `draft-status` routes** (`reviews/[reviewId]/` keyed by reviewId; `past-replies/` keyed by responseId)
5. `src/lib/reviews/` directory mixes F1, F2, F3, Guardian triage, and SerpAPI resolution — directory ≠ feature
6. Orphans: KPI service+route pair (Stack A); `mock-source.ts` (1 importer, dev affordance); `completion_reason='import_consent_blocked'` dead write (documented intent, ADR 0016)

Full discovery evidence (sources, line ranges, consumer inventories): retained in
the Phase 0 agent report; the load-bearing facts are reproduced above.
