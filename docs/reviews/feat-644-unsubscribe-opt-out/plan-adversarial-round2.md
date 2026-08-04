# #644 plan revision 2 — adversarial review, round 2

**Reviewer:** codex (read-only), session `019fc700-a509-78f1-be11-a0d96413aeae` · 11m51s
**Target:** `docs/superpowers/plans/2026-08-03-644-unsubscribe-opt-out.md` (revision 2)
**VERDICT: REVISE** — round 2 of a 3-round budget. One round remains before the workflow
requires escalating the disagreement to the owner instead of looping.

## Scoreboard against round 1

| # | Round-1 finding | Round-2 status |
|---|---|---|
| 1 | Unknown tokens acknowledged falsely | **PARTIALLY CLOSED** — 503 makes recovery *possible*, not guaranteed; spawns finding 8 |
| 2 | Rate-limit exclusion vs router | **PARTIALLY CLOSED** — mechanism verified sound, but only POST is exempted; GET/HEAD still limited |
| 3 | Raw token in logs / Sentry not guaranteed | **NOT CLOSED** — catching does not stop Fastify's *incoming request* log |
| 4 | `redeemed_at` racy | **NOT CLOSED** — atomicity fixed, but the transactional *ordering* is wrong |
| 5 | Cross-account business name | **CLOSED** |
| 6 | Reserved-character path encoding | **CLOSED** |
| 7 | Dual-lane mailto | **CLOSED** |

New defects found in revision 2 itself: **8, 9, 10**.

---

## 3. NOT CLOSED — catching does not prevent Fastify request logging

Fastify emits its `incoming request` log **before `onRequest` and before the handler**
(`fastify/lib/route.js:513`), and the installed Pino serializer copies `originalUrl`/`url`
verbatim (`pino-std-serializers/lib/req.js:65`). So a handler that catches and returns 503
*normally* still has its raw URL serialized on the ordinary request path. Catching only
suppresses the *additional* error log from Fastify's error handler.

Revision 2's claim at plan:146 that the adapter catch closes raw-token logging is
therefore **false**. Deployed lanes currently use `warn` level, which incidentally
suppresses the automatic info-level request log — but development uses `info`
(`worker/config/fastify-options.ts:17`), and a log-level coincidence is not a structural
invariant protecting invariant #5.

**Required:** disable request logging for this route, or install a token-redacting request
serializer. Not a catch.

## 4. NOT CLOSED — atomic timestamp, wrong transactional ordering

The conditional `UPDATE … redeemed_at IS NULL RETURNING` does prevent timestamp
overwrites, and there is **no** ABBA deadlock against a concurrent `recordSuppression`
(which only inserts into the suppression table, `suppression.ts:160`, while redemption
holds no token-row lock before that insert).

But revision 2 orders `recordSuppression` **before** the claim (plan:91), which breaks two
contracts:

1. **Correction-path replay.** A redeemed token is contractually a no-op (spec:213). If an
   admin later removes the suppression through the audited **Correction path** (spec:672),
   replaying the spent token **re-inserts the suppression** before the failed claim ever
   discovers the token was already redeemed. The audited correction is silently undone by
   a stale link.
2. **Purge race producing stale provenance.** The purge scrubs token provenance with an
   UPDATE of the same row (`purge-stages.ts:333`). Because revision 2's initial resolve is
   *unlocked*, redemption can read the old `account_id`, the purge can commit the scrub,
   and redemption then inserts a suppression carrying **stale non-null provenance** —
   contradicting §5.2's requirement that post-purge redemption yield `account_id = NULL`
   (spec:389).

**Required:** the claim must **serialize before** the suppression side effect. The natural
shape is to make the claim itself return the provenance it just locked —
`UPDATE … SET redeemed_at = NOW() WHERE id = … AND redeemed_at IS NULL RETURNING account_id, business_id, normalized_handle, channel`
— and feed `recordSuppression` from that row, with a separate safe lookup if the adapters
still need to distinguish unknown from already-spent.

## 2. PARTIALLY CLOSED — GET/HEAD left rate-limited

Mechanism verified sound: Fastify routes before constructing the request
(`route.js:458`); `routeOptions.config` comes from the resolved route context
(`request.js:180`); hooks registered before routes are copied into each route at
`preReady` (`route.js:390`); automatic HEAD routes inherit the GET route's options
(`route.js:248`); and method mismatches, OPTIONS, extra segments and case mismatches all
resolve to the empty 404 context, so none inherit the exemption (case sensitivity is
Fastify's default and is not overridden, `fastify-options.ts:15`).

**But** revision 2 attaches the flag only to `app.post(...)` (plan:112). The **worker GET
redirect is a separate route** (spec:365, plan:155), so it and its inherited HEAD route
still run the global ingress limiter. Attach the flag to both.

## 1. PARTIALLY CLOSED — 503 enables recovery, does not guarantee it

A 503 preserves the *possibility* of recovering a mint race, unlike 200. But the
repository contains no contract proving providers retry a 503, how often, or for how long
(spec:699), and the plan's assertion at plan:225 that providers bound their own retries is
unsupported by repository evidence. Whether any relevant provider treats 503 as permanent
cannot be verified here.

Also relevant: the intended #630 contract mints the token in a **pre-send transaction** and
reuses it on retries (`2026-07-28-send-mode-cross-spec-amendments.md:114`), so a conforming
implementation commits before external delivery. The 503 is a useful defence against a
broken ordering, **not** proof every provider can repair it. Restate the rationale honestly
rather than claiming guaranteed recovery.

No Railway health-check collision: Railway probes `/api/health` (`railway.toml:20`), which
remains a dependency-free 200 route (`worker/index.ts:548`).

## 8. NEW — unknown-token Sentry and log amplification

Every arbitrary unknown token is planned to produce a Sentry report (plan:152) on a
deliberately unauthenticated, **unrate-limited** route (spec:711). Worker Sentry config
samples traces but has no error-event sampling or deduplication (`worker/sentry.ts:6`), and
the intake promises one structured log per request (intake:145). A provider retry loop — or
plain hostile random-token traffic — yields unbounded Sentry and log amplification.

HTTP processing must stay unthrottled (§9.2), but **observability needs bounded
aggregation, deduplication, or sampling.** This is the direct cost of the finding-1
reversal and must be designed, not assumed.

## 9. NEW — route-config type contract incomplete

No runtime collision with `fastify-options.ts` or raw-body behaviour: server options do not
define route config (`fastify-options.ts:15`), and `fastify-raw-body` reads only
`config.rawBody` (`plugin.js:30`).

Compile-time defect: the installed plugin augments `FastifyContextConfig` only with
`rawBody` (`plugin.d.ts:3`) and Fastify's base interface is otherwise empty
(`context.d.ts:4`). So the plan's direct `request.routeOptions.config.skipIngressRateLimit`
access (plan:117) **fails typecheck** unless revision 3 adds module augmentation or an
equivalent typed seam.

## 10. NEW — encoded route spellings bypass the planned Sentry scrub

The scrubber applies regexes directly to the supplied URL string (`sentry-scrub.ts:65`) and
Fastify exposes the raw URL unchanged (`request.js:161`). Revision 2 plans **literal**
`/ingress/unsubscribe` redaction while explicitly supporting `/ingress/%75nsubscribe/…`
routing (plan:103, plan:159). The encoded spelling will not match a literal path regex, so
a captured event can **retain the raw token**. The scrub and its test matrix must cover
router-equivalent encoded spellings.

---

## Explicitly cleared

- **Crash-net interaction:** caught, awaited handler failures never reach the
  `unhandledRejection` listener (`worker/index.ts:869`).
- **Removing `suppressionId`:** no caller needs it — both adapters require only
  success/unknown mapping, and analytics stays internal to `recordSuppression`
  (`suppression.ts:190`).
- **Cross-account predicate under NULL provenance:** migration 096:144 guarantees
  `account_id NULL` implies `business_id NULL`; the equality evaluates UNKNOWN, yielding no
  business match, and the mandated generic-fallback test prevents an inner join from hiding
  the token row.
