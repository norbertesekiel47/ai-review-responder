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
export interface ReviewRef {
  responseId: string;
  reviewId: string;
  businessId: string;
}

/**
 * Resolved publishing target. OPAQUE to worker orchestration — it is produced by
 * the adapter and threaded back into the adapter's transport methods. The retained
 * (deferred-neutralization) Zernio disposition layer is the ONLY worker code allowed
 * to read its provider coordinates, via `target.dispositionContext`. Worker
 * orchestration never destructures a `zernio_*` field.
 */
export interface ResolvedPublishTarget {
  ref: ReviewRef;
  /** Provider coordinates for the retained Zernio disposition layer. Opaque to
   *  orchestration. Disappears when the GBP adapter forces error neutralization. */
  dispositionContext: PublishDispositionContext;
}

/** What the retained Zernio disposition helpers consume. Named, not hidden, because
 *  decision 1 keeps the Zernio-aware disposition in the worker for now. */
export interface PublishDispositionContext {
  accountId: string;   // zernio_account_id
  locationId: string;  // zernio_location_id
  providerReviewId: string; // resolved Zernio review id
}

export type ResolveTargetResult =
  | { kind: 'no_connection' }
  | { kind: 'review_not_found'; reason: string; meta: Record<string, unknown> }
  | { kind: 'resolved'; target: ResolvedPublishTarget };

/** Neutral view of a published reply for the post-verify / 409 paths. */
export type FindReplyResult =
  | { kind: 'review_absent' }                              // not in feed after pagination
  | { kind: 'found'; reply: { comment: string } | null };  // found; reply may be null

export interface ReviewPublisher {
  /** Owns: active-connection SELECT + provider review-id lookup (page-walk + Redis
   *  cache + field-match). Returns a neutral discriminated result. May THROW the
   *  existing Zernio transient/permanent classes (deferred neutralization). */
  resolveTarget(ref: ReviewRef): Promise<ResolveTargetResult>;

  /** Post a reply. Throws the existing Zernio error classes on failure. */
  publishReply(target: ResolvedPublishTarget, replyText: string): Promise<void>;

  /** Delete the existing reply (edit = DELETE-before-POST). Throws Zernio classes. */
  deleteReply(target: ResolvedPublishTarget): Promise<void>;

  /** Fetch our review's current reply from the live feed (post-verify + 409).
   *  Owns the page-cache bounding internally (hides getCachedZernioReviewPage). */
  findReply(target: ResolvedPublishTarget): Promise<FindReplyResult>;
}

export function getReviewPublisher(): ReviewPublisher { /* returns ZernioReviewPublisher */ }
```

```ts
// src/lib/publishing/zernio-review-publisher.ts  (NEW — first adapter)
// Thin wrapper that DELEGATES to the existing, already-mockable primitives:
//   - the active-connection SELECT (moved here from ResponsePublisherWorker)
//   - lookupZernioReviewId / getCachedZernioReviewPage (stay in zernio-publisher.ts)
//   - zernioClient.{postReply,deleteReply,listAllReviews}
// Delegation is deliberate: it keeps the 9 existing tests' mocks of zernioClient.* /
// lookupZernioReviewId intact, which is our strongest "zero behavior change" guard.
```

### The one documented tension (for Codex)
Decision 2 (neutral input contract) and decision 1 (worker keeps Zernio-aware
disposition needing account/location/reviewId) are in tension: fully hiding provider
coordinates would require moving disposition into the adapter (rejected — that's the
deferred Scope-B/C work). Resolution: the transport methods take a `ResolvedPublishTarget`
(the adapter's own value object), **not** raw provider strings. Worker *orchestration*
stays provider-noun-free; only the retained disposition layer reads
`target.dispositionContext`. This preserves behavior (single resolution, shared Redis
cache) and avoids a new TOCTOU window. The leak is explicit and disappears with the
GBP adapter. **`resolveTarget(ref)` is the neutral-result surface; transport methods
take the opaque target — that is the faithful realization of both decisions.**

## Call-site migration (7 files, each mechanical; disposition behavior unchanged)

| File | Today | After |
|---|---|---|
| `ResponsePublisherWorker.ts` | `SELECT … zernio_connections` + `resolvePublishableZernioReviewId(...)` | `publisher.resolveTarget(ref)` → switch on result (`no_connection`→park, `review_not_found`→exception, `resolved`→continue with `target`) |
| `review-lookup.ts` | catches `ZernioReviewNotFoundError`, opens review_exception | becomes the worker-side disposition for the `review_not_found` result (same DB writes); transient still wraps→`PublisherTransientWithContext` |
| `post-reply.ts` | `zernioClient.postReply(acct, zReviewId, …)` + verify | `publisher.publishReply(target, text)`; coords for disposition from `target.dispositionContext` |
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
