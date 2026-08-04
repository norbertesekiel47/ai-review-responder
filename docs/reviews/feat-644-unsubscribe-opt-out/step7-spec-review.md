# #644 — step 7 spec & correctness review

**Scope.** Full branch diff vs `origin/main` merge-base (47 files, +11221/−21), checked field
by field against `.feature/intake.json`. Read-only; no source file modified.

**Verdict: ships, with eight findings — none blocking.** The diff implements every
`user_visible_behavior` item, holds every listed invariant, and covers every `edge_cases`
entry with both a code path and a test. All 70 `tests_to_add` titles are present verbatim.
Four of them assert something narrower than they promise, and one of those (F3) leaves a real
production constant unguarded. The gaps found are at the **seams between slices**, which is
where they were expected to be.

Evidence gathered locally (all green on this worktree):

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm ci:static-policy` | pass (1052 files) — invariant #13, #10 |
| `pnpm ci:db-imports` | pass (strict) — invariant #15 |
| `pnpm ci:tenant-scope` | pass — entries 416 / baseline 416 (5 new `pre-auth-token` entries, baseline bumped in-PR) |
| `pnpm ci:live-db-suites` | pass |
| `pnpm ci:rls-audit` | pass (static) |
| `pnpm test src/lib/solicitation/__tests__/unsubscribe.integration.test.ts` | 20/20 (live DB, not skipped) |
| the other 9 new suites | 157/157 |

---

## Findings

### F1 — [medium] the ingress re-derives redemption success instead of asking the shared owner

`worker/ingress/unsubscribe.ts:135`

```ts
if (redemption.status === 'unknown_token') { replyUnknownToken(reply, 'ledger'); return; }
reply.status(200).send({ received: true });
```

`src/lib/solicitation/unsubscribe.ts:229-239` documents the opposite as a contract:

> *Both callers (the RFC 8058 ingress and the Vercel POST) **MUST** use it rather than testing
> statuses themselves: `status !== 'unknown_token'` reads as a reasonable success test and is
> wrong for exactly one outcome, which is the one that matters.*

`src/app/api/u/[token]/route.ts:50` honours it; the ingress does not. So the two surfaces
answer the **same token** differently once the audited Correction path (§8.2, #645) has
removed a suppression:

| Surface | outcome | answer |
|---|---|---|
| `POST /api/u/<token>` | `already_redeemed_not_suppressed` | 303 → bare neutral page, no receipt (correct) |
| `POST /ingress/unsubscribe/<token>` | `already_redeemed_not_suppressed` | **`200 {received:true}`** — the mail client renders "unsubscribed" with no global row in existence |

That 200 is the false-success class the ticket's own glossary entry ("A spent token is not
proof of a live suppression", `CONTEXT.md:93`) exists to eliminate, reached through the one
caller that did not use the helper written to prevent it.

Two aggravating facts: **no test exercises `already_redeemed_not_suppressed` through the
adapter** (`rg already_redeemed_not_suppressed worker/` returns nothing outside comments), and
the single-flight comment at `unsubscribe.ts:378` *encodes* the re-derivation as a soundness
premise ("all three non-`unknown_token` outcomes map to 200"), so the divergence is now load-
bearing for a second mechanism.

**Note on what is and is not wrong.** Plan §1.7 / T1 step 5 only specify `unknown_token` → 503
and infra → 503, so 200 here is plan-consistent, and 503 would make the provider retry a token
that will never resolve differently. The defect is that the module's stated MUST is false of
the shipped code — a future maintainer reading `redemptionConfirmsSuppression` will believe the
ingress cannot render a false success. Either call the helper and decide the ingress's answer
explicitly, or amend the comment to say the ingress deliberately maps all three to 200 and why.

### F2 — [medium] the new pino censor narrows diagnostics for all five other ingress providers

`worker/config/fastify-options.ts:60-61`

```ts
paths: ['msg', 'err.message', 'err.stack', 'err.aggregateErrors[*].message', 'err.aggregateErrors[*].stack'],
censor: (v) => typeof v === 'string' ? redactSensitivePathsAndQueries(v) : v,
```

`redactSensitivePathsAndQueries` documents its own input assumption at
`src/lib/shared/sentry-scrub.ts:83-85` ("The input is assumed URL-SHAPED … do not rely on this
function to leave prose intact"). The censor feeds it **free prose from every provider**
(Stripe, Resend, Telegram, Twilio, Zernio) — and `fastify-options.ts:66-69` asserts the exact
opposite:

> *this is a redaction change and must not narrow ingress diagnostics for the other providers
> (Stripe, Resend, Twilio, Telegram, Zernio).*

Reproduced against the shipped function:

| Input | Output |
|---|---|
| `Zernio ingest failed? code=REVIEW_CREATED batch=7` | `Zernio ingest failed? code=[REDACTED]` — **`batch=7` gone** |
| `Could not decode payload? decoded=null raw=abc` | `…? decoded=[REDACTED]` — matched via the `code` substring inside `decoded` |
| `Error: bad?\n at a (/app/x.ts:1:1)\n at eval (…) key=1\n at z (/app/z.ts:3:3)` | the `at z` frame is replaced by `[REDACTED]` |
| `…Are you passing the raw request body you received from Stripe?` | trailing `?` dropped |

Mechanism: `redactSensitivePathsAndQueries` splits on the **first** `?` and treats everything
after it as a query string; `SENSITIVE_QUERY_KEY_RE` matches substrings, so `decoded`,
`encoded`, `keyword`, `passcode`, `signature` all trip it. Applied to `err.stack`, a `?` in the
*message* makes the whole stack "query", and one later `…key=…` deletes every frame after it.

Nothing tests this. `worker/config/__tests__/fastify-options.test.ts:119-163` asserts serializer
field parity and one unredacted URL; no assertion pins that a Stripe/Zernio `msg` or
`err.message` survives intact. The stated contract at `:66-69` is therefore both false and
unguarded — the exact "enumerated redaction is only as good as its list" lesson D7 records,
one level up.

Intended behaviour is preserved (`…?location_id=abc&api_key=SECRET` → `api_key=[REDACTED]`,
`location_id` kept), and the direction of error is loss of detail, never leakage. Cheapest fix
is a regression test asserting a representative provider error message round-trips unchanged;
the sharper fix is to apply the token-path rules alone to prose and reserve the query split for
values that are actually URLs.

### F3 — [medium] `source: 'unsubscribe_link'` is asserted by no test anywhere in the repo

`src/app/api/u/[token]/route.ts:45`

`rg -n "unsubscribe_link" src/app worker` returns **one** hit: the production call site itself.
The intake promises the title *"redeeming through the landing page writes source
unsubscribe_link"*, and that title exists — at
`src/lib/solicitation/__tests__/unsubscribe.integration.test.ts:366` — but it calls the
redemption core directly and **passes the source in by hand** (`redeem(raw, 'unsubscribe_link')`,
helper at `:141-146`). The route is never involved. The only test that does drive the real route
mocks the redemption with a fake whose signature drops the field entirely:

```ts
// src/app/__tests__/unsubscribe-landing.test.tsx:87
async redeemUnsubscribeToken(_tx: unknown, input: { rawToken: string }): …
```

**Failure scenario:** change `route.ts:45` to `source: 'unsubscribe_one_click'`. Every ledger
row written by a human clicking the landing-page button is permanently mis-attributed to the RFC
8058 machine path, and **zero tests fail**. That is the exact split
`intake.observability[2]` exists to measure ("whose `source` property splits
`unsubscribe_one_click` (RFC 8058, unattended) from `unsubscribe_link` (human click) so the two
channels are measurable separately"), and §3.1 provenance is not retroactively repairable.

The mirror-image assertion already exists on the worker side —
`worker/ingress/__tests__/unsubscribe.test.ts:318` pins
`expect(call[1]).toEqual({ rawToken: validToken, source: 'unsubscribe_one_click' })`. One line
in the landing-page fake (accept and record `input.source`) closes it.

### F4 — [medium] the §9.2 structural guard checks one of the three route modules

`worker/ingress/__tests__/unsubscribe-rate-limit.test.ts:230` — *"the unsubscribe **route
modules** never import checkRateLimit"*

The body reads exactly one file:

```ts
const source = readFileSync(path.join(REPO_ROOT, 'worker/ingress/unsubscribe.ts'), 'utf8');
```

The plural is false. `src/app/api/u/[token]/route.ts` and `src/app/(public)/u/[token]/page.tsx`
are the two surfaces the intake's §9.2 invariant covers alongside the ingress, and neither is
inspected.

**Failure scenario:** add `await checkRateLimit(...)` to the Vercel POST — a statutory opt-out
is now throttled in violation of §9.2, exactly the "just add a limiter here" change the test's
own comment says it exists to stop, and it stays green. Vercel is also the *more* likely place
for it: `/api/*` is where every other mutating route in the app is limited, and the WAF runbook
records that rule 1a already matches this path. Extend the guard to the three files.

### F5 — [low] the §9.5 log line emits an outcome the intake's observability contract does not list

`worker/ingress/unsubscribe.ts:151-160`

`logRedemption` runs for every non-`unknown_token` outcome, so it emits
`outcome: 'already_redeemed_not_suppressed'`. `intake.observability[0]` enumerates the
vocabulary as *"outcomes redeemed | already_suppressed | failed"*. Benign superset — a
dashboard filtered on the documented three silently drops the one outcome that indicates a
correction/replay collision. Fix is one word in the intake or one branch in the adapter.

### F6 — [low] a success-page test asserts receipt↔token binding, not the ordering its title names

`src/app/__tests__/unsubscribe-landing.test.tsx:378` — *"the success copy renders only for a
receipt minted after a committed write"*

The body (`:381-395`) renders with `otherReceipt` — a **genuine, in-TTL** receipt bound to a
*different* token hash — and asserts no success copy. That proves the receipt is bound to its
token, which is valuable and covered nowhere else. It does not construct a receipt that exists
without a committed write, and could not: the route makes that unconstructable. The
commit-before-mint property is genuinely asserted at `:187`
(`expect(ledger.events()).toEqual(['redeem','commit','mint'])`). Net effect: a reader auditing
coverage counts ordering as tested twice when it is tested once. Rename to name the binding.

### F7 — [low] a rate-limit test's title claims coverage the harness cannot provide

`worker/ingress/__tests__/unsubscribe-rate-limit.test.ts:112` — *"still enforces the ingress
rate limit on every other ingress path"*

The harness (`worker/ingress/__tests__/helpers/unsubscribe-app.ts:66`) registers exactly one
sibling, a stub `POST /ingress/resend`. None of the five real provider routes exists in the
test app, so "every other ingress path" is asserted over a single stub. This matters more than
usual here: `registerIngressRateLimitHook` replaced the hook for **all** providers, and D11
records that the previous version was bypassable on every one of them.

I verified independently that the replacement is a strict superset of the old predicate — the
raw arm can only lose a case by truncating at `?`/`#` (impossible inside a 9-char literal
prefix the string already starts with) or by percent-decoding (which cannot remove the
`%`-free literal `/ingress/`), and it *adds* `/%69ngress/resend` and absolute-form targets. So
there is no live regression; the title simply over-claims relative to its assertion. Registering
the five real paths in the harness would close it.

### F8 — [low] an invariant-#5 rationale comment states a reachability condition that is false

`src/lib/solicitation/unsubscribe.ts:340-344`

> *this branch is reachable **precisely** when the gate rejected the input for exceeding
> `MAX_SIGNED_INPUT_LENGTH`, so digesting it here would restore the unbounded work that bound
> exists to prevent.*

The branch is reached for **every** gate rejection — wrong shape, wrong MAC, wrong length. The
suite proves it: `src/lib/solicitation/__tests__/unsubscribe.test.ts:92` ("a forged token is
rejected without opening a database connection") drives it with a well-formed 66-char
MAC-forged token. The behaviour is correct and the invariant holds; the comment is the defect.
Because it reads as a *narrow* justification, the obvious next edit is "this is only the
over-length case, so we can safely hash here for correlation" — which would reintroduce
unbounded hashing on an unauthenticated, unrate-limited route. Reword to "reachable for any gate
rejection; no digest is taken because a token that was never minted has no prior attempt to
correlate with, and the input is not length-bounded on this path."

---

## Field-by-field verification

### `user_visible_behavior` — 10/10 implemented, nothing unrequested

| # | Item | Where | Verdict |
|---|---|---|---|
| 1 | ingress POST writes global row `unsubscribe_one_click`, 200 only after commit | `worker/ingress/unsubscribe.ts:100-146`; `src/lib/solicitation/unsubscribe.ts:334-397` | ✅ order asserted (`unsubscribe.test.ts:104-127`: `['redeem','commit','reply']`) |
| 2 | ingress GET 302 → `${NEXT_PUBLIC_APP_URL}/u/<token>` | `unsubscribe.ts:165-193` | ✅ |
| 3 | `/u/<token>` no-login/no-fee/no-form-fields, one button, names the business, writes nothing | `src/app/(public)/u/[token]/page.tsx:129-155` | ✅ form has a submit control and zero inputs |
| 4 | button POST writes `unsubscribe_link`, 303 → `?ok=<receipt>`, receipt minted after commit | `src/app/api/u/[token]/route.ts:41-56` | ✅ mint is textually after `await sql.begin` |
| 5 | success only on verified, in-TTL receipt; `?done=1`/forged/expired never render success | `page.tsx:88-105` | ✅ |
| 6 | unknown/malformed/redeemed → one identical neutral page with mailto | `page.tsx:157-186`; `findRedeemableUnsubscribeToken` collapses all three to `null` | ✅ structural, not remembered — `NeutralView` takes no token-derived input |
| 7 | unknown at ingress → 503, no Sentry, no per-request line; unknown at `/api/u` → 303 bare | `unsubscribe.ts:216-222`; `route.ts:46` | ✅ |
| 8 | everything live with `SOLICITATION_SEND_ENABLED` off (DR1) | — | ✅ asserted structurally (`unsubscribe.test.ts` greps the module source for the flag name) |
| 9 | every entry point HMACs before any DB work | `unsubscribe.ts:79-88` called first in all four entry points | ✅ |
| 10 | §1.8 render-time ledger read | `page.tsx:98-102` | ✅ — see the seam analysis below |

No behaviour in the diff is outside this list. The three additions that are not in
`user_visible_behavior` — `SESSION_COOKIE_SECRET_PREVIOUS` rollover, the D4 boot gate, the
per-token single-flight — are each recorded as an accepted deviation (D12/adversarial finding 2,
D4, D12/finding 1) with owner sign-off, and none is recipient-visible.

### `invariants` — all held

- **#5 (raw token never persisted or logged).** Persistence: only `token_hash` is bound
  (`unsubscribe.ts:275,364,404`); the single-flight map is keyed on the hash
  (`worker/ingress/unsubscribe.ts:432`), explicitly so `.keys()` in a heap dump is safe.
  Logging: the only loggable form is a 12-char hash prefix; `sanitizeErrorInPlace`
  (`:274-289`) does two passes (shared URL rule + literal containment) before either sink; the
  route carries `logLevel:'silent'` and the unmatched-404 case is covered by the global
  serializer + `redact`. The `unknown_token` early return deliberately emits `tokenHashPrefix:
  ''` for over-length input so a megabyte of junk is not hashed. ✅
- **#10 `node:crypto`.** `createHash/createHmac/randomBytes/timingSafeEqual` only;
  `ci:static-policy` green. ✅
- **#1 (Vercel = UI only).** The Next route does one Postgres write, no LLM/external/long-running
  work; ESLint boundary test green. ✅
- **#6 (third-party ingress on Railway).** The RFC 8058 provider POST terminates in
  `worker/ingress/`; the Vercel POST is our own button, not third-party ingress. ✅
- **#13 (no `NEXT_PUBLIC_*` companion).** `SOLICITATION_UNSUBSCRIBE_MAILTO` and
  `SESSION_COOKIE_SECRET_PREVIOUS` are server-lane only; `ci:static-policy` allowlist unchanged. ✅
- **#15 (explicit DB client).** `src/lib/solicitation/unsubscribe.ts` takes `Sql`/`TransactionSql`
  and never imports `@/lib/db/server`; the three composition roots (page, route, ingress) import
  the singleton. `ci:db-imports` strict-green. ✅
- **§9.1 (2xx only after commit).** Ingress: `postgres.js` resolves `begin` after `COMMIT`, and
  the reply is issued outside the transaction; ordering asserted, not assumed. Failure → 503 +
  `captureException`, never swallowed. Vercel: an unhandled throw yields a 500 and
  `onRequestError = Sentry.captureRequestError` (`src/instrumentation.ts:9`) reports it; the
  receipt is minted only after `begin` resolves. ✅
- **§9.2 (neither path rate-limited/BotID/WAF).** `skipIngressRateLimit` on both worker routes;
  `/api/u` is absent from `src/lib/security/botid-routes.ts`; no `src/middleware.ts` exists; the
  Vercel WAF rule that *would* match is LOG-only and the runbook now carries a 🛑 BLOCKER
  checklist item before any flip to enforce. The 1 KB body limit and the single-flight defer or
  bound; neither drops. ✅
- **§9.5 (never log raw handle or token).** ✅ (see F3 for the outcome-vocabulary nit)
- **DR1.** No suppression-path file references `SOLICITATION_SEND_ENABLED`. ✅
- **§5.4 (unknown/malformed/redeemed indistinguishable).** Enforced by the *shape of the return
  type* — `findRedeemableUnsubscribeToken` returns one `null` for all three, so the page has
  nothing to branch on. ✅
- **§5.2 (purged account still writes a row with `account_id NULL`).** The ledger row is built
  from the claim's `RETURNING`, never from a pre-read (`unsubscribe.ts:364-380`), and the
  integration suite proves it by parking the claim behind a real purge row lock and asserting
  `account_id IS NULL` after. ✅
- **§5.5 vs §5.4.** Button page names exactly one business, cross-account fail-closed via
  `AND b.account_id = t.account_id`; success page names none. ✅
- **§2.1 first-write-wins.** `recordSuppression` is the single owner of the `ON CONFLICT`
  predicates and is never re-implemented; `recordSuppression` returning `null` deliberately does
  not gate the `redeemed_at` stamp. ✅

### `edge_cases` — 22/22 have a path and a test

Every entry maps to a named test. Spot-checks worth recording:

- *Two overlapping redemptions* — `unsubscribe.integration.test.ts:493` runs **genuinely
  concurrent transactions on separate connections** and probes `pg_locks` for a real waiter
  (`waitForTokenRowLockWaiter`) before releasing the first; a sequential test would pass while
  the race was broken.
- *Concurrent purge* — same mechanism, asserts `account_id IS NULL` on the resulting ledger row.
- *Post-snapshot mint* — a real concurrent transaction commits the mint between the claim and
  the follow-up read; asserts `unknown_token`, not `already_suppressed`.
- *Correction-path replay* — asserts `countGlobalRows === 0` after the replay, i.e. no
  re-suppression, and that `redeemed_at` is unchanged.
- *Account-scoped row does not justify the global sentence* — asserted through the real shared
  predicate, not a mock.
- *Percent-encoded ingress path escapes the limiter; unmatched sub-path stays limited* — both
  asserted against a real router, with a status assertion proving the first actually routes.
- *Reserved characters* — `encodeURIComponent` at all four construction points (ingress redirect,
  form action, 303 Location, receipt query value); asserted end to end.

### `tests_to_add` — 70/70 present verbatim; 4 narrower than their titles

All 70 titles found by exact string match, and the ten suites run 177/177 green. Every title was
read against its body. The ones that do not deliver what they promise:

| Title | Reality |
|---|---|
| *redeeming through the landing page writes source unsubscribe_link* | **F3** — calls the core directly and supplies the source itself; the route's constant is unguarded |
| *the unsubscribe route modules never import checkRateLimit* | **F4** — reads one of three modules |
| *the success copy renders only for a receipt minted after a committed write* | **F6** — asserts receipt↔token binding; ordering is covered at `:187` instead |
| *still enforces the ingress rate limit on every other ingress path* | **F7** — one harness stub, no real provider route |

Three more are technically accurate but weaker than they read, and are not worth acting on:

- *any sequence of redemptions over one token yields exactly one success-shaped outcome*
  (`unsubscribe.integration.test.ts:440`) counts `status === 'redeemed'`. "Success-shaped" in
  this module means `redemptionConfirmsSuppression === true`, which is true for **two** of the
  four outcomes, so a 3-element sequence has three success-shaped outcomes and the test asserts
  one. The assertion is the right one; the intake's own wording is what conflicts with
  `unsubscribe.ts:209-220`.
- *hashes the raw token with SHA-256 and never returns or stores the raw value*
  (`unsubscribe.test.ts:28`) proves the digest. "Never stores" is enforced by migration 096's
  `token_hash ~ '^[a-f0-9]{64}$'` CHECK, not here, and the two `not.toContain` lines at `:38-39`
  cannot fire given the hex assertion two lines above.
- *redacts a token containing an encoded slash to the end of the path*
  (`sentry-scrub.test.ts:245`) — its first assertion (`/u/abc%2Fdef`) does not discriminate the
  new cross-slash rule (no literal `/` in the input, so the old segment-bounded regex gives the
  same answer); the title is carried entirely by the two assertions after it, which do.
- *request logging enabled still never emits a raw unsubscribe token*
  (`unsubscribe.test.ts:599`) is purely negative and would pass if all Fastify logging were
  silenced; the sibling at `:553` supplies the positive control.

Everything else asserts what it says, several of them unusually well — *a forged token is
rejected without opening a database connection* (`unsubscribe.test.ts:92`) traps both `apply`
**and** `get` on the `sql` proxy, so even a property read fails the test; *a forged receipt* and
*an expired receipt* both perform a real POST first so the suppression is live, isolating the
receipt gate from the ledger gate; *a correction landing between POST and GET* compares
`innerHTML` byte-for-byte against a freshly rendered neutral page rather than merely asserting
the absence of success copy.

### `allowed_edit_surface` — clean

All 47 changed paths fall inside the enumerated surface. Surface amendments stand at 2 of 2
(D9 records amendment #3 declined). `.feature/intake.json` and
`docs/superpowers/plans/feat-644-unsubscribe-opt-out-intake.json` are byte-identical after
`jq -S`.

### `non_goals` — none breached

No migration (`git diff --name-only -- supabase/` is empty). No `job_outbox` row. No write to
`solicitation_asks`. No re-subscribe path. No rate limiting, BotID registration, or WAF
enforcement on either surface. No `inbound_events` dedup claim on the ingress.

One wording nit: the non-goal reads *"this ticket only redeems and exports the hash function
#630 will import"*, and the branch also exports `mintUnsubscribeRawToken`. Plan revision 7
§1.4a specifies that export explicitly (plan lines 89-93, 341, 369 — "#630 **must** call
`mintUnsubscribeRawToken()`"), and the HMAC admission gate is unimplementable without it, so
this is stale intake wording rather than scope creep.

### `observability` — matches, with F3

Per-request line, the deliberate unknown-token exclusion, the 60 s window with `replica_id`
tagging and shutdown flush, the Sentry-on-write-failure-only rule, and the
`solicitation_suppressed` analytics split by `source` all match the code. The window's bound is
proven with 5 000 records → exactly one warn line, and the shutdown flush is driven through the
**real** module-level reporter and the **real** `createGracefulShutdown`, then pinned to
`worker/index.ts` by source assertion. Only the outcome vocabulary drifts (F3).

### `rollback_plan` — still accurate

Revert is clean: no migration to reverse, and nothing in the revert deletes suppression rows.
`SOLICITATION_UNSUBSCRIBE_MAILTO` and `SESSION_COOKIE_SECRET_PREVIOUS` are inert once the code
is gone. The plan does not mention the **forward** risk this branch adds — a deployed worker
without `SESSION_COOKIE_SECRET` now crash-loops by design — but D1's carry-obligation #1
records it as an owner-verified pre-merge step, so it is documented, just not in this field.

---

## The three seam questions

**1. Do the Vercel POST and the Railway ingress agree on what each outcome means?**
Three of four outcomes, yes. They diverge on `already_redeemed_not_suppressed` — see **F1**.
Both call the same core with the same `TransactionSql` contract and the same source constants;
only the success test differs.

**2. Is §1.8's render-time invariant enforced end to end?**
Yes, and structurally. `resolveLandingState` (`page.tsx:88-105`) is the only producer of
`{view:'success'}`, and it is reachable only through
`verifyUnsubscribeReceipt(...) && await hasLiveGlobalSuppressionForToken(db, rawToken)` — a
short-circuit `&&`, so the ledger read is inside the same render. No other path in the module
returns that view; `LandingView` is exhaustive over the union. A repeated `?ok=` arrives as an
array and is treated as no receipt at all. A verified receipt with no live suppression falls
through to `findRedeemableUnsubscribeToken`, which returns `null` for a spent token, landing on
neutral.

One structural caveat, which I do **not** consider a defect but which the next reader should
know: the chain is proven in **two halves that meet at a mock boundary**. The page half fakes
all three DB functions (`unsubscribe-landing.test.tsx:129-131`) and the SQL half proves
`hasLiveGlobalSuppressionForToken` against real Postgres
(`unsubscribe.integration.test.ts:684-711`); no test drives page → real Postgres as one arc, and
there is no Playwright coverage of `/u/`. Given that the render-time call is a single
short-circuited `&&` in a five-line function, and that both halves are independently strong, the
residual risk is small — but "the invariant is proven end to end" is true of the *design*, not of
any single test.

Two supporting facts worth recording. First, the fake ledger in
`src/app/__tests__/unsubscribe-landing.test.tsx:32-110` is **stateful with real transitions**
(a `correctionPathRemoves` mutator, a real `Set` of handles) and the crypto is real, so the
§1.8 tests turn on a suppression genuinely disappearing between POST and GET rather than on a
`mockResolvedValue(false)`. Second, the real `hasLiveGlobalSuppressionForToken` is proven
against Postgres in the integration suite, including the account-scoped-row exclusion. Third,
D4's requirement that a missing `SESSION_COOKIE_SECRET` **propagate** rather than render neutral
holds: there is no `error.tsx` in `src/app/(public)/u/` or any ancestor short of
`src/app/global-error.tsx`, so the throw becomes a 500 plus a Sentry event, not a false neutral.

**3. Do the two surfaces agree on token encoding?**
Yes, and the round trip is closed at every hop. Minted tokens are `base64url '.' base64url`
(`TOKEN_SHAPE_RE`), so they contain no reserved characters and the question only bites for
forged input — which is exactly where §5.4 requires the neutral page rather than a 404. Traced:
Fastify decodes `:token` → `encodeURIComponent` on the 302 target → Next decodes `params.token`
→ `encodeURIComponent` in the form action → route decodes `params.token` → `encodeURIComponent`
in the 303 `Location`, with the receipt separately `encodeURIComponent`'d as a query value. Each
hop is asserted (`unsubscribe.test.ts` pins `/u/a%2Fb%3Fc%23d`;
`unsubscribe-landing.test.tsx` pins both the action and the redirect target).

The 303 `Location` is deliberately **relative** (`route.ts:31-38`), so a cross-site POST cannot
steer the recipient off-origin via a `Host` header — the D11 "never trust the raw request
target" lesson applied on the Vercel side.

---

## `sentry-scrub.ts` blast radius — assessed

Five runtime importers, not the six the blast-radius file lists
(`src/lib/account-offboarding/scrub-error.ts` only *mentions* the module in a comment). Three
are Sentry sinks — `src/instrumentation-client.ts` (browser), `src/instrumentation.ts` (Next
server), `worker/sentry.ts` — plus `worker/config/fastify-options.ts` (pino) and the ingress
adapter.

**The four shipped `/approve/` contracts are byte-identical before and after** (`/approve/<t>`,
`/api/approve/<t>/edit`, `GET /approve/tok 200`, `/approve/tok#section`), verified by running
both versions of the function over a representative input set. Real deltas:

1. **Fragments are no longer passed through untouched.** `redactTokenPaths(fragment)` is new, so
   `/dashboard#/approve/tok` now redacts inside the fragment. Direction is safe; RepWorth uses no
   hash routing, so live impact is nil. Untested — no assertion pins fragment-span redaction.
2. **The unanchored `/u/` alternative** truncates any logged string containing `/u/` to the next
   `?`/`#`/whitespace, case-insensitively, across `/` — including in the browser bundle. This is
   **D5**, accepted as fail-safe. Repo-wide grep finds no pre-existing `/u/` URL outside the new
   routes, so today it is latent rather than live. The browser side was considered: D5's own
   example (`google.com/maps/u/0/contrib/…`) is a browser-Sentry breadcrumb.
3. **The decode fallback returns the fully decoded string** (`sentry-scrub.ts:136-137`), so when
   only the decoded form matches, the logged value no longer equals the input
   (`/reviews/%2Fu%2Ffoo` → `/reviews//u/[REDACTED]`). Safe, since the token is replaced in the
   same step, but worth knowing when reading a log against a raw access log.

The `serializers.req` replacement is field-for-field identical to Fastify 5.8.5's own
`asReqValue`, and Fastify merges user serializers over the defaults, so `err`/`res` survive.
`registerIngressRateLimitHook` is a strict superset of the old predicate for all five providers.
The one behavioural narrowing is **F2**.

---

## Low-confidence appendix — observations, not findings

Below the ≥80 % bar; recorded so the next reader does not re-derive them.

1. **Absolute-form + unmatched path escapes both limiter arms.**
   `GET http://worker.host/ingress/bogus HTTP/1.1` has `routeOptions.url === undefined` (no
   route) and a `request.url` that fails the decoded prefix test, so the hook returns early. The
   module doc (`rate-limit.ts:64-70`) says the two-arm design exists precisely so a 404 cannot
   "reopen an unthrottled flood namespace" — that namespace is still reachable. **Pre-existing
   and unchanged by this branch**, cost is routing plus one log line (no signature verify, no
   DB), and #644 closed two *other* holes in the same hook. Same class:
   `/INGRESS/resend` 404s and is unthrottled (find-my-way is case-sensitive). Worth a follow-up
   that strips scheme+authority once before the prefix test.
2. **The encoded-prefix bypass stays open for `/approve/`.** `redactUnsubscribeToken`'s decoded
   pass re-runs only the unsubscribe regex, never `APPROVE_TOKEN_PATH_RE`, so a Sentry
   `transaction` of `GET /%61pprove/<token>` would log a raw approval token. Not a regression,
   and I could not establish that Next.js routes that spelling, so the failure scenario is not
   demonstrable — but the branch closed exactly this class for unsubscribe on the same function
   and left the sibling open with no comment.
3. **Observability asymmetry between the surfaces** (punted to me by the standards review).
   The §1.6 mint-race counter is emitted only from the ingress; `POST /api/u/<token>` reaches the
   identical ledger-miss condition and records nothing. Checked against the intake: `observability[3]`
   scopes the signal to *"a rising unknown-outcome rate **at the ingress**"*, so this is
   intake-consistent, not drift. A process-level counter on Vercel's per-invocation isolates
   would not aggregate usefully anyway.
4. **`SOLICITATION_UNSUBSCRIBE_MAILTO` is documented as a Railway var with no worker-lane
   declaration.** `.claude/reference/env-vars.md` lists it as "Vercel + Railway" and requires the
   two values to be equal, but it is declared only in `src/lib/config/server.ts` and read only by
   the landing page. The Railway half is forward-looking for #622; setting it on Railway does
   nothing today. Intentional-looking, but a reader could conclude the header already emits it.
5. **`D12` has a triage-table row but no `## D12` section** in the deviations file, and the file's
   header says "All eleven ACCEPT" while the table lists twelve. The reasoning is not lost — it
   lives in `adversarial-review-implementation.md` findings 1 and 2, which the row points at —
   but the file's own convention ("the entries below carry the reasoning") is broken for the
   single largest deviation on the branch.
6. **Vercel access logs will contain the raw token** in the request path for both `/u/<token>`
   and `/api/u/<token>`. Inherent to any tokenized URL and identical to the shipped
   `/approve/<token>` precedent the intake names as the pattern to follow, so it is an accepted
   class rather than a #644 defect — but invariant #5's "never logged" is true only of *our*
   logs, not the platform's.
7. **`hasLiveGlobalSuppression` compares the raw `channel` string** from the token table, while
   the write path narrows it through `toSuppressionChannel` first. Only diverges if the two
   tables' CHECK constraints drift, in which case the spent branch silently answers
   `already_redeemed_not_suppressed` instead of throwing. Both constraints ship in migration 096,
   so it is theoretical today.
8. **Vercel never asserts `SESSION_COOKIE_SECRET` at boot.**
   `assertUnsubscribeTokenSecretConfigured` is wired only through
   `assertUnsubscribeIngressConfigured()` at `worker/index.ts:537`; `register()` in
   `src/instrumentation.ts` calls only `assertCoreAppConfig()`, which does not cover it. A Vercel
   deploy missing or short-changing the secret goes green, then 500s every `/u/<token>` GET and
   every POST for every recipient of every business, with Sentry volume as the only signal. **D4
   records this trade explicitly** ("Vercel does not assert it … the landing page must let this
   error propagate loudly"), so it is not reported as a defect — but the closure is one line:
   `requiresProductionConfig()` returns true on Vercel, so calling the same assertion inside
   `register()`'s `nodejs` branch converts a per-request statutory failure into a boot failure.
9. **The `global-error.tsx` crash page omits `SOLICITATION_UNSUBSCRIBE_MAILTO`.** When the D4
   throw fires, the recipient sees the generic branded crash page carrying `support@repworth.net`
   — correct per D4 (distinct from neutral, loud, not a false success), but the statutory
   fallback address is absent from the one page that most needs it.
10. **`solicitation_suppressions.account_id` carries an FK; `solicitation_unsubscribe_tokens.account_id`
    does not** (migration 096 `:59` vs `:112`). A hard `DELETE FROM accounts` while tokens still
    carry that id would make every redemption for those tokens throw an FK violation — a permanent
    503 on a statutory opt-out. Not reachable today: offboarding tombstones rather than deletes,
    and the only production `DELETE FROM accounts` is the admin-onboarding rollback
    (`src/lib/onboarding/admin-onboarding-service.ts:249`).
11. **The ingress GET path hashes an unbounded token.** `handleUnsubscribeGet` deliberately skips
    the admission gate (§5.4), so `failClosed` → `unsubscribeTokenLogPrefix` SHA-256s an input
    bounded only by Node's URL/header cap, not by `MAX_SIGNED_INPUT_LENGTH`. The "one length
    compare instead of an HMAC over a megabyte" reasoning at `unsubscribe.ts:48-50` does not hold
    for that call site. Reachable only when `NEXT_PUBLIC_APP_URL` is unset, which the boot gate
    now prevents on deployed lanes.
12. **Three sequential round trips before render.** `resolveLandingState` can issue three queries
   on an unauthenticated path whose whole design rationale is minimising unauthenticated DB work.
   Flagged by the standards review and deliberately not tabled there; it trades against
   `loadTokenTarget`'s one-owner property and edges into #651.
