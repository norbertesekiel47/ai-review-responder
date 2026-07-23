# SerpAPI `local_results`: competitor fields, match reliability, quota cost

Research for #530 (part of wayfinder map #528). Facts only — schema semantics
are decided in #532. Verified premise: `ranking_snapshots` persists only our
own `rank_position` (`supabase/migrations/001_initial_schema.sql:442`);
everything else in `local_results` is currently discarded
(`worker/jobs/RankingTrackingWorker.ts:86-107`).

## Verified fields

**The codebase uses only `engine=google_maps`** for local results
(`worker/jobs/RankingTrackingWorker.ts:65`, `src/lib/reviews/place-id-resolver.ts:58`,
`src/lib/reviews/serpapi-prefill.ts:85`; reviews use `google_maps_reviews`,
`src/lib/reviews/serpapi-source.ts:27`). The `google_local` engine is unused.

Per-entry fields documented for the Google Maps engine's `local_results`
([serpapi.com/maps-local-results](https://serpapi.com/maps-local-results)):

| Field | Type | Doc description |
|---|---|---|
| `position` | Integer | "Position of the local result on the page" |
| `title` | String | Business name |
| `place_id` | String | "Place ID of the local result" — canonical `ChIJ…` Place ID |
| `data_id` / `data_cid` | String | Google internal / CID identifiers |
| `rating` | Float | "Rating of the local result" |
| `reviews` | Integer | "Number of reviews of the local result" |
| `gps_coordinates` | Object | `{ latitude, longitude }` |
| `type`, `price`, `address` | String | Category, price band, address |

Practical presence caveats (docs do not mark optionality; our own code already
treats fields as optional):

- `RankingTrackingWorker` types entries as `{ place_id?, title?, position? }`
  and falls back to array index + 1 when `position` is missing or non-integer
  (`worker/jobs/RankingTrackingWorker.ts:86-98`).
- `place-id-resolver` skips entries missing `place_id`, `gps_coordinates`, or
  `title` (`src/lib/reviews/place-id-resolver.ts:93-94`) — i.e. we already
  assume some entries can lack `place_id`.
- `rating`/`reviews` are not guaranteed for review-less businesses; the docs
  ([serpapi.com/google-maps-api](https://serpapi.com/google-maps-api)) show them
  in examples but do not promise presence. Any persistence must treat both as
  nullable.
- Page size: ~20 results per page, paginated via `start` (+20 per page).
  `RankingTrackingWorker` fetches page 1 only → the free competitor set is the
  **top ~20** for that keyword/location.

**Engine trap:** on the `google_local` engine, `place_id` is documented as the
"Google CID (customer identifier)", NOT a canonical `ChIJ…` Place ID
([serpapi.com/local-results](https://serpapi.com/local-results)). Switching
engines would silently break `place_id` matching against
`businesses.google_place_id`. Stay on `google_maps`.

## Match-reliability notes (week-over-week competitor identity)

- **Primary key: `place_id`.** Present on the overwhelming majority of
  `google_maps` local results; it is what we already match our own business on
  (`worker/jobs/RankingTrackingWorker.ts:89-91`). Weekly joins on `place_id`
  are the right default.
- **Place IDs are stable but not immortal.** Google documents that place IDs
  "may change due to updates on the Google Maps database" and recommends
  refreshing IDs older than ~12 months; IDs go obsolete when a business closes
  or moves ([Google Places docs, Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id)).
  At weekly cadence this is a rare-event problem (a rival's row simply
  restarts under a new ID), not a matching-algorithm problem.
- **Fallback identity signals already exist in-repo** if #532 wants
  continuity across an ID rotation: `data_cid` (long-lived Google CID, also in
  the same response) or normalized-title + GPS proximity — the exact heuristics
  (`normalizeName`, `nameSimilarity`, `haversineMeters`) already live in
  `src/lib/reviews/place-id-resolver.ts:161-204`.
- **Set churn ≠ identity churn.** The top-20 for a keyword reshuffles;
  a rival absent one week may just have dropped below page 1. Persisting
  "not present this week" is a ranking fact, not an identity loss.
- **Query stability matters for comparability.** Result sets depend on
  `ll=@lat,lng,15z` vs `location=<text>` (`worker/jobs/RankingTrackingWorker.ts:71-75`);
  `ranking_snapshots.search_location` already records which was used, so
  week-over-week comparisons should filter on same keyword + same
  `search_location`.

## Quota-cost analysis

- **Zero marginal SerpAPI calls for top-20 competitors.** The competitor rows
  arrive in the SAME `getJson` response `RankingTrackingWorker` already makes
  (one search per business x keyword x snapshot; currently capped at 1 keyword,
  `worker/jobs/RankingTrackingWorker.ts:173`). The `local_results` array is in
  memory and discarded after the own-rank match — persisting it is free at the
  API layer.
- **Extra calls are needed only for**: (a) competitors beyond position ~20
  (pagination, +1 search per extra page); (b) per-competitor detail lookups
  (`place_id` → `place_results`, +1 search each); (c) competitor review text
  (`google_maps_reviews`, +1 search each — and page 1 always returns 8 reviews
  ignoring `num`, per `.claude/reference/lab-notes.md` "SerpAPI Maps Reviews
  ignores `num` on page 1"). None are required for title/rating/review-count/
  position deltas.
- **In-repo budget guards (unchanged by persisting competitors):**
  ranking lane `checkRateLimit('serpapi:ranking:monthly', 100, 30d, strict)`
  (`worker/jobs/RankingTrackingWorker.ts:196`); place-ID resolution 75/day
  fail-closed (`src/lib/reviews/place-id-resolver.ts:8`); prefill cached 7 days.
- **Plan pricing units:** only successful searches count; cached searches are
  free ([serpapi.com/pricing](https://serpapi.com/pricing)). Current published
  plans: Free 250/mo, Starter $25/1,000, Developer $75/5,000, Production
  $150/15,000, Big Data $275/30,000. Note: the repo's cost constant
  `SERPAPI_PREFILL_COST_USD = 0.005` cites a "$50/5000 plan"
  (`src/lib/reviews/serpapi-prefill.ts:11`) that no longer exists on the
  pricing page (and $50/5,000 would be $0.010 anyway; Developer is
  $0.015/search). The constant is stale on both counts — worth a follow-up if
  cost dashboards should reflect real spend.

## Open questions for #532

1. Snapshot shape: JSONB competitor array on `ranking_snapshots` vs normalized
   `competitor_snapshots` rows (join-ability vs write simplicity)?
2. Top-N cap to persist (all ~20, or top 10)? Storage-only decision — quota
   cost is identical.
3. Matching semantics on `place_id` rotation: accept a broken series, or add
   `data_cid` / name+GPS fallback continuity?
4. Should own-business rows be included in the persisted competitor set
   (self-row makes delta queries uniform) or excluded?
5. Nullability policy for `rating`/`reviews` when absent — persist NULL or
   drop the entry?
6. Does `search_location` + keyword remain the comparison key, and what
   happens to history if an owner edits `ranking_search_location`?
