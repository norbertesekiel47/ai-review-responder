# #644 — Unsubscribe opt-out path: RFC 8058 ingress + `/u/<token>` landing

**Branch** `feat-644-unsubscribe-opt-out` · **RISK** high · **SURFACE** mixed · **db_touching** true
**Intake contract** `.feature/intake.json` (audit copy `docs/superpowers/plans/feat-644-unsubscribe-opt-out-intake.json`)
**Spec of record** `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` §5.1–§5.5, §9.1, §9.2, §10, DR1
**Glossary** `CONTEXT.md` → "Solicitation suppression & unsubscribe"
**Depends on** #643 (migration 096/097 + `src/lib/solicitation/suppression.ts`) — merged, `4186cefa`
**Hands off to** #630 (imports `hashUnsubscribeToken`), #622 (shares `SOLICITATION_UNSUBSCRIBE_MAILTO`)

**Revision 3** — supersedes revision 2 after adversarial round 2
(`docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-round2.md`, VERDICT: REVISE).
Round 2 closed findings 5/6/7 and cleared the crash-net interaction and the `suppressionId`
removal. Revision 3 addresses findings 1, 2, 3, 4 (reopened) and the new 8, 9, 10.
Owner authorised continuing past the workflow's 3-round review budget.

Surface amendments used: **1 of 2** (`sentry-scrub.ts`, round 1). Revision 3 deliberately
keeps every new fix inside the existing surface — see §1.6.

---

## 1. Seam design

### 1.1 Modules touched

| Module | Verdict |
|---|---|
| `src/lib/solicitation/suppression.ts` (#643) | **Deepened, interface unchanged.** `recordSuppression` reused verbatim. |
| `src/lib/solicitation/unsubscribe.ts` (NEW) | **The one new interface.** Two real adapters. |
| `worker/index.ts` | Route registration + the hook now delegates to resolved route config. |
| `worker/ingress/rate-limit.ts` | Hosts the `FastifyContextConfig` module augmentation (finding 9). |
| `src/lib/shared/sentry-scrub.ts` | **Deepened, interface unchanged.** Path redaction generalised (findings 3, 10). |
| ingress handler / route handler / page | **Adapters, not modules.** |

### 1.2 The new interface

```ts
// src/lib/solicitation/unsubscribe.ts

/** Invariant #5/#10. Exported for #630's minting so one function owns the digest. */
export function hashUnsubscribeToken(rawToken: string): string;

/**
 * §5.4's enumeration rule, enforced STRUCTURALLY: unknown, malformed, and
 * already-redeemed all return null. Read-only.
 *
 * Cross-account fail-closed (round-1 finding 5, CLOSED): businessName resolves
 * ONLY when businesses.account_id equals the token's account_id.
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

### 1.3 Claim FIRST, then suppress — ordering is load-bearing (finding 4, reopened)

Revision 2 ordered `recordSuppression` before the `redeemed_at` claim. Round 2 showed that
ordering breaks two contracts:

1. **It silently undoes an audited Correction path removal.** A redeemed token is
   contractually a no-op (spec:213). If an admin removes a suppression through the audited
   Correction path (spec §8.2), replaying the spent link **re-inserts the suppression**
   before the failing claim ever discovers the token was spent.
2. **It can write stale provenance across a concurrent purge.** The purge scrubs token
   provenance with an UPDATE of the same row (`purge-stages.ts:333`). With an *unlocked*
   initial resolve, redemption reads the old `account_id`, the purge commits the scrub, and
   redemption inserts a suppression carrying non-null provenance — contradicting §5.2's
   `account_id = NULL` requirement.

**Revision 3 makes the claim the first and only write-ordering primitive, and has it return
the provenance it just locked:**

```sql
-- Step 1: claim. Row lock + fresh provenance in one statement.
UPDATE solicitation_unsubscribe_tokens
   SET redeemed_at = NOW()
 WHERE token_hash = ${tokenHash} AND redeemed_at IS NULL
 RETURNING account_id, business_id, normalized_handle, channel
```

- **Row returned** → we own the redemption. Call `recordSuppression` using the RETURNED
  `account_id`/`normalized_handle`/`channel`, never values read earlier. If the purge
  committed first, those columns are already NULL and the suppression row correctly carries
  `account_id = NULL` (§5.2). If we commit first, the purge scrubs afterwards. Either
  interleaving is correct. → `status: 'redeemed'`.
- **No row returned** → disambiguate with a separate read:
  `SELECT 1 FROM solicitation_unsubscribe_tokens WHERE token_hash = $1`.
  Exists → `already_suppressed` (no write at all, so a Correction path removal stands).
  Absent → `unknown_token`.

`recordSuppression` is never reached on the already-spent path. That is the whole point.

No ABBA deadlock: `recordSuppression` only inserts into the suppression table
(`suppression.ts:160`), and after this reordering redemption holds the token-row lock
*before* that insert, consistently in one direction.

### 1.4 The rate-limit exclusion keys on route config — on BOTH routes (finding 2)

Round 2 verified the mechanism is sound: Fastify routes before constructing the request
(`route.js:458`); `routeOptions.config` comes from the resolved route context
(`request.js:180`); hooks registered before routes are copied in at `preReady`
(`route.js:390`); automatic HEAD inherits the GET route's options (`route.js:248`); and
method mismatch, OPTIONS, extra segments and case mismatch all resolve to the empty 404
context, so none inherit the exemption.

Revision 2's defect was scope, not mechanism: it flagged only `app.post`. **The worker GET
redirect is a separate route**, so it and its inherited HEAD were still throttled.

```ts
const UNSUBSCRIBE_ROUTE_OPTS = {
  config: { skipIngressRateLimit: true },
  // finding 3: suppress Fastify's `incoming request` log, which serialises the raw
  // URL — and therefore the raw token — BEFORE onRequest and before the handler.
  logLevel: 'silent',
} as const;

app.post('/ingress/unsubscribe/:token', UNSUBSCRIBE_ROUTE_OPTS, handleUnsubscribePost);
app.get('/ingress/unsubscribe/:token',  UNSUBSCRIBE_ROUTE_OPTS, handleUnsubscribeGet);

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/ingress/')) return;
  if (request.routeOptions.config?.skipIngressRateLimit === true) return;
  await enforceIngressRateLimit(request, reply);
});
```

**Finding 9 — the typed seam.** `fastify-raw-body` augments `FastifyContextConfig` with
only `rawBody` (`plugin.d.ts:3`) and Fastify's base interface is otherwise empty
(`context.d.ts:4`), so the property access above does **not** typecheck as-is. Add the
augmentation alongside the limiter that owns the rule:

```ts
// worker/ingress/rate-limit.ts
declare module 'fastify' {
  interface FastifyContextConfig {
    /** Opt a route out of the global /ingress/ limiter (§9.2). Statutory paths only. */
    skipIngressRateLimit?: boolean;
  }
}
```

Tests go through real `app.inject()` — a unit test of a string predicate would have passed
while production failed.

### 1.5 Raw-token logging: silence the route, generalise the scrub (findings 3, 10)

**Verified on Fastify 5.8.5** (not assumed — revision 2's claim here was wrong): with
`logLevel: 'silent'` on the route, a request to `/ingress/unsubscribe/SECRET_TOK` emits
**zero** log lines, while a sibling `/ingress/resend` still logs `"url":"/ingress/resend"`.
This holds on the throwing path too. Revision 2's "the adapter catch closes it" was false —
Fastify emits `incoming request` at `route.js:513`, before `onRequest` and before the
handler, and the pino serializer copies the URL verbatim.

> **Trap for the implementer:** `logLevel: 'silent'` also silences `request.log`. The
> adapter's own §9.5 structured line must go through `createWorkerLogger`, which is
> independent of the Fastify child logger. Do not use `request.log` in this handler.

**Finding 10 — the Sentry scrub must survive encoded spellings.** `redactSensitivePathsAndQueries`
currently applies `/(\/approve\/)[^/?#\s]+/gi` directly to the raw URL
(`sentry-scrub.ts:76`), and Fastify exposes the raw URL unchanged. Two gaps: the encoded
prefix `/ingress/%75nsubscribe/…` routes correctly but misses a literal regex, and a token
containing `%2F` would decode to a second path segment that `[^/?#\s]+` leaves partly
exposed. Revision 3 therefore:

1. Percent-decodes the path **for matching only** (`try/catch`, malformed input falls back
   to the raw path).
2. Redacts **everything after the prefix to the end of the path**, not one segment — a
   token is always terminal, so this is strictly more conservative and immune to `%2F`.
3. Returns the original path unchanged when nothing matches, so non-token URLs are not
   silently rewritten.
4. Covers `/approve/`, `/u/`, `/api/u/`, `/ingress/unsubscribe/`.

Test matrix must include the router-equivalent encoded spelling and a `%2F`-bearing token.

### 1.6 Bounded observability on an unrate-limited route (finding 8)

The route is deliberately unauthenticated and unrate-limited (§9.2), so *per-request*
observability work is an amplification vector: worker Sentry config has trace sampling but
no error sampling or dedup (`worker/sentry.ts:6`), and the intake promised a structured log
per request.

**Revision 3 splits the two sinks by cause:**

| Cause | Sentry | Log |
|---|---|---|
| Ledger write / infra failure | **Yes** — genuinely exceptional, inherently rare, already alarm-worthy | per occurrence |
| Unknown token | **No** — it is attacker- and scanner-reachable input, not an exception | aggregated: one line per 60s window carrying a count, not one per request |

An unknown token is *expected* traffic on a public endpoint; treating it as an exception is
what creates the amplification. The mint-race signal the observability plan wants is a
**rate**, which the windowed counter serves better than N individual events. The counter is
in-process, which is sound because the worker is single-replica by invariant.

### 1.7 What 503 does and does not buy (finding 1)

Stated honestly, replacing revision 2's overclaim: a 503 **preserves the possibility** of
recovering a mint race, unlike a 200 which ends the retry. It is **not** a guarantee — the
repository contains no contract proving providers retry a 503, at what cadence, or for how
long, and whether any given provider treats 503 as permanent cannot be established from
repository evidence.

It is a defence against a *broken* ordering, not a substitute for correct ordering. The
intended #630 contract already mints the token in a **pre-send transaction** and reuses it
on retries (`2026-07-28-send-mode-cross-spec-amendments.md:114`), so a conforming
implementation commits before delivery and the race should not arise at all.

No Railway health-check collision: Railway probes `/api/health` (`railway.toml:20`), a
dependency-free 200 route (`worker/index.ts:548`).

### 1.8 The §5.5 / §5.4 conflict

§5.4 wins (owner sign-off): the **button** page names the business, the **success** page
uses the generic sentence. One exported lookup, no "display" variant, no leak.

---

## 2. Tracer tickets

### T1 — The RFC 8058 one-click path, end to end

**Blocking edges:** none.
**Files:** NEW `src/lib/solicitation/unsubscribe.ts`, `worker/ingress/unsubscribe.ts` ·
MOD `worker/index.ts`, `worker/ingress/rate-limit.ts`, `src/lib/shared/sentry-scrub.ts`,
`scripts/ci/tenant-scope-allowlist.ts` · tests in `worker/ingress/__tests__/`,
`src/lib/solicitation/__tests__/`, `src/lib/shared/__tests__/`

1. **Claim-then-suppress ordering** — §1.3. The correction-path replay and the purge race
   are the two tests that matter most here.
2. **Rate-limit exemption on BOTH POST and GET**, plus the type augmentation — §1.4.
   Test via `app.inject()`: percent-encoded path, 404 sub-path, GET, HEAD, sibling ingress route.
3. **`logLevel: 'silent'`** on both routes; adapter logs via `createWorkerLogger` — §1.5.
4. **Commit-then-2xx (§9.1).** `postgres.js` awaits `COMMIT` before `sql.begin()` resolves
   (confirmed round 1).
5. **Infra failure** → adapter catches, `captureException` sanitized, returns **503**.
   **Unknown token** → 503 with **no** Sentry event, aggregated log only (§1.6).
6. **`GET` 302s** to `${NEXT_PUBLIC_APP_URL}/u/${encodeURIComponent(token)}`.
7. **No `rawBody`, no signature, no `claimInboundEvent`.**
8. **DR1.** Nothing on this path reads `SOLICITATION_SEND_ENABLED`; test explicitly.

**Live-DB conventions (CLAUDE.md #573):** `*.integration.test.ts`, no migration SQL,
`assertSchemaReady`, fixtures cleaned by `normalized_handle`. The overlapping-redemption and
purge-race tests need real concurrent transactions, not sequential calls.

### T2 — The human landing path, end to end

**Blocking edges:** T1. Unchanged from revision 2 except that unknown-token POSTs redirect
to the neutral page (never `?done=1`), and all path construction uses `encodeURIComponent`.

1. Three render states, one lookup: `?done=1` → success copy (no lookup, no write); token
   resolves → button page naming the business; otherwise → neutral page.
2. Plain `<form method="post">`; no `'use client'`, no `fetch`; works with JS disabled.
3. Cross-account fail-closed name resolution (§1.2).
4. `export const dynamic = 'force-dynamic'`; `robots: { index: false, follow: false }`;
   exactly one `<main id="main-content">`.
5. No `checkRateLimit`, no BotID registration — `BOTID_PROTECTED_ROUTES` stays at exactly 4.
6. Mailto unset → omit the line.

**Brand:** invoke `repworth-brand-design` before writing the page.

### T3 — Registry, runbook, glossary

**Blocking edges:** T1, T2. Unchanged from revision 2: dual-lane
`SOLICITATION_UNSUBSCRIBE_MAILTO` registry entry with an equal-values requirement and
staging evidence; WAF runbook exclusion note; `CONTEXT.md` glossary extension recording
redemption semantics, the §5.5/§5.4 resolution, and the honest-failure decision.

---

## 3. Risks carried into implementation

| Risk | Disposition |
|---|---|
| Missed rate-limit exclusion throttles a statutory endpoint | Closed: route-config keying on **both** routes + `app.inject()` tests. |
| Raw token in worker logs | Closed: `logLevel: 'silent'`, verified empirically on 5.8.5. |
| Raw token in Sentry | Closed: adapter-level sanitized capture + generalised scrub covering encoded spellings and `%2F` tokens. |
| Spent token undoing an audited Correction path removal | Closed: claim-first ordering (§1.3). |
| Purge race writing stale provenance | Closed: provenance comes from the claim's `RETURNING`, under the row lock. |
| Observability amplification on a public unrate-limited route | Closed: no Sentry for unknown tokens; 60s aggregated counter. |
| Provider may not retry a 503 | **Accepted and stated honestly** (§1.7). Correct #630 mint ordering is the real defence; 503 is the backstop. |
| Content-type other than JSON/urlencoded 415s | Accepted. RFC 8058 §3.1 mandates urlencoded; the app-wide parser handles it. |
| Cross-site form POST | Accepted by design (§9.2); confirmed defensible in round 1. |
| Revert leaves delivered asks advertising 404 URLs | Staging ride first; short window; ledger rows never deleted by rollback. |
