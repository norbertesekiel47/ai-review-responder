# Standards & Maintainability Review — P8: bound under-lock Stripe calls in tier-change

**Reviewer role:** Standards & maintainability (review-only, no edits)
**Rubric applied:** `thermo-nuclear-code-quality-review` skill + `.claude/CLAUDE.md` + `.claude/rules/{engineering,production,design,repworth}.md`
**Scope:** `git diff main...HEAD` — fork point `880435ba`
**Production surface:** `src/lib/accounts/tier-change.ts` (the `STRIPE_UNDER_LOCK_REQUEST_OPTIONS` constant, `stripeOptions()` spread, `subscriptions.retrieve` 3-arg call)
**Tests:** `src/lib/accounts/__tests__/tier-change-stripe-timeout.test.ts` (new, 356 lines) + edits to `src/lib/accounts/__tests__/tier-change.test.ts`

---

## Verdict

**APPROVE.** No structural regression, no file-size explosion, no spaghetti-branch growth, no
canonical-helper duplication, no `any`/cast churn that obscures the real contract. The change is a
tight, single-owner constant threaded through the two seams that already existed. Every technical
claim in the load-bearing caveat comment was independently verified against the pinned SDK source
and holds. **No findings I would stake >=80% confidence on.** The items below are sub-80% judgment
calls recorded for the author's discretion, not blockers.

---

## What the change does (as reviewed)

Three under-lock Stripe requests inside `applyTierChangeInTx` (`subscriptions.retrieve`, the base
`subscriptionItems.update`, and the overage update/create/del) previously ran with the client-wide
defaults (`timeout: 20_000`, `maxNetworkRetries: 2` from `stripe-client.ts`). Under two pg advisory
locks + `FOR UPDATE`, a slow provider could pin the locked transaction open for ~60s+. The PR
introduces one shared constant `STRIPE_UNDER_LOCK_REQUEST_OPTIONS = { timeout: 8_000,
maxNetworkRetries: 0 }`, spreads it into the mutation options via `stripeOptions()`, and passes it
directly (3-arg form) to the GET `retrieve`.

---

## Rubric pass — the specific questions asked

### 1. Is extending `stripeOptions()` the right seam? — YES

`stripeOptions()` already owned "the RequestOptions object for a mutating tier-change step." Adding
the timeout/retry bound to that object is the correct home: all three mutations carry both an
idempotency key and the bound, and both are per-call request options. The GET `retrieve` correctly
bypasses `stripeOptions()` (it has no idempotency key) and consumes the raw constant. The seam is
not muddied — `stripeOptions()` remains "options for a mutating step," now complete rather than
partial. No new indirection, no new branch.

### 2. Is the single-constant approach clean (one owner of the bound)? — YES

`STRIPE_UNDER_LOCK_REQUEST_OPTIONS` is the sole owner of the literal `8_000` / `0` in production;
grep confirms no other timeout/retry literal in the file. `stripeOptions()` spreads it and
`retrieve` references it — one authoritative representation (engineering.md "one authoritative owner
per fact"). The test file re-states `{ timeout: 8000, maxNetworkRetries: 0 }` as its own
`EXPECTED_BOUND` / `toBe(8000)` literals; that is **correct** test practice — importing the SUT
constant would make the assertions tautological. Not a duplication smell.

### 3. Is the `retrieve(id, {}, options)` 3-arg form idiomatic / clearly commented? — YES

The SDK's `retrieve` signature is `(id, params?, options?)`; the request-options bound must ride in
the third slot, forcing `{}` as params. The inline comment states exactly this and notes the GET has
no idempotency key. Idiomatic and correctly explained — the `{}` would otherwise read as a mystery
argument.

### 4. Test quality — SOUND, with a pre-existing brittleness caveat

- **Not tautological / not over-mocked at the assertion layer.** The tests fail without the change:
  they assert the bound reaches every recorded SDK call (`lastArgOf(...).toMatchObject(EXPECTED_BOUND)`),
  and separately preserve each exact per-step idempotency key. Good separation: identity keys and the
  timeout bound are asserted independently.
- **The `fast-check` property test earns its keep.** Randomizing `activeLocations` (0–50) ×
  `hasOverageItem` and asserting *every* recorded request carries `timeout===8000 &&
  maxNetworkRetries===0` is exactly the invariant the PR establishes, across all four overage
  branches. `numRuns: 25` is adequate for a 2-variable space.
- **Brittleness (pre-existing pattern, not a regression):** `queueApply` / `queueExecution` encode
  the exact count and ordering of SQL round-trips via `sqlReturnQueue.push(...)`. Adding or removing
  a query inside `applyTierChangeInTx` will break these tests in a positionally-opaque way. This is
  the established `createMockSql` harness convention already used by the sibling `tier-change.test.ts`,
  so the PR follows house style rather than introducing new coupling — noted, not charged against it.

### 5. Does wrapping existing assertions in `expect.objectContaining` weaken them inappropriately? — NO

The four edits in `tier-change.test.ts` relax the 3rd-arg options assertion from exact-match
`{ idempotencyKey }` to `objectContaining({ idempotencyKey })`. This is the **minimal correct** change:
those tests own the idempotency-key contract; the options object now legitimately also carries the
bound, so an exact match would be a false failure. The bound itself is exhaustively owned by the new
test file. This is a clean division of concerns, not an inappropriate loosening — the relaxed tests
still fail if the idempotency key regresses.

### 6. Comment quality on the constant — ACCURATE and load-bearing; borderline over-detailed

Verified against `node_modules/stripe/cjs`:
- `RequestSender._shouldRetry` (line 155) returns `true` when `error && numRetries===0 &&
  CONNECTION_CLOSED_ERROR_CODES.includes(error.code)` **before** the `numRetries >= maxRetries` guard
  — so `maxNetworkRetries: 0` is genuinely **not** an absolute single-attempt guarantee. The comment
  is correct.
- `HttpClient.CONNECTION_CLOSED_ERROR_CODES = ['ECONNRESET', 'EPIPE']` and `TIMEOUT_ERROR_CODE =
  'ETIMEDOUT'` — confirming the comment's key distinction that the *timeout* case (this bound's
  target) gets exactly one attempt, while only a reset/pipe error adds one retry.

The caveat is genuinely useful: it corrects a non-obvious SDK behavior that materially changes the
worst-case lock-hold reasoning. See appendix for the two soft reservations (SDK-internal coupling and
the loose "≈26s" figure).

---

## Fowler smell / codebase-design pass

- **Deep vs shallow module:** `stripeOptions()` stays a small pure helper; it hides the key-format
  and now the bound behind one call. Acceptably deep for its size.
- **No change amplification / no new conditional:** zero new branches added to the already-busy
  `applyTierChangeInTx` / `mutateStripe` / `buildTierChangeProviderPlan` flows. The bound rides
  existing call sites.
- **No feature logic leaking into a shared path:** the bound is local to tier-change (the under-lock
  concern is specific to this flow); it correctly does **not** touch the shared
  `STRIPE_CLIENT_CONFIG` singleton, which other call sites depend on at 20s/2-retries.
- **File size:** `tier-change.ts` is 757 lines, well under the 1k threshold; +19 net lines. No
  decomposition pressure.
- **Naming/glossary:** `STRIPE_UNDER_LOCK_REQUEST_OPTIONS` names the abstraction (the *why* —
  under-lock) not the mechanism. Good. `stripeOptions` is generic but pre-existing (see appendix).

---

## Low-confidence appendix (NOT in the findings table — author discretion)

**A. The caveat comment couples to a Stripe SDK private method + pinned version.**
`src/lib/accounts/tier-change.ts:375` names `RequestSender._shouldRetry` and `stripe-node 22.2.0`.
It is accurate today, but it documents behavior whose authoritative owner is the SDK. On the next
`stripe` bump nobody is prompted to re-verify `_shouldRetry`, so the comment can silently rot. This
is a defensible trade (the gotcha is load-bearing for the lock-hold argument), which is why it is not
a table finding — but a shorter form ("`maxNetworkRetries:0` still allows one retry on
ECONNRESET/EPIPE — verified in the pinned SDK") would carry the same warning with less version-bound
surface.

**B. The "Worst-case lock hold ≈ 26s" figure is a loose estimate.** Three under-lock calls each
capped at 8s = 24s baseline; a first-attempt reset on any call adds one more ≤8s attempt. The exact
worst case depends on how many of the three calls hit the reset path, so "≈26s" is directionally
right but not a derivation a reader can reproduce from the comment. Consider "≈24–32s" or dropping
the precise number in favor of "roughly halved from the 20s/2-retry default."

**C. `stripeOptions()` bundles two concerns and has a generic name.** It now returns
`{ ...bound, idempotencyKey }` — a timeout/retry policy plus a request-identity key. The name says
neither. Pre-existing and small (shallow but harmless); flagging only because the PR is the moment
the helper stopped being purely "the idempotency key." A rename such as `stripeStepOptions` or a doc
line would clarify, but inlining is not warranted.

**D. Test harness queue-position coupling** (`queueExecution`/`queueApply`) — see §4 above. Consistent
with the existing repo pattern; a comment mapping each `push(...)` to the query it feeds would reduce
future maintenance friction, but this is house style, not a defect introduced here.

---

## Findings table

No findings >=80% confidence.
