# #644 — Unsubscribe opt-out path: RFC 8058 ingress + `/u/<token>` landing

**Branch** `feat-644-unsubscribe-opt-out` · **RISK** high · **SURFACE** mixed · **db_touching** true
**Intake contract** `.feature/intake.json` (audit copy `docs/superpowers/plans/feat-644-unsubscribe-opt-out-intake.json`)
**Spec of record** `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` §5.1–§5.5, §9.1, §9.2, §10, DR1
**Glossary** `CONTEXT.md` → "Solicitation suppression & unsubscribe"
**Depends on** #643 (migration 096/097 + `src/lib/solicitation/suppression.ts`) — merged, `4186cefa`
**Hands off to** #630 (imports `hashUnsubscribeToken`), #622 (shares `SOLICITATION_UNSUBSCRIBE_MAILTO`)

**Revision 2** — supersedes revision 1 after adversarial review round 1
(`docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-round1.md`, VERDICT: REVISE,
7 findings). Owner decisions taken 2026-08-03: unknown tokens now fail **honestly** rather
than returning a false success (finding 1), and `allowed_edit_surface` was amended once to
admit `src/lib/shared/sentry-scrub.ts` (finding 3). Findings 2, 4, 5, 6, 7 accepted and
folded in below.

---

## 1. Seam design (codebase-design)

### 1.1 Modules touched

| Module | Verdict |
|---|---|
| `src/lib/solicitation/suppression.ts` (#643) | **Deepened, interface unchanged.** `recordSuppression` reused verbatim; no `ON CONFLICT` predicate is re-implemented. |
| `src/lib/solicitation/unsubscribe.ts` (NEW) | **The one new interface.** Two real adapters justify the seam. |
| `worker/index.ts` ingress hook | **Simplified.** The inline `/ingress/` string test now delegates to resolved route config (§1.4). |
| `src/lib/shared/sentry-scrub.ts` | **Deepened, interface unchanged.** Three new path patterns added to the existing redaction table. |
| `worker/ingress/unsubscribe.ts`, `src/app/api/u/[token]/route.ts`, `src/app/(public)/u/[token]/page.tsx` | **Adapters, not modules.** Parse, call one module function, map to a response. |

### 1.2 The new interface

```ts
// src/lib/solicitation/unsubscribe.ts

/** Invariant #5/#10. Exported for #630's minting so one function owns the digest. */
export function hashUnsubscribeToken(rawToken: string): string;

/**
 * §5.4's enumeration rule, enforced STRUCTURALLY: unknown, malformed, and
 * already-redeemed all return null. The page cannot leak the distinction
 * because the module never tells it. Read-only.
 *
 * Cross-account fail-closed (finding 5): businessName resolves ONLY when
 * businesses.account_id matches the token's account_id. account_id and
 * business_id are unrelated plain UUIDs on this table, so a minting bug that
 * paired account A with business B would otherwise name B (violating §5.5).
 */
export function findRedeemableUnsubscribeToken(
  db: SqlExecutor, rawToken: string,
): Promise<{ businessName: string | null } | null>;

/** Throws on infra failure. Domain outcomes are returned, not thrown. */
export function redeemUnsubscribeToken(
  tx: TransactionSql,
  input: { rawToken: string; source: 'unsubscribe_one_click' | 'unsubscribe_link' },
): Promise<
  | { status: 'redeemed'; tokenHashPrefix: string }
  | { status: 'already_suppressed'; tokenHashPrefix: string }
  | { status: 'unknown_token'; tokenHashPrefix: string }
>;
```

Hidden behind it: the SHA-256 digest, the §5.4 collapse, the cross-account predicate,
delegation to `recordSuppression`, and the `redeemed_at` claim (§1.3).

`tokenHashPrefix` rides out on every outcome so callers log correlation without ever
holding the raw token (§9.5). The `suppressionId` field from revision 1 is **removed** —
it tempted callers into the finding-4 bug of conditioning the stamp on it.

### 1.3 `redeemed_at` is an atomic claim, not a follow-up write (finding 4)

`recordSuppression` returns `null` in **two** different situations — an existing row won
first-write-wins, and a concurrent redemption lost the unique-index race — so its return
value cannot drive the stamp. Both naive readings are broken:

- Stamp unconditionally → two overlapping transactions both see `redeemed_at IS NULL`
  and the loser overwrites the winner's timestamp.
- Stamp only when a suppression row was written → a token whose handle was already
  suppressed by a `complaint` is **never** stamped and stays redeemable forever.

**The claim is therefore its own atomic statement**, independent of the insert result:

```sql
UPDATE solicitation_unsubscribe_tokens
   SET redeemed_at = NOW()
 WHERE id = ${tokenId} AND redeemed_at IS NULL
 RETURNING id
```

Order inside the single `sql.begin()`: resolve token by hash → `recordSuppression` →
atomic claim. `status` is `redeemed` when the claim returned a row, `already_suppressed`
when it did not (the token was already spent), `unknown_token` when the hash resolved
nothing. Verification needs a genuinely overlapping `Promise.all` integration test —
the sequential "second redemption" test and the property test do **not** exercise this.

### 1.4 The rate-limit exclusion keys on route config, not URL text (finding 2)

Revision 1's `shouldEnforceIngressRateLimit(url)` string predicate is **withdrawn**.
`request.url` is the raw URL while find-my-way decodes before matching, so the two
disagree. Verified locally on Fastify 5.8.5:

| Request | Routes to unsubscribe? | Raw-prefix test | Consequence of revision 1 |
|---|---|---|---|
| `/ingress/unsubscribe/abc` | yes | passes | ok |
| `/ingress/%75nsubscribe/abc` | **yes** | **fails** | statutory POST rate-limited — §9.2 violated |
| `/ingress/unsubscribe/x/extra` | no (404) | passes | unthrottled flood namespace |

`request.routeOptions.config` **is** populated at `onRequest` (routing has already run),
and the 404 case correctly yields `config = {}`. So:

```ts
app.post('/ingress/unsubscribe/:token', { config: { skipIngressRateLimit: true } }, handler);

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/ingress/')) return;
  if (request.routeOptions.config?.skipIngressRateLimit === true) return;
  await enforceIngressRateLimit(request, reply);
});
```

The exclusion is keyed to the **resolved route**, so encoding tricks cannot defeat it and
an unmatched path cannot inherit it. Tests go through real `app.inject()`, not a pure
predicate — a unit test of a string function would have passed while production failed.

---

## 2. Tracer tickets

---

### T1 — The RFC 8058 one-click path, end to end

**Blocking edges:** none.

**Files:** NEW `src/lib/solicitation/unsubscribe.ts`, `worker/ingress/unsubscribe.ts` ·
MOD `worker/index.ts`, `scripts/ci/tenant-scope-allowlist.ts`, `src/lib/shared/sentry-scrub.ts` ·
tests in `worker/ingress/__tests__/`, `src/lib/solicitation/__tests__/`, `src/lib/shared/__tests__/`

**Contract details**

1. **Rate-limit exclusion via route config** — §1.4. The ticket's single highest-risk
   detail; test through `app.inject()` including the percent-encoded and 404 cases.
2. **Commit-then-2xx (§9.1).** `postgres.js` awaits `COMMIT` before `sql.begin()` resolves
   (confirmed in review), so returning after the await is sound.
3. **Failure handling is explicit, never propagation (finding 3).** The adapter **catches**
   the error, calls `captureException` with sanitized context, and returns `503` itself.
   It must NOT rethrow: Fastify's default 5xx handler logs the full request and pino's
   serializer includes `request.url` — verified to emit
   `/ingress/unsubscribe/SECRET123`, an **invariant #5 breach**. There is also no Fastify
   Sentry error handler registered, so propagation would give a logged 500 and no alert.
4. **Unknown token → `503` + Sentry** (finding 1, owner decision). The provider retries,
   so a token whose #630 mint transaction commits *after* the ask is delivered is still
   redeemable. A `200` would end the retry and lose that opt-out permanently.
5. **`GET` 302s** to `${NEXT_PUBLIC_APP_URL}/u/${encodeURIComponent(token)}` — encoding is
   mandatory (finding 6): Fastify decodes reserved characters in route params, so `a%2Fb`
   becomes `a/b` and an unencoded interpolation yields a two-segment path that 404s
   instead of reaching the neutral page.
6. **Sentry path redaction** — extend `sentry-scrub.ts` (which masks only `/approve/<token>`
   today) to `/u`, `/api/u`, and `/ingress/unsubscribe`, with tests.
7. **No `rawBody`, no signature, no `claimInboundEvent`.** Nothing to verify; idempotency
   comes from first-write-wins plus the §1.3 claim.
8. **Logging (§9.5).** `createWorkerLogger` sanitizes object args but **not** strings —
   log `{ token_hash_prefix, outcome }` as an object, never interpolated.
9. **DR1.** Nothing on this path reads `SOLICITATION_SEND_ENABLED`; test explicitly.

**Live-DB conventions (CLAUDE.md gotcha #573):** `*.integration.test.ts`, no migration SQL,
`assertSchemaReady`, fixtures cleaned by `normalized_handle`.

---

### T2 — The human landing path, end to end

**Blocking edges:** T1.

**Files:** MOD `src/lib/solicitation/unsubscribe.ts` (+`findRedeemableUnsubscribeToken`) ·
NEW `src/app/(public)/u/[token]/page.tsx`, `src/app/api/u/[token]/route.ts` ·
MOD `src/app/robots.ts`, `src/lib/config/server.ts`, `scripts/ci/tenant-scope-allowlist.ts` · tests

**Contract details**

1. **Three render states, one lookup.** `?done=1` → success copy (no lookup, no write);
   token resolves → button page naming the business; otherwise → neutral page.
2. **Unknown token at POST → 303 to the neutral page**, never `?done=1` (finding 1). A
   compliance page must not claim an opt-out that did not happen.
3. **Progressive enhancement.** Plain `<form method="post">`, no `'use client'`, no `fetch`.
   Form action and 303 target both use `encodeURIComponent(token)` (finding 6).
4. **Cross-account fail-closed name resolution** (finding 5) — §1.2. Test the corrupt
   pairing, not just missing/scrubbed provenance.
5. **`export const dynamic = 'force-dynamic'`** (required by the `(public)` guard test) and
   `robots: { index: false, follow: false }`.
6. **Exactly one `<main id="main-content">`** — the `(public)` layout does not wrap children.
7. **No `checkRateLimit`, no BotID registration.** `BOTID_PROTECTED_ROUTES` is an opt-in
   allowlist of exactly 4 paths whose test asserts that count — leave it alone.
8. **Mailto unset →** omit the line rather than render a broken `mailto:`.

**Brand:** invoke `repworth-brand-design` before writing the page.

---

### T3 — Registry, runbook, glossary

**Blocking edges:** T1, T2.

- `.claude/reference/env-vars.md` — `SOLICITATION_UNSUBSCRIBE_MAILTO` declared explicitly
  as a **dual-lane** variable (finding 7): spec §10 registers it on Railway for #622's
  `List-Unsubscribe` header, and this ticket reads it on Vercel for the §5.4 fallback.
  **Both environments must carry the same value**; document that, and note staging
  evidence of equality is required before solicitation sends are enabled.
- `docs/runbooks/vercel-waf-rate-limiting.md` — record that `/u/<token>` and
  `/api/u/<token>` must stay excluded if the two broad `/api` WAF nets are ever flipped
  from log-only to enforce.
- `CONTEXT.md` — extend the **Unsubscribe token** entry with redemption semantics, and
  record the §5.5/§5.4 resolution (§1.2) and the honest-failure decision (finding 1).

---

## 3. Risks carried into implementation

| Risk | Disposition |
|---|---|
| A missed rate-limit exclusion silently throttles a statutory endpoint | Closed by route-config keying (§1.4) + `app.inject()` tests incl. percent-encoded and 404 cases. |
| Raw token reaching logs or Sentry | Closed by adapter-level catch + explicit 503 + `sentry-scrub.ts` extension. |
| Concurrent double-POST corrupting `redeemed_at` | Closed by the §1.3 atomic claim + an overlapping `Promise.all` test. |
| Unknown token at ingress causes provider retry storm for a token that will never exist | Accepted. Providers bound their own retries, and the failure mode it prevents (permanent silent opt-out loss) is strictly worse. Watch the `unknown_token` rate. |
| `SOLICITATION_UNSUBSCRIBE_MAILTO` has no second consumer yet, so nothing enforces header/page equality | Partially closed by the dual-lane registry entry + staging equality evidence; fully closes only when #622 lands. |
| A content-type other than JSON/urlencoded 415s before the handler | Accepted. RFC 8058 §3.1 mandates urlencoded and the app-wide parser handles it; a global catch-all parser would change behavior for five other ingress routes. |
| Cross-site form POST to `/api/u/<token>` | Accepted by design (§9.2), and confirmed defensible in review: a token can only suppress the handle it already belongs to. |
| Reverting after merge leaves delivered asks advertising 404 URLs | Staging ride first; short revert window; ledger rows never deleted by rollback. |
