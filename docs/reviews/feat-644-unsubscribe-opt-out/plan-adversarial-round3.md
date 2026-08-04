# #644 plan revision 3 — adversarial review, round 3

**Reviewer:** codex (read-only), session `019fc759-0ee0-78c2-a116-f785f9019c7b` · 12m26s
**VERDICT: REVISE** — 5 findings. Owner authorised continuing past the 3-round budget.

Reviewer's summary: revision 3 "closes several prior defects, but the new claim
disambiguation recreates the lost-opt-out mint race, and the revision introduces additional
routing, scrubbing, and observability-contract defects."

## Prior findings — status

| # | Result |
|---|---|
| 3 — raw token logging | **CLOSED.** Independently reproduced on 5.8.5: the throwing unsubscribe route emitted zero lines while `onRequest` still executed; a sibling logged normally. `createWorkerLogger` writes through `console.*`, independent of Fastify (`logger.ts:89`). |
| 9 — types | **CLOSED.** `**/*.ts` is program-wide (`tsconfig.json:29`), so the augmentation in the imported `rate-limit.ts` merges globally; Fastify's interface is empty and `fastify-raw-body` adds only `rawBody`, so optional properties merge without conflict. |
| 2 — rate limit | **GET/HEAD gap CLOSED.** Fastify clones shorthand options and the generated HEAD route, so sharing one options object across both registrations is safe. **Adjacent defect remains — finding 2 below.** |
| 4 — ordering | **PARTIAL.** Claim-first does prevent spent-link replay. Purge serialization is sound and **corrects revision 3's framing**: purge touches only account-scoped suppressions before updating tokens, while redemption inserts a *global* row — disjoint rows/partial indexes, so no ABBA. Retaining non-null provenance pre-purge is **legitimate** (§6.3 keeps `account_id` on retained global rows). The residual defect is the disambiguation query — finding 1. |
| 10 — Sentry scrub | **OPEN** — over-redacts `/approve/`; finding 3. |
| 8 — observability | **OPEN** — findings 4 and 5. |
| 1 — 503 | §1.7 language **accepted**; the intake still contradicted it — finding 4. |

## Rollback semantics (Part B) — cleared

Claim-first does **not** burn a token when `recordSuppression` throws, provided the adapter
catches outside `sql.begin(...)`. Postgres.js 3.4.9 rolls back when the transaction callback
rejects and commits only on success, so claim + suppression + analytics roll back together.
**The real worst case is finding 1: no claim, no suppression, and a success-shaped result.**

---

## 1. CRITICAL — the failed-claim `SELECT 1` recreates the mint-race lost opt-out

The shared client sends a bare `BEGIN` with no isolation override (`src/lib/db/server.ts:40`)
against PostgreSQL 16, i.e. **Read Committed**. Interleaving: redemption's `UPDATE` sees no
token → the mint commits → the follow-up `SELECT 1`, taking a fresh snapshot, sees the new
**unredeemed** token and reports `already_suppressed` → `recordSuppression` never runs. The
provider receives a success-shaped no-op with no suppression in existence — precisely the
failure the 503 decision was made to prevent.

**Fix (revision 4):** disambiguate on `redeemed_at`, not existence. `redeemed_at IS NOT NULL`
→ `already_suppressed`; `redeemed_at IS NULL` → the token was minted after our snapshot →
report `unknown_token` → 503 → provider retries and succeeds.

## 2. HIGH — encoded ingress-root spellings bypass the global limiter

The hook still scoped enforcement with raw `request.url.startsWith('/ingress/')`.
Reproduced on 5.8.5: `/%69ngress/resend` **resolves to** `/ingress/resend` but fails the raw
check, escaping the limiter — falsifying the promised "still enforces … every other ingress
path" test.

**Fix (revision 4):** scope on `request.routeOptions.url` **OR** a decoded raw path, so
matched routes are encoding-proof *and* 404s under `/ingress/` stay throttled. A
resolved-route-only test would have dropped every 404 out of the hook, reopening the
unthrottled flood namespace round 2 flagged — both arms are required.

**Note:** this is a **pre-existing bypass affecting every `/ingress/` route**, not one this
ticket introduces. Fixing it here is in-surface and closes it for Stripe/Resend/Telegram/
Twilio/Zernio too — flagged to the owner as a scope question.

## 3. HIGH — the generalized scrub over-redacts existing approval routes

Revision 3 applied "redact to end of path" to `/approve/` on the assertion that a token is
always terminal. False: `/api/approve/<token>/edit` must keep `/edit`
(`sentry-scrub.test.ts:175`), and the console-message form `GET /approve/tok 200` must keep
the status (`sentry-scrub.test.ts:201`). Both are shipped, tested contracts.

**Fix (revision 4):** leave `/approve/` byte-for-byte as-is; add a **separate** rule for
`/u/`, `/api/u/`, `/ingress/unsubscribe/` that crosses `/` but stops at `?`, `#`, or
whitespace.

## 4. HIGH — the amended intake was internally contradictory

The plan removed Sentry for unknown tokens, while the intake still required an unknown-token
Sentry report *and* one structured log per request, *and* a new test requiring **no** Sentry
report. No implementation could satisfy all three.

**Fix (revision 4):** intake `user_visible_behavior` and `observability` rewritten to state
explicitly that unknown tokens emit a `warn` log and **no** Sentry event.

## 5. MEDIUM — the 60-second counter lacked restart and replica semantics

Its "single-replica by invariant" justification **contradicts the project contract**:
CLAUDE.md is explicit that single-replica operation is *detected, not enforced*, and that
cross-deployment overlap is expected during a normal deploy. An in-process count also
vanishes on restart before its window flushes, the shutdown sequence has no flush, and none
of the promised tests covered window emission, reset, flush, or multi-replica aggregation.

**Fix (revision 4):** counter **dropped**. One `warn` line per unknown request — bounded by
the same request rate as the route's own DB query, consistent with every other ingress
route, and aggregated by the existing log pipeline with no new machinery.
