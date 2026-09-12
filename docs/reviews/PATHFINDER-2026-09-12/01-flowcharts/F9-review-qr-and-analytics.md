# F9 — Review QR and the analytics boundary

**Theme Z · `43afb2b71` #982 (Review QR — migration 115) · `4502ed1f8` #1110
(moved under `/dashboard/requests/qr`) · plus the owner-intake singletons
`862a039d1` #1109, `13540eed6` #1101, `9c40633f8` #1100, `dec98bab5` #1123.**

**54 nodes.** Charted because it is the window's only new *public, unauthenticated*
route, and because it tests invariant #13's sibling rule — *durable facts are
NOT client-postable*.

---

## Correction to the brief

**The event is `qr_scan_redirected`, not `qr_scan`.**
`supabase/migrations/115_qr_scan_analytics_event.sql:44` and
`src/lib/analytics/events.ts:31`.

## The scan lane

```mermaid
flowchart TD
  Z1["printed poster<br/>dashboard/requests/qr/print/[businessId]/page.tsx:93-99"]
  Z2["GET /q/[businessId]<br/>src/app/q/[businessId]/route.ts:60-63"]
  Z3["UUID shape guard :32, :65-68"]
  Z4["resolveQrRedirect(sql, businessId) :70"]
  Z5["getQrRedirectRow — PRE-AUTH read<br/>src/lib/locations/repo.ts:198-209<br/>unscoped businesses × accounts, allowlisted 'pre-auth-token'"]
  Z6["refusals: not_found :68 · archived :69 · subscription :70-72 · bad_place_id :73-74<br/>src/lib/locations/review-qr.ts"]
  Z6b["subscriptionAllowsQrRedirect<br/>src/lib/shared/subscription-status.ts:86-91"]
  Z7["buildWriteReviewUrl + isPlaceId canonicality<br/>review-qr.ts:42-46 · reviews/url-parser.ts"]
  Z8["unavailablePage() — 200, no-store, SCANNER-SAFE HTML :36-58"]
  Z9["302 RETURNED FIRST :94-97"]
  Z10["after() deferred, post-response, best-effort :76-92"]
  Z11["makeAnalyticsEventKey('qr_scan_redirected', [businessId, randomUUID()])<br/>:80 · events.ts:100-109"]
  Z12["enqueueAnalyticsEvent(sql, …) :78-88"]
  Z13["reportCaughtError on failure — NEVER thrown :89-91"]
  Z14["isAnalyticsEventName enqueue.ts:24-26"]
  Z15["sanitizeAnalyticsProperties — blocks token/secret/password keys<br/>enqueue.ts:28 · events.ts:111-129"]
  Z16["INSERT analytics_events … ON CONFLICT (event_key) DO NOTHING :29-54"]

  Z1 --> Z2 --> Z3 --> Z4 --> Z5 --> Z6
  Z6 --> Z6b
  Z6 -->|refused| Z8
  Z6 -->|ok| Z7 --> Z9
  Z9 --> Z10 --> Z11 --> Z12 --> Z14 --> Z15 --> Z16
  Z12 -.throws.-> Z13

  subgraph CLIENTLANE["the CLIENT-postable lane — structurally parallel, NEVER used by QR"]
    Y1["POST /api/analytics/enqueue :22"]
    Y2["assertSameOrigin :24"]
    Y3["isClientEnqueueableEventName :39 · events.ts:96-98"]
    Y4["CLIENT_ENQUEUEABLE_EVENT_NAMES events.ts:86-92<br/>signup_started · sample_demo_started · sample_demo_to_signup<br/>· gbp_connect_started · gbp_connect_failed<br/>qr_scan_redirected is ABSENT"]
    Y5["checkRateLimit 120/60s :49"]
    Y6["rw_analytics_id anon cookie :13, :43-47, :71-77"]
    Y1 --> Y2 --> Y3 --> Y4 --> Y5 --> Y6 --> Z16
  end

  subgraph DISPATCH["AnalyticsDispatchPoller"]
    W1["tick :198-206"]
    W2["stale-claim reclaim (>10 min dispatching) :117-127"]
    W3["claim pending → dispatching, FOR UPDATE SKIP LOCKED :129-143"]
    W4["isAnalyticsConfigured() short-circuit :108-110 · posthog.ts:38-40"]
    W5["captureAnalyticsEvent — buffers, appends $insert_id :151-155"]
    W6["markDispatchDeferred — infra fault, attempt REFUNDED :91-103"]
    W7["flushAnalytics() confirms delivery :174"]
    W8["markDispatchCompleted / markDispatchFailed :57-86"]
    W1 --> W2 --> W3 --> W4 --> W5 --> W7 --> W8
    W4 -.-> W6
  end
  Z16 -.polled.-> W1

  subgraph OWNER["the owner surface"]
    V1["ReviewQrPage :33-58 → requireOwnerAccess(sql) :34"]
    V2["getOwnerReviewQrLocations(sql, accountId, appUrl)<br/>review-qr.ts:96-110, called :35-39"]
    V3["getLocationsForAccount repo.ts:64 — OWNER-SCOPED, distinct from Z5"]
    V4["toOwnerReviewQrLocation + QRCode.toDataURL (2048px) :141-155"]
    V5["RequestsTabs active='qr', gated on solicitationWatchEnabled() :22, :55"]
    V6["ReviewQrClient :39-159 — eligible → QR/download/print, else reconnect CTA"]
    V7["print/[businessId]/page.tsx:70-102 → PrintButton window.print()"]
    V1 --> V2 --> V3 --> V4 --> V6
    V1 --> V5
    V6 --> V7
  end

  subgraph LEGACY["the redirects"]
    U1["settings/review-qr/page.tsx:12-14 → /dashboard/requests/qr"]
    U2["settings/review-qr/print/[businessId]/page.tsx:13-20 → the new print route"]
  end
  U1 --> V1
  U2 --> V7
  N1["Sidebar REVIEW_QR_NAV :78, :199-207 — defined ONCE, rendered as a<br/>Requests child OR a top-level row, mutually exclusive on solicitationEnabled"] --> V1
  N2["MobileTabBar :68-71 — third slot is Requests or Review QR"] --> V1
```

## The analytics boundary — the rule holds, and it is enforced in the right place

`qr_scan_redirected` is a **server-side durable fact and is correctly NOT
client-postable.** `CLIENT_ENQUEUEABLE_EVENT_NAMES` (`events.ts:86-92`) lists
exactly five: `signup_started`, `sample_demo_started`,
`sample_demo_to_signup`, `gbp_connect_started`, `gbp_connect_failed`.
`qr_scan_redirected` is absent. The QR route inserts directly via
`enqueueAnalyticsEvent` (`route.ts:78-88`), never through
`/api/analytics/enqueue`.

The allowlist's own comment (`events.ts:81-85`) states the rule better than
CLAUDE.md does: *"Durable state-change facts … are owned by workers/route
handlers after a DB commit and must NOT be client-postable, or anyone could
forge the activation funnel."* **This is the correct side of the line, and the
reasoning is recorded at the allowlist rather than in a doc.**

## Three design properties worth copying

1. **The 302 is returned before the analytics write.** `route.ts:94-97`
   returns; `after()` at `:76-92` runs the insert post-response. A scanner
   never waits on an analytics row, and `reportCaughtError` at `:89-91`
   guarantees an insert failure never reaches the visitor.
2. **The refusal page is scanner-safe.** `unavailablePage()` (`:36-58`)
   returns **200** with no-store HTML rather than a 404 — because a phone
   camera's in-app browser renders a 404 as a dead end. The status code is a
   product decision made against the actual client, and it is commented as
   one.
3. **Two reads, two scopes, deliberately not shared.** `getQrRedirectRow`
   (`repo.ts:198-209`) is an unscoped pre-auth join, explicitly allowlisted as
   `pre-auth-token` in `tenant-scope-allowlist.ts`; `getLocationsForAccount`
   (`repo.ts:64`) is the owner-scoped read. Two functions in one file for two
   trust models. **Legitimate specialization — DO NOT unify.** New register
   entry.

## The owner-intake singletons

| Merge | What it added | Note |
|---|---|---|
| `9c40633f8` #1100 | `src/lib/shared/password-rules.ts` — one owner for `passwordSchema`, both submit guards, and the displayed requirements list | **Replaced three hand-written copies, one of which was wrong.** The model for every other "N spellings of one rule" finding in this pass |
| `862a039d1` #1109 | `src/lib/shared/business-categories.ts` — 15 groups / 92 subcategories `as const`; `resolveVertical` gains a **total** `SUBCATEGORY_VERTICALS` table consulted before the keyword matcher | Measured before the change: keyword matching dropped **48 of 92** to `other` and resolved **two wrongly** — and a vertical picks a freshness window, so those were wrong send/withhold decisions, not mislabels |
| `13540eed6` #1101 | `src/lib/solicitation/contacts-csv-template.ts` (pure, `todayUtc` injected) + `TemplateCard.tsx` | Built in code rather than shipped as a static asset **so one eval suite feeds the template back through `parseContactsCsv`** — a template that drifts from the header contract would earn `missing_required_header` and discard the whole upload |
| `dec98bab5` #1123 | Import-offer actions take a slot instead of an inline flex | |

#1109's before-measurement is the single best piece of engineering evidence in
the window: it quantified the defect (48/92 wrong bucket, 2 actively wrong)
*before* choosing the fix, and the fix was a total table rather than a better
heuristic.

## Defects

None found. The QR lane's three reads are each correctly scoped, the analytics
event is on the correct side of the client boundary, the `ON CONFLICT
(event_key)` dedup is present (`enqueue.ts:29-54`), and the poller refunds the
attempt on an infra fault (`markDispatchDeferred`, `:91-103`) rather than
burning it — the same fail-open-but-safe posture CLAUDE.md's cost-guard gotcha
describes.
