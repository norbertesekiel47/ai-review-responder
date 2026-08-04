# #644 plan — adversarial review, round 1

**Reviewer:** codex (read-only), session `019fc6e7-8d80-73a3-bcfb-71b3e4dd657b` · 13m26s
**Target:** `docs/superpowers/plans/2026-08-03-644-unsubscribe-opt-out.md`
**VERDICT: REVISE**

Reviewer's summary of what it could NOT break: `postgres.js` awaits `COMMIT` before
`sql.begin()` resolves (so commit-then-2xx is sound as designed); `recordSuppression`
does prevent duplicate ledger rows; the current dependency chain does not read
`SOLICITATION_SEND_ENABLED` (DR1 holds); a token-bound cross-site POST is a defensible
CSRF exception.

## Findings and triage

| # | Sev | Finding | Verdict |
|---|---|---|---|
| 1 | Critical | Unknown tokens receive a false success acknowledgment (200 at ingress, `?done=1` on the human path) | **ESCALATED** — reverses an owner decision; see below |
| 2 | Critical | URL-prefix rate-limit exclusion disagrees with Fastify's router | **ACCEPT** |
| 3 | Critical | "propagate → Sentry → 5xx" leaks the raw token AND does not guarantee Sentry | **ACCEPT** |
| 4 | High | Concurrent redemption: `redeemed_at` stamping is unspecified and racy | **ACCEPT** |
| 5 | High | Business-name lookup lacks a cross-account fail-closed predicate | **ACCEPT** |
| 6 | Medium | Decoded reserved characters in the token corrupt redirect/form paths | **ACCEPT** |
| 7 | Medium | `SOLICITATION_UNSUBSCRIBE_MAILTO` deployment surface is contradictory | **ACCEPT** |

---

### 1. Unknown tokens receive a false success acknowledgment — ESCALATED

Plan requires unknown ingress tokens → `200`, and unknown human POSTs → redirect to
success copy. Reviewer argues this conflicts with §9.1's "2xx only after the ledger write
commits", with the concrete failure: #630 advertises a token whose row was not committed
(or whose hash is wrong); the provider receives `200`, **stops retrying**, no suppression
exists, and the human path falsely says "You're unsubscribed." A warning log cannot
reconstruct the handle, so the opt-out is unrecoverable.

**Why this is escalated rather than accepted:** the `200` was an explicit owner decision
at intake sign-off (2026-08-03, grilling Q4), chosen over `404`. The reviewer surfaces
NEW evidence not weighed at that time — specifically the mint-race: if #630's token
INSERT commits *after* the ask is delivered, a provider POST arriving early finds no
token. Under `200` that opt-out is lost permanently; under `5xx` the provider retries and
succeeds once the mint lands. That argument is materially stronger than the one the
decision was made against. Owner decision required before this plan can be revised.

### 2. URL-prefix exclusion disagrees with Fastify's router — ACCEPT

`request.url` is the **raw** URL; find-my-way **decodes** the path before matching.
Verified empirically by the reviewer:

- `/ingress/%75nsubscribe/abc` **routes** to `/ingress/unsubscribe/:token` but **fails** a
  raw `/ingress/unsubscribe/` prefix test → the statutory POST gets rate-limited. This is
  §9.2 violated by exactly the door the ticket warned about.
- `/ingress/unsubscribe/anything/extra` **bypasses** the limiter while returning 404 →
  an unthrottled flood namespace.

**Revision:** drop the string-prefix predicate entirely. Use route-level
`config: { skipIngressRateLimit: true }` read from `request.routeOptions.config` in the
`onRequest` hook (routing has already run at `onRequest`), so the exclusion is keyed to
the *resolved route* rather than to text. Test through real Fastify injection, not only a
pure predicate. This supersedes the plan's `shouldEnforceIngressRateLimit(url)` seam.

### 3. 5xx leaks the raw token and does not guarantee Sentry — ACCEPT

Three distinct defects in one plan sentence ("propagate → Sentry (loud) → 5xx"):

1. Fastify's default 5xx handler logs the complete request; the pino serializer includes
   `request.url`. Verified: a thrown DB error logs `/ingress/unsubscribe/SECRET123` —
   **an invariant #5 breach** (raw token in logs).
2. **No Fastify Sentry error handler is registered** in `worker/index.ts`, so propagation
   yields a logged 500, not the promised alert. §9.1's "loud Sentry" would simply not happen.
3. `src/lib/shared/sentry-scrub.ts` masks only `/approve/<token>`; `/u`, `/api/u`, and
   `/ingress/unsubscribe` are absent.

**Revision:** catch the DB failure inside the adapter, `captureException` explicitly with
sanitized context, return an explicit `503`, and never let the default handler see the raw
URL. Extend `sentry-scrub.ts` path redaction to all three new paths, with tests.
**Requires an `allowed_edit_surface` amendment** to add `src/lib/shared/sentry-scrub.ts`
and its tests.

### 4. Concurrency correctness asserted but not designed — ACCEPT

`recordSuppression` returns `null` in **two** distinct cases: an existing row won
first-write-wins, and a concurrent redemption lost the unique-index race. The plan never
says how `redeemed_at` is stamped, and both obvious readings are wrong:

- Stamp unconditionally → two overlapping transactions both read `redeemed_at IS NULL`;
  the loser overwrites the winner's timestamp.
- Stamp only when `suppressionId !== null` → a token whose handle was already suppressed
  by a `complaint` **never** gets stamped, so it stays redeemable forever.

**Revision:** stamp with an atomic claim —
`UPDATE solicitation_unsubscribe_tokens SET redeemed_at = NOW() WHERE id = $1 AND redeemed_at IS NULL RETURNING id`
— inside the same `sql.begin()`, decoupled from the suppression insert result. Add a
genuinely overlapping `Promise.all` integration test; the planned sequential
"second redemption" test and the property test do **not** exercise this race.

### 5. Business-name lookup lacks a cross-account fail-closed predicate — ACCEPT

`account_id` and `business_id` on `solicitation_unsubscribe_tokens` are plain UUID
provenance columns with **no FK and no relationship between them** (migration 096). The
plan promises §5.5's "never any other account" but tests only missing/scrubbed provenance.
A minting bug storing account A with business B would expose B's name.

**Revision:** join on `businesses.id = token.business_id AND businesses.account_id = token.account_id`,
fall back to generic copy on mismatch, and test the corrupt pairing. Makes §5.5's
cross-tenant prohibition structural rather than assumed.

### 6. Decoded tokens break redirects and form actions — ACCEPT

Fastify decodes reserved characters inside route parameters: `a%2Fb` → `a/b`, `a%3Fb` →
`a?b`, `a%23b` → `a#b`. The plan interpolates the token into the worker `302` and the
Vercel form action / `303` without requiring encoding, so a malformed token containing an
encoded slash becomes a two-segment `/u/a/b` and **404s instead of reaching the neutral
page** — a dead-end §5.4 forbids.

**Revision:** `encodeURIComponent(token)` at every path-construction boundary; test
reserved-character inputs. (The fixed origin already prevents a conventional open
redirect; path corruption is the real hazard.)

### 7. Mailto deployment surface is contradictory — ACCEPT

Spec §10 registers `SOLICITATION_UNSUBSCRIBE_MAILTO` on **Railway**; the plan adds it only
to Next's server config. Ops configuring per the spec would leave Vercel without the
value, so an invalid landing link omits §5.4's working alternative.

**Revision:** declare it explicitly as a **dual-lane** variable in the registry, document
that both environments must carry the same value, and add staging evidence for equality
before solicitation sends are enabled.
