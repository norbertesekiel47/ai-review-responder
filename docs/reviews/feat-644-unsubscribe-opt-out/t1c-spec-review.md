# T1c spec review — commit `567531d8` (#644 RFC 8058 unsubscribe ingress)

**Verdict: ✅ Spec compliant.** No findings at or above the ≥80%-confidence bar.

Reviewed against the committed tree (`git show 567531d8:…`) for the two concurrently-edited
paths. Working tree was byte-identical to the commit at review time
(`git diff --stat 567531d8 -- src/lib/solicitation/unsubscribe.ts src/lib/solicitation/__tests__/`
→ empty), so nothing was read from a mutated file. No source file was modified.

---

## Findings

| Severity | File:line | Finding |
|---|---|---|
| — | — | None at ≥80% confidence. |

### Sub-threshold notes (recorded, not findings)

1. **`failed` log line carries no `hash_prefix`.**
   `worker/ingress/unsubscribe.ts:170` → `reportCaughtError(ENDPOINT, sanitized, { outcome: 'failed', stage })`.
   The three success outcomes log `hash_prefix`; the failure line does not, so an infra-failed
   attempt cannot be correlated with the provider's retry of the same token. Spec §9.5
   (`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:743-748`) is permissive
   here — "Log the `token_hash` prefix … **when correlation is needed**" — and `hashUnsubscribeToken`
   is already exported, so this is a cheap improvement rather than a violation. Confidence this is
   a spec breach: ~40%.
2. **`failClosed` reports before it replies** (`unsubscribe.ts:168-172`). If `reportCaughtError`
   itself threw, the 503 would never be written and the error would reach Fastify's default
   handler. `captureException` is already guarded and `createWorkerLogger` is fail-open on
   serialization, so the window is theoretical; pino's `redact` on `msg`/`err.message`/`err.stack`
   still covers the escape. Not actionable.
3. **Arm 1 of the scope test is not independently test-covered.** Deleting
   `request.routeOptions.url?.startsWith(…)` from `rate-limit.ts:74-76` fails **zero** tests —
   the decoded-raw arm subsumes every case in the matrix. The spec mandates both arms, and the
   raw arm is the one with a live-bypass history, so keeping it is correct; but the guard against
   *its* removal is the reviewer, not the suite. See Claim B below for the exact mutation ledger.

---

## Claims A–E

### Claim A — commit-then-200 (§9.1). **Verified.**

Read `worker/ingress/unsubscribe.ts:95-121`. The reply is constructed only after
`await sql.begin(...)` resolves:

```ts
const redemption = await sql.begin((tx) =>
  redeemUnsubscribeToken(tx, { rawToken, source: 'unsubscribe_one_click' }),
);
if (redemption.status === 'unknown_token') { replyUnknownToken(reply); return; }
logger.log('Unsubscribe redemption', { … });
reply.status(200).send({ received: true });
```

The transaction callback is a single expression returning `redeemUnsubscribeToken`'s promise —
it closes over neither `reply` nor any send path, so there is no reachable way to answer from
inside the transaction. postgres.js resolves `begin` only after COMMIT is acknowledged.

Post-commit failure direction is safe: everything after the `await` is inside the same
`try`, so a throw from `logger.log` or `reply.send` lands in `failClosed` → **503**, never a
2xx. A commit that fails at the ack (`begin` rejects) likewise yields 503. Every failure mode
biases toward "provider retries a committed, idempotent redemption", never toward "provider
believes a lost opt-out was delivered".

The test asserts **ordering**, not just status — `worker/ingress/__tests__/unsubscribe.test.ts`
instruments `mockBegin` to push `'commit'` after `run(TX)` resolves and adds an `onSend` hook
pushing `'reply'`, then asserts `order` equals `['redeem','commit','reply']`. A handler that
replied inside the callback would return 200 and still fail this test. Ran the suite: passes.

### Claim B — the hook reproduces the old bypass. **Verified by reading the tests; mutations NOT re-run.**

`worker/ingress/rate-limit.ts:72-82` matches the specified shape exactly, including the
exemption keying strictly on `request.routeOptions.config?.skipIngressRateLimit`.
`decodeIngressPath` (`rate-limit.ts:86-94`) is total: strips at the first `[?#]`, decodes in
`try/catch`, falls back to the raw path.

Traced each test against each mutation by hand:

| Mutation | Tests that would fail |
|---|---|
| Restore old `request.url.startsWith('/ingress/')` (raw literal, no decode) | `still enforces the ingress rate limit on a percent-encoded ingress root path` (`/%69ngress/resend` — routes to the real handler, fails a literal compare, escapes the limiter) and `still enforces the ingress rate limit on an unmatched percent-encoded ingress path` (`/%69ngress/bogus`) → **2** |
| Remove the decoded-raw arm (resolved-route only) | `still enforces the ingress rate limit on an unmatched percent-encoded ingress path` and `enforces the ingress rate limit on an unmatched path under the unsubscribe prefix` — both are 404s, where `routeOptions.url === undefined`, so the surviving arm returns `false` and every 404 drops out of the hook → **2** |

Both counts match the implementer's report. The claim's characterisation is accurate, with the
caveat that the two failure sets overlap on one test.

**Exemption cannot be inherited by an unmatched path**: it reads only resolved route config.
`enforces the ingress rate limit on an unmatched path under the unsubscribe prefix` pins this —
`/ingress/unsubscribe/<token>/extra` 404s with an empty route context, so the decoded-raw arm
puts it in scope and no config exempts it; the test asserts `checkRateLimit` was called once.

Structural guards are present too: `the unsubscribe route modules never import checkRateLimit`
greps the adapter source, and a sibling test asserts `worker/index.ts` no longer contains
`request.url.startsWith('/ingress/')`.

### Claim C — unknown tokens are genuinely silent. **Verified.**

`replyUnknownToken` (`unsubscribe.ts:145-151`) does exactly three things: `recordUnknownUnsubscribeToken()`,
`reply.status(503)`, `send`. No `logger.*`, no `reportCaughtError`, no `captureException` on
that path — and the forged-token branch (`unsubscribe.ts:104-107`) routes through the same
function, so a failed admission gate is equally silent and opens no transaction.

The route carries `logLevel: 'silent'`, so Fastify emits nothing either. Two tests pin it:
`an unknown token returns 503 and emits no per-request log line` asserts the parsed
`createWorkerLogger` record list is `[]`, and `does not report an unknown token to Sentry`
asserts `captureException` was never called.

Window bound: `createUnknownTokenReporter` (`unsubscribe.ts:257-296`) opens a window on the
**first** record and returns early while `cancelTimer !== null`, so no traffic volume can arm a
second timer inside an open window — the "at most one line per 60s per process" bound is
structural, not probabilistic. `emit()` zeroes `count` *before* calling the sink so a throwing
logger cannot double-count into the next flush. `stop()` cancels then emits and is idempotent
(count 0 → early return).

**Clock is injectable**: `UnknownTokenWindowClock { now, schedule }` is a constructor dep. The
test rig (`unknown-token-window.test.ts:29-70`) supplies a manual `nowMs` and captures the
expiry callback in a `pending` variable — no real time, and no `vi.useFakeTimers()` reaching
into the rest of the module graph. `hostile unknown token traffic emits at most one warning per
window` drives 5,000 records and asserts exactly one `warn`; `the aggregated unknown token line
carries the replica id and an accurate count` asserts `count: 17` plus `replica_id`/`deployment_id`
from `replicaIdentityFields(readReplicaIdentity())`. `a partial unknown token window is flushed
on graceful shutdown` drives the **real** module-level reporter through the **real**
`createGracefulShutdown` and then greps `worker/index.ts` for the wiring.

The process-level reporter `unref()`s its timer, so a pending telemetry window never keeps the
process alive.

### Claim D — `hash_prefix`, not `token_hash_prefix`. **Verified in both directions — the claim is correct.**

`createWorkerLogger`'s `emit` routes every object arg through `sanitizeAnalyticsProperties`
(`src/lib/shared/logger.ts:76`), which drops any key for which `isBlockedPropertyKey` is true.
That predicate is at `src/lib/analytics/events.ts:61-70` and includes:

```ts
lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('password')
```

So `token_hash_prefix` would have been **silently dropped** — the log line would have shipped
with `outcome` only and no correlation value, with no error anywhere. The shipped name
`hash_prefix` contains none of the three substrings and is absent from both blocked sets
(`hashprefix` normalized), so it survives. Confirmed empirically by the passing assertion
`expect(records[0]?.data).toEqual({ outcome: 'redeemed', hash_prefix: 'a1b2c3d4e5f6' })` —
a strict `toEqual`, so a dropped key fails the test.

### Claim E — no raw token anywhere. **Verified.**

Enumerated every sink the adapter can reach:

- **Success log** — `logger.log('Unsubscribe redemption', { outcome, hash_prefix })`. String arg
  is a constant; object arg carries only the 12-char digest prefix from `logPrefix()`. No handle
  (the adapter never sees one — `UnsubscribeRedemption` exposes only `status` + `tokenHashPrefix`).
  `never logs the raw token or the raw handle` additionally asserts the whole sink contains no `@`.
- **Error path** — `sanitizeErrorInPlace` mutates `message` and `stack` in place through two
  passes: `redactSensitivePathsAndQueries` (whose `UNSUBSCRIBE_TOKEN_PATH_RE` deliberately spans
  `/`, so a `%2F`-bearing token cannot be half-exposed) then a literal `split(rawToken).join('[REDACTED]')`.
  Mutating rather than wrapping is right: a `cause` chain would be re-serialized by Sentry's
  linked-errors integration carrying the original text.
- **Sentry** — `reportCaughtError` calls `captureException(error, { tags: { endpoint } })` with
  the already-sanitized Error. The endpoint tag is a constant. `worker/sentry.ts` registers no
  `extraErrorData` integration, so custom Error properties are not serialized — and it would not
  matter anyway: `redeemUnsubscribeToken` binds only `hashUnsubscribeToken(rawToken)` as a query
  parameter, never the raw token, so a postgres.js error's `.query`/`.parameters` cannot carry it.
- **Non-`err` custom keys** — the D7 gap. `reportCaughtError` passes the Error as a positional
  arg, which `logger.ts:serializeError` reduces to `error_name`/`error_message`(/`error_stack` off
  production lanes) — all sanitized upstream. The `context` object is `{ outcome, stage }`, both
  closed literals (`FailureStage = 'redeem' | 'redirect'`), never free text.
- **Fastify's own logger** — routes carry `logLevel: 'silent'`; the unmatched-404 case route
  config can never reach is covered by the global `serializers.req` + `redact` in
  `worker/config/fastify-options.ts`, and `an unmatched path carrying a real token never logs the
  raw token` asserts the raw log contains `/ingress/unsubscribe/[REDACTED]`.
- **Redaction proven at the INFO lane, not just `warn`** — `request logging enabled still never
  emits a raw unsubscribe token` builds a second harness with `productionConfigRequired: false`
  and exercises POST-failure, GET and 404 shapes.

The only place the raw token is intentionally re-emitted is the 302 `Location` header, which is
the user's own browser and is by design.

---

## Also checked

- **`worker/index.ts` purity** — the diff adds only registration + lifecycle:
  `registerIngressRateLimitHook(app)`, `registerUnsubscribeRoutes(app)`,
  `assertUnsubscribeTokenSecretConfigured()` beside the existing `assert*Env()` block, and
  `stopUnknownUnsubscribeTokenWindow()` inside `stopBackgroundLoops`. No business logic, no DB
  writes. Invariant #12 and the worker-layout rule hold. The hook body moved *out* of the boot
  file and into the module that owns the policy — a net improvement.
- **Edit surface** — `git show --stat` lists exactly 9 files, all inside the declared set:
  `worker/ingress/unsubscribe.ts` (new), `worker/ingress/rate-limit.ts`,
  `worker/ingress/__tests__/{unsubscribe,unsubscribe-rate-limit,unknown-token-window}.test.ts`
  + `__tests__/helpers/unsubscribe-app.ts`, `worker/index.ts`,
  `src/lib/solicitation/unsubscribe.ts` (boot-gate export only — the diff adds one exported
  function and two imports, nothing else), `src/lib/solicitation/__tests__/unsubscribe-boot-gate.test.ts`.
  No `package.json` change → **no new runtime dependency**.
- **26 verbatim test titles** — scripted character-for-character `grep -F` of all 26 strings
  against the three committed suites: **0 missing**.
- **`any` types** — none in any file this commit touched (the `worker/ingress/__tests__` hits are
  all pre-existing Stripe/Resend suites).
- **`${JSON.stringify(x)}::jsonb`** — absent; the adapter performs no JSONB write at all.
- **DR1** — no `SOLICITATION_SEND_ENABLED` / `solicitationSendEnabled` reference on this path,
  asserted structurally by `redeems and writes a ledger row while SOLICITATION_SEND_ENABLED is off`
  reading the adapter source, not merely behaviourally.
- **Route options** — `config: { skipIngressRateLimit: true }`, `logLevel: 'silent'`,
  `bodyLimit: 1024`, shared by both POST and GET at `/ingress/unsubscribe/:token`, registered by
  one function so a test drives the real registration. The `FastifyContextConfig` augmentation
  for `skipIngressRateLimit` is in `worker/ingress/rate-limit.ts` as specified.
  `an oversized request body is rejected before the handler runs` pins the 413 with
  `mockBegin` never called.
- **GET** — `reply.redirect(landingPageUrl(rawToken), 302)`; Fastify 5's `(dest, code)` argument
  order (package.json pins `fastify: ^5.8.5`), so the 302 is real, not a 200 with a stringified
  code. `encodeURIComponent` present and pinned by
  `encodes reserved characters when building the landing page redirect` (`a%2Fb%3Fc%23d` round-trips).
  Writes nothing — the test asserts `mockBegin` was never called. Deliberately does **not** gate
  the token, which is correct per §5.4's enumeration rule.
- **Boot gate** — `assertUnsubscribeTokenSecretConfigured()` is exported from
  `src/lib/solicitation/unsubscribe.ts`, guards on `requiresProductionConfig()` then `isMockMode()`,
  and is called from `worker/index.ts` inside the existing assertion block. Four tests cover the
  deployed-lane throw (including the short-secret case and the lane proof riding in the message)
  and the dev/mock silence.
- **`ci:db-imports`** — ran `npx tsx scripts/ci/db-imports-audit.ts`: *"passed (strict — no
  non-composition-root file imports db/server)"*. The adapter's `sql` import is legal because
  `worker/ingress/**` is a composition root (invariant #15).
- **Test run** — `npx vitest run` on the three worker suites: **3 files, 32 tests, all passing**
  (425ms). Neither concurrently-edited path was mutated during the run.

## Out of scope (per instructions)

The §1.6 counter living inside `worker/ingress/unsubscribe.ts` rather than its own module is
known and accepted; not evaluated, and no split recommended. The code as written is deliberately
structured so the boundary does not matter — the reporter is a pure factory with an injected
clock, so the tests drive it independently of where the file sits.
