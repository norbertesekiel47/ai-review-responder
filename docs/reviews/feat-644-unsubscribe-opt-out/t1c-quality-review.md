# T1c — Code quality review

**Commit:** `567531d8` (`feat(#644): RFC 8058 unsubscribe ingress on Railway, end to end`)
**Scope:** code quality only. Spec compliance passed separately with zero findings; nothing below
re-litigates *what* was built.
**Files reviewed (committed versions, via `git show`):** `worker/ingress/unsubscribe.ts`,
`worker/ingress/rate-limit.ts`, `worker/index.ts`, `src/lib/solicitation/unsubscribe.ts` (delta),
plus the three new suites and `worker/ingress/__tests__/helpers/unsubscribe-app.ts`.
**Standards applied:** `.claude/rules/design.md`, `.claude/rules/production.md`,
`.claude/rules/repworth.md`, `.claude/CLAUDE.md` (invariants #5, #12, worker-layout + gotchas).

**Verdict: Changes needed** — three Important findings, none of them blocking correctness on the
happy path, all of them on the failure/telemetry edges that a statutory endpoint is judged by.

---

## Strengths

1. **Commit ordering is asserted as an *order*, not a status.** `worker/ingress/unsubscribe.ts:103`
   answers only after `sql.begin()` resolves, and `unsubscribe.test.ts` pins
   `['redeem', 'commit', 'reply']` through an `onSend` hook. A handler that replied from inside the
   transaction callback would still return 200 and would still be wrong; this test is the only
   shape that catches it.
2. **The redaction defence is layered and each layer's *limits* are written down.**
   `sanitizeErrorInPlace` does two independent passes (shared URL rule + literal containment) and
   mutates in place with an explicit rationale — a `cause` wrapper would be re-serialized by
   Sentry's linked-errors integration with the original text, and a fresh `Error` would throw away
   the frames. The route-level `logLevel: 'silent'` is documented as defence-in-depth that *cannot*
   reach the unmatched-404 case, and the global serializer that can is tested at the INFO lane
   (`unsubscribe.test.ts` → "request logging enabled still never emits a raw unsubscribe token"),
   which is the lane production hides.
3. **The limiter fix is tested through a real router, not a string predicate.**
   `buildUnsubscribeTestApp` wires `buildFastifyOptions` + content-type parsers + the real hook +
   the real routes and drives `app.inject()`. The test comment says the quiet part out loud: a unit
   test of the old string check would have passed while `/%69ngress/resend` escaped the limiter in
   production. The exemption keying strictly on **resolved route config** (never the URL) is the
   right choice and is proven by the `…/extra` 404 case.
4. **The §1.6 counter is a genuine seam despite sharing a file.** Two-method interface
   (`record`/`stop`), an injected `clock` whose `schedule` returns its own cancel function (no
   platform timer handle ever escapes), and a factory the tests drive without `vi.useFakeTimers()`.
   The adapter touches it through exactly one call site. The banding holds; a reader does not have
   to hold both concerns at once.
5. **The timer is `unref`'d** with the rationale on the line
   (`unsubscribe.ts:306` — "a pending telemetry window must never be why the process lives on"), and
   the partial window is flushed through the real `createGracefulShutdown` orchestrator in test,
   with a structural pin that `worker/index.ts` actually wires it.

---

## Findings

### Important

#### I1 — `emit()` runs in a bare `setTimeout` callback; a throw there is a fatal worker crash
`worker/ingress/unsubscribe.ts:263` (`emit`), reached from `worker/ingress/unsubscribe.ts:304`
(`setTimeout(onExpiry, ms)`).

`emit()` calls `deps.identityFields()` and `deps.warn(...)` with no `try/catch`, and the production
`schedule` invokes it from a raw timer callback. A throw on that path is not caught by anything: it
surfaces as `uncaughtException`, and `worker/index.ts:860` `fatalExit` treats `uncaughtException` as
**always fatal** ("the stack unwound, so process state is genuinely unknown"). The blast radius of a
telemetry line failing is therefore the entire single-replica worker — every BullMQ queue, every
poller, and the statutory endpoint itself.

Realistic trigger: `createWorkerLogger.emit` guards the sanitizer and `JSON.stringify` but *not* the
final `console.warn`, which can throw `EPIPE`/`ERR_STREAM_DESTROYED` when Railway tears down or
rotates the log stream — precisely the condition under which a container is already unhappy.

This is the exact rule CLAUDE.md states unconditionally ("**Best-effort work after a worker's
primary side effect needs its own `try/catch` (log-and-swallow)** — never let observability poison
the success path") and the precedent it names does exactly that: the replica-cardinality check
"carries its own log-and-swallow `try/catch` for exactly that reason". `Release It!` posture:
failure isolation — a rate signal must not be able to take the process with it.

**Fix:** wrap the body of `emit()` (or the `schedule` callback) in log-and-swallow. Note the reset
of `count` already happens before the sink call, so a swallow cannot double-count.

#### I2 — `NEXT_PUBLIC_APP_URL` has no boot gate, and its absence turns the GET route into an unbounded Sentry amplifier
`worker/ingress/unsubscribe.ts:143` (`landingPageUrl`), `worker/index.ts:528–532`.

`landingPageUrl` throws when `NEXT_PUBLIC_APP_URL` is unset. In the worker config it is `rawOpt`
(`src/lib/config/worker.ts:150`), `warnMissingProductionEnv` (`worker/config/startup-assert.ts:276`)
does not list it, and every assertion that *does* require it is gated behind another feature flag
(`assertSelfServeSignupEnv`, `assertChannelsWhatsAppEnv`, `assertZernioPublishingEnv`,
`assertAccountOffboardingEnv`). That is the identical reasoning the commit itself used to justify
adding `assertUnsubscribeTokenSecretConfigured` for `SESSION_COOKIE_SECRET` — the new gate closes
half the D4 hole and leaves the other half open.

Consequences if unset on a deployed lane:
- Every human GET — the *majority* real-world opt-out shape, since many mail clients follow the
  link rather than POST — throws, hits `failClosed`, and returns 503 instead of the neutral page.
- `failClosed` → `reportCaughtError` → **one `captureException` per request** on a route that is
  deliberately unauthenticated **and** deliberately exempt from the ingress limiter. Worker Sentry
  has no sampling and no dedup (the module's own §1.6 comment says so). This is the precise
  amplification vector the unknown-token counter was written to avoid, reproduced on the sibling
  branch with no bound at all.

**Fix:** extend the T1c boot gate (or add a sibling assertion beside it) to cover
`NEXT_PUBLIC_APP_URL`, with the same deployed-lane + non-mock gating. The route registration already
depends on it; making the dependency a boot fact rather than a per-request throw is both cheaper and
consistent with the gate the same commit introduced.

#### I3 — The one telemetry signal on this endpoint cannot answer the incident it exists for
`worker/ingress/unsubscribe.ts:154` (`replyUnknownToken`), `:279` (`record`).

`replyUnknownToken` is called from **two materially different** branches:
- `unsubscribe.ts:98` — the admission gate rejected the string. This is scanner/forged traffic:
  expected noise on a public endpoint, and by construction *not* a token we ever minted.
- `unsubscribe.ts:108` — the token passed our own HMAC (so we **did** mint it) but the ledger
  returned `unknown_token`. This is the #630 mint race — the one case the 503 exists to keep
  recoverable, and a real statutory near-miss.

`record()` takes no arguments and the window line carries only `count` + replica identity, so the
two collapse into one number. The failure scenario is exactly the one the review brief names: a
provider reports that opt-outs are not landing. The responder greps the worker log, finds
`unsubscribe_unknown_token_window count=4127`, and **cannot tell whether a single well-formed token
was among them** — the number is dominated by scanner traffic that means nothing. The success line
(`outcome` + `hash_prefix`) proves what *did* land; nothing proves what should have and didn't.

Minimum a responder needs that is missing: a way to count the well-formed-but-unknown case on its
own. Cheapest version consistent with §1.6's bound is a `stage: 'gate' | 'ledger'` argument on
`record()` and two counters in the same window line (`count_gate` / `count_ledger`) — still one line
per 60 s per process, still no per-request emission, still no raw token.

Worth noting as a secondary point on the same branch: because the ledger-unknown case emits no
per-request line, its `tokenHashPrefix` — which `redeemUnsubscribeToken` already returns on the
`unknown_token` variant — is discarded. A responder holding "the provider says it POSTed token X"
has no correlatable value at all for the one outcome where correlation matters. Emitting a bounded
sample of hash prefixes (e.g. first N per window) would close that without reopening the
per-request amplification. This is a judgement call, not a defect; the `count_ledger` split is the
part I would insist on.

### Minor

#### M1 — Post-commit work sits inside the transaction's `try`
`worker/ingress/unsubscribe.ts:118` (`logger.log`) and `:122` (`reply.status(200).send`).

Both run **after** COMMIT but inside the `try` whose `catch` calls `failClosed` → 503 + Sentry. A
throw from either flips a committed, legally-effective redemption into a 5xx the provider will
retry, and manufactures a Sentry event describing a failure that did not happen.

Practical risk is low — `createWorkerLogger.emit` is internally fail-open for the sanitizer and for
`JSON.stringify`, the fields are two plain strings, and Fastify's `reply.send()` on an already-sent
reply *warns* rather than throwing (`FST_ERR_REP_ALREADY_SENT` is a level-40 log, which
`fastify-options.ts` already redacts) — so there is no double-reply crash here. But the CLAUDE.md
rule is stated without a likelihood qualifier, and this is the highest-consequence instance of it in
the repo: the side effect is a statutory opt-out.

**Fix:** move the log + reply out of the `try` (the `catch` only needs to cover the gate and
`sql.begin`), or give the log line its own swallow.

#### M2 — Exported handlers reopen the door `registerUnsubscribeRoutes` closes
`worker/ingress/unsubscribe.ts:88`, `:134`.

`handleUnsubscribePost` and `handleUnsubscribeGet` are `export`ed but referenced nowhere outside the
module — `git grep` across the tree at `567531d8` finds them only in the plan document. The module's
own doc-comment (`:62–66`) argues that route registration must have one owner *because the options
ARE the security contract* (limiter exemption §9.2, silenced request log, 1 KB body cap). Exporting
the bare handlers hands a future caller a way to register them without any of that and still pass
the "the unsubscribe route modules never import checkRateLimit" structural test.

`design.md`: interfaces should be as narrow as the caller's need; every exported element must earn
its place. Neither is needed by any caller, and the tests drive them through `app.inject()` against
the real registration. **Fix:** drop both `export` keywords.

#### M3 — `stop()` flushes but does not disarm; counts recorded during the drain are lost
`worker/ingress/unsubscribe.ts:291`.

In `createGracefulShutdown`, `stopBackgroundLoops()` (which calls
`stopUnknownUnsubscribeTokenWindow()`) runs **before** `closeServer()`. An unknown token arriving in
that drain window calls `record()`, which sees `cancelTimer === null` and arms a **fresh** unref'd
60 s window that can never fire before `process.exit()`. Those counts vanish silently, and the flush
the shutdown hook exists to guarantee is not actually final.

Bounded and explicitly a rate signal, not a correctness input — hence Minor. **Fix:** a `stopped`
flag that makes `record()` a no-op (or an immediate-emit) after `stop()`, which also makes the
documented "Idempotent" contract on `stop` unambiguous.

---

## The arm-1 question (`request.routeOptions.url` in `registerIngressRateLimitHook`)

**Verdict: load-bearing. The decoded-raw arm does not subsume it, and the gap is exploitable on
every ingress provider.**

The spec reviewer's measurement is correct — deleting arm 1 fails zero tests — but the conclusion
"therefore dead" is wrong. That is **missing coverage**, not dead logic.

The input arm 2 cannot see is an **absolute-form request target** (RFC 9112 §3.2.2 — origin servers
*MUST* accept it):

```
POST http://<host>/ingress/resend HTTP/1.1
```

`find-my-way@9.6.0` normalizes this before routing —
`node_modules/.pnpm/find-my-way@9.6.0/node_modules/find-my-way/index.js:571-572`:

```js
if (path.charCodeAt(0) !== 47) {          // 47 is '/'
  path = path.replace(FULL_PATH_REGEXP, '/')   // /^https?:\/\/.*?\//
}
```

…so the route resolves normally, while Fastify's `request.url` (a passthrough of `req.raw.url`)
still holds the full absolute-form string. `decodeIngressPath` finds no `?`/`#`, decodes
`http://<host>/ingress/resend` to itself, and `.startsWith('/ingress/')` is **false**.

Verified empirically against this worktree's own `fastify@5.8.5` + `find-my-way@9.6.0`, driving a
raw socket (not `app.inject()`, which normalizes the target):

| request line | routed to | arm 1 | arm 2 |
|---|---|---|---|
| `POST http://h/ingress/resend HTTP/1.1` | `/ingress/resend` (200) | **true** | **false** |
| `GET http://h/ingress/unsubscribe/abc.def HTTP/1.1` | `/ingress/unsubscribe/:token` (200) | **true** | **false** |
| `GET /ingress/unsubscribe/abc.def HTTP/1.1` | `/ingress/unsubscribe/:token` | true | true |
| `GET /%69ngress/unsubscribe/abc.def HTTP/1.1` | `/ingress/unsubscribe/:token` | true | true |
| `POST /%2569ngress/resend HTTP/1.1` | 404 | false | false |

Delete arm 1 and `POST http://host/ingress/stripe` reaches the real Stripe handler — signature
verification, dedup claim, the whole unauthenticated work path — with the per-IP limiter never
consulted. That is the *same class* of bypass this commit exists to close, reachable by a one-token
change to the request line rather than a percent-encoded prefix. (Railway's edge very likely
rewrites absolute-form to origin-form today, which is why this is a latent hole rather than a live
one — but the limiter must not depend on an undocumented property of a proxy the team does not own,
and the hook is also reachable from the private network.)

The last row is worth recording as *not* a hole: a double-encoded prefix fails to route at all, so
it is an ordinary non-ingress 404 and out of the limiter's declared scope either way.

**Recommendation:** add the absolute-form case to `unsubscribe-rate-limit.test.ts`. `app.inject()`
cannot express it (light-my-request normalizes the target), so the test needs `app.listen({port: 0})`
plus a raw `net.connect` write — roughly 15 lines, and it converts a branch that currently *reads*
load-bearing into one that *is* provably load-bearing. Without it, the next reader runs the same
mutation experiment, gets the same "zero failures", and deletes it. On a security-adjacent path that
is the maintenance trap the brief was worried about; the mutation-testing claim in the commit
message ("Two mutation runs prove each arm load-bearing") is true for arm 2 and, on the committed
test set, not true for arm 1.

---

## Diagnosability assessment

The endpoint deliberately abstains from Sentry and per-request logs for unknown tokens. What
remains:

| Outcome | Signal | Correlatable? |
|---|---|---|
| `redeemed` / `already_suppressed` / `already_redeemed_not_suppressed` | one `info` line, `outcome` + `hash_prefix` | yes |
| gate rejection (forged) | window counter only | no (by design, correct) |
| ledger `unknown_token` | **same** window counter | **no — see I3** |
| thrown failure | Sentry + one `error` line, `outcome:'failed'` + `stage` | partially (hash_prefix omission already queued) |

For "a provider reports opt-outs are not landing", the responder can confirm what *did* commit
(success lines, `hash_prefix` matched against the provider's token list) and can see *that* 503s are
happening (window count). What they cannot do is distinguish the benign cause from the statutory one
— I3. The `stage` tag on `failClosed` is a good instinct and the right granularity; the same
granularity is simply missing one level up.

One further observation, low confidence and not raised as a finding: the two `stage` values
(`'redeem'`, `'redirect'`) are typed as a closed union and used as a Sentry tag, which is the right
shape — but `stage: 'redirect'` has exactly one realistic cause today (I2's unset
`NEXT_PUBLIC_APP_URL`), so if I2 is fixed with a boot gate the tag becomes near-unreachable. Keep
it; it costs nothing and the GET path will grow.

## Observations not raised as findings

- `sanitizeErrorInPlace` sanitizes `message` and `stack` but does not walk `error.cause`. Sentry's
  linked-errors integration *does* serialize the cause chain, so a nested cause carrying the raw
  token would escape both passes. I could not construct a reachable instance — the raw token is
  hashed before it reaches the DB layer, and no HTTP client is called on this path — so this is a
  structural gap with no demonstrated path to it. Worth a one-line comment stating the assumption
  ("nothing on this path wraps an error whose cause could carry the token") rather than code.
- `UNSUBSCRIBE_ROUTE_OPTS` is a single frozen-by-`as const` object shared by reference between the
  POST and GET registrations. Fastify does not mutate route options, and sharing is what makes the
  "one owner of the security contract" claim true, so this is correct — noted only because a shared
  mutable options object is usually a smell.
- The module-level `processReporter` is constructed as an import side effect. Two `Fastify` apps in
  one test process therefore share one counter (the helper builds a second app in several tests).
  This is not a bug — the counter is per-process by design, and tests that assert on it use the
  injectable factory instead — but it does mean `record`/`stop` are two free functions over hidden
  process state, which is the one place the file's otherwise-clean banding leaks.
- `worker/index.ts` changes are pure registration + lifecycle: one `registerIngressRateLimitHook`
  call, one `registerUnsubscribeRoutes` call, one assertion in the existing boot-gate block, one
  flush in the existing shutdown block. Invariant #12 and the "entry points orchestrate" rule are
  respected; the deleted inline hook body moving into the limiter module is a strict improvement
  (the policy now lives beside the rule it governs and is testable through a real router).
- No `any`, no `NEXT_PUBLIC_*` companion flag, Node native crypto throughout the touched lib code,
  and every comment carries rationale rather than narration. The comment density is high but each
  block explains a *why* that is not recoverable from the code (why 503 not 404, why `hash_prefix`
  not `token_hash_prefix`, why mutate rather than wrap, why the counter is in this file).
