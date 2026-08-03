# #644 T1a — code quality review of commit `2e181fc0`

**Scope.** `2e181fc0` against `2e181fc0^` (`ca1c5ab8`), six files, +532/−10. Quality
only — spec compliance was reviewed separately and passed
(`t1a-spec-review.md`). This review asks whether what was built is *well* built,
against `.claude/rules/design.md`, `.claude/rules/repworth.md`,
`.claude/rules/engineering.md`, and the nearest precedent
`src/lib/account-offboarding/tokens.ts`.

**Verdict: Changes needed** — one Critical finding (a third, production-visible log
shape that still carries the raw token) and its matching test gap.

**Gates run at review time (worktree, HEAD = `2e181fc0`):**

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npx eslint` on the four changed source/test files | exit 0 |
| `vitest run` on the three affected suites | 3 files, 51 tests, all pass |

Everything below marked *(measured)* was reproduced by running the code, not by
reading it.

---

## Findings

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | **Critical** | `worker/config/fastify-options.ts:24-46` | The `err` serializer is left at pino's default, so `err.message` / `err.stack` carry the raw URL past both new mechanisms — and that is the only one of the three shapes that survives the production `warn` level. |
| 2 | **Important** | `worker/config/__tests__/fastify-options.test.ts:38-63,86-104` | The harness only ever builds `buildFastifyOptions(false)` and only asserts the two info-level lines. It cannot fail for #1, despite its own comment naming the prod `warn` level as the thing that hid the class. |
| 3 | Minor | `worker/config/fastify-options.ts:38-43` | The custom `req` serializer silently drops `remotePort` (and `version`) relative to Fastify's default, for every ingress provider, with no note that the narrowing is deliberate. |
| 4 | Minor | `src/lib/shared/sentry-scrub.ts:84-86` | Everything after the first `#` is treated as a URL fragment and never scanned. Correct for URLs; the commit newly routes arbitrary log strings through this function, where it is not. |
| 5 | Minor | `src/lib/solicitation/unsubscribe.ts:64` | `isWellFormedUnsubscribeToken` names the syntactic half of a function that is really a constant-time MAC verification, and diverges from its own sibling `verifyUnsubscribeReceipt`. (Plan-pinned name — a follow-up, not an implementer error.) |

---

### 1. Critical — `err.message` / `err.stack` still carry the raw URL, at the one log level production emits

`worker/config/fastify-options.ts` closes two shapes:

- `serializers.req` → the `incoming request` line's `req.url`, and
- `hooks.logMethod` → **string** args, which covers the default 404 handler's
  `Route GET:<url> not found` message.

The third shape is the `err` key. `logMethod` skips it by construction — it only
rewrites `typeof arg === 'string'` — and `serializers.err` is left at
`pino.stdSerializers.err`, which serializes `message` and `stack` verbatim.

**Measured**, driving a real Fastify 5.8.5 instance built from
`buildFastifyOptions(...)` with a capturing stream:

```jsonc
// handler throws with the URL in the message → level 50
{"req":{"url":"/u/[REDACTED]", …},
 "err":{"message":"boom handling /u/SECRET_TOK",
        "stack":"Error: boom handling /u/SECRET_TOK\n    at …"},
 "msg":"boom handling /u/[REDACTED]"}
```

Note the shape of the failure: the same line shows the token redacted in `msg`
and in `req.url`, and unredacted twice inside `err`.

The second reproduction needs no application bug at all in the *message* — it is
Fastify's own error text:

```jsonc
// double send → node_modules/fastify/lib/reply.js:145, level 40 (warn)
{"err":{"message":"Reply was already sent, did you forget to \"return reply\" in \"/u/SECRET_TOK\" (GET)?",
        "stack":"FastifyError: … \"/u/SECRET_TOK\" (GET)? …"},
 "msg":"Reply was already sent, did you forget to \"return reply\" in \"/u/[REDACTED]\" (GET)?"}
```

`FST_ERR_REP_ALREADY_SENT` is `'Reply was already sent, did you forget to
"return reply" in "%s" (%s)?'` (`node_modules/fastify/lib/errors.js:263`), and
`reply.js:145` interpolates `this.request.url` into it. The worker registers no
`setErrorHandler` and no `setNotFoundHandler` (verified by grep over `worker/`),
so Fastify's defaults are what run in production.

**Why this is Critical rather than Important — the level argument inverts.**
The spec review recorded, correctly, that `buildFastifyOptions(true)` sets
`level: 'warn'` and that a prod-lane 404 therefore "produced zero log lines". That
same fact cuts the other way for the shape that was missed: `incoming request` and
`Route … not found` are both level **30 (info)** and are filtered out in
production, while `FST_ERR_REP_ALREADY_SENT` logs at **40 (warn)** and
`defaultErrorHandler`'s 5xx branch (`node_modules/fastify/lib/error-handler.js:94`)
at **50 (error)** — both above the production threshold. So the two shapes this
commit closed are the two that production never emits, and the shape it left open
is the one that production does. Invariant #5 ("raw tokens exist only in memory
and in the notification channel — never in Postgres, outbox payloads, **or
logs**") is not yet satisfied on the worker.

The spec review's Claim-A appendix states "the error path is covered by the
serializer" and "object args (`err`, `req`, `res`) pass through untouched, so
structured fields are unaffected". The first half is true only of `req.url`; the
second half is the bug, not a reassurance.

**Suggested fix** (keeps one authoritative owner for the rule, per
engineering.md):

```ts
import { stdSerializers } from 'pino';

serializers: {
  req: …,
  // err messages embed request.url verbatim — Fastify's own
  // FST_ERR_REP_ALREADY_SENT does, at warn level.
  err: (error: unknown) => {
    const serialized = stdSerializers.err(error as Error);
    return {
      ...serialized,
      message: redactSensitivePathsAndQueries(serialized.message),
      stack: redactSensitivePathsAndQueries(serialized.stack),
    };
  },
},
```

A broader alternative — recursing over object args inside `logMethod` — would also
catch a future `{ url }` field, but costs a deep walk on every log call and
duplicates what serializers exist for. The `err` serializer is the narrower,
deeper fix.

---

### 2. Important — the redaction test cannot fail for the leak that matters

`injectWithLogCapture` is a genuinely good harness: a real `Fastify(...)`, a real
`app.inject()`, and `expect(JSON.stringify(lines)).not.toContain('SECRET_TOK')`
rather than a weaker "a redaction happened" assertion. Two gaps:

1. It hard-codes `buildFastifyOptions(false)` — the **info** lane. Neither new test
   exercises the `warn` lane, which is what staging and production run.
2. No test drives an error. Both leaking shapes in #1 require one.

The harness's own doc comment says request logging is left ON because "the prod
default of `warn` hides this whole class, which is what let the leak survive three
reviews" — the comment identifies the exact hazard the test then does not cover.
This is the "test that would still pass if the implementation were subtly wrong"
case from the review brief.

The regression test for #1 should be: `buildFastifyOptions(true)`, a registered
route under an unsubscribe prefix that throws (and, separately, that double-sends),
then `expect(JSON.stringify(lines)).not.toContain('SECRET_TOK')`. That single
assertion covers all three shapes without pinning any of them.

---

### 3. Minor — the `req` serializer narrows ingress diagnostics for every provider

Fastify's default (`node_modules/fastify/lib/logger-pino.js:46-56`) emits
`method, url, version, host, remoteAddress, remotePort`. The replacement emits
`method, url, host, remoteAddress` — `remotePort` is dropped for **all** worker
ingress (Stripe, Resend, Twilio, Telegram, Zernio), not just the unsubscribe path,
and `version` is dropped for any future `accept-version` constrained route.

Nothing in the repo or the runbooks reads either field (grepped), so this is a
diagnostics narrowing rather than a break — but it is a side effect of a
redaction change, it is not mentioned in the commit message or the code comment,
and losing the source port makes it harder to tie a Railway ingress line to a
specific upstream connection during an incident. Either restore `remotePort` or
say in the comment that the four-field shape is the intended contract.

---

### 4. Minor — the fragment carve-out is correct for URLs, not for arbitrary log strings

`redactSensitivePathsAndQueries` splits at the first `#` and returns the fragment
untouched. For a real request URL that is right: a fragment never reaches a
server. But `hooks.logMethod` now routes **every** string a pino call passes
through this function, and for a free-text log line the `#` is not a fragment
delimiter. *(Measured)*:

```
"note #1 see /u/TOK"  ->  "note #1 see /u/TOK"      // unredacted
"Is this ok? key=v"   ->  "Is this ok? key=[REDACTED]" // over-redacted
```

No Fastify-emitted message contains a `#` today, so nothing leaks now; this is a
latent hole in a function that the new comment advertises as "the rule" for the
whole ingress logger. Worth a sentence in the doc comment stating that the input
is assumed URL-shaped, so T1c's adapter authors know not to rely on it for prose.

Related (no action): `createWorkerLogger` is not pino and is untouched by the
hook, so CLAUDE.md's "string args are logged verbatim" note still holds there.
T1c must not interpolate a raw token into a `createWorkerLogger` string.

---

### 5. Minor — `isWellFormedUnsubscribeToken` names the mechanism's weakest half

The function is the module's security boundary: a constant-time HMAC verification
that decides whether a request may touch Postgres at all. "Well-formed" reads as a
syntax check. Two design.md rules bite:

- *"Names should reveal abstractions rather than mechanisms"* — the doc comment has
  to spend a paragraph correcting the name ("The admission gate. Constant-time,
  stateless, ZERO database work"). design.md: when a comment exists to justify a
  name, redesign the name.
- *"Related operations should share conventions"* — the sibling verifier in the
  same file, doing the same kind of work (bounds check → parse → constant-time MAC
  compare), is `verifyUnsubscribeReceipt`. One is `verify*`, one is `isWellFormed*`.

Concrete risk: a T1c/T2 adapter author reads `isWellFormedUnsubscribeToken` as a
shape check and either (a) adds a second "real" verification, or (b) maps its
`false` to a 400 *malformed* branch distinct from the 404 *unknown token* branch —
which is exactly the oracle the stateless gate exists to avoid. `verifyUnsubscribeToken`
or `isAuthenticUnsubscribeToken` would carry the weight.

**Caveat:** the plan pins this name
(`docs/superpowers/plans/2026-08-03-644-unsubscribe-opt-out.md:100,344`) and the
implementer was instructed to ship exactly those five exports, so this is a
plan-level follow-up, not an implementation defect. It is also free to change
today — nothing calls the module yet.

---

## What was checked and found sound

These are the focus areas from the brief where I looked hard and found nothing.

**`timingSafeEqual` cannot be reached with unequal lengths.** `macMatches`
(`unsubscribe.ts:120-127`) length-compares first and the comment correctly
justifies why that leaks nothing (the MAC width is fixed and public). Both callers
route through it; there is no second comparison site.

**No path throws instead of returning `false`.** *(Measured)* — all 14 hostile
inputs in the token suite and all 12 in the receipt suite return `false` without
throwing, including `'x'.repeat(100_000)`, `'.'`, `''`, a bare nonce, a bare MAC,
a three-part token, and a token with a trailing newline. The only throw is the
deliberate fail-closed missing-secret case.

**Integer parsing is airtight.** `/^\d+$/` then `Number.isSafeInteger`
(`unsubscribe.ts:97-100`) rejects `''`, `' 12'`, `'1e3'`, `'0x10'`, `'-1'`,
`'Infinity'`, and `MAX_SAFE_INTEGER + 1` — and the inline comment names exactly
why `Number()` alone would not. This is the single best-reasoned block in the diff.
(A leading-zero timestamp `'000123'` is accepted and verifies, since the MAC is
computed over the canonical `123`; the value is identical, so there is no TTL or
authorisation consequence. Non-canonical, not a defect.)

**Ordering is bounded before it is expensive.** Length check → shape regex →
HMAC. `MAX_SIGNED_INPUT_LENGTH = 128` is checked first in both public verifiers,
so a megabyte of junk costs one integer compare — and the comment says so.

**No `/g` `lastIndex` carry-over.** Both hoisted regexes
(`sentry-scrub.ts:60,67`) are used exclusively with `String.prototype.replace`,
which resets `lastIndex` for a global regex; neither is used with `.test()`.
*(Measured)* repeated calls with the same input return identical results, and the
existing idempotency test (`redactSensitivePathsAndQueries` applied twice) still
passes. Hoisting them out of the literal position was safe.

**No catastrophic backtracking.** `UNSUBSCRIBE_TOKEN_PATH_RE` is an alternation of
literals followed by one unnested `[^?#\s]+` — linear. `TOKEN_SHAPE_RE`'s two
greedy classes are disjoint from the `.` separator, so there is no ambiguity to
backtrack through, and it is length-bounded before it runs. *(Measured)* 0.097 ms
on a 60 KB adversarial `'/x/'.repeat(20000) + '%'`.

**Redact-then-decode ordering holds.** *(Measured)*

```
"/ingress/%75nsubscribe/TOK"     -> "/ingress/unsubscribe/[REDACTED]"
"/u/%252Fabc"                    -> "/u/[REDACTED]"
"/dashboard/%E0%A4%A/u/TOK"      -> "/dashboard/%E0%A4%A/u/[REDACTED]"
"/dashboard/%E0%A4%A"            -> "/dashboard/%E0%A4%A"   // malformed, no throw
```

The `try/catch` around `decodeURIComponent` is a deliberate fallback with a
reason, not a silent catch — repworth.md-compliant. The one uncovered case is a
*doubly*-encoded prefix (`/ingress/%2575nsubscribe/TOK`, single decode pass), and
that URL cannot route, so no genuine token can arrive in that shape. A one-line
note in the doc comment saying the decode pass is single-depth by design would
close the question for the next reader.

**Faithful sibling of the HMAC precedent.** `src/lib/account-offboarding/tokens.ts`
uses the same `getSessionCookieSecret()` trust boundary, the same
`repworth:<domain>:v1` versioned context string, the same
`createHash('sha256')…digest('hex')` hash-only-persisted posture, and node:crypto
throughout (invariant #10). The new module improves on it in the way the precedent's
own comment anticipated — it adds the per-token random nonce that
`createKeepMyDataRawToken` explicitly lacks — and the two context constants are
kept distinct with a comment saying why. The one divergence is the absence of an
`assertUnsubscribeTokenSecretConfigured()` boot-assert export mirroring
`assertKeepMyDataTokenSecretConfigured()`; the spec review already carries that to
T1c as its Finding 2, and adding a sixth export here would have broken the
"exactly these five exports" instruction. Correctly deferred.

**Module depth.** Five exports is more surface than ideal, but they are two
cohesive triples/pairs sharing a secret, a length bound and one comparison helper,
and the format is genuinely hidden: `mintUnsubscribeRawToken` exists precisely so
that #630 cannot re-derive `<nonce>.<mac>` by hand, and the doc comment says so.
A caller does **not** need to understand the token format to use the module
correctly — the one thing that would break that property (a caller splitting on
`.` itself) is designed out by exporting the minter. That is the deep-module move.
Only the naming in #5 pushes reasoning back onto the caller.

**Tests exercise the public interface.** No mocks of internal shapes; the only
stub is `SESSION_COOKIE_SECRET` via `vi.stubEnv` + `vi.resetModules`, following
the convention the account-offboarding token suite established, and the comment
cites it. Two assertions are notably strong: the wire-format test builds the MAC
by hand from the documented format rather than from the minter (so it would catch
a minter that drifted from the spec), and both redaction suites assert the token
is *absent from the whole output*, not merely that a substitution occurred.

**Contributed size.** `unsubscribe.ts` 128 lines new; `sentry-scrub.ts` 208 → 246
(+38); `fastify-options.ts` 47 → 86 (+39). Nothing large, nothing made large.
No new top-level directory, no new dependency, no new file that could have been an
edit to an existing one — the unsubscribe module is the second concrete use of the
HMAC pattern, so extracting it is warranted rather than speculative.

**Rule compliance spot-checks.** No `any` anywhere in the diff (the test's
`logger as FastifyLoggerOptions` is a narrowing cast with a comment explaining the
union, not an escape hatch). `const` throughout except the deliberate `let index`
loop counter and `let decoded`. Named exports only. Early returns, no nesting past
one level. No business logic in the entry point — `buildFastifyOptions` composes
and delegates the rule to `redactSensitivePathsAndQueries`, keeping one
authoritative owner for the redaction (engineering.md), which is why fixing #1
belongs in the serializer rather than as a second copy of the regex.

---

## Suggested order of work

1. Add the `err` serializer (#1) and the `warn`-lane error-path test (#2) — same
   change, one regression assertion covers both.
2. Decide `remotePort` (#3): restore it, or document the four-field contract.
3. One-line doc additions for #4 (input assumed URL-shaped) and the single-depth
   decode pass.
4. Carry #5 to the plan owner as a rename before the first caller lands in T1c.

---
---

# Re-review of `8efd2b8d`

Scoped to the Critical (#1) and Important (#2) findings above, plus confirmation
of the two Minors. Diffed `8efd2b8d` against `2e181fc0`. (Repo HEAD is
`eb6fe196`; `git diff --stat 8efd2b8d HEAD` touches only
`docs/runbooks/vercel-waf-rate-limiting.md`, so every measurement below is a
measurement of `8efd2b8d`'s source.) The rename I suggested in #5 was rejected by
the coordinator and is not revisited.

**Verdict: Approved.** #1, #2 and both Minors are closed, and the substituted
mechanism is sound — in two respects strictly better than what I prescribed. One
new Important finding is logged as a required follow-up before T1c writes the
first real ingress error path; it is a hardening gap, not a regression, and my own
prescribed fix would have shared it.

Gates re-run at `8efd2b8d`: `tsc --noEmit` exit 0, `eslint` on the changed files
exit 0, the three suites 55/55 pass (was 51).

| # | Severity | Location | Finding |
|---|---|---|---|
| 6 | **Important** | `worker/config/fastify-options.ts:31-36` | `redact.paths` is enumerated, so any string outside `msg` / `err.message` / `err.stack` is logged raw. Measured leaks: `err.aggregateErrors[*].message`, a custom enumerable error property, and any arbitrary logged field. Not a regression — neither the removed `logMethod` nor my prescribed serializer wrapper covered these — but it makes an unwritten contract on T1c/T2. |

---

## The substitution is sound — and the stated rationale is factually correct

**The phantom-dependency argument checks out.** `node_modules/pino` does not
exist, `package.json` has no `pino` entry, and pino resolves only transitively
(`node_modules/.pnpm/pino@10.3.1`, `pino-std-serializers@7.1.0`). Under pnpm's
strict layout `import { stdSerializers } from 'pino'` would not resolve from the
repo root. My prescription was wrong on this point; rejecting it was correct.

**`redact` is the better seam, for a reason neither of us stated up front.** pino
applies `redact` *after* serialization and *after* printf interpolation. That
buys two things `logMethod` structurally could not:

- it reaches `msg` when pino *derives* it from the error rather than receiving it
  as a string argument (the double-send case — see point 3 below), and
- it reaches the cause-flattened `message`/`stack` that
  `pino-std-serializers@7`'s `errSerializer` builds via `messageWithCauses` /
  `stackWithCauses` (`lib/err.js:20-21`) — *(measured)* an `Error('outer', {cause:
  Error('inner at /u/SECRET_TOK')})` serialises to
  `err.message === 'outer failed: inner at /u/[REDACTED]'`.

And removing `logMethod` costs nothing on the string side. *(Measured)* at the
`warn` lane, all three string-argument shapes are still redacted:

```
log.warn('printf style %s here', '/u/SECRET_TOK')  -> msg "printf style /u/[REDACTED] here"
log.warn(`template style /u/SECRET_TOK here`)      -> msg "template style /u/[REDACTED] here"
log.warn({ note: 'ctx' }, 'obj+msg /u/SECRET_TOK') -> msg "obj+msg /u/[REDACTED]"
```

Printf interpolation happens before redaction, so the format-argument case — the
one plausible way removing the hook could have regressed — is covered. One
mechanism replacing two, with wider coverage, is the right call under design.md.

---

## Point 1 — does `redact` cover all three shapes, at both lanes?

**Yes; removing `logMethod` did not reopen the 404 case.** *(Measured)* on a real
Fastify 5.8.5 instance built from `buildFastifyOptions(...)`:

| Case | Lane | Result |
|---|---|---|
| 404 `/ingress/unsubscribe/SECRET_TOK/extra` | `false` (info) | 3 lines; `req.url` and `msg` (`Route GET:/ingress/unsubscribe/[REDACTED] not found`) both redacted; **no leak** |
| same | `true` (warn) | 0 lines (below threshold) |
| 5xx handler throw | `true` (warn) | `msg`, `req.url`, `err.message`, `err.stack` all redacted; **no leak** |
| double send (`FST_ERR_REP_ALREADY_SENT`) | `true` (warn) | level 40; `msg`, `err.message`, `err.stack` all redacted; **no leak** |

The 404 message survives the hook's removal because Fastify passes it as a string
argument (`four-oh-four.js:54`), which pino turns into `msg` before `redact`
runs.

Cosmetic side effect, already documented by the implementer in the
`redactSensitivePathsAndQueries` doc comment: a message ending in `?` loses it
(`… "/u/SECRET_TOK" (GET)?` → `… "/u/[REDACTED] (GET)`), because the `?` split
treats it as an empty query. Lossy but fail-safe, and now explicitly declared as
"do not rely on this function to leave prose intact". No action.

---

## Point 2 — shapes `redact` misses (Finding 6)

**Yes, three — all measured at the `warn` lane, all with `req.url` correctly
redacted on the same line:**

```jsonc
// AggregateError
"err":{"type":"AggregateError","message":"all legs failed",
       "aggregateErrors":[{"message":"leg A /u/SECRET_TOK"},{"message":"leg B"}]}

// custom enumerable property on the error
"err":{"message":"opaque failure","requestUrl":"/u/SECRET_TOK"}

// any non-err key written by application code
"failure":{"message":"boom /u/SECRET_TOK"}
```

The mechanism is `pino-std-serializers@7`'s `errSerializer`
(`lib/err.js:24-39`): `aggregateErrors` is emitted as a **separate array** of
recursively serialized errors, each with its own `message`/`stack`, and
`for (const key in err)` copies every enumerable property verbatim. Neither is on
the enumerated path list.

**Honest correction to my original report.** The coordinator framed this as
"wrapping the serializer is structural, `redact` is enumerated". That framing is
right in principle but not of the snippet I actually prescribed — my
`{...stdSerializers.err(e), message: redact(...), stack: redact(...)}` redacts
exactly the same two fields and would leak all three shapes above identically.
Only a wrapper that walks *every* string in the serialized error would be
structural, and pino's path-based `redact` cannot express that. So the
substitution is **not worse than my prescription** on this axis; it is equal, and
better on dependency hygiene. The third case (`{ failure: … }`) is outside both
approaches — no `err` serializer runs on a non-`err` key at all.

**Recommended follow-up, verified working before recommending it.** fast-redact's
`[*]` wildcard is accepted by pino here — *(measured)* adding
`'err.aggregateErrors[*].message'` and `'err.aggregateErrors[*].stack'` to
`paths` turns the aggregate case into `"leg A /u/[REDACTED]"`. That closes the one
enumerable gap. The custom-property and non-`err`-key cases cannot be closed by
enumeration, so they need a stated contract instead — one line in the
`fastify-options.ts` comment along the lines of: *the ingress logger redacts
`msg` and the serialized error's `message`/`stack` only; never place a request
URL in any other log field or error property.* That is exactly the kind of
caller-obligation engineering.md wants made explicit next to the abstraction that
depends on it, and T1c is the first code that will be bound by it.

Reachability today is low — nothing in `worker/` throws an `AggregateError`
carrying a request URL, and no unsubscribe route exists yet — which is why this
is Important-and-follow-up rather than blocking.

---

## Point 3 — my `msg` claim was wrong; the implementer is right

**Settled: pre-fix, the double-send `msg` leaked.** Re-measured by reconstructing
`2e181fc0`'s logger config verbatim (its `hooks.logMethod` + `serializers.req`,
against `git show 2e181fc0:src/lib/shared/sentry-scrub.ts`):

```
B PRE-FIX msg         = "Reply was already sent, did you forget to \"return reply\" in \"/u/SECRET_TOK\" (GET)?"
B PRE-FIX err.message = "Reply was already sent, did you forget to \"return reply\" in \"/u/SECRET_TOK\" (GET)?"
```

My original report's second code block transcribed that `msg` as
`/u/[REDACTED]`, and the sentence "the same line shows the token redacted in
`msg` … and unredacted twice inside `err`" is **wrong for the double-send
repro**. It was right for the *first* repro, and that is where the error came
from: the two Fastify sites differ.

- `defaultErrorHandler` (`error-handler.js:87,94`) logs
  `({req, res, err}, error?.message)` — an explicit **string argument**, which
  `logMethod` did redact. `msg` was `[REDACTED]` there. My report was correct.
- `reply.js:145` logs `({ err })` with **no string argument**, so pino derives
  `msg` from the raw error and `logMethod` never sees it. `msg` leaked. My report
  was wrong.

So pre-fix the double-send line leaked the token in **three** fields (`msg`,
`err.message`, `err.stack`), not two — my Critical finding understated it. The
implementer's measurement is the accurate one, and their inference from it (that
`msg` belongs on the redact path list and that this makes `logMethod` redundant)
is correct and is why the fix is complete.

---

## Point 4 — the Important finding is genuinely closed

The harness now takes `productionConfigRequired` as a **required** input rather
than hard-coding the info lane, with a doc comment explaining that the two levels
see disjoint sets of lines. Two new tests drive real error paths at
`buildFastifyOptions(true)`.

I confirmed the new assertions **fail against `2e181fc0`** rather than trusting
the commit message — running each assertion against the reconstructed pre-fix
config:

```
A err.message === "boom handling /u/[REDACTED]"   -> false  (actual "boom handling /u/SECRET_TOK")
A err.stack contains "/u/[REDACTED]"              -> false
A whole-output not.toContain('SECRET_TOK')        -> false
B err.message contains "/u/[REDACTED]"            -> false
B whole-output not.toContain('SECRET_TOK')        -> false
```

(`B level === 40` passes pre-fix, as expected — it is a shape guard on which line
was found, not a redaction assertion.) Four of the five new assertions are
genuine regression tests for the Critical finding. Closed.

---

## The two Minors

**#3 field parity — closed.** `version` and `remotePort` are restored; the
serializer is now field-for-field identical to
`fastify/lib/logger-pino.js:46-56` apart from the redacted `url`. The parity test
correctly asserts against the serializer *directly* rather than through
`app.inject()` — under inject there is no socket and no `accept-version`, so both
fields would serialize to `undefined` and JSON would drop the keys, and the test
comment says exactly that. The `Array.isArray(acceptVersion)` join is a small
deliberate divergence (Fastify would pass an array through); Node joins repeated
headers itself for `accept-version`, so the branch is defensive and the comment
says so. Fine.

**#4 fragment carve-out — closed, and the monotonicity argument holds.**
*(Measured)* across 13 inputs spanning both shipped fragment contracts, the
approve rule, the query scrubber and the malformed-percent path: three outputs
changed, **all three gain redaction, none lose any**, and both shipped contracts
are byte-identical.

```
CHANGED "note #1 see /u/TOK"                 -> "note #1 see /u/[REDACTED]"
CHANGED "Error #42 at /ingress/unsubscribe/TOK" -> "Error #42 at /ingress/unsubscribe/[REDACTED]"
CHANGED "/x#%2Fu%2FTOK"                      -> "/x#/u/[REDACTED]"
  same  "/approve/tok#section"               -> "/approve/[REDACTED]#section"
  same  "/u/tok#done"                        -> "/u/[REDACTED]#done"
  same  "/api/approve/abc/edit", "GET /approve/tok 200", "/users/123",
        "/u/tok?code=s#f", "plain text", "/dashboard/%E0%A4%A"    (unchanged)
```

The argument is sound because `redactTokenPaths` only ever performs
`String.replace` substitutions within the fragment span — there is no branch that
can remove a substitution the previous version made. Extraction of
`redactTokenPaths` also removed the path/fragment duplication rather than
copy-pasting the two rules, which is the engineering.md "one authoritative owner"
move. Still linear: 0.081 ms on a 60 KB all-fragment adversarial input.

Residual, on-disk only (no action): query-key redaction is still *not* applied
inside a fragment, so `/x#a?token=SECRET` keeps its value. Pre-existing and
untouched by this fix, and it cannot expose an unsubscribe token (which lives in
a path, and paths inside fragments are now covered). Worth a follow-up only if
the query scrubber is ever asked to cover free prose too.

