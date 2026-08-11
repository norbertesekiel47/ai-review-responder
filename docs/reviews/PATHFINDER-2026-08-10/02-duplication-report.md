# Pathfinder 2026-08-10 — duplication report

Part 1 = within-feature (Phase 2a agent, all code read, every claim ≥2 cited
locations). Part 2 = cross-feature (Phase 2b agent, appended below).
Consolidation verdicts are the agents'; final dispositions land in
`03-unified-proposal.md`.

## Part 1 — within-feature findings

### Ranked: the three that matter most

1. **F1 — dual `review_content_hash` derivation + dual `reviews` INSERT column
   lists (BEHAVIORAL).** `worker/jobs/zernio/zernio-ingest-shared.ts:425-427,430-453`
   hand-rolls `star|trimmed` over *unsanitized* trim; the canonical path is
   `computeContentHash` over sanitized `reviewText` (null-when-empty → hashes
   `"5|null"` vs `"5|"`) at `src/lib/reviews/process-review.ts:153-171` +
   `types.ts:33-36` + `zernio-normalize.ts:45-48`. An imported row's hash never
   matches the live lane's for identical content → a later `review.updated`
   spuriously takes the content-changed lane. Fix: build via
   `buildZernioMonitoredReview` + shared insert.
2. **F6 — structural auto-approval candidacy predicate spelled 3×**
   (`persist.ts:105-109` boolean; `auto-approval.ts:296-299` block-reason;
   `:334,344-346` re-check). Drift here changes what can auto-post
   (invariant #3); nothing forces the three lists to agree. Fix: one
   `STRUCTURAL_GATES: [predicate, reason][]` table feeding all three. The perf
   split (pre-tx boolean vs total evaluator) is legitimate and survives.
3. **F1 — `review_exceptions` dedup ON CONFLICT predicate spelled twice**
   (`ingest-failed-hook.ts:113-128` vs `zernio-ingest-shared.ts:130-148`) while
   one copy documents itself as the single owner. The predicate must match the
   partial index byte-for-byte (CLAUDE.md gotcha) — two copies is exactly the
   drift the comment claims to prevent.

### Full findings table (agent verdicts)

| F | Concern | Locations | Consolidate? |
|---|---|---|---|
| F1 | dual content-hash + INSERT lists | zernio-ingest-shared.ts:425-453 vs process-review.ts:153-171 | **Yes — behavioral** |
| F1 | `zernio://` identity template ×5 | zernio-ingest-shared.ts:214,423-424; zernio-normalize.ts:71-72; ZernioRecentReviewPoller.ts:196; zernio-publisher.ts:72 | Yes — dedup key, one helper |
| F1 | review_exceptions ON CONFLICT ×2 | ingest-failed-hook.ts:113-128 vs zernio-ingest-shared.ts:130-148 | Yes |
| F1 | PHI-gate block ~15 lines ×2 (+in-tx variant) | ZernioReviewIngestWorker.ts:220-235 vs ZernioBackfillWorker.ts:379-394 (shared :545-558) | Yes (mild) — compliance path |
| F1 | pagination-loop skeleton ×2 | ZernioReviewIngestWorker.ts:148-180 vs ZernioBackfillWorker.ts:279-335 | **No** — loop bodies genuinely diverge; only the 6-line catch tail is identical |
| F2 | junction proof + initial-run correlate hand-synced ×2 each | import-consent.ts:280-294 vs :653-679; :667-670 vs import-offer-view.ts:100-102 | Yes — same hand-sync class the A4 bug punished |
| F2 | businesses row-lock preamble ×2 (+variant) | import-offer/route.ts:97-102 vs import-consent.ts:364-370 (job-eligibility.ts:201-206) | Yes (mild) — `lockBusinessRow` owner |
| F2 | analytics key hand-built ×2 beside `makeAnalyticsEventKey` | import-consent.ts:308-315 vs :407-414 | No — 3-line tidy |
| F3 | draft-status twins: ~35-40% identical kernel, ~60% deliberate | reviews/[reviewId]/draft-status:29-126 vs past-replies/draft-status:44-172 | **Partial** — extract outbox→poll-state mapper (3rd copy already at import-offer-view.ts:153-167); import `OUTBOX_IN_FLIGHT_STATUSES` in past-replies (hand-spelled :99-103); decide the no-store-header divergence deliberately |
| F3 | OCC catch→409 ladder byte-identical ×3 | draft/route.ts:183-201; draft/[responseId]/route.ts:124-142; publish/route.ts:115-133 | Yes — `mapConcurrencyError` in `_shared` |
| F3 | PATCH/DELETE preamble duplicates `_shared` helper | draft/[responseId]/route.ts:64-99,:191-217 vs edit-reply-request.ts:119-159 | Yes — split helper's first half; 4 copies → 1 |
| F3 | regenerate-tx guards mirrored (in-flight guard, MAX(version)+1 ×3) | on-demand-generate.ts:51-160 vs draft/route.ts:111-252 (+process-review.ts:358-363) | Yes — `pendingGenerateExists`, `nextResponseVersion`; full tx merge NO (OCC/resume semantics differ) |
| F3 | tenant-proof query ×2, comment-identical | generate/route.ts:54-62 vs draft-status/route.ts:43-51 | Yes (mild) — `proveReviewOwnership` |
| F4 | `useEditReplyDraft` 515 lines = 5× fetch skeleton + verbatim publish tail; NOT server-logic duplication | useEditReplyDraft.ts:267-585 (tail :354-373 vs :395-412) | Yes — `postJson` + `runAction`, ~-150 lines, answers the fallow flag |
| F4 | poll constants + `readJsonSafe` ×2; loops documented-distinct | useEditReplyDraft.ts:39-40,92-98 vs useInlineGenerate.ts:44-45,75-81 | Constants/helper yes; **loop merge no** |
| F4 | reply max-length `2000` ×4 unshared (2 client, 2 server zod) | ManualEditor.tsx:5; InlineGeneratePanel.tsx:25; draft/route.ts:59; draft/[responseId]/route.ts:52 | Yes — `MAX_REPLY_LENGTH` |
| F6 | structural candidacy predicate ×3 | persist.ts:105-109; auto-approval.ts:296-299; :334,344-346 | **Yes — invariant #3** |
| F6 | generation dispatch + opts object ×2 (skipCache retry) | generate-draft.ts:120-139 vs :253-269 | Yes (mild) — ADR-0017 provenance comment-enforced today |
| F7 | `sql.begin(redeemUnsubscribeToken)` wrapper ×2 | worker/ingress/unsubscribe.ts:386-388 vs api/u/[token]/route.ts:43-45 | No — code already records the follow-up; execute when a third caller appears |

**Cleanest feature audited: F7.** F2 internally disciplined. F1 carries the
worst behavioral item; F6 the highest-stakes one.

### Bonus fact for Phase 3

The outbox-status → poll-state mapping has a **third copy** in F2
(`import-offer-view.ts:153-167`) — this is cross-feature, handed to Part 2.

## Part 2 — cross-feature findings (Phase 2b agent, all seeds verified against source)

### The centerpiece — Stack A vs Stack B, metric by metric

Both stacks import the same window vocabulary (`kpi/types.ts:61-99`) and all four
query files recompute `trendSpanWeeks` locally. Verdict: **accidental duplication,
GA-blocking** — Stack A (Spec-11 launch KPI layer, its own header admits it
"mirror[s] dashboard/service.ts query style") got the ADR 0019 anchor; Stack B is
what renders and never did.

| Metric | A | B | #757 action |
|---|---|---|---|
| Response rate | `kpi/service.ts:210-224,315-331`, null-when-empty | `dashboard/service.ts:451-485` (+prior window), `aggregate-queries.ts:163-169` (JOIN form), 0-when-empty | **Stays `detected_at`** (ADR 0019 D2 — workflow KPI; #675 nudge) |
| Avg star | `:225-232,:332-341` anchored | `service.ts:486-507` on `detected_at` | **Re-anchor** :489,:492,:495-496,:499-500,:506 |
| Sentiment trend | `:254-274,:365-387` anchored | `service.ts:526-546` — **near-verbatim clone differing only in anchor** (row types and `round` helpers are structural twins) | **Re-anchor** :536,:542,:543 |
| Volume | `:233-245,:342-354` calendar-month MoM | no MoM; weekly velocity `service.ts:199-216` + `aggregate-queries.ts:187-204`, rating breakdown `service.ts:327-335` + `aggregate-queries.ts:206-216` | **Re-anchor** `service.ts:208,:211,:213,:333`; `aggregate-queries.ts:198,:199,:214` |
| TTR / time-saved | `:246-253,:355-364` with validity filter | `service.ts:508-525` counts approvals on `approved_at` — no duration metric exists in B | Neither re-anchors (action timestamps) |
| Remainder | — | all-time totals (unwindowed), recent-review feeds (`detected_at` = ingestion recency, correct), pending counts | Leave alone |

**Fragment portability verified:** `reviewTimeAnchor` (`kpi/service.ts:145-149`)
and `reviewTimeWindowFilter` (:152-154) contain no FROM/JOIN and no tenant
predicate — exporting them does NOT trip the `ci:tenant-scope` constraint. One
friction: the prefix union is `'' | 'r.'` but Stack B aliases are `rv`/`rev` —
widen the type or rename aliases at plug sites.

### Other cross-feature findings

| # | Concern | Locations | Verdict |
|---|---|---|---|
| 2 | Outbox-status → poll-state mapping ×3 (F2+F3) | `import-offer-view.ts:153-167`; `reviews/[reviewId]/draft-status/route.ts:101-121`; `past-replies/draft-status/route.ts:99-167` | **Split**: the in-flight/terminal trichotomy is accidental — `classifyOutboxStatus()` beside `OUTBOX_IN_FLIGHT_STATUSES` (`job-outbox-status.ts:34`) owns it; the completed-branch semantics are legitimate per-surface |
| 3 | In-flight set hand-spelled in JS — exactly ONE site | `past-replies/draft-status/route.ts:100-102` (predates the constant, #56 vs #588; touched twice since without migrating) | Accidental — one-line fix. SQL re-spells are sanctioned (invariant #2), correctly excluded |
| 4 | `zernio://` name template ×7 spellings / 5 files | `zernio-normalize.ts:71-72`; `zernio-ingest-shared.ts:214,423-424`; `ZernioRecentReviewPoller.ts:195-196`; `zernio-publisher.ts:72` | Accidental duplication of a format contract — written and string-compared, never parsed; one byte of drift silently breaks reconcile/tombstone/short-circuit. Builder in `zernio-normalize.ts` (owns the format comment) |
| 5 | Tenant-ownership proof | Byte-identical twins `generate/route.ts:54-62` vs `draft-status/route.ts:43-51`; variants `agents/read.ts:311-328`, `edit-existing.ts:93-98`, `import-offer-view.ts:99-105`; past-replies family uses cookie-scope instead | **Split**: the twins consolidate as ONE whole-query helper (fragment extraction structurally forbidden — `ci:tenant-scope` strips subqueries); account-vs-cookie split is documented specialization |
| 6 | `COALESCE(MAX(version),0)+1` — **×5, not ×3** | `on-demand-generate.ts:144-150`; `past-replies/draft/route.ts:205-209`; `process-review.ts:358-363`; `zernio-ingest-shared.ts:496`; `restore-original/route.ts:204`. Scoping drifts: 2 of 5 bind business_id | Accidental duplication of a micro-invariant — `nextResponseVersion(tx, reviewId)`; scoping variance is already drift |
| 7 | `businesses` row-lock preamble ×6+ | import-offer route, import-consent, job-eligibility, finalize-tx, stripe/shared, persist/auto-approval | **Legitimate specialization** — the lock-first *pattern* is shared but tx-ownership belongs to each caller; predicate differences track caller identity. DO NOT unify |
| 8 | PgBouncer JSONB guard asymmetry | Guarded: `past-replies/draft-status:86-90` (+OutboxPoller, per allowlist) | **NON-FINDING** — other pollers never SELECT `payload`; the lab-notes allowlist is accurate. Recorded so nobody "fixes" it |
| 9 | Client poll pattern (F2 banner vs F3 row hooks) | `ImportOfferBanner.tsx:162-170` (react-query, 4s) vs `useInlineGenerate.ts` / `useEditReplyDraft.ts` (setTimeout machines, 1.5s/60s) | **Split**: banner vs rows legitimate (cadence, state ownership, fetch stack); within the two row hooks, `readJsonSafe` + poll constants are verbatim ×2 — extract |
| 10 | 45s Redis fail-open cache block ×4 functions | `kpi/service.ts:191-199,283-307,396-401`; `dashboard/service.ts:118-144`; `aggregate-service.ts:96-118` — kpi's comment admits mirroring #487 | Accidental — `withTtlCache(key, ttl, compute)`; note #757 re-anchor rides the same 45s self-expiry ADR 0019 relied on |

