# #644 T1a — spec review of commit `2e181fc0`

**Verdict: ✅ Spec compliant.** Every requested item is present, nothing beyond the
allowed surface was built, and the one item the implementer added beyond the plan
(the pino `hooks.logMethod`) is **empirically necessary** — measured, not reasoned.

Reviewed by reading the code and running it, not by trusting the implementer's report.
Commit diffed against parent `ca1c5ab8`. Six files, +532/−10, all inside
`allowed_edit_surface`:

```
M src/lib/shared/__tests__/sentry-scrub.test.ts
M src/lib/shared/sentry-scrub.ts
A src/lib/solicitation/__tests__/unsubscribe.test.ts
A src/lib/solicitation/unsubscribe.ts
M worker/config/__tests__/fastify-options.test.ts
M worker/config/fastify-options.ts
```

No new dependencies (`package.json` / `pnpm-lock.yaml` untouched). No new top-level
directory. Working tree clean at review time.

---

## Findings

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | Low | `src/lib/shared/sentry-scrub.ts:67` | The `/u/` alternative is unanchored, so any logged string containing `/u/` is truncated to the next whitespace — including Google Maps URLs of the form `https://www.google.com/maps/u/0/contrib/12345`, which become `.../maps/u/[REDACTED]`. Fails safe, but degrades Sentry breadcrumb/transaction diagnostics in a codebase that routinely handles Google Maps URLs. |
| 2 | Medium | `docs/superpowers/plans/feat-644-unsubscribe-opt-out-deviations.md` D4 (not in the reviewed commit) | The mitigating premise carried into T1c is false: "The worker asserts `SESSION_COOKIE_SECRET` at boot (`worker/config/startup-assert.ts:449`), so the ingress cannot hit this in practice." That assert lives inside `assertAccountOffboardingEnv()`, which returns early unless `ACCOUNT_OFFBOARDING_ENABLED === 'true'` (documented **Off** in `.claude/reference/env-vars.md:517`) and is additionally skipped under `MOCK_EXTERNAL_APIS=true`. No other boot assert covers the var. |

Neither is a deviation of the commit from its spec. Finding 1 is an inherent
consequence of a requirement the spec itself imposes (see §2.3). Finding 2 is a
documentation defect that will mislead T1c.

### Finding 1 — detail

`UNSUBSCRIBE_TOKEN_PATH_RE = /(\/ingress\/unsubscribe\/|\/api\/u\/|\/u\/)[^?#\s]+/gi`
cannot be anchored to path start, because the shipped console-message contract
(`GET /u/tok 200`, mirroring `GET /approve/tok 200`) requires matching mid-string.
The spec's own acceptance case — `/users/123` must not match — passes, because
`/users/` contains no `/u/` substring. Measured behaviour:

```
"/users/123"                                    -> "/users/123"
"/admin/users/123/detail"                       -> "/admin/users/123/detail"
"https://www.google.com/maps/u/0/contrib/12345" -> "https://www.google.com/maps/u/[REDACTED]"
"error at /srv/u/lib/x.js:12"                   -> "error at /srv/u/[REDACTED]"
```

Blast radius is bounded to two sinks: the Fastify ingress logger and
`scrubSentryEvent` (`request.url`, `transaction`, breadcrumb `url`/`from`/`to`/
`http.url`, breadcrumb `message`). It never loses a secret, only context. Anchoring
`/u/` to string start or to a `\s` boundary would recover most of it while keeping
the console-message contract; worth considering if Sentry noise materialises, not
worth churning the file for now.

### Finding 2 — detail

Consequence if T1c ships on the stated premise: a Railway worker deployed without
`SESSION_COOKIE_SECRET` (or with one under 32 bytes) **boots successfully today**,
then throws inside `isWellFormedUnsubscribeToken` on every well-shaped token —
returning 503 per request with a Sentry event, i.e. every statutory opt-out fails
with no boot-time signal and no distinguishable symptom from a genuine unknown-token
flood. Fail-closed is the right posture; the missing boot gate is the gap.

Recommended carry-forward for T1c (not for this commit — adding a sixth export here
would itself violate the "exactly these five exports" instruction): add
`SESSION_COOKIE_SECRET` to an unconditional worker boot assert, or gate it on the
unsubscribe ingress being registered, mirroring the existing
`assertKeepMyDataTokenSecretConfigured()` precedent
(`src/lib/account-offboarding/tokens.ts:29`). D4's Vercel half is already correct —
`src/lib/config/server.ts:104` reads the var as optional, and D4 correctly instructs
T2 to let the error propagate loudly.

---

## 1. `src/lib/solicitation/unsubscribe.ts` — new module

### 1.1 Exports

Exactly the five requested, in the requested order, with the requested signatures:

| Export | Line | Verdict |
|---|---|---|
| `hashUnsubscribeToken(rawToken: string): string` | 38 | ✓ SHA-256 hex, `node:crypto` |
| `mintUnsubscribeRawToken(): string` | 49 | ✓ `<nonce>.<MAC>` |
| `isWellFormedUnsubscribeToken(rawToken: string): boolean` | 64 | ✓ constant-time, zero DB |
| `mintUnsubscribeReceipt(tokenHash, issuedAtMs): string` | 81 | ✓ |
| `verifyUnsubscribeReceipt(tokenHash, receipt): boolean` | 86 | ✓ |

`findRedeemableUnsubscribeToken` and `redeemUnsubscribeToken` are **absent** — correct,
they belong to T1b. No database import of any kind: the module's only imports are
`node:crypto` and `@/lib/shared/session-cookie-secret`. `pnpm ci:db-imports` PASS.

Private helpers: `signNonce`, `signReceipt`, `macMatches`. Each has two call sites, so
none is a one-caller extraction. No speculative abstraction, no options bag, no flags.

### 1.2 Token format

`randomBytes(16).toString('base64url')` → 22-char nonce (≥16 bytes ✓, base64url ✓),
MAC = `HMAC-SHA256(getSessionCookieSecret(), 'repworth:solicitation-unsubscribe-token:v1:' + nonce)`
as base64url (43 chars). Whole token `[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}` — URL-safe,
no escaping needed.

The spec wrote the payload as `HMAC-SHA256(secret, nonce)`; the code signs
`<context>:<nonce>`. That is the versioned-context-string convention the spec named as
the precedent to follow (`src/lib/account-offboarding/tokens.ts:4`), so it is a
faithful reading, not a deviation.

### 1.3 Context-string separation

Three domains, three distinct versioned prefixes, no possible collision:

```
repworth:solicitation-unsubscribe-token:v1:<nonce>
repworth:unsubscribe-receipt:v1:<tokenHash>:<issuedAtMs>
repworth:account-offboarding-keep-my-data-token:v1:<id>:<deliveryId>   (pre-existing)
```

A MAC minted in one domain can never verify in another — the prefixes differ before
the first variable byte.

### 1.4 Receipt format

`${issuedAtMs}.${HMAC-SHA256(secret, 'repworth:unsubscribe-receipt:v1:' + tokenHash + ':' + issuedAtMs).base64url}` —
byte-for-byte the requested format. Verification uses `timingSafeEqual` via
`macMatches`, TTL is `10 * 60 * 1000`. The test asserts the wire format by
reconstructing it from `createHmac` independently of the minter, which is the right
way to pin a format.

### 1.5 Totality — verified by reading the code paths

`isWellFormedUnsubscribeToken` (line 64):

1. `rawToken.length > 128` → `false`. Bounds cost before any regex or HMAC.
2. `TOKEN_SHAPE_RE.test` — `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`. No `g` flag, so no
   `lastIndex` statefulness. `$` in JavaScript is strict end-of-input (unlike Perl/
   Python), so a trailing `\n` is rejected — and the test pins exactly that case.
   Two greedy character classes separated by a literal `.` that is outside both
   classes: no catastrophic backtracking, and length is already bounded to 128.
   Guarantees exactly one separator, both halves non-empty and base64url.
3. `macMatches` compares `Buffer.length` **before** `timingSafeEqual`, so the
   unequal-length throw is unreachable. The length comparison leaks nothing: the MAC
   width is fixed and public.

`verifyUnsubscribeReceipt` (line 86):

1. `receipt.length > 128` → `false`.
2. `indexOf('.') === -1` → `false` (covers `''`).
3. `/^\d+$/` on the prefix → rejects empty, ` 12`, `1e3`, `0x10`, `-1`, `abc`.
4. `Number.isSafeInteger` → rejects `${Number.MAX_SAFE_INTEGER}0`.
5. `macMatches` length-guards again.

No path can throw on any string input. Confirmed by reading, then corroborated by the
suite's 26 hostile-input cases (which include 100 000-char inputs on both sides of the
separator). The only throw either function can produce is the config error in §Claim C.

### 1.6 Invariants

- **#10** — `node:crypto` only, no `crypto-js`. `pnpm ci:static-policy` PASS.
- **#5** — only the SHA-256 digest is returned for persistence; the raw token is never
  logged, never stored, never embedded in the hash output. The test asserts neither
  half of the raw token survives into the digest.
- **#15** — no DB client involved, so nothing to inject.

### 1.7 Explicitly out-of-scope items — all absent

Grepped and read: no `SESSION_COOKIE_SECRET_PREVIOUS`, no dual-secret verification, no
`SOLICITATION_UNSUBSCRIBE_TOKEN_SECRET`, no fail-open branch. The module docblock
(lines 12–15) states the constraint and forbids adding them, pointing at deviations D1.

---

## 2. `src/lib/shared/sentry-scrub.ts`

### 2.1 The `/approve/` rule is unchanged

Parent (`git show 2e181fc0^:src/lib/shared/sentry-scrub.ts:76`):

```ts
const redactedPath = path.replace(/(\/approve\/)[^/?#\s]+/gi, '$1[REDACTED]');
```

Current (`:60`, `:92`): the identical literal hoisted to `APPROVE_TOKEN_PATH_RE` and
applied with the identical replacement string. Only the binding moved.

Hoisting a `/g` regex to module scope is the one way this could have changed
behaviour (`lastIndex` statefulness). It does not: `RegExp.prototype[Symbol.replace]`
sets `lastIndex = 0` for global regexes, and neither new constant is ever used with
`.test()`. I confirmed this differentially rather than by argument — old inline vs new
hoisted, over 10 inputs including the two shipped contracts, **three consecutive
passes** to expose any `lastIndex` carry-over: **IDENTICAL**, 0 diffs.

Both shipped contracts re-verified live:

```
"/api/approve/abc123/edit" -> "/api/approve/[REDACTED]/edit"    (keeps /edit)
"GET /approve/tok 200"     -> "GET /approve/[REDACTED] 200"     (keeps the status)
```

### 2.2 The second rule

`UNSUBSCRIBE_TOKEN_PATH_RE = /(\/ingress\/unsubscribe\/|\/api\/u\/|\/u\/)[^?#\s]+/gi` —
a separate constant, applied by a separate function, exactly the three requested
prefixes, longest first so `/api/u/` is captured whole. `/` is deliberately outside the
character class (redacts across segments); `?`, `#` and `\s` remain in it. Verified:

```
"/u/abc%2Fdef"                   -> "/u/[REDACTED]"
"/u/abc/def"                     -> "/u/[REDACTED]"
"/ingress/unsubscribe/a/b/c"     -> "/ingress/unsubscribe/[REDACTED]"
"GET /u/tok 200"                 -> "GET /u/[REDACTED] 200"
"/u/tok?code=x#frag"             -> "/u/[REDACTED]?code=[REDACTED]#frag"
```

### 2.3 Encoded-spelling order

`redactUnsubscribeToken` (`:105`) implements the four steps in the required order:

| Step | Spec | Code |
|---|---|---|
| a | apply `/approve/` to the raw string | `:92`, before the call |
| b | if the new rule matches that result, redact and return, raw spelling preserved | `:106–107` |
| c | otherwise percent-decode in `try/catch`, retest, return the **decoded** form | `:109–117` |
| d | otherwise return (a) unchanged | `:117` (`decodedRedacted === decoded ? path`) |

The decoded form is only ever returned when it *matched*, so a non-matching
percent-encoded path is never silently rewritten: `/dashboard/%E0%A4%A` (malformed) and
any well-formed non-matching encoded path both come back byte-identical. Single-decode
is the correct depth — a double-encoded prefix (`%2575nsubscribe`) does not route to the
unsubscribe handler either, so matching it would over-reach.

### 2.4 Non-matching input

Unchanged, verified across the probe set above. `/users/123` and
`/admin/users/123/detail` both pass through untouched — the spec's named case.

---

## 3. `worker/config/fastify-options.ts`

`logger.serializers.req` emits exactly `method`, redacted `url`, `host`,
`remoteAddress`. Observed on a live instance:

```json
"req":{"method":"GET","url":"/ingress/unsubscribe/[REDACTED]","host":"localhost:80","remoteAddress":"127.0.0.1"}
```

All pre-existing options preserved, not clobbered: `requestTimeout: 30_000`,
`keepAliveTimeout: 60_000`, `connectionTimeout: 10_000`, `bodyLimit: 5 MB`, and the
`warn`/`info` level selection. The pre-existing wiring test (oversized body → 413,
`app.server.requestTimeout === 30_000`) still passes untouched.

The three `logger` equality assertions were relaxed from `toEqual({level})` to
`loggerOptions(opts).level` — necessary, since the logger object legitimately grew
two keys. The narrowing helper avoids inline casts and keeps `pnpm typecheck` clean
with no `any`.

---

## Claim A — the `logMethod` hook (EMPIRICALLY CONFIRMED)

**Method.** Stood up four real Fastify 5.8.5 instances from `buildFastifyOptions`,
each with pino's stream swapped for an in-memory capture, and `inject()`ed
`GET /ingress/unsubscribe/SECRET_TOK_ABC123/extra` (unmatched). Selectively deleted
`hooks` / `serializers` from the returned logger options to isolate each mechanism.

| Variant | Status | Raw token in log output? |
|---|---|---|
| A — as shipped (serializer + hook) | 404 | **no** |
| B — serializer only, hook removed | 404 | **YES** |
| C — hook only, serializer removed | 404 | **YES** |
| D — neither (parent-commit behaviour) | 404 | **YES** |

Variant B, verbatim:

```json
{"level":30,...,"req":{"method":"GET","url":"/ingress/unsubscribe/[REDACTED]",...},"msg":"incoming request"}
{"level":30,...,"msg":"Route GET:/ingress/unsubscribe/SECRET_TOK_ABC123/extra not found"}
```

The claim is **true and load-bearing**: the plan's serializer alone leaves the raw
token in the default 404 handler's message string. Variant C shows the converse — the
hook alone leaves it in `req.url`. Both mechanisms are required; neither is redundant.

**Is the existing test real?** Yes. `worker/config/__tests__/fastify-options.test.ts:38–63`
builds an actual `Fastify(...)` from `buildFastifyOptions(false)` with a capturing
stream and calls `app.inject()`. It asserts the 404 status, `req.url` **and**
`msg === 'Route GET:/ingress/unsubscribe/[REDACTED] not found'`, plus a whole-output
`not.toContain('SECRET_TOK')`. Removing the hook fails the `msg` assertion and the
containment assertion. Not a synthetic string test.

**Two additional facts worth recording**, both measured:

1. **Prod/staging emit nothing on this path anyway.** `buildFastifyOptions(true)` sets
   `level: 'warn'`, and both the `incoming request` line and the default 404 message are
   level 30 (info). The prod-lane 404 run produced **zero** log lines. The leak is
   therefore live only on the info-level lanes (local/dev). This is *not* an argument
   against the fix — plan §1.5 already calls the `warn` default "a coincidence, not an
   invariant" — but it bounds the exposure.
2. **The error path is covered by the serializer.** A prod-lane (`warn`) route that
   throws under `/ingress/unsubscribe/<token>` logs at level 50 with
   `"url":"/ingress/unsubscribe/[REDACTED]"`. That closes intake `edge_cases[7]`
   ("the raw token must never reach Fastify's default error handler, whose pino
   serializer logs request.url") ahead of T1c.

### Over-redaction and hot-path cost

**Cost: negligible, and lower than it first appears.** Measured
`redactSensitivePathsAndQueries` at **465 ns/call** on a typical non-matching log
string, and **19 µs** on a 20 KB string. More importantly, pino **skips `logMethod`
entirely for below-level calls** — verified directly: a `level: 'warn'` logger with a
counting hook fired the hook 2 times for 4 calls (`info`, `debug` skipped; `warn`,
`error` ran). So on prod/staging the hook only runs on warn/error/fatal, which on a
webhook ingress is a trickle. No flag needed.

**Over-redaction: real but low-impact** — see Finding 1. Only strings are touched;
object args (`err`, `req`, `res`) pass through untouched, so structured fields are
unaffected. `method.apply(this, args)` preserves pino's `this` binding and printf-style
interpolation.

**`createWorkerLogger` is unaffected — confirmed by reading it.**
`src/lib/shared/logger.ts` is not pino at all: `emit()` builds a plain record and writes
via `console.log`/`warn`/`error`. It shares no code path with the Fastify logger, so the
hook cannot reach it. CLAUDE.md's standing note that its **string args are logged
verbatim** therefore still holds — a corollary T1c must respect: the ingress adapter's
own §9.5 line must not interpolate the raw token, because nothing will redact it.

---

## Claim B — single-sided receipt TTL (CONFIRMED)

`unsubscribe.ts:97`:

```ts
if (Date.now() - issuedAtMs > RECEIPT_TTL_MS) return false;
```

Rejects age > 10 min; a future-dated `issuedAtMs` yields a negative age and passes. No
lower bound anywhere. The comment at `:94–96` states the rationale (clock skew between
hosts) rather than restating the code.

A future-dated receipt is mintable only by a holder of `SESSION_COOKIE_SECRET`: the
timestamp is inside the signed payload
(`repworth:unsubscribe-receipt:v1:<tokenHash>:<issuedAtMs>`), so altering it invalidates
the MAC. Not attacker-reachable. Residual risk is bounded twice over — by plan §1.8's
rule that a receipt is never sufficient on its own (a render-time ledger read still
governs the success claim), and by the fact that the only future-dating source is our
own clock.

*Observation, not a finding:* `issuedAtMs` is caller-supplied and unvalidated at mint
time. `mintUnsubscribeReceipt(hash, Date.now() + ONE_YEAR)` produces a receipt that
effectively never expires, and `mintUnsubscribeReceipt(hash, NaN)` produces
`"NaN.<mac>"` — a receipt that can never verify, failing silently to the neutral page.
Both are caller-discipline constraints for T2 (pass `Date.now()`), not defects in this
module.

*Observation:* `verifyUnsubscribeReceipt` accepts a leading-zero timestamp
(`"0" + issuedAtMs` verifies, since the MAC is computed over the parsed number). Benign
receipt malleability — no security consequence — but do not use the receipt string as a
dedup or cache key.

---

## Claim C — fail-closed on a missing secret (CONFIRMED)

`isWellFormedUnsubscribeToken` reaches the secret only via `signNonce()` →
`getSessionCookieSecret()` (`src/lib/shared/session-cookie-secret.ts:9`), which throws
`'SESSION_COOKIE_SECRET is not set'` when unset and
`'... must be at least 32 bytes'` when too short.

**It is a config error, not a per-input error.** Both shape checks — the 128-char length
bound and `TOKEN_SHAPE_RE` — run *before* the secret is read, and both `return false`.
So no input can produce a throw on a correctly configured deployment: malformed input
returns `false`, well-formed-but-forged input returns `false` after one constant-time
compare. The throw requires the deployment to already be broken.

(Given a broken deployment, hostile traffic *can* trigger it repeatedly with any
well-shaped random string. That is the correct fail-closed behaviour — the alternative,
returning `false`, would silently reclassify every genuine statutory opt-out as
malformed. Finding 2 above is about the missing boot gate that would surface the
misconfiguration before traffic does.)

The tests pin both halves: `mintUnsubscribeRawToken` and a correctly-shaped token both
throw `/SESSION_COOKIE_SECRET/` under `vi.stubEnv('SESSION_COOKIE_SECRET', '')`.

---

## Test titles — all eight verbatim

Grepped as fixed strings (`rg -F`) across `src/` and `worker/`. Each appears exactly
once. No smart quotes, no casing drift, no doubled spaces.

| # | Title | Hits |
|---|---|---|
| 1 | `hashes the raw token with SHA-256 and never returns or stores the raw value` | 1 |
| 2 | `a well formed token passes the hmac gate` | 1 |
| 3 | `the minted raw token round trips through the hmac gate` | 1 |
| 4 | `redacts the unsubscribe token from Sentry event paths` | 1 |
| 5 | `redacts a percent-encoded unsubscribe path from Sentry` | 1 |
| 6 | `redacts a token containing an encoded slash to the end of the path` | 1 |
| 7 | `leaves approve path redaction segment-bounded` | 1 |
| 8 | `a trailing segment url is redacted by the global request serializer` | 1 |

All eight also match their `tests_to_add` entries in
`docs/superpowers/plans/feat-644-unsubscribe-opt-out-intake.json` (indices 28, 63, 64,
5, 11, 12, 17, 66), which is what `scripts/verify-gate.sh`'s `promised-tests` row greps.

**No `*.integration.test.ts` file added.** The new suite is
`src/lib/solicitation/__tests__/unsubscribe.test.ts` — correct, since it must run in the
parallel project. **No test touches a database:** the suite's only imports are
`node:crypto` and `vitest`; no `TEST_DATABASE_POOL_URL`, no `assertSchemaReady`, no
`sql` client, no `acquireLiveDbLock`.

---

## Code-quality gates

| Gate | Result |
|---|---|
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| the three touched suites (51 tests) | PASS |
| `pnpm ci:static-policy` | PASS |
| `pnpm ci:process-env` | PASS |
| `pnpm ci:db-imports` | PASS |
| `pnpm ci:feature-surface` | PASS |
| `pnpm ci:tenant-scope` | PASS |

- **No `any`.** The single grep hit is the prose "any string returns a boolean" in a
  docblock.
- **Comments explain why, not what.** Every comment in the three production files
  carries a reason a reader could not recover from the code: why `/approve/` stays
  segment-bounded, why the unsubscribe rule crosses `/`, why the decoded form is what
  gets returned, why the length compare precedes `timingSafeEqual`, why the TTL is
  single-sided, why the gate throws. None restates mechanics.
- **No over-engineering.** No helper with a single caller, no speculative parameter, no
  new abstraction layer. `MAX_SIGNED_INPUT_LENGTH` is shared by both verifiers, which is
  the right amount of sharing.
- **`worker/config/fastify-options.ts` stays free of `process.env`** — the existing
  contract in its docblock is preserved. `src/lib/shared/sentry-scrub.ts` has zero
  imports, so pulling it into the worker's boot path adds no dependency weight.

---

## Reproduction

The empirical work above is reproducible from a scratch script that imports
`buildFastifyOptions` directly and swaps pino's stream — no repo files were added for
it. Shape:

```ts
const options = buildFastifyOptions(false);
const raw: string[] = [];
const app = Fastify({ ...options, logger: { ...options.logger, stream: { write: l => raw.push(l) } } });
await app.inject({ method: 'GET', url: '/ingress/unsubscribe/SECRET_TOK_ABC123/extra' });
// delete (options.logger as any).hooks between runs to isolate each mechanism
```
