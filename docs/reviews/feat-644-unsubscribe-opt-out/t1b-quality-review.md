# T1b — code quality review

**Commit:** `de937391` — *feat(#644): unsubscribe redemption core — claim first, then suppress*
**Scope:** quality only. Spec compliance was reviewed separately and passed; this review does not
re-litigate *what* was built, only *how well*.
**Method:** read-only. No source file was modified, no mutation experiment was run, no test was
executed (the branch is under concurrent edit and the live DB is shared).

**Files under review**

- `src/lib/solicitation/unsubscribe.ts` (+188)
- `src/lib/solicitation/__tests__/unsubscribe.integration.test.ts` (+669, new)
- `src/lib/solicitation/__tests__/unsubscribe.test.ts` (+33)
- `scripts/ci/tenant-scope-allowlist.ts` (+37; baseline 411 → 416)

**Explicitly out of scope** (already raised and settled elsewhere): the two Low findings the spec
reviewer queued for a batched fix (`try/finally` around `waitForTokenRowLockWaiter` at
`unsubscribe.integration.test.ts:515,581`; the "statement 1" assumption in the Proxy at
`:228-243`); the legitimacy of the deterministic Proxy choreography; the acknowledged low entropy
of the `fast-check` property; the accuracy of the five allowlist entries.

---

## 1. Strengths

**The claim is genuinely the only write-ordering primitive, and the code proves it rather than
asserting it.** `redeemUnsubscribeToken` builds the ledger row exclusively from the `RETURNING`
of the claim `UPDATE` (`unsubscribe.ts:220-237`) — never from a value read before the claim. The
concurrent-purge test (`:555-589`) parks a real second transaction on the token row lock and then
asserts `account_id IS NULL` on the resulting ledger row, which is only reachable if the
provenance came from the post-lock row version. That is the difference between a design that
happens to work and one whose invariant is observable.

**Enumeration resistance is structural, not procedural.** `findRedeemableUnsubscribeToken` folds
unknown / malformed / already-redeemed into one `null` return
(`:168-188`), so the landing page has no material with which to distinguish them even if a future
author wanted to. Compare the alternative — three distinct returns plus a comment asking the
caller to render them identically — which decays on the first refactor. The cross-account guard is
in the `ON` clause (`b.account_id = t.account_id`) rather than a post-query check, so it fails
closed by construction.

**The three concurrency tests test the mechanism, not the outcome.** `waitForTokenRowLockWaiter`
polls `pg_stat_activity` for `wait_event_type = 'Lock'` before releasing the parked transaction
(`:194-210`), so the assertions cannot pass on a lucky sequential interleaving — the second writer
is *proven* blocked. Most "concurrency tests" in most codebases are two sequential calls with a
`setTimeout`; these are not.

**Query construction is clean.** Every interpolation in the four new statements is a Postgres.js
bind parameter. No `${JSON.stringify(x)}::jsonb`. No dynamic SQL assembly. `scope = 'global'` and
`'email'` are literals in the SQL text, which is correct — they are not values, they are part of
the predicate.

**Comments carry rationale.** Nearly every comment in the new code answers *why* (why claim
first, why `redeemed_at` and not bare existence, why not `suppressionMatchSql`, why the
`recordSuppression` null return must not gate the stamp). None narrate the code. This is the
standard `.claude/rules/repworth.md` asks for and it is met.

---

## 2. Module depth

**Verdict: still a coherent deep module. No split warranted.**

The file is 317 lines with seven exported functions and two exported types. The seven form one
lifecycle over one secret-bearing artefact:

```
mintUnsubscribeRawToken  →  (delivery)  →  isWellFormedUnsubscribeToken
                                              ├→ findRedeemableUnsubscribeToken   (read)
                                              └→ redeemUnsubscribeToken           (write)
                                                     └→ mintUnsubscribeReceipt / verifyUnsubscribeReceipt
```

`hashUnsubscribeToken` is the shared digest owner. Nothing here is a bag of unrelated helpers: a
caller that needs one of these will need at least two more, and splitting the redemption pair into
`unsubscribe-redemption.ts` would create two modules that must be understood together — the exact
shallow-boundary failure `design.md` warns about. The `── redemption ──` section banner at
`:116-119` is doing adequate navigational work at this size.

The interface is also genuinely small relative to what it hides: a caller never sees the token
table, the ledger table, the claim ordering, `recordSuppression`, the provenance-scrub CHECK, the
channel narrowing, or the Read Committed re-snapshot. That is real complexity hidden behind five
call shapes.

**Where the depth leaks (see findings 1 and 2):** two obligations that the implementation depends
on for correctness are *not* in the interface. Callers must know (a) that the transaction must be
READ COMMITTED and (b) that a token row lock is held from the claim until they commit. Neither
appears in the doc comment; (a) appears only in a body comment the caller will never read. A deep
module hides its internals *and* documents the constraints callers cannot discover — this one does
the first half.

**Size is justified.** 188 added lines, of which roughly 90 are comment. The executable core of
`redeemUnsubscribeToken` is about 40 lines for a four-outcome state machine with two concurrency
hazards. That is not bloated.

---

## 3. Transaction and failure semantics

### 3.1 Lock hold duration

The claim `UPDATE` (`:220-225`) takes a row-level exclusive lock on the token row. Postgres holds
that lock until the **caller's** transaction commits — `redeemUnsubscribeToken` cannot release it.
Work performed after the claim, inside the function:

| Step | Can it be moved before the claim? | Verdict |
|---|---|---|
| `toSuppressionChannel(claimed.channel)` | No — the channel comes from the `RETURNING` | Unavoidable |
| `recordSuppression(tx, …)` | No — atomicity is the point | Unavoidable |

So the function itself holds the lock for the minimum possible window. **The hazard is on the
caller side and is undocumented.** T1c will wrap this in `sql.begin(...)` in two runtimes
(Railway ingress per spec §362, Vercel POST). Anything the route does inside that transaction
after `redeemUnsubscribeToken` returns — minting a receipt, a PostHog call, an outbound HTTP hop,
rendering — extends the lock hold. Because RFC 8058 providers legitimately replay the same
one-click POST, replays of *that specific token* would queue behind it. Blast radius is bounded to
one token (the lock is per-row, not table-level), so this is a latency hazard rather than an
outage, but `production.md` explicitly asks not to hold locks across slow remote calls, and the
only place that obligation can be stated is the doc comment. It is not there.

### 3.2 Is there post-claim work that can throw?

Yes — `toSuppressionChannel` (`:289-295`) throws when the token table's `channel` CHECK and
`SUPPRESSION_CHANNELS` drift. It runs **after** the `UPDATE`.

This is *correct* in the sense that matters: the throw propagates out of the caller's `tx`, which
rolls back, so the `redeemed_at` stamp is undone atomically. There is no window in which a caller
can treat a redemption as committed while the suppression is missing — the two are in one
transaction by construction, and the function's `TransactionSql` parameter type makes that
unforgeable. `recordSuppression` likewise only inserts (it never updates the token row), so the
ABBA claim in the doc comment at `:202-203` holds: this path always takes the token lock before
touching the ledger.

**The seam worth noting:** the doc comment promises "Throws on infra failure; the four domain
outcomes are RETURNED." A drifted channel CHECK is neither infra nor one of the four. It is a
programmer error / impossible state, and failing fast is the right call (`design.md`: define away
invalid states, and where you cannot, fail inside a boundary). But an infra-failure retry loop in
T1c cannot distinguish it from a transient Postgres error and would retry it forever. Worth a
line in the doc comment; not worth restructuring.

### 3.3 Read Committed dependency — the substantive finding

`:245-249` states, in a body comment, that the disambiguating `SELECT` relies on Read Committed
taking a fresh per-statement snapshot. The function accepts an arbitrary caller-supplied
`TransactionSql` and never asserts or documents that requirement at the interface.

This is **not hypothetical in this codebase**. Two live call sites build non-default-isolation
transactions, one of them in the same directory:

- `src/lib/solicitation/batch-view.ts:437` — `await tx\`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY\``
- `src/lib/escalations/list.ts:43` — `sql.begin('isolation level repeatable read read only', …)`

Both are read-only today, so neither can call `redeemUnsubscribeToken` right now. But the *pattern*
— "wrap this read model in a REPEATABLE READ transaction for a consistent snapshot" — is
established local precedent, and the landing page will want a consistent view.

Two concrete failures under REPEATABLE READ:

1. **A concurrent redemption becomes an exception instead of an outcome.** At REPEATABLE READ, an
   `UPDATE` whose target row was modified by a transaction that committed after this
   transaction's snapshot raises `40001 could not serialize access due to concurrent update` —
   it does not block-and-recheck. The "two overlapping redemptions" case (which the suite proves
   returns `already_suppressed` at `:474-526`) would instead throw, breaking the documented
   "domain outcomes are RETURNED" contract.
2. **A genuinely-redeemed token reports `unknown_token`.** If the caller's transaction performs
   any statement before `redeemUnsubscribeToken` (a plausible route shape: read the token for
   display via `findRedeemableUnsubscribeToken`, then redeem in the same transaction), the
   snapshot is taken at that earlier statement. A concurrent redemption committing in between is
   invisible to the follow-up `SELECT`, which reads `redeemed_at IS NULL` → returns
   `unknown_token`. The recipient who *did* successfully opt out is shown "this link is invalid."
   On a statutory opt-out path that is the worst available lie.

The fix is a doc-comment sentence, not a code change. Optionally `SHOW transaction_isolation` and
throw, but that costs a round trip on every redemption and is probably not worth it — stating the
obligation is.

---

## 4. The four-outcome union

```ts
export type UnsubscribeRedemption =
  | { status: 'redeemed'; tokenHashPrefix: string }
  | { status: 'already_suppressed'; tokenHashPrefix: string }
  | { status: 'already_redeemed_not_suppressed'; tokenHashPrefix: string }
  | { status: 'unknown_token'; tokenHashPrefix: string };
```

**Exhaustiveness:** yes. This is a discriminated union on a string-literal `status`, so TypeScript
narrows correctly in a `switch` and, with a `never`-typed `default` or a function with a declared
non-`void` return type, an unhandled member is a compile error. No issue here.

**Discoverability of `already_redeemed_not_suppressed`:** the *name* is excellent — it is
impossible to read it and think it means success. The trap is not the name.

**The trap is that the success/failure partition exists only as prose, positionally.** The doc
comment at `:129-135` says:

> Only the first two may claim success to the recipient.

"The first two" is a reference to declaration order. Two independent consequences:

1. **The comment is coupled to the type's member order.** Reordering the union — a refactor every
   linter and every developer would consider a no-op — silently makes the only statement of the
   partition wrong. `engineering.md` asks for one authoritative owner per system fact; this fact
   has no owner in code at all.
2. **Two callers in two runtimes must each re-derive it.** Per spec §234-235 and §362 there will be
   a Railway ingress handler (`unsubscribe_one_click`) and a Vercel POST route
   (`unsubscribe_link`) — the two members of `UnsubscribeRedemptionSource` are named for exactly
   those surfaces. Nothing in the type system prevents either from writing
   `if (result.status !== 'unknown_token') showSuccess()`, which is the natural shape and which
   shows "you have been unsubscribed" to a recipient for whom no suppression exists — precisely
   the state `already_redeemed_not_suppressed` was invented to make visible.

Because there are two callers by construction, the usual `repworth.md` objection ("no abstraction
for a single caller") does not apply. The cheapest fix that makes correct use automatic is a
one-line exported predicate beside the union:

```ts
/** §5.5: only these two outcomes may show the recipient a success sentence. */
export function redemptionMayClaimSuccess(outcome: UnsubscribeRedemption): boolean {
  return outcome.status === 'redeemed' || outcome.status === 'already_suppressed';
}
```

That pulls the classification down into the module that owns the state machine (`design.md`: pull
complexity downward; make the common case automatic) and removes the positional reference. An
alternative — a `succeeded: boolean` field on each variant — also works but duplicates the
discriminant.

Absent that, the minimum change is to replace "the first two" with the two member names, so the
comment survives reordering.

---

## 5. Query construction

| Statement | Parameterised? | Notes |
|---|---|---|
| `findRedeemableUnsubscribeToken` SELECT (`:177-185`) | Yes — `${hashUnsubscribeToken(rawToken)}` | `token_hash` is `UNIQUE`, `businesses.id` is PK, so the `LEFT JOIN` yields ≤1 row; no `LIMIT 1` needed |
| claim `UPDATE` (`:220-225`) | Yes — `${tokenHash}` | |
| disambiguating `SELECT` (`:250-256`) | Yes — `${tokenHash}` | |
| ledger `EXISTS` (`:268-275`) | Yes — `${existing.channel}`, `${existing.normalized_handle}` | `scope = 'global'` is a literal predicate, correctly so |

No `${JSON.stringify(x)}::jsonb`. No JSONB parsing at all, so the PgBouncer string-decode carve-out
is not engaged and the CLAUDE.md allowlist needs no entry. No `sql.unsafe`, no fragment
concatenation. Clean.

One small note: the destructure `const [row] = await …` silently discards extra rows. Both
statements are provably single-row via unique constraints, so this is fine and matches the
precedent in `suppression.ts:187`.

---

## 6. Test quality

### 6.1 What is tested well

- **Behaviour through the public interface.** Every test drives `redeemUnsubscribeToken` /
  `findRedeemableUnsubscribeToken` and asserts on the returned union plus the resulting database
  state. No test reaches into module internals or asserts on the SQL text.
- **`::text` timestamp reads** (`:172-179`). The helper deliberately reads `redeemed_at::text`
  because postgres.js truncates timestamptz microseconds into a JS `Date` — which would let two
  distinct stamps compare equal and silently defeat the "does not re-stamp" assertions. That is
  the CLAUDE.md microsecond gotcha applied correctly and *explained* at the point of use.
- **The mutation claims in the commit message hold up on inspection.** Reverting `:257` to bare
  existence turns `:528-553` red (the mint-race test would see the token and report
  `already_redeemed_not_suppressed`). Dropping `scope = 'global'` from `:273` turns `:619-640`
  red (the account-scoped row would satisfy the `EXISTS`). Both are real, load-bearing tests.
- **`:644-656` includes a positive control.** It asserts the owning-business name resolves
  *before* asserting the foreign one does not, so a `null` from a broken query cannot masquerade
  as the cross-account guard working. This is the discipline most negative tests skip.
- **The unit-suite addition (`unsubscribe.test.ts:92-122`)** uses a Proxy whose `get` trap *also*
  throws, so the assertion is "no connection was reached for", not the weaker "no query was
  issued". That is the right strength for a gate whose entire justification is avoiding an
  unbounded public path to Postgres.

### 6.2 Fixture hygiene

Cleanup is keyed by `normalized_handle` (`:277-298`), and every handle is a fresh
`unsubscribed-${randomUUID()}@test.local` registered in `handlesInPlay` (`:88-92`). Business and
tenant ids are per-run `randomUUID()`s. So no two runs — and no two tests — can collide on a key.
`afterAll` (`:300-328`) adds an account-scoped net for stray ledger rows (which would otherwise
wedge teardown against the NO-ACTION FK to `accounts`) and releases the advisory lock in a
`finally`, nested correctly so a failed `db.end()` cannot leak the lock. This is above the bar.

**One defect: `afterEach` clears its own recovery state before doing the work.**

```ts
const handles = [...handlesInPlay];
handlesInPlay.clear();          // ← state is gone
const removed = await db`DELETE FROM solicitation_suppressions …`;   // ← if this throws…
```

If any of the three DELETEs throws (lock contention, a wedged connection, a timeout), the handle
set is already empty and those rows are unreachable for the rest of the run. `afterAll`'s net
sweeps `solicitation_suppressions WHERE account_id = <seed>` — which **cannot** reach the rows
written by the purge-scrubbed test at `:394-403`, whose whole point is `account_id IS NULL`. Those
rows, plus the token rows, leak permanently into the shared local test DB.

Impact is low (handles are random UUIDs, so leaked rows never collide with a future run — this is
silent accumulation, not a failure), but `production.md` treats cleanup as a contract that must
hold on the failure path too, and the fix is to move `handlesInPlay.clear()` into a `finally`
after the deletes, or to only clear the handles actually deleted.

### 6.3 Weaker spots (observations, not findings)

- **`:405-419` asserts against an unfiltered `COUNT(*) FROM solicitation_suppressions`.** This is
  the only assertion in the file that reaches outside its own fixtures. It is safe in practice —
  every live-DB suite that writes this table (`suppression.integration.test.ts` included) takes
  the same `repworth_live_db_integration` advisory lock, so the table is quiescent — but that
  safety is an implicit dependency on a global mutex, unlike every other assertion here, which is
  scoped by handle. The test's own situation justifies it (an unknown token has no handle to scope
  by), so this is a note rather than a finding; a tighter version would count tokens *and*
  suppressions for the specific hash/handle-less case, or simply assert no row exists whose
  `source` is one of the two unsubscribe sources.
- **`:593-603` and `:605-617` are near-duplicates.** Both seed, redeem, delete the global row via
  the correction path, and replay. The first asserts `countGlobalRows === 0`; the second asserts
  the status and the unchanged stamp. One test asserting all three would carry the same evidence.
  Not wrong — the split arguably names two distinct facts — but it is 25 lines for one scenario.
- **`toSuppressionChannel`'s throw (`:289-295`) is untested.** Reaching it requires the two CHECK
  constraints to drift, which cannot be arranged without DDL, and this suite correctly must not
  apply DDL (#573). Acceptable gap; the branch is a fail-fast assertion, not behaviour.
- **`findRedeemableUnsubscribeToken` is not tested against a purge-scrubbed token.** The doc
  comment at `:163-166` attributes the generic-copy fallback to the `b.account_id = t.account_id`
  equality failing on a NULL. That is true but not the operative mechanism: the migration-096
  `solicitation_unsubscribe_tokens_provenance_scrub_implication` CHECK forces `business_id` NULL
  whenever `account_id` is NULL, so `b.id = t.business_id` already kills the join one condition
  earlier. The behaviour is right and doubly guaranteed; the comment's stated *reason* is the
  second line of defence, not the first. A one-line test (`seedToken({ accountId: null })` →
  `{ businessName: null }`) would pin it.
- **No test asserts the outcome for a *malformed* token against the live DB.** Covered by the unit
  suite's Proxy test, which is the better place for it. Not a gap.

### 6.4 Can any test pass while the implementation is subtly wrong?

Reviewed each of the 16 against that question. The three concurrency tests, the two
correction-path tests, and the account-scope test are all load-bearing (each has an identified
mutation that reddens it). The `fast-check` property at `:421-447` is the weakest — with
`numRuns: 10` over an array of two constants, its state space is small and it is effectively an
exhaustive check of "redeem 1–5 times in any source order," which the example tests at `:358` and
`:449` already cover. That is the acknowledged low-entropy point and is out of scope here. Nothing
else in the suite is capable of passing against a materially wrong implementation.

---

## 7. Smaller quality points

**`business_id` is dead.** `:224` returns it, `:151-156` declares it on `ClaimedTokenRow`, and
nothing reads `claimed.business_id`. `recordSuppression`'s input type
(`suppression.ts:92-129`) has no business field, so there is nowhere for it to go. Drop both.
Secondary: `ClaimedTokenRow` is the only *named* row interface in the file — the two sibling
queries in the very same function use inline type literals (`:177`, `:250-252`). Once the unused
field is gone the interface is a three-field type used once, and inlining it would make the file
internally consistent. (`design.md`: consistency is design information; a name that is not pulling
weight is a jump for the reader.)

**The malformed branch defeats the module's own input bound.** `:209-215` calls
`hashUnsubscribeToken(input.rawToken)` on the *raw, unbounded* input — reachable precisely when the
gate rejected it, including when it rejected it **because** the input exceeded
`MAX_SIGNED_INPUT_LENGTH`. The constant's own comment at `:39-42` states the intent: "Bounding the
input first means a megabyte of junk costs one length compare instead of an HMAC over it." The
reject path then SHA-256s the megabyte. Practical impact is small — the token arrives in the URL
path, so the HTTP server's URL/header limit (~16 KB on both Fastify and Node) bounds it long before
Postgres or the CPU cares — but this is on the one surface §9.2 forbids rate-limiting, and the
value produced is meaningless: `tokenHashPrefix` is documented at `:142-144` as existing "to
correlate a provider retry with its first attempt," and a forged token has no first attempt. Either
return a fixed sentinel on this branch or make `tokenHashPrefix` optional on the `unknown_token`
variant. Note the asymmetry: `findRedeemableUnsubscribeToken` correctly does no hashing on its
reject path (`:175`).

**Duplicate digest computation.** `:213` and `:217` both call `hashUnsubscribeToken`. Mutually
exclusive branches, so this costs nothing at runtime; it disappears with the fix above.

**`type SqlExecutor = Sql | TransactionSql` at `:121` duplicates `suppression.ts:22`.** Not a
finding — this alias is copied verbatim in 19 files across the repo and is the established
convention that `ci:db-imports` and the sql-tag scanner are written against
(`scripts/ci/lib/sql-tag-scan.ts:29` names the pattern explicitly). Following precedent is correct
here; extracting a shared alias would be the deviation.

**Allowlist entries.** Verified accurate by the spec reviewer; not re-reviewed. Quality note only:
the five `reason` strings are unusually good — each states why the *tenant* boundary is absent
rather than asserting an exception, and the `solicitation_suppressions` entry explains why it is
deliberately narrower than `suppressionMatchSql`. These will still be legible in a year.

---

## 8. Findings

| Severity | Location | Finding |
|---|---|---|
| Important | `src/lib/solicitation/unsubscribe.ts:190-208` | The doc comment omits two caller obligations the implementation depends on. (a) **Correct only at READ COMMITTED** — stated only in a body comment at `:245-249`. Same directory already builds REPEATABLE READ transactions (`src/lib/solicitation/batch-view.ts:437`; also `src/lib/escalations/list.ts:43`). Under REPEATABLE READ the claim `UPDATE` raises `40001` on a concurrent redemption instead of blocking-and-rechecking (breaking "domain outcomes are RETURNED"), and if the caller ran any earlier statement in the same tx the follow-up `SELECT` reuses the stale snapshot and returns `unknown_token` for a token that *was* redeemed — showing "invalid link" to a recipient who successfully opted out. (b) **The caller's transaction holds a row lock on the token from the claim until commit**; `production.md` forbids holding locks across slow remote calls and T1c's route is where that will happen. Fix is doc-comment text, not code. |
| Important | `src/lib/solicitation/unsubscribe.ts:129-140` | The success/failure partition of the four-outcome union exists only as prose, referenced **positionally** ("Only the first two may claim success"). Reordering the union — a no-op refactor — silently invalidates the only statement of the rule, and the two callers ahead (Railway one-click ingress + Vercel POST, per spec §234-235/§362) must each re-derive it. Nothing prevents `status !== 'unknown_token'` → success, which shows "you have been unsubscribed" when `already_redeemed_not_suppressed` means no suppression exists. `design.md`: pull complexity downward, make the common case automatic. Fix: a one-line exported `redemptionMayClaimSuccess` predicate (two callers, so `repworth.md`'s single-caller rule does not bar it), or at minimum name the two members instead of "the first two". |
| Minor | `src/lib/solicitation/unsubscribe.ts:151-156, 224` | `business_id` is selected in the claim's `RETURNING` and declared on `ClaimedTokenRow`, but never read — `recordSuppression` has no business field to receive it. Dead knowledge on a hot path. Secondary: `ClaimedTokenRow` is the file's only named row interface; the two sibling queries in the same function use inline literals (`:177`, `:250-252`). Once the dead field is dropped it is a three-field type with one use. |
| Minor | `src/lib/solicitation/unsubscribe.ts:209-215` | The malformed branch SHA-256s the **unbounded** raw input — reachable exactly when the gate rejected it, including for exceeding `MAX_SIGNED_INPUT_LENGTH`, whose own comment at `:39-42` justifies the constant as "a megabyte of junk costs one length compare instead of an HMAC over it". The module defeats its own stated bound on the one path §9.2 forbids rate-limiting. Impact is bounded in practice by HTTP URL-length limits, and the resulting `tokenHashPrefix` cannot serve its documented purpose (`:142-144`: correlating a provider retry with its first attempt — a forged token has none). Return a sentinel, or make the field optional on `unknown_token`. Contrast `findRedeemableUnsubscribeToken:175`, which correctly hashes nothing on reject. |
| Minor | `src/lib/solicitation/__tests__/unsubscribe.integration.test.ts:277-298` | `afterEach` calls `handlesInPlay.clear()` *before* the three DELETEs. If any DELETE throws, the handles are unrecoverable and `afterAll`'s net (`:308`, scoped by `account_id`) cannot reach the rows written by `:394-403`, whose `account_id` is NULL by construction — those ledger and token rows leak permanently into the shared local test DB. Low impact (random handles never collide), but cleanup must hold on the failure path. Move the `clear()` into a `finally`, or clear only what was deleted. |

**Not reported (already known / settled):** the `try/finally` gap around `waitForTokenRowLockWaiter`
(`:515`, `:581`); the "statement 1" assumption in `commitBetweenStatements` (`:228-243`); the
`fast-check` property's low entropy; the deterministic Proxy choreography; the five allowlist
entries.

---

## 9. Assessment

**Approved.** The concurrency reasoning is sound and — unusually — proven by tests that observe the
lock rather than assume it; query construction, tenant-scope documentation, comment discipline and
fixture hygiene are all at or above the repo bar. Nothing found is a correctness defect in the
code as written. The two Important findings are both about the *interface contract* rather than the
implementation: obligations and classifications that the module knows and its two future callers
will have to guess. Both are cheap to close (a doc-comment paragraph and a one-line predicate) and
are best closed before T1c is written against this surface, since T1c is exactly where mis-guessing
either one becomes a user-visible statutory failure.
