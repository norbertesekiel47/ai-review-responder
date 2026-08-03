# #644 — Unsubscribe opt-out path: RFC 8058 ingress + `/u/<token>` landing

**Branch** `feat-644-unsubscribe-opt-out` · **RISK** high · **SURFACE** mixed · **db_touching** true
**Intake contract** `.feature/intake.json` (audit copy `docs/superpowers/plans/feat-644-unsubscribe-opt-out-intake.json`)
**Spec of record** `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` §5.1–§5.5, §9.1, §9.2, §10, DR1
**Glossary** `CONTEXT.md` → "Solicitation suppression & unsubscribe"
**Depends on** #643 (migration 096/097 + `src/lib/solicitation/suppression.ts`) — merged, `4186cefa`
**Hands off to** #630 (imports `hashUnsubscribeToken`), #622 (shares `SOLICITATION_UNSUBSCRIBE_MAILTO`)

**Revision 7** — supersedes revision 6 after **owner-run `/codex:adversarial-review` #3**
(needs-attention, 4 high; report `plan-adversarial-owner-run-3.md`). The post-mortem
recommended escalating findings 2/3 to map level as a locked-decision conflict; **the owner
directed that everything be solved in this ticket**, and on re-examination the conflict
dissolves rather than needing escalation — see §1.4a. All four accepted:
**(1)** unmatched `/ingress/unsubscribe/<t>/extra` logged the raw token because
`logLevel:'silent'` only applies post-routing → global request serializer (§1.5,
**surface amendment #2**);
**(2)+(3)** the unbounded public DB path and the loss-inducing bulkhead both came from
treating every arriving string as possibly-valid → **self-authenticating tokens** (§1.4a):
forged tokens never reach the database, the bulkhead is deleted, and the loss path with it;
**(4)** a receipt could outlive the suppression it claimed → the success page now reads the
ledger **at render time** (§1.8), fixing the root cause of all three false-success vectors.

**Revision 6** — superseded. Followed **owner-run `/codex:adversarial-review` #2**
(needs-attention, 3 high + 1 medium; report `plan-adversarial-owner-run-2.md`). All four
accepted: **(1)** a spent token whose suppression was later removed by the audited
Correction path still minted a success receipt — the display side of a hole whose write side
revision 4 had closed (§1.3); **(2)** exempting the route from the limiter left its body
size and DB concurrency unbounded (§1.4b); **(3)** the promised-test titles still contradicted
the revised behaviour — the same drift class as owner-run #1, in the one field I had not
swept; **(4)** the handoff restated mutable facts that drifted a third time, now fixed
structurally by not restating them at all.

**Revision 5** — superseded. Followed the **owner-run `/codex:adversarial-review`**
(verdict: needs-attention, 3 high findings), which ran because the programmatic codex
reviewer failed four consecutive ways. All three accepted:
**(1)** the success view was renderable from a bare `?done=1`, so `/u/bogus?done=1` claimed
a successful opt-out with no suppression written — now bound to a signed receipt (§1.8);
**(2)** revision 4's per-request unknown-token log was justified by a false equivalence with
other ingress routes, which are all rate-limited while this one is deliberately not — now a
hard-bounded, replica-tagged windowed aggregate (§1.6); **(3)** the handoff and
`.feature/state.json` had drifted to a superseded revision — reconciled.

**Revision 4** — superseded. Followed adversarial round 3
(`plan-adversarial-round3.md`, VERDICT: REVISE, 5 findings). Round 3 **closed** findings 3
(raw logging, independently reproduced), 9 (types), and the GET/HEAD half of 2, and
corrected one of my own claims: retaining non-null provenance *before* a purge is
legitimate per §6.3, so revision 3's "stale provenance" framing was partly wrong. Revision 4
fixes the three defects revision 3 *introduced* — the `SELECT 1` mint-race, the `/approve/`
scrub over-redaction, and the intake contradiction — plus the raw-URL hook scoping and the
counter's false replica premise.

**Revision 3** — superseded. Followed adversarial round 2
(`docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-round2.md`, VERDICT: REVISE).
Round 2 closed findings 5/6/7 and cleared the crash-net interaction and the `suppressionId`
removal. Revision 3 addresses findings 1, 2, 3, 4 (reopened) and the new 8, 9, 10.
Owner authorised continuing past the workflow's 3-round review budget.

Surface amendments used: **2 of 2** — `sentry-scrub.ts` (round 1) and
`worker/config/fastify-options.ts` (revision 7, owner-run #3 finding 1). The second would
normally trip the workflow's abort criteria; the owner explicitly directed that all findings
be resolved within this ticket, which supersedes that stop.

---

## 1. Seam design

### 1.1 Modules touched

| Module | Verdict |
|---|---|
| `src/lib/solicitation/suppression.ts` (#643) | **Deepened, interface unchanged.** `recordSuppression` reused verbatim. |
| `src/lib/solicitation/unsubscribe.ts` (NEW) | **The one new interface.** Two real adapters. |
| `worker/index.ts` | Route registration + the hook now delegates to resolved route config. |
| `worker/ingress/rate-limit.ts` | Hosts the `FastifyContextConfig` module augmentation (finding 9). |
| `src/lib/shared/sentry-scrub.ts` | **Deepened, interface unchanged.** Path redaction generalised (findings 3, 10), and now the single rule behind BOTH sinks (Sentry + the pino request serializer). |
| `worker/config/fastify-options.ts` | **Surface amendment #2.** Gains a `logger.serializers.req` that redacts token paths before anything is written — covers unmatched 404s, which route-level config cannot reach (§1.5). |
| ingress handler / route handler / page | **Adapters, not modules.** Each calls `isWellFormedUnsubscribeToken` first (§1.4a). |

### 1.2 The new interface

```ts
// src/lib/solicitation/unsubscribe.ts

/** Invariant #5/#10. Exported for #630's minting so one function owns the digest. */
export function hashUnsubscribeToken(rawToken: string): string;

/**
 * §1.4a. Mints `<nonce>.<HMAC-SHA256(secret, nonce)>`. #630 MUST call this rather
 * than rolling its own random string — exporting the minter, not just the format,
 * is what makes the constraint unbreakable.
 */
export function mintUnsubscribeRawToken(): string;

/**
 * §1.4a admission gate. Constant-time, stateless, ZERO database work. Every entry
 * point calls this FIRST, so a forged token never reaches Postgres. This is what
 * lets both surfaces stay unrate-limited (§9.2) without an unbounded DB path.
 */
export function isWellFormedUnsubscribeToken(rawToken: string): boolean;

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
  // Spent token whose suppression was later removed via the audited Correction
  // path. Deliberately distinct from already_suppressed: it must NOT mint a
  // success receipt, and it must NOT re-suppress (§1.3).
  | { status: 'already_redeemed_not_suppressed'; tokenHashPrefix: string }
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
- **No row returned** → disambiguate by reading **`redeemed_at`**, never by a bare
  existence check:
  `SELECT redeemed_at FROM solicitation_unsubscribe_tokens WHERE token_hash = $1`.
  - Row with `redeemed_at IS NOT NULL` → the token is **spent**. That fact alone proves
    only that it was *once* redeemed — **not** that a suppression exists now. Consult the
    ledger before deciding (see below). Either way there is **no write**, so a Correction
    path removal stands.
  - Row with `redeemed_at IS NULL` → **the token was minted after our UPDATE's snapshot.**
    Report `unknown_token` (→ 503), so the provider retries and succeeds once the mint is
    visible. Reporting success here is exactly the mint-race lost opt-out this ticket
    exists to prevent.
  - No row → `unknown_token`.

**Verified 2026-08-03 against the live test database** (PostgreSQL 16, Read Committed, real
concurrent connections — not reasoning). Six cases, all pass:

| Scenario | Outcome | Why it matters |
|---|---|---|
| Mint commits **inside** the race window (between our UPDATE and the follow-up read) | `unknown_token` → 503 | The exact interleaving round 3 flagged |
| Provider retry immediately after that 503 | `redeemed` | **Proves no permanent 503** — the opt-out lands on retry |
| Mint commits before the UPDATE | `redeemed` | Ordinary path |
| Second redemption of a spent token | `already_suppressed` | Idempotent, no second row |
| Redemption after a concurrent transaction **rolled back** | `redeemed` | A rollback must not strand the token |
| Never-minted token | `unknown_token` | Genuine unknown |

> **Why a bare `SELECT 1` is wrong** (round-3 finding 1). The shared client sends a plain
> `BEGIN` with no isolation override (`src/lib/db/server.ts:40`), so this runs at **Read
> Committed** against PostgreSQL 16. Interleaving: our `UPDATE` matches nothing; the #630
> mint transaction commits; our follow-up read — taking a *fresh* snapshot — sees the new,
> **unredeemed** token and would report `already_suppressed`. `recordSuppression` never
> runs and the provider receives a success-shaped no-op with no suppression in existence.
> Branching on `redeemed_at` converts that interleaving into a retryable 503.

`recordSuppression` is never reached on the already-spent path. That is the whole point.

**A spent token is not proof of a live suppression** (owner-run review round 2, finding 1).
Revision 5 labelled `redeemed_at IS NOT NULL` as `already_suppressed` and minted a success
receipt for it. But the audited **Correction path** (§8.2) can remove that suppression
afterwards — at which point replaying the spent link would display "You're unsubscribed"
while **no suppression exists**. That is the same false-success class §1.8 was written to
eliminate; revision 4 closed the *write* side of this hole and left the *display* side open.

The spent branch therefore performs an explicit **current-ledger existence check** on the
token's own `normalized_handle` + `channel`, scoped to `scope='global'`:

| Claim | Ledger now | Outcome | Receipt? |
|---|---|---|---|
| won | — (we just wrote it) | `redeemed` | **yes** |
| lost, token spent | global row **exists** | `already_suppressed` | **yes** — truthful |
| lost, token spent | **no** global row (correction removed it) | `already_redeemed_not_suppressed` | **no** → neutral page |
| lost, token unspent | — | `unknown_token` (post-snapshot mint) | no |
| no token row | — | `unknown_token` | no |

The correction case deliberately does **not** re-suppress — that would silently undo the
audited removal, which is exactly what round-3 finding 4 forbade. The recipient lands on the
neutral page, which carries the working `mailto:` (§5.4), so it does not dead-end.

> **Why this is not `suppressionMatchSql`.** That fragment (#643, CLAUDE.md G7) answers the
> *send-time gate* question — "may we contact this handle **for this account**?" — and
> matches `global` OR that account's `account`-scoped row. Here the question is different:
> "does the **recipient's own global opt-out** still stand?", because that is precisely what
> the §5.5 success sentence asserts ("or from any other business that uses RepWorth"). An
> `account`-scoped row would satisfy `suppressionMatchSql` while making that sentence false.
> Distinct question, distinct query — and it lives in `unsubscribe.ts` because
> `suppression.ts` is outside this ticket's edit surface. Needs a `pre-auth-token`
> tenant-scope allowlist entry.

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
  // §1.4b: RFC 8058 bodies are ~30 bytes; the app-wide default is 5 MB.
  bodyLimit: 1024,
} as const;

app.post('/ingress/unsubscribe/:token', UNSUBSCRIBE_ROUTE_OPTS, handleUnsubscribePost);
app.get('/ingress/unsubscribe/:token',  UNSUBSCRIBE_ROUTE_OPTS, handleUnsubscribeGet);

app.addHook('onRequest', async (request, reply) => {
  // Scope: a request is "ingress" if EITHER the resolved route is (encoding-proof for
  // matched routes) OR the decoded raw path looks like it (so 404s under /ingress/ stay
  // throttled). Both arms are needed — see the two notes below.
  const isIngress =
    request.routeOptions.url?.startsWith('/ingress/') === true ||
    decodeIngressPath(request.url).startsWith('/ingress/');
  if (!isIngress) return;

  // Exemption: keyed STRICTLY on resolved route config, so an unmatched path can never
  // inherit it.
  if (request.routeOptions.config?.skipIngressRateLimit === true) return;

  await enforceIngressRateLimit(request, reply);
});
```

**Round-3 finding 2 — the scoping test had the same disease as the exemption.** Revision 3
still gated enforcement on raw `request.url.startsWith('/ingress/')`. Reproduced on 5.8.5:
`/%69ngress/resend` **resolves to** `/ingress/resend` but fails that raw check, so it
escapes the limiter entirely. Revision 4 derives *both* the scope and the exemption from
`request.routeOptions.url`, the decoded route pattern.

> This is a **pre-existing bypass affecting every `/ingress/` route**, not one this ticket
> introduces — but the intake promises a test asserting the limiter still fires for every
> other ingress path, and that promise is false today. Fixing it here is in-surface
> (`worker/index.ts`) and closes the gap for Stripe/Resend/Telegram/Twilio/Zernio at the
> same time.
>
> **Owner decision 2026-08-03: keep the fix in this branch** rather than splitting it out.
> Rationale accepted: it closes a live production hole now instead of whenever a separate
> ticket is scheduled, and the two promised tests that assert it are already in the intake.
> Reviewers should read the `worker/index.ts` hook change as deliberate in-scope work, not
> as drift outside the ticket.

**Why both arms are required.** Unmatched paths yield `routeOptions.url === undefined`, so
a resolved-route-only test would drop every 404 out of the hook — reopening precisely the
unthrottled flood namespace round 2 flagged. The decoded-raw arm keeps
`/ingress/unsubscribe/x/extra` and `/%69ngress/bogus` throttled. Conversely a raw-only test
misses `/%69ngress/resend`. Neither arm alone is correct.

`decodeIngressPath` is a local total helper: strip query/fragment, `decodeURIComponent` in
a `try/catch`, fall back to the raw path on malformed input.

**Test matrix (via `app.inject()`):** matched unsubscribe POST/GET/HEAD exempt ·
`/ingress/%75nsubscribe/<t>` exempt · `/ingress/resend` limited · `/%69ngress/resend`
limited · `/ingress/unsubscribe/x/extra` (404) limited · `/%69ngress/bogus` (404) limited ·
non-ingress route untouched.

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

### 1.4a The token is self-authenticating — forged tokens never reach the database

**This is the structural answer to owner-run #3 findings 2 and 3**, which the post-mortem
called a locked-decision conflict. It is not: the conflict dissolves once the right question
is asked.

§9.2 forbids rate limiting because **a legitimate opt-out must never be refused**. It does
not require us to *serve* forged tokens. Revisions 1–6 treated every arriving string as
possibly-valid and therefore worth a database round trip — which is what made an
unauthenticated public DB path unbounded, which is what forced a bulkhead, which
re-introduced the loss §9.2 exists to prevent. Break the first link and the whole chain goes.

**The raw token becomes `<nonce>.<HMAC-SHA256(secret, nonce)>`**, base64url, keyed on
`getSessionCookieSecret()` — verified available on **both** surfaces (Vercel:
`approval/cookies.ts`, `zernio/connect-session-cookie.ts`; worker:
`account-offboarding/tokens.ts`).

```ts
/** Minted by #630. Exported HERE so the format has exactly one owner. */
export function mintUnsubscribeRawToken(): string;

/** Constant-time, stateless, ZERO database work. The admission gate. */
export function isWellFormedUnsubscribeToken(rawToken: string): boolean;
```

Every entry point — Railway ingress, `GET /u/<token>`, `POST /api/u/<token>` — calls
`isWellFormedUnsubscribeToken` **first**. A failure short-circuits to the neutral page (or
503 at the ingress) having touched nothing.

What this buys:

| Concern | Before | After |
|---|---|---|
| Anonymous random-token flood → DB (finding 2) | Unbounded, fans out across serverless instances | **Never reaches the DB.** One HMAC compare, no connection, no Supavisor budget |
| Bulkhead sheds a valid opt-out (finding 3) | Real loss path, admitted by §1.7 | **Bulkhead deleted.** Nothing to shed, so nothing to lose |
| Vercel has no in-process bound | Fatal — each instance has its own | **Irrelevant** — the gate is stateless, so it works identically on every instance |
| §5.4 enumeration | DB read distinguishes nothing | Strengthened: a forged token is rejected without a lookup |

Compatible with the spec's rejection of "a self-describing signed token" (§5.2): that was
rejected for putting the **recipient's address** in a URL. This encodes **no PII** — just a
random nonce and a MAC over it.

**Residual, stated honestly:** someone holding a token we genuinely sent can still replay it
and induce one indexed lookup per request. That population is exactly the one §9.2 exists to
serve, the work is a single unique-index probe already bounded by `statement_timeout`, and
it is no worse than any other public page. No admission control, so no loss path.

**Constraint hand-off to #630:** minting **must** call `mintUnsubscribeRawToken()` rather
than generating its own random string, or every unsubscribe link fails the gate. Exporting
the minter (not just a format description) is what makes that impossible to get wrong. No
live tokens exist yet — `SOLICITATION_SEND_ENABLED` is off everywhere — so there is no
back-compatibility window.

### 1.4b Exempt from the limiter is not exempt from bounds (owner-run round 2, finding 2)

Removing the rate limiter removed the only thing bounding this route's *workload*. Each
request buffers a body against the app-wide **5 MB** limit
(`worker/config/fastify-options.ts:21`), is parsed by the app-wide urlencoded parser
(`content-type-parsers.ts:18`), and opens a transaction containing an `UPDATE`, a follow-up
`SELECT`, and now a ledger check. Hostile traffic can therefore exhaust buffers and saturate
the **shared** worker/DB pool, delaying other webhooks *and* legitimate opt-outs — a
self-defeating outcome for the one route that must never drop one.

§9.2 forbids **rate limiting**, because a throttled unsubscribe is a silently-lost statutory
opt-out. It does not forbid — and `production.md` positively requires — bounding the work a
public endpoint can induce. The two are different: a rate limiter *drops* a request on a
per-caller quota; a bulkhead *defers* it with a retryable status.

1. **Per-route body limit — 1 KB.** RFC 8058 §3.1's body is `List-Unsubscribe=One-Click`,
   about 30 bytes. Fastify's per-route `bodyLimit` yields 413 above it. Nothing legitimate
   approaches this.
2. ~~**Bounded concurrency bulkhead.**~~ **WITHDRAWN in revision 7** (owner-run #3,
   finding 3). Revision 6 claimed it "defers, never loses" while §1.7 simultaneously
   conceded there is **no evidence providers retry a 503** — the plan contradicted itself,
   and the honest reading is that the bulkhead was an intentional silent-loss path for a
   statutory opt-out. It is deleted rather than justified. §1.4a removes the pressure that
   motivated it: forged traffic never reaches the database, so there is nothing to shed.

**The no-loss claim is withdrawn wherever it rested on provider retry.** The only place a
503 is still returned for a *well-formed* token is `unknown_token` (§1.7), and that case is
explicitly documented as "enables recovery, does not guarantee it".

Tests: an oversized body is rejected without reaching the handler; a forged token induces
**no database connection at all**; and no path applies a per-recipient rate limit (§9.2
stays intact).

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

**`logLevel: 'silent'` is NOT sufficient on its own** (owner-run #3, finding 1). It applies
only **after the exact route resolves** — and revision 4 deliberately requires
`/ingress/unsubscribe/<token>/extra` to stay a rate-limited **404**, which resolves to *no*
route and therefore carries no silent config. Fastify logs the raw URL before `onRequest`,
so a valid token plus a trailing segment lands in logs: **invariant #5 violated by a rule I
added myself.**

Round 2's reviewer offered two fixes — silence the route **or** install a token-redacting
request serializer — and I took the cheaper one, which only ever covered matched routes.
Revision 7 does **both**:

```ts
// worker/config/fastify-options.ts  — SURFACE AMENDMENT #2
logger: {
  serializers: {
    req: (request) => ({
      method: request.method,
      url: redactSensitivePathsAndQueries(request.url),  // §1.5's shared rule
      host: request.host,
      remoteAddress: request.ip,
    }),
  },
}
```

One redaction rule, two sinks (pino + Sentry), covering matched routes, unmatched 404s,
trailing segments, malformed input, and percent-encoded spellings alike. The route-level
`logLevel: 'silent'` stays as defence in depth. **Test with request logging explicitly
enabled** — the prod default of `warn` hides this class, which is what let it survive three
reviews.

**Finding 10 — the Sentry scrub must survive encoded spellings.** `redactSensitivePathsAndQueries`
currently applies `/(\/approve\/)[^/?#\s]+/gi` directly to the raw URL
(`sentry-scrub.ts:76`), and Fastify exposes the raw URL unchanged. Two gaps: the encoded
prefix `/ingress/%75nsubscribe/…` routes correctly but misses a literal regex, and a token
containing `%2F` would decode to a second path segment that `[^/?#\s]+` leaves partly
exposed. Revision 3 therefore:

1. **Leaves the existing `/approve/` rule completely alone.** Revision 3 proposed applying
   tail redaction to it as well; round-3 finding 3 showed that breaks two shipped
   contracts — `/api/approve/<token>/edit` must keep `/edit`
   (`sentry-scrub.test.ts:175`) and the console-message form `GET /approve/tok 200` must
   keep the status (`sentry-scrub.test.ts:201`). `/approve/` stays segment-bounded,
   byte-for-byte as today.
2. Adds a **second, separate rule** for the three new prefixes only —
   `/u/`, `/api/u/`, `/ingress/unsubscribe/` — which redacts across `/` (so a `%2F`-bearing
   token cannot half-escape) but still **stops at `?`, `#`, or whitespace**, preserving the
   console-message contract.
3. Handles encoded spellings **without corrupting output offsets**. "Decode for matching,
   redact the raw string" is *wrong* — the offsets do not correspond. The exact order,
   verified below, is:
   1. apply the `/approve/` rule to the **raw** string;
   2. if the new-prefix rule matches that result, redact it and return — raw spelling
      preserved;
   3. otherwise percent-decode (`try/catch`) and retest; if **that** matches, redact and
      return the **decoded** form. Returning the decoded form is safe precisely because the
      token is being replaced with `[REDACTED]` in the same step;
   4. otherwise return the result of step 1 unchanged.
4. Returns the input unchanged when nothing matches.

**Verified 2026-08-03** with a standalone prototype over 12 cases — all four shipped
`/approve/` contracts (`/approve/<t>`, `/api/approve/<t>/edit`, `GET /approve/tok 200`,
`/approve/tok#section`) preserved byte-for-byte, plus the encoded spelling, a `%2F` token,
console-message form for the new paths, and `/users/123` correctly NOT matching `/u/`.

**Test matrix must pin the regressions, not just the new paths:** the two existing
`/approve/` contracts above, plus the encoded route spelling, a `%2F`-bearing token, and
`/users/123` (which must NOT match the `/u/` prefix).

### 1.6 Bounded observability on an unrate-limited route (finding 8)

The route is deliberately unauthenticated and unrate-limited (§9.2), so *per-request*
observability work is an amplification vector: worker Sentry config has trace sampling but
no error sampling or dedup (`worker/sentry.ts:6`), and the intake promised a structured log
per request.

**Revision 3 splits the two sinks by cause:**

| Cause | Sentry | Log |
|---|---|---|
| Ledger write / infra failure | **Yes** — genuinely exceptional, inherently rare, already alarm-worthy | one line per occurrence |
| Unknown token | **No** — attacker- and scanner-reachable input, not an exception | one line per occurrence, `warn`, `token_hash` prefix only |

An unknown token is *expected* traffic on a public endpoint; treating it as an **exception**
is what creates the amplification, because Sentry is the quota-bounded sink with no error
sampling or dedup configured (`worker/sentry.ts:6`). Abstaining there is the whole fix.

**Unknown tokens emit NO per-request log line either** (owner-run review, finding 2).
Revision 4 kept one `warn` per unknown request and justified it as "bounded by request
volume, like every other ingress route". **That comparison was false**: every other ingress
route sits behind the global limiter, and this one is deliberately exempt by §9.2. Under a
scanner sweep, hostile traffic, or a provider retry storm there is *no* bound — and the
flood would drown the very mint-race signal the line exists to surface.

Revision 4 over-corrected in the other direction too: round 3's finding was that the
counter's *single-replica premise* was false, **not** that aggregation was wrong. Revision 5
keeps the aggregate and fixes the premise:

```
window = 60s, per process
on unknown token: count++
on window expiry OR graceful shutdown:
  logger.warn({ event: 'unsubscribe_unknown_token_window',
                count, window_start, window_end, replica_id })
  reset
```

- **Hard bound: at most one line per 60s per process**, regardless of traffic volume. That
  is a real bound, not an appeal to traffic shape.
- **Summable across replicas** — every line carries `replica_id` from
  `worker/config/replica-identity.ts`, so a cross-deployment overlap during a
  zero-downtime deploy produces two tagged series that add up, rather than one series that
  silently under-reports. This is the round-3 premise defect, fixed rather than dodged.
- **Restart semantics, stated:** a partial window is flushed by the existing graceful
  shutdown sequence in `worker/index.ts`. An ungraceful crash loses at most one partial
  window (≤60s of counts) — acceptable for a rate signal, and explicitly not a
  correctness input to anything.
- Per-request lines are retained for `redeemed`, `already_suppressed`, and `failed`, which
  are bounded by real minted tokens and by genuine infra failure rates.

**Test required:** hostile unknown-token traffic (many requests inside one window) must
produce **at most one** warning, and the emitted count must equal the number of requests.

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

### 1.8 The success view is bound to a signed receipt, not a bare flag

**Owner-run adversarial review, finding 1.** Revisions 1–4 rendered the success copy from
`?done=1` alone, explicitly without consulting redemption state. So `/u/bogus?done=1`
tells a visitor "You're unsubscribed" when **no token resolved and no suppression was
written** — it bypasses §5.4's neutral-page rule entirely and can leave someone believing
they opted out when they did not. On a CAN-SPAM path that is the failure this whole ticket
exists to prevent. (I raised this during grilling and judged it "bounded — nobody does
that". That was wrong: the cost of being wrong is a recipient who stops watching for mail
that keeps coming.)

**Revision 5 binds the success view to server-minted evidence**, keeping the no-JS
progressive-enhancement flow intact:

```ts
// src/lib/solicitation/unsubscribe.ts — HMAC precedent: account-offboarding/tokens.ts
export function mintUnsubscribeReceipt(tokenHash: string, issuedAtMs: number): string;
export function verifyUnsubscribeReceipt(tokenHash: string, receipt: string): boolean;
```

- Receipt = `<issuedAtMs>.<base64url HMAC-SHA256(secret, "repworth:unsubscribe-receipt:v1:<tokenHash>:<issuedAtMs>")>`,
  keyed on `getSessionCookieSecret()` — the same trust boundary
  `src/lib/account-offboarding/tokens.ts` already uses for its keep-my-data token.
- `POST /api/u/<token>` mints one **only** for `redeemed` and `already_suppressed` — both
  of which are backed by a suppression row that exists *right now* (§1.3: the second is
  ledger-verified, not inferred from `redeemed_at`). For `unknown_token` **and
  `already_redeemed_not_suppressed`** it mints nothing and redirects to `/u/<enc(token)>`
  bare, landing on the neutral page. **A receipt is never issued without a live
  suppression** — that is the invariant, not "a receipt follows a POST".
- The page renders success **only** when `ok` verifies against
  `hashUnsubscribeToken(token)` via `timingSafeEqual` **and** is within a 10-minute TTL.
  Otherwise it falls through to ordinary token evaluation — so a crafted or expired `ok`,
  or a bare `?done=1`, gets the button page or the neutral page, never a false success.
- No cookie, so a cookie-blocking browser still sees success after a real opt-out; no JS,
  so the flow still works with scripting disabled.

The receipt is not an authorisation token — it authorises nothing and grants no access.

**A receipt is necessary but NOT sufficient** (owner-run #3, finding 4 — the *third*
false-success vector). Verification proves only that a suppression existed **when the
receipt was minted**; the audited Correction path can remove it during the 10-minute TTL, or
race the spent-token check. Revision 6 stated the invariant "a receipt is never issued
without a live suppression" but bound it to the **minting** moment, which is exactly why
this vector survived it.

> **The corrected invariant, bound to the rendering moment:**
> *A page may claim "you are unsubscribed" only from a ledger read taken during that render.*
> The receipt gates **whether we are permitted to show** the success state (§5.4 enumeration
> resistance). The live ledger read establishes **whether the claim is true**. Both are
> required; neither substitutes for the other.

So `GET /u/<token>?ok=<receipt>` renders success only when the receipt verifies **and** a
`scope='global'` row for the token's handle exists *at render time*. If the receipt verifies
but the row is gone, render the neutral state — the correction happened, and the honest
answer is that they are not currently suppressed. Tests must cover a correction landing
between POST and GET, and a correction racing a replay.

This is the root-cause fix for a class that produced three vectors (`?done=1`, spent-token
replay, stale receipt): all three asserted a fact about **mutable** ledger state from
evidence **decoupled in time** from that state. No carried proof can ever be sufficient,
because §8.2 makes the ledger mutable by design.

### 1.9 The §5.5 / §5.4 conflict

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

**Blocking edges:** T1. Unknown-token POSTs redirect to the bare neutral-page URL with no
receipt minted; the success view is bound to a signed receipt (§1.8); all path construction
uses `encodeURIComponent`.

1. Three render states: a **verified** `?ok=<receipt>` → success copy (no write, no lookup
   beyond hashing the token); token resolves → button page naming the business; otherwise →
   neutral page. An absent, malformed, forged, or expired receipt falls through to the
   latter two — **never** to success.
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
