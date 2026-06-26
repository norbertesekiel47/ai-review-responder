# Stage 5 — ReviewPublisher seam (modularity-audit remediation)

_Branch: `refactor/audit-stage5-review-publisher-seam`. Pure refactor, ZERO behavior
change. Closes the last Q5 gap from the modularity audit: publishing is hard-wired
to Zernio across ~7 worker files; the parked direct-GBP path would be a rewrite, not
an adapter swap. Define the seam now so GBP becomes a second adapter._

## Locked decisions (confirmed with Norbert, 2026-06-26)

1. **Seam depth = minimal transport seam.** The adapter owns Zernio paging/caching/
   field-match; the worker keeps catching the existing Zernio error classes and keeps
   all DB disposition. **Neutral error taxonomy is deferred** to when the real GBP
   adapter lands (doing it now means guessing GBP's error shapes — the residual risk
   the plan explicitly accepts).
2. **ID resolution = adapter owns it, returns neutral results.** The adapter resolves
   the active publishing connection + provider review-id behind the neutral
   `ReviewRef`. The dispositionable *resolution* outcomes (`no_connection`,
   `review_not_found`) come back as neutral discriminated **results** the worker
   dispositions. Transport-op errors (auth/permanent/transient/409/validation) stay as
   thrown Zernio classes the worker catches (decision 1).

## The contract

```ts
// src/lib/publishing/review-publisher.ts  (NEW — interface + types + factory)

/** Neutral identity — app-owned ids ONLY. No provider nouns ever appear here. */
export interface ReviewRef { responseId: string; reviewId: string; businessId: string; }

/** Provider coordinates that locate a review's reply slot. ALL the adapter's
 *  transport methods need — the adapter never sees an app-owned id. */
export interface ReviewLocator {
  accountId: string;        // zernio_account_id
  locationId: string;       // zernio_location_id
  providerReviewId: string; // resolved Zernio review id
}

/** The neutral ref (for worker disposition) nested SEPARATELY from the provider
 *  locator, so transport gets `target.locator` (coords only — no app-owned id). */
export interface ResolvedPublishTarget { ref: ReviewRef; locator: ReviewLocator; }

export type ResolveTargetResult =
  | { kind: 'no_connection' }
  | { kind: 'review_not_found'; meta: Record<string, unknown> }
  | { kind: 'transient'; accountId: string; locationId: string; error: ZernioTransientError }
  | { kind: 'resolved'; target: ResolvedPublishTarget };

/** Neutral view of the feed for post-verify / 409 (diagnostics preserved). */
export type FindReplyResult =
  | { kind: 'review_absent'; pagesWalked: number; reviewsSeen: number }
  | { kind: 'found'; reply: { comment: string } | null };

export interface ReviewPublisher {
  /** Owns active-connection lookup + review-id resolution (page-walk + Redis cache).
   *  Neutral result; rethrows genuinely terminal/unknown lookup errors. */
  resolveTarget(ref: ReviewRef): Promise<ResolveTargetResult>;
  /** Transport — coords-only locator; throw the existing Zernio error classes. */
  publishReply(locator: ReviewLocator, replyText: string): Promise<void>;
  deleteReply(locator: ReviewLocator): Promise<void>;
  /** Locate + read current reply; owns the page-cache bounding internally. */
  findReply(locator: ReviewLocator): Promise<FindReplyResult>;
}

export function getReviewPublisher(): ReviewPublisher { /* lazy ZernioReviewPublisher */ }
```

```ts
// src/lib/publishing/zernio-review-publisher.ts  (NEW — first adapter)
// Thin wrapper that DELEGATES to the existing, already-mockable primitives:
//   - the active-connection SELECT (moved here from ResponsePublisherWorker)
//   - lookupZernioReviewId / getCachedZernioReviewPage (stay in zernio-publisher.ts)
//   - zernioClient.{postReply,deleteReply,listAllReviews}
// Delegation is deliberate: it keeps the existing tests' mocks of zernioClient.* /
// lookupZernioReviewId intact, which is our strongest "zero behavior change" guard.
```

### How the two decisions are reconciled (for Codex)
Decision 2 (neutral input contract) and decision 1 (worker keeps the Zernio-aware
disposition that needs account/location/reviewId) meet cleanly via **two types**:
- The adapter's transport methods take a `ReviewLocator` — **provider coordinates
  only, no app-owned id**. The adapter is fully app-id-agnostic except `resolveTarget`,
  which is precisely the ref→coords mapping.
- `ResolvedPublishTarget = { ref, locator }` (nested, not flattened). The worker holds
  the target so its retained (deferred-neutralization) disposition reads `target.ref`
  (status writes, exceptions, Sentry) and passes `target.locator` — coordinates only,
  no app-owned id — to the adapter's transport methods (Codex R1 #2).
- `verify409InTx`, which has no ref, calls `findReply` with a bare locator — no fake ref.

This preserves behavior (single resolution, shared Redis cache, no new response-status
read so no new TOCTOU window) and removes provider nouns from the adapter's transport
surface. The leak that remains — the worker still catches Zernio error *classes* — is
decision 1's deferred work and disappears when the GBP adapter forces error neutralization.

## Call-site migration (7 files, each mechanical; disposition behavior unchanged)

| File | Today | After |
|---|---|---|
| `ResponsePublisherWorker.ts` | `SELECT … zernio_connections` + `resolvePublishableZernioReviewId(...)` | `publisher.resolveTarget(ref)` → switch on result (`no_connection`→park, `review_not_found`→exception, `resolved`→continue with `target`) |
| `review-lookup.ts` | catches `ZernioReviewNotFoundError`, opens review_exception | becomes the worker-side disposition for the `review_not_found` result (same DB writes); transient still wraps→`PublisherTransientWithContext` |
| `post-reply.ts` | `zernioClient.postReply(acct, zReviewId, …)` + verify | `publisher.publishReply(target, text)`; coords for disposition read from `target.accountId/locationId/providerReviewId` |
| `verify-posted.ts` | `zernioClient.listAllReviews` + `getCachedZernioReviewPage` + find/compare | `publisher.findReply(target)` (page-cache hidden) + keep canonicalize-compare + indeterminate throws |
| `publisher-error-handlers.ts` | `verify409AndDispose`/`verify409InTx`: `listAllReviews`+pagecache | route list-fetch through `publisher.findReply(target)`; disposition unchanged |
| `edit-publish.ts` | `zernioClient.deleteReply/postReply` in locked tx (injected via `EditPublishDeps`) | `publisher.deleteReply/publishReply(target)`; inject publisher via deps for tests |
| `failed-hook.ts` | reads `ctx.account_id/location_id` off `PublisherTransientWithContext` | **unchanged** — no zernioClient call; error still carries context |

`applyTransientExhaustionFallback` (DB disposition that happens to live in
`zernio-publisher.ts`) stays put — out of scope to relocate.

**Out of scope (per locked plan):** neutral error taxonomy, moving disposition into the
adapter, DB-singleton injection, LLM abstraction, behavior changes, dup reduction.

## Test strategy (the "zero behavior change" guard)
- Keep ALL 9 existing publisher/publishing tests green. Because the adapter delegates
  to `zernioClient.*` + `lookupZernioReviewId`, most existing mocks keep working; adjust
  only where a call-site now goes through `getReviewPublisher()`.
- New unit tests for the adapter: `resolveTarget` (no_connection / review_not_found /
  resolved), `findReply` (absent / found+null / found+reply), page-cache bounding hidden.
- **New concurrency test (required):** a status change landing mid-publish must still
  lose to the existing idempotency / `awaiting_owner_connect` status-guarded UPDATEs —
  proving the seam opens NO new TOCTOU window vs today.

## Verify gate (re-run independently, never trust agent green)
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow`
Then: Codex correctness review (read-only) → thermo-nuclear maintainability → PR →
CI green incl. React Doctor 100/100 → staging ride (worker-touching) → merge.

## Stage 6 hygiene (fold in; re-verify each still applies)
- Delete `docs/design/dashboard-redesign/assets/warm-editorial.css` (confirm no ref).
- Delete unused `DrawerState`-type export in edit-reply hook (confirm genuinely unused).
- Dedupe `flagOff` across telegram/whatsapp `_shared.ts` (may already be deduped).
- Reformat stale `fallow-ignore` comment in `AutoPostNoticeWorker.ts`. Run `ci:fallow`.
</invoke>
