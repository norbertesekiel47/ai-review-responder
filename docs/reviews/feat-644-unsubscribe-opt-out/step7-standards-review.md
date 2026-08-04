# #644 — step 7 standards & maintainability review

Scope: full branch diff `git diff $(git merge-base HEAD origin/main)..HEAD`
(merge-base `326d7b1c`), 46 files, +10646/-21 (feature code ~4.4k lines).
Method: `thermo-nuclear-code-quality-review` skill against `.claude/rules/{design,repworth,engineering,production}.md`,
`.claude/CLAUDE.md` invariants, and the `CONTEXT.md` locked glossary.
Read before reporting: `docs/superpowers/plans/feat-644-unsubscribe-opt-out-deviations.md` (twelve triaged deviations).
Read-only review — no source file modified.

Weighting per the brief: the **seams between slices** (module depth of the domain
module, cross-surface duplication, comment quality at volume, test health, the
shared rate-limit hook), not per-slice correctness that earlier rounds covered.

---

## Verdict

**No structural regression, and no blocking defect.** The branch is unusually
disciplined for its size: no `any`, no new top-level directory, no file over 1k
lines, invariant #15 honoured throughout (the domain module never imports
`@/lib/db/server`; both surfaces pass their executor in), invariant #5 defended in
depth at four sinks, and the one genuinely shared compliance predicate
(`hasLiveGlobalSuppression`) has exactly one owner as D8 required.

What it does have is a **documentation-integrity problem at the seams**. Three
load-bearing comments state contracts that the code as written does not keep, and
one of them (the rate-limit hook) is positioned to cause the exact production
bypass D11 spent a real-socket test closing. These are cheap to fix and worth
fixing before merge, because this branch's comments are the primary artefact a
future maintainer will trust — by design, and at 45% comment density.

---

## Findings

### F1 — `redemptionConfirmsSuppression`'s stated contract is violated by one of the two callers it names

`src/lib/solicitation/unsubscribe.ts:226-232`:

> *Both callers (the RFC 8058 ingress and the Vercel POST) **MUST** use it rather
> than testing statuses themselves: `status !== 'unknown_token'` reads as a
> reasonable success test and is wrong for exactly one outcome, which is the one
> that matters.*

`worker/ingress/unsubscribe.ts:125` does precisely the forbidden thing:

```ts
if (redemption.status === 'unknown_token') {
  replyUnknownToken(reply, 'ledger');
  return;
}
reply.status(200).send({ received: true });
```

Only `src/app/api/u/[token]/route.ts:52` uses the sanctioned helper.

The ingress's behaviour is defensible on its own terms — an RFC 8058 200 is
"provider, we received this", not a success claim made to a recipient, so
`already_redeemed_not_suppressed → 200` is arguably correct there. But the comment
does not say that. It names the ingress explicitly and forbids exactly the
expression the ingress uses.

**Standard violated:** design.md — *"Make contracts, assumptions, invariants,
responsibilities, and caller/callee obligations explicit and close to the
abstraction they protect"*; a contract one of its two named subjects does not keep
is worse than no contract, because the next reader must decide which is the bug.

**Maintenance failure scenario:** a maintainer reconciling the two either (a)
"fixes" the ingress to use `redemptionConfirmsSuppression`, turning
`already_redeemed_not_suppressed` into a 503 the provider retries forever on a
token that will never resolve differently, or (b) concludes the helper is
advisory and drops it from the Vercel route, restoring the third false-success
vector revision 7 called the root cause of the whole class.

**Fix (comment-only):** state the split — the helper governs *success claims made
to a recipient*; the RFC 8058 ingress answers a *machine* and maps only
`unknown_token` to a retryable status. One sentence in the doc comment, plus a
one-line note at `worker/ingress/unsubscribe.ts:125` naming why the direct status
test is right there.

---

### F2 — the rate-limit hook's "both arms are required" paragraph justifies arm 2 twice and arm 1 never

`worker/ingress/rate-limit.ts:64-69`:

> *"**Both arms of the scope test are required.** An unmatched path yields
> `routeOptions.url === undefined`, so a resolved-route-only test would drop every
> 404 out of the hook and reopen an unthrottled flood namespace. A raw-URL-only
> test — what shipped before #644 — misses `/%69ngress/resend`, which resolves to
> the real route while failing a literal prefix compare, and therefore escaped the
> limiter entirely on EVERY provider."*

Sentence 2 justifies **arm 2**'s existence. Sentence 3 justifies **arm 2's
decoding** — verified: for `/%69ngress/resend`, `decodeIngressPath` returns
`/ingress/resend` and arm 2 is `true` on its own. Neither sentence justifies
**arm 1** (`request.routeOptions.url?.startsWith(…)`).

Arm 1's actual load-bearing case is the **absolute-form request target**
(RFC 9112 §3.2.2, `POST http://host/ingress/resend HTTP/1.1`), where `find-my-way`
resolves the route while `request.url` retains the absolute string and arm 2 goes
`false`. That reason appears **only** in `deviations.md` D11 and in the test file
`worker/ingress/__tests__/unsubscribe-rate-limit.test.ts:182-220`. It is absent
from the production file a maintainer edits.

**Standard violated:** engineering.md — *"When hidden assumptions live only in
comments, caller folklore, or tribal setup steps, move them into code, contracts,
tests, scripts, or checked configuration"*; design.md — *"document … hidden design
decisions, rationale, and tricky implementation facts callers should not need to
know"*.

**Maintenance failure scenario — concrete and already rehearsed once on this
branch:** a maintainer reads the paragraph, tests the one case it names against
arm 1 alone, finds arm 2 already covers `/%69ngress/resend`, and deletes arm 1 as
redundant. D11 records that this reasoning was actually followed to the point of a
mutation run before a real socket falsified it. The consequence is a live limiter
bypass on **Stripe, Resend, Telegram, Twilio and Zernio** via a one-token change
to the request line. The real-socket test would catch it — but only if the
maintainer runs the unsubscribe suite while editing the shared limiter, which the
comment gives them no reason to do.

**Fix (comment-only, ~3 lines):** name absolute-form as arm 1's case, and
reference the real-socket test by path so the falsifying evidence is one jump
away.

---

### F3 — the receipt API exposes the token's internal representation across a two-surface boundary

`mintUnsubscribeReceipt(tokenHash, issuedAtMs)` / `verifyUnsubscribeReceipt(tokenHash, receipt)`
(`src/lib/solicitation/unsubscribe.ts:142`, `:147`) take the **hash**. Every
production caller holds the raw token and derives it at the call site:

- `src/app/api/u/[token]/route.ts:56` — `mintUnsubscribeReceipt(hashUnsubscribeToken(token), Date.now())`
- `src/app/(public)/u/[token]/page.tsx:98` — `verifyUnsubscribeReceipt(hashUnsubscribeToken(rawToken), receiptParam)`

Two production files, on the same surface but in different route trees, must
independently derive the same value. Both parameters are `string`, so nothing in
the type system distinguishes a raw token from its digest.

**Standard violated:** design.md — *"Hide volatile decisions, internal
representations, storage shape … inside the module that owns the knowledge"* and
*"Design interfaces around what callers need to know, not how the implementation
works"*. The hash is the module's persistence representation; the receipt's
callers have no need of it.

**Maintenance failure scenario:** mint and verify are **symmetric**, and both
parameters are `string`. A one-sided slip — passing the raw token at the mint site
in `route.ts` but not at the verify site in `page.tsx`, or the reverse — produces
no type error and no runtime error. Receipts simply stop verifying, and the
recipient who *did* successfully unsubscribe is redirected to the **Neutral page**
telling them the link isn't active: a silent false-negative on the exact statutory
claim §1.8 was rewritten to make honest.

Scope check, in fairness to the suite: this is **caught by test, not by type**.
`src/app/__tests__/unsubscribe-landing.test.tsx:190` independently verifies the
route's receipt with `verifyUnsubscribeReceipt(hashUnsubscribeToken(token), …)`,
so it pins the keying and would fail on a one-sided *or* two-sided change. The
finding is therefore about interface quality rather than a live hole: a narrower
signature would make the whole class unrepresentable for free, instead of relying
on a test in a third file continuing to re-spell the same derivation. Note that
the internal representation has already propagated into that test file and into
`unsubscribe.integration.test.ts:121` and `worker/ingress/__tests__/unsubscribe.test.ts:147`
— five re-spellings of `hashUnsubscribeToken(<raw>)` outside the owning module.

**Fix (code, ~6 lines):** take `rawToken: string` on both and hash internally.
`hashUnsubscribeToken` stays exported for #630's minting (its stated reason) and
for the single-flight map key at `worker/ingress/unsubscribe.ts:342`, but drops
from two of its three external call sites.

---

### F4 — `redeemUnsubscribeToken` pushes its transaction boundary onto callers, then documents two obligations it could have made structural

`src/lib/solicitation/unsubscribe.ts:334` takes `tx: TransactionSql` and carries
two explicit **CALLER OBLIGATIONS** (`:325-332`):

1. `tx` MUST be READ COMMITTED — under REPEATABLE READ the claim raises 40001
   instead of blocking, breaking the "domain outcomes are returned, not thrown"
   contract, and a caller that read anything first gets `unknown_token` for a
   token that *was* redeemed.
2. No remote call may sit between the call and the commit.

Both callers satisfy both — by doing the identical thing:

```ts
// worker/ingress/unsubscribe.ts:373
sql.begin((tx) => redeemUnsubscribeToken(tx, { rawToken, source: 'unsubscribe_one_click' }))
// src/app/api/u/[token]/route.ts:44
sql.begin((tx) => redeemUnsubscribeToken(tx, { rawToken: token, source: 'unsubscribe_link' }))
```

There is no caller that composes this into a larger transaction, and none is
planned. The `TransactionSql` parameter is generality bought with two
unenforceable contracts and no second use case.

**Standard violated:** design.md — *"Reduce exception surface by changing
interfaces or invariants where possible. Define away invalid states and awkward
cases instead of making every caller repeat defensive ceremony"*, and *"Pull
complexity downward when the lower module owns the detail"*. repworth.md — *"Do
not add abstraction layers in anticipation of a feature … wait for the second
concrete use case."*

**Maintenance failure scenario:** a third caller appears (the most likely
candidate is a #645 admin tool or a #630 retry path) and reaches for the
REPEATABLE READ snapshot builder already in this domain —
`src/lib/solicitation/batch-view.ts` builds exactly that for its read-only view.
Obligation 1 is then violated silently: the failure mode is not an error but
`unknown_token` returned for a genuinely redeemed token, i.e. an "invalid link"
shown to someone who successfully opted out. Nothing in the type system, CI, or
the test suite catches it; only the prose does.

**Fix (code, ~10 lines):** `redeemUnsubscribeToken(db: Sql, input)` owning its own
`sql.begin()`. Invariant #15 is still satisfied — the executor stays an explicit
parameter and the module still never imports `@/lib/db/server`
(`findRedeemableUnsubscribeToken` already takes `SqlExecutor` this way).
Obligation 1 becomes impossible to violate, obligation 2 becomes a property of the
function rather than of each call site, the duplicated ceremony disappears from
both surfaces, and the single-flight's `postgres.js resolves begin only after
COMMIT` note at `worker/ingress/unsubscribe.ts:369-371` stops being a property the
adapter has to re-derive.

If the boundary is deliberately kept in the caller, say so in the doc comment —
"the caller owns the transaction so X can compose it" — because as written the
comment gives two rules and no reason they are the caller's problem.

---

### F5 — the gate-rejection comment misstates when its branch is reachable

`src/lib/solicitation/unsubscribe.ts:340-344`:

> *"…and no hashing either: this branch is reachable **precisely when** the gate
> rejected the input for exceeding `MAX_SIGNED_INPUT_LENGTH`, so digesting it here
> would restore the unbounded work that bound exists to prevent."*

`isWellFormedUnsubscribeToken` (`:85-95`) returns `false` for **three** reasons:
length (`:86`), shape-regex failure (`:87`), and MAC mismatch (`:91`). A short
forged token such as `aaa.bbb` reaches this branch having cost one HMAC compare
and nothing else — the stated justification for skipping the digest does not apply
to it.

The *decision* (don't hash) remains fine; the stated reason is false, and the
second half of the comment ("There is also nothing to correlate") is the reason
that actually holds in all three cases.

**Standard violated:** repworth.md — comments are for the "why"; a "why" that is
factually wrong about the adjacent code is a defect, not a nit. engineering.md —
*"When code works for reasons nobody can explain, stop and prove the behavior with
data before depending on it."*

**Maintenance failure scenario:** a reader who trusts "precisely when" concludes
that anything reaching `redeemUnsubscribeToken` has already been length-bounded,
and later adds work here (a metric, a log, a dedup key) on that false premise.

**Fix (comment-only):** drop "precisely when …" and lead with the reason that is
always true — a token that was never minted has no prior attempt and no row, so
there is nothing to correlate.

---

### F6 — the new `CONTEXT.md` glossary entry's verbatim SQL does not match the code it describes

`CONTEXT.md:93` ("**Unsubscribe redemption**", added by this branch) states the
claim primitive as:

> `UPDATE … SET redeemed_at = NOW() WHERE token_hash = $1 AND redeemed_at IS NULL RETURNING account_id, business_id, normalized_handle, channel`

The implementation (`src/lib/solicitation/unsubscribe.ts:351-356`) returns
`account_id, normalized_handle, channel` — no `business_id`. Verified as correct
on the code side: `recordSuppression` (`src/lib/solicitation/suppression.ts:154`)
has no `businessId` input, and `business_id` appears exactly once in the module,
in the landing-page join at `:293`.

**Standard violated:** engineering.md — *"Keep one authoritative representation
for each piece of system knowledge"*; repworth.md — *"When deleting a doc or
marking a checklist item done, fix its audit tick in the same change … dangling
refs and stale ticks are bugs."* `CONTEXT.md` is a locked-glossary file, i.e. the
highest-trust prose in the repo, and this entry is one of the three terms the
branch itself coined.

**Maintenance failure scenario:** #645 (Correction path) or #630 (minting) reads
the glossary as the contract, assumes the claim yields `business_id` provenance,
and either writes it into a suppression row — the `account_id IS NULL implies
business_id IS NULL` one-way implication (G12) makes that a purge-correctness bug
— or adds the column to `RETURNING` to match the doc, re-widening the claim's
projection for no consumer.

**Fix (doc-only):** drop `business_id` from the quoted SQL.

---

### F7 — `already_redeemed_not_suppressed` has zero coverage at the worker ingress

`worker/ingress/unsubscribe.ts:125` maps every non-`unknown_token` outcome to 200.
Across `worker/ingress/__tests__/unsubscribe.test.ts`, `mockRedeem` returns only
`redeemed`, `already_suppressed` and `unknown_token` (`:80, :111, :207-208, :228,
:243, :290, :442, :486, :490`). The third success-shaped outcome — the one the
glossary calls *"the one that is easy to lose"*, and the only reason
`redemptionConfirmsSuppression` exists — is never driven through the ingress.

Worse, the module's own single-flight comment (`worker/ingress/unsubscribe.ts:294-296`)
says *"all three non-`unknown_token` outcomes map to 200 … **Re-check that mapping
before widening this**"* — the mapping it instructs you to re-check is the one with
no test.

**Standard violated:** repworth.md — *"Write tests for: … outbox transitions,
subscription guards"* (the enumerated-outcome class); production.md — *"Design the
failure semantics … before production defines them for you."*

**Maintenance failure scenario, compounding F1:** F1 leaves the ingress testing
`status === 'unknown_token'` directly against a docstring forbidding it. F7 means
that if someone reconciles the two by "correcting" the ingress to use
`redemptionConfirmsSuppression`, `already_redeemed_not_suppressed` silently becomes
a 503 the provider retries forever — and **the suite stays green**, because no test
ever produces that outcome here. The two findings are individually minor and
jointly a real hazard; fix F1's comment and add the outcome to the ingress matrix
in the same change.

---

### F8 — a redaction assertion that cannot fail

`worker/ingress/__tests__/unsubscribe.test.ts:278` —
`expect(harness.rawFastifyLog()).not.toContain(validToken)`.

The harness is built `productionConfigRequired: true` (`:83`), so pino sits at
`warn`; the route carries `logLevel: 'silent'`; and on this path `failClosed`
answers 503 itself so Fastify's error handler never runs. The delegated audit
probed it directly: **zero Fastify log lines are produced**, so the assertion
reduces to `''.not.toContain(token)` and can never go red. The equivalent
`info`-lane assertions at `:591` and `:620` are real; this one is not.

**Standard violated:** engineering.md — *"When tests are slow, flaky … improve the
feedback path rather than normalizing skipped checks"*; production.md's
diagnosability bar. This is also D2's own lesson recurring: *"Redaction tests must
run at the level production runs at"* — here the level is right and the **sink is
empty**, which is the same class of false comfort one step further along.

**Maintenance failure scenario:** the single highest-stakes property on this branch
(invariant #5 — the raw token never reaches a log) has a green assertion at this
line that would stay green if the adapter started logging the raw token, because
the assertion inspects a sink this path never writes to. Assert against the sink
the path *does* write (`sink.lines()`, as `:301` does) or drive a request that
reaches Fastify's error handler.

---

### F9 — the landing suite's fake re-implements the redemption core's outcome selection

`src/app/__tests__/unsubscribe-landing.test.tsx:87-106` hand-rolls the selection
between `redeemed` / `already_suppressed` / `already_redeemed_not_suppressed` /
`unknown_token` that `src/lib/solicitation/unsubscribe.ts:334-395` owns.

The suite's header comment defends *stateful* faking, and correctly — that is what
makes the Correction-path tests real. But the **outcome selection** is not state,
it is the branch logic under test, and it now has two implementations.

**Standard violated:** engineering.md — *"Keep one authoritative representation for
each piece of system knowledge"*; design.md — *"Use tests to protect behavior
through public contracts … Do not let test convenience force shallow or leaky
interfaces."*

**Maintenance failure scenario:** if the real core's outcome selection changes —
e.g. the spent branch stops consulting the ledger, collapsing
`already_redeemed_not_suppressed` back into `already_suppressed` — **every §1.8
landing test still passes**, because they run against the fake's copy. §1.8 exists
precisely to prevent a false "you are unsubscribed", and its regression suite is
insulated from the module that decides it. The integration suite does cover the
real core, so this is a drift risk rather than a live hole; the fix is to have the
fake own only the *ledger state* and delegate outcome selection to the real
`redeemUnsubscribeToken`.

---

## Assessed and deliberately NOT reported

Per the brief, and confirmed against `deviations.md` before writing:

- §1.6 counter living inside `worker/ingress/unsubscribe.ts` — D9, owner declined
  amendment #3. Judged as written; no split recommended. (Note only: D9's text
  cites the file at **315 lines**; it is now **518** after the D12 single-flight
  landed. The owner's decision rested on the smaller figure. Not re-raised as a
  finding — recorded so the decision record is not read as describing today's file.)
- `/u/` over-redaction in `sentry-scrub.ts` — D5, accepted fail-safe trade.
- `hash_prefix` rather than `token_hash_prefix` — D10, forced by the analytics
  blocked-key sanitizer. Correctly applied at both sites
  (`worker/ingress/unsubscribe.ts:151`, `:251`).
- Dedicated DB pool for redemption — deferred to #651 by owner decision.
- Single-sided receipt TTL (D3) and the enumerated redaction contract (D7).
- `estimated_diff_size` overrun (D6) and its measurement-artifact addendum.

## Assessed and found sound

Recorded because the brief asked for an honest verdict on these seams, not only
for defects:

- **Module depth of `src/lib/solicitation/unsubscribe.ts` (545 lines, 11 value
  exports).** Still a coherent deep module, not a bag. The three bands (token
  primitives / receipt / redemption) are not independently splittable: all three
  sit on the same signing-key rollover core (`macMatchesUnderAnySigningKey`,
  `getPreviousSessionCookieSecret`, `macMatches`, `MAX_SIGNED_INPUT_LENGTH`), so a
  split would either duplicate that core or need a third module to hold it.
  A caller does **not** need to understand the redemption state machine:
  `redemptionConfirmsSuppression` (`:234`) exists precisely so the four-outcome
  union stays internal knowledge, and `STATUS_CONFIRMS_SUPPRESSION` as a
  `Record<Status, boolean>` makes a fifth outcome a compile error rather than a
  silent default. That is textbook information hiding. F3 and F4 are the two
  places where the interface leaks; neither is a size problem.
- **Cross-surface duplication.** The two surfaces genuinely differ (machine 200/503
  vs human 303-to-page), and the one predicate that must never disagree —
  "does the recipient's own global opt-out stand?" — has exactly one owner
  (`hasLiveGlobalSuppression`, `:452`), shared by the spent branch and the §1.8
  render-time check, as D8 required. `loadTokenTarget` (`:420`) likewise. The only
  real duplication is the `sql.begin` ceremony (F4).
- **Comment density (~45% across the four main files).** Judged honestly: the
  large majority earns its place. It is dominated by *negative* constraints a
  reader cannot recover from the code — why the ordering is claim-first, why
  `then(release, release)` rather than `finally`, why the counter resets before
  the sink call, why single-flight must not become a semaphore, why the redirect
  is relative. Those are exactly the "why" repworth.md asks for. F1, F2 and F5 are
  the three that have gone stale or wrong; they are the exception, not the pattern.
- **Invariants.** No `any` anywhere in the new code. `node:crypto` throughout
  (#10). No `NEXT_PUBLIC_*` companion for either new config value (#13).
  Composition roots only for the DB singleton (#15) — the two route handlers, the
  server-component page, and `worker/index.ts`. Tenant-scope allowlist grows by
  exactly 5 with an explicit baseline bump 411 → 416 (`scripts/ci/tenant-scope-allowlist.ts:38`).
- **Live-DB fixture hygiene** (`src/lib/solicitation/__tests__/unsubscribe.integration.test.ts`).
  Follows the CLAUDE.md #573 conventions: correctly named for vitest's serialized
  `integration` project, applies no migration DDL, asserts with `assertSchemaReady`
  (`:275`) against `MIGRATION_096_SOLICITATION_SUPPRESSIONS`, and holds the
  cross-process `acquireLiveDbLock` (`:271`) — which it does not strictly need as a
  non-migration-shape suite, but which is the right call given it drives real
  concurrent transactions. Teardown is two-layered and correctly scoped: `afterEach`
  sweeps by the handles that test tracked (`:293-311`), `afterAll` nets by
  `account_id` (`:319-331`), with the comment at `:314` explaining why the second
  layer exists (a mid-sweep throw would otherwise wedge teardown behind the
  `businesses` FK). No suite-shared mutable key, no dependence on table state it
  did not create.
- **Glossary discipline.** No renamed concepts found. Code and comments use
  Suppression ledger, Suppression scope, Unsubscribe token, Correction path,
  Unsubscribe redemption, Success receipt, and Neutral page consistently, and the
  `_Avoid_` synonyms (blocklist, opt-out table, burn the link, confirmation token,
  done parameter, error page, unsuppress, re-subscribe) appear nowhere in the
  diff's source files. F6 is a content error inside a glossary entry, not a
  vocabulary violation.

---

## Low-confidence appendix — NOT reported in the findings table

Observations below `80%` confidence, or that are preference rather than defect.
Recorded so a later reader does not have to re-derive them; **none should be
actioned without independent judgement.**

1. **Sequential DB round trips on the unauthenticated path.** The spent branch
   (`unsubscribe.ts:381` then `:390`) and `hasLiveGlobalSuppressionForToken`
   (`:414` then `:416`) each issue two queries where one `EXISTS`-with-join would
   do; `resolveLandingState` can reach three round trips before rendering. On a
   route whose entire design rationale is minimising unauthenticated DB work —
   and whose single-flight seam exists specifically to protect pool occupancy —
   halving the pool-hold time per request is a real argument. Not tabled: it
   trades against `loadTokenTarget`'s "one owner of this read" property, which is
   the more valuable invariant, and it edges into the #651 pool work.

2. **Observability asymmetry between the two surfaces.** The §1.6 windowed counter
   exists to surface the "#630 mint race — a well-formed token WE minted failing
   to resolve", called a real statutory near-miss. It is emitted only from the
   Railway ingress; `src/app/api/u/[token]/route.ts` reaches the identical
   ledger-miss condition (`redemptionConfirmsSuppression → false`) and records
   nothing anywhere. A mint race manifesting through the human path is invisible.
   Not tabled: plan §1.6 is explicitly scoped to "an unrate-limited route" on the
   worker, so this is a spec-scope question rather than a standards violation, and
   a process-level counter on Vercel's per-invocation isolates would not aggregate
   usefully anyway.

3. **`worker/ingress/unsubscribe.ts` at 518 lines now hosts three separable
   concerns**, not the two D9 considered: the route adapter, the §1.6 window
   (~145 lines), and the D12 per-token single-flight (~90 lines). The latter is a
   DB-pool-protection mechanism that arrived after the owner's decision and is not
   what that decision was about. Explicitly not recommending the split, per the
   brief; noted only because D9 invites a step-7 reviewer to say whether the file
   does more than one job, and the honest answer is that it now does three. All
   three are clearly banded and separately injectable, so the cost today is low.

4. **`worker/ingress/__tests__/unsubscribe.test.ts:147` re-spells the log-prefix
   width** as `hashUnsubscribeToken(validToken).slice(0, 12)` rather than calling
   the exported `unsubscribeTokenLogPrefix`, whose doc comment
   (`unsubscribe.ts:247-252`) claims the digest and its width "keep exactly one
   owner here". The claim is falsified by its own test. Mitigated by the adjacent
   test at `:155` ("the failed line hash prefix matches the one the redemption
   core produces"), which does go through the export.

5. **`redactSensitivePathsAndQueries` is now dual-purpose** — a URL scrubber that
   `worker/config/fastify-options.ts` also applies to `msg` and `err.stack`, i.e.
   free prose. The docstring is honest about it ("do not rely on this function to
   leave prose intact"), but the name still says URL. A rename or a thin
   prose-safe wrapper would remove the surprise. Preference, not defect.

6. **Minor comment-restates-code instances** (`unsubscribe.ts:201`, `:419`).
   Trivial against the surrounding density; listed only for completeness.

7. **Assertions that read as discriminating but are not.**
   (a) `worker/ingress/__tests__/unsubscribe.test.ts:301` —
   `expect(sink.lines()).not.toContain('@')` cannot fail: `UnsubscribeRedemption`
   (`unsubscribe.ts:195-199`) carries only `status` + `tokenHashPrefix`, so the
   adapter never holds a handle. (b)
   `src/lib/solicitation/__tests__/unsubscribe-boot-gate.test.ts:54-56` —
   `toThrow(/SESSION_COOKIE_SECRET_PREVIOUS/)` matches on *any* throw, because the
   static template at `unsubscribe.ts:126-127` always spells that literal; the real
   assertion is `:57`'s `/at least 32 bytes/`. (c)
   `worker/ingress/__tests__/unsubscribe-rate-limit.test.ts:243` —
   `expect(source).not.toContain("request.url.startsWith('/ingress/')")` pins one
   exact string spelling and survives any requoting or hoisting, so it does not in
   fact guard the arm-1 regression that F2 is about. None is a false pass; all
   three overstate what they protect.

8. **Untested branches, in rough order of consequence.** The GET failure path
   (`FailureStage = 'redirect'`, `worker/ingress/unsubscribe.ts:164-171` + the
   `landingPageUrl` throw at `:188`) — unreachable on a deployed lane thanks to the
   boot gate, but fully reachable in dev/mock, and it is the one-Sentry-event-per-
   request hazard `assertUnsubscribeIngressConfigured` exists for. Then:
   `resolveAppUrl`'s trailing-slash strip (`:182`, every fixture uses a bare
   origin, so `…/` → `//u/<token>` would pass); the repeated-`?ok=` array branch
   (`page.tsx:96`); `Cache-Control: no-store` on the 303 (`route.ts:65`);
   `decodeIngressPath`'s malformed-percent `catch` (`rate-limit.ts:89-93`);
   `stop()` idempotency (documented at `worker/ingress/unsubscribe.ts:434`, never
   called twice); the receipt TTL `>` vs `>=` boundary (`unsubscribe.ts:162`).

9. **Test-suite duplication that will drift.** The two boot-gate suites
   (`src/lib/solicitation/__tests__/unsubscribe-boot-gate.test.ts:22-34` and
   `worker/ingress/__tests__/unsubscribe-boot-gate.test.ts:37-49`) assert the same
   two regexes on the same delegated throw — the ingress gate merely calls the
   token gate (`worker/ingress/unsubscribe.ts:204`) — and both carry a near-verbatim
   "silent off a deployed lane / under mock mode" case. Separately, all four
   single-flight properties in `unsubscribe-single-flight.test.ts` are re-asserted
   in `unsubscribe.test.ts:400-522`; the HTTP suite does add per-waiter reply and
   log assertions the unit suite cannot reach, so this is partial rather than pure
   duplication.

10. **`unsubscribe.integration.test.ts:62-63` mutates
    `process.env.SESSION_COOKIE_SECRET` at module top level without `vi.stubEnv`
    and never restores it.** Safe today — `fileParallelism: false` on the
    `integration` project and no sibling integration suite reads that var — but it
    is a cross-suite coupling waiting for the second reader.

11. **The ingress suite drives the process-global unknown-token reporter**
    (`worker/ingress/unsubscribe.ts:517`) rather than an injected one, so a real
    unref'd 60 s timer is shared across the file. Harmless at the current
    sub-second runtime; a latent flake if the file ever runs past 60 s, at which
    point `expect(workerLogRecords(sink)).toEqual([])` (`:234`) would see a window
    flush.

12. **`registerIngressRateLimitHook` is covered only from
    `worker/ingress/__tests__/unsubscribe-rate-limit.test.ts`**, despite being
    general limiter policy for all five providers; the pre-existing
    `worker/ingress/__tests__/rate-limit.test.ts` does not reference it. A future
    edit to `rate-limit.ts` does not obviously point at the file that tests it —
    which is the same discoverability problem as F2, one layer out.

### Verified strong — recorded so it is not re-litigated

The delegated audit ran every suite (191 non-DB tests plus 20 live-DB tests, all
green) and empirically probed the assertions I most suspected. Confirmed genuine,
not vacuous: redaction **is** asserted at the production `warn` lane across all
three shapes prod emits (`worker/config/__tests__/fastify-options.test.ts:165,
:189, :212`), including `err.aggregateErrors[0].message` — closing D2's and D7's
lesson properly; single-flight sharing **is** proven (12 waiters, one `redeem`
call, `unsubscribe-single-flight.test.ts:107-109`, plus an arrival-barrier test
through the real router); the HMAC fixtures reach `timingSafeEqual` rather than the
length short-circuit (forged MACs are `'A'.repeat(43)`, the exact base64url width);
key rollover is walked end-to-end (`unsubscribe.test.ts:163-322`); the three
concurrency tests are each non-vacuous (row-lock serialisation, mint-race →
`unknown_token`, purge → `account_id NULL`); and commit-before-2xx is asserted as
an *order*, not a status, which is the right shape for §9.1.
