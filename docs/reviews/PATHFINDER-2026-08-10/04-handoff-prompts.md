# Pathfinder 2026-08-10 — handoff prompts (Phase 4)

Each block below is a ready-to-file ticket body; this repo's vehicle is
`gh issue create` + `/feature <ticket-ref>` (ticket-seeded — grill only deltas).
Ordering: H1 is GA-blocking and already exists as #757 (the block below is the
scope comment to post there). H2 is a bug. H3–H5 are independent.

---

## H1 — #757 scope (post as comment; the ticket becomes mechanical)

```
Architecture pass 2026-08-10 verdict (03-unified-proposal.md P1): ONE stack.

1. Extract fragment owners from src/lib/kpi/service.ts into src/lib/kpi/fragments.ts:
   reviewTimeAnchor, reviewTimeWindowFilter, detectedAtWindowFilter, TTR validity
   filter. Verified portable (no FROM/JOIN, no tenant predicate — ci:tenant-scope
   safe). Widen the prefix union '' | 'r.' for Stack B's rv/rev aliases.
   Anchor-pinning tests move with the fragments.
2. Re-anchor Stack B at exactly these lines (from the Phase 2b metric map):
   dashboard/service.ts:489,492,495-496,499-500,506 (avg star); 536,542,543
   (sentiment trend); 208,211,213 (velocity); 333 (rating breakdown);
   aggregate-queries.ts:198,199 (velocity); 214 (rating breakdown).
   DO NOT touch: response rate (service.ts:451-485, aggregate-queries.ts:163-169
   — ADR 0019 D2, stays detected_at), timeSaved (508-525, keys on approved_at),
   all-time totals, recent-review feeds, pending counts.
3. DELETE getLocationKpiSummary + getAccountKpiSummary + GET /api/dashboard/kpis
   + their tests. Zero consumers verified three ways. KEEP src/lib/kpi/types.ts
   (9 importers). Route fate: deleted — future KPI cards extend Stack B's payload
   composing the same fragments.
4. ADR 0019 addendum records the consolidation.
Anti-pattern guards: no flag keeping both stacks; no registry; no re-anchoring
of workflow metrics. Flowcharts: 01-flowcharts/ + 02-duplication-report.md Part 2.
```

## H2 — BUG: imported reviews hash differently than live rows (C1)

```
Title: Imported-row content hash diverges from the live lane's for identical content

worker/jobs/zernio/zernio-ingest-shared.ts:425-453 (insertImportedReview) hand-rolls
review_content_hash as star|trimmed over UNSANITIZED text; the canonical path is
computeContentHash over sanitized reviewText, null-when-empty ("5|null" vs "5|").
Consequence: a review imported with an external reply carries a hash the live lane
will never reproduce, so a later review.updated webhook for it spuriously takes the
content-changed lane (supersede + regenerate) with no actual content change.

Fix: build the imported row via buildZernioMonitoredReview + the shared insert seam
so computeContentHash is the only derivation. Add a test asserting an imported row
and a live-ingested row of identical content produce byte-identical hashes.
Blast radius check: existing imported rows on staging carry divergent hashes —
decide whether to backfill-rehash or accept one spurious supersede per touched row.
Evidence: 02-duplication-report.md Part 1 finding 1; f1-review-import.md.
```

## H3 — Invariant-#3 hardening: one owner for the structural auto-approval gates (C2)

```
Title: STRUCTURAL_GATES table — three hand-synced spellings of what can auto-post

persist.ts:105-109 (pre-tx boolean), auto-approval.ts:296-299 (block-reason form),
auto-approval.ts:334,344-346 (evaluator re-check) each spell the candidacy list
(flag && origin_lane===live_ingest_new && version===1 && !suppressNotification).
Nothing forces agreement; drift changes what can auto-post (invariant #3).
Fix: one STRUCTURAL_GATES [predicate, reason][] table feeding all three call
shapes. The perf split (cheap pre-tx boolean vs total evaluator) is deliberate
and must survive. Property test: the three call shapes agree on every input
(fast-check over the candidate-fields domain).
Evidence: 02 Part 1 finding 2; f6-content-freshness-persist.md.
```

## H4 — Format/vocabulary single-owner sweep (C3+C4+C5, one small ticket)

```
Title: Three one-owner fixes: zernio:// builder, review_exceptions predicate, in-flight JS spell

1. zernioProviderReviewName(acct, loc, id) in zernio-normalize.ts (owns the format
   comment); migrate 7 spellings across 5 files (list: 02 Part 2 finding 4).
   The format is written and string-compared, never parsed — drift is silent.
2. Make insertReviewExceptionIfAbsent actually sole: ingest-failed-hook.ts:113-128
   re-spells the byte-for-byte ON CONFLICT partial-index predicate its twin claims
   to own alone.
3. past-replies/draft-status/route.ts:100-102: import OUTBOX_IN_FLIGHT_STATUSES
   (the one JS hand-spell left; SQL re-spells are sanctioned, leave them).
```

## H5 — Mechanical debt bundle (#731-style, behaviour-preserving)

```
Title: Post-pass mechanical bundle: OCC ladder, preamble split, version allocator, poll plumbing

Scope (03-unified-proposal.md P3, evidence 02 Parts 1+2): mapConcurrencyError ×3;
resolveEditReplyContext first-half split (×4→1); pendingGenerateExists +
nextResponseVersion(tx, reviewId) (×5 — also fixes the business_id scoping drift);
proveReviewOwnership whole-query helper (fragment form is audit-forbidden);
classifyOutboxStatus trichotomy (×3, completed-branches stay per-surface);
MAX_REPLY_LENGTH (×4); shared readJsonSafe + poll constants (×2);
postJson/runAction inside useEditReplyDraft (~−150 lines, clears the fallow
515-line flag); screenPhiOrOpenException (×2); junctionReachedSql/initialRunJoinSql
(the A4 hand-sync class); withTtlCache (×4); NO_STORE_HEADERS decision on
past-replies draft-status.
Guard: every item is behaviour-preserving; anything that isn't gets ejected to
its own ticket. DO-NOT-UNIFY register (03 P4) is binding — touching those items
is out of scope.
```

## H6 — Doc-truth sweep (no code)

```
Title: Docs: spec §5.3 guard placement, imported_count semantics, ADR 0018 precedence note

1. Spec 2026-08-05 §5.3: guard runs BEFORE the run-row claim (owner decision
   2026-08-07); spec says "joins the existing pre-flight guards" — make it say
   what ships.
2. Document imported_count ≠ rows stored (PHI-skip asymmetry) wherever counters
   are read by ops.
3. ADR 0018 addendum: delete_failed RecoveryControl deliberately outranks the
   hold (PastReplyCard.tsx:250-263).
```
