# #644 — deviations from the plan

Entries are things plan revision 7 did not anticipate. Each gets a triage verdict
(ACCEPT / RE-PLAN) at step 6.5, before any review agent sees this file.

---

## D1 — `SESSION_COOKIE_SECRET` rotation invalidates delivered unsubscribe links

**Raised** 2026-08-03, step 4 start, before T1a was dispatched. The handoff named this
as the open question on §1.4a ("confirm whether a `SESSION_COOKIE_SECRET` rotation would
invalidate delivered links"). It does.

**Mechanism.** §1.4a keys `isWellFormedUnsubscribeToken` on `getSessionCookieSecret()`
(`src/lib/shared/session-cookie-secret.ts:9`). `token_hash` is an *unkeyed* SHA-256, so a
rotation does not corrupt the lookup — it makes every **already-delivered** link fail the
admission gate and land on 503 (ingress) or the neutral page (landing), while the token row
remains perfectly valid and redeemable. CAN-SPAM §7704(a)(3) requires the link operate
≥30 days, so the failure is statutory, silent, and indistinguishable from a genuine unknown
token by design (§5.4).

**Pre-existing, not introduced.** Rotation already breaks the keep-my-data offboarding token
today — `src/lib/account-offboarding/tokens.ts:24` derives the raw token as a deterministic
HMAC under the same secret and persists only its hash. #644 raises the consequence to
statutory grade; it does not create the coupling. `SESSION_COOKIE_SECRET` has no entry in
`.claude/reference/env-vars.md` at all, and no rotation procedure exists anywhere in the repo
(it is asserted at worker boot only — `worker/config/startup-assert.ts:449`).

**Owner decision 2026-08-03: document-only constraint.** Options weighed were dual-secret
verification (`SESSION_COOKIE_SECRET_PREVIOUS`), a dedicated never-rotated
`SOLICITATION_UNSUBSCRIBE_TOKEN_SECRET`, and withdrawing the HMAC gate. Document-only was
chosen: it costs no code and no new secret to provision, and the two rejected code options
each add a path for an event that has never happened and still has no procedure. Withdrawing
the gate was rejected outright — it reopens owner-run #3 findings 2 and 3 (the unbounded
unauthenticated DB path and the bulkhead loss path that revision 7 deleted).

**Deliverable, owned by T3** (`.claude/reference/env-vars.md` is already in
`allowed_edit_surface`, so this needs no surface amendment):

- Add a `SESSION_COOKIE_SECRET` registry entry stating it MUST NOT be rotated without a
  documented procedure, and naming **both** blast radii: in-flight unsubscribe links
  (statutory, ≥30 days) and keep-my-data offboarding tokens.
- State the escape hatch explicitly — if a rotation ever becomes necessary, dual-secret
  verification is the scoped follow-up, and it must land *before* the rotation, not after.

**Not a surface amendment. Not a re-plan trigger.** §1.4a's design is unchanged; T1a's spec
is unchanged. The residual risk is accepted and now visible instead of silent.

---

## D2 — §1.5's redaction fix was incomplete: Fastify logs the 404 URL as a message string

**Raised** 2026-08-03 by the T1a implementer, commit `2e181fc0`.

Plan §1.5 closed the unmatched-404 leak with a pino `logger.serializers.req`. That is
necessary but **not sufficient**. Fastify's default 404 handler logs
`Route GET:/ingress/unsubscribe/<token>/extra not found` as a **plain message string**, and
pino serializers bind only to the `req`/`res`/`err` objects — never to the message. So the
exact case §1.5 was written for still leaked the raw Unsubscribe token, violating
invariant #5.

Fastify writes the URL in **three distinct shapes**, and the plan knew about one:

| Shape | Emitted by | Level | Reached by |
|---|---|---|---|
| serialized request object | `incoming request`, before `onRequest` and before routing | `info` | `serializers.req` |
| plain message string | the default 404 handler | `info` | `hooks.logMethod` |
| serialized **error** object | `FST_ERR_REP_ALREADY_SENT` (`reply.js:145`); any 5xx | `warn` / `error` | `serializers.err` |

**The third shape is the one that mattered, and it was found last** (T1a quality review,
Critical). `hooks.logMethod` rewrites only **string** arguments, so an `Error` argument passes
through untouched and `err.message` / `err.stack` keep the raw URL — and the raw token.

The sting is in the levels. Production runs the ingress logger at **`warn`**
(`buildFastifyOptions(productionConfigRequired)`), so the two shapes the first fix closed are
`info` and **are never emitted in production at all**. The error shape logs at `warn` and
`error` — above the threshold. The first fix therefore closed exactly the shapes prod does not
emit and left open the one it does, while the deviations entry below claimed the leak was
shut. Invariant #5 was unsatisfied on the worker the whole time.

Compounding it, the test harness pinned `buildFastifyOptions(false)` — the `info` lane — and
drove no error path, so the suite was structurally incapable of failing for this, despite
carrying a comment naming the prod `warn` level as what let the class survive three reviews.

**Fix in flight:** wrap pino's `stdSerializers.err` with the same single rule, and restructure
the suite to assert against the **production `warn` lane** with a real error path. One rule,
now four sinks (Sentry, `req`, message strings, `err`).

**Lesson worth promoting at merge:** every previous instance of this bug was found by
*measuring* Fastify rather than reasoning about it — but measurement at the wrong log level is
just a slower way to be wrong. Redaction tests must run at the level production runs at.

**Closed in the same file** with a pino `hooks.logMethod` applying the *same single rule*
(`redactSensitivePathsAndQueries`) to every string argument. One rule, now three sinks
(Sentry, the request serializer, the log message).

**Scope.** `worker/config/fastify-options.ts` is already in `allowed_edit_surface` as surface
amendment #2, so this widens nothing — it is a correction *within* the amendment the plan
already spent, not a third amendment. It is correctly scoped to the Fastify server logger
only; `createWorkerLogger` (`src/lib/shared/logger.ts`) is a separate logger and is untouched,
so CLAUDE.md's "string args are logged verbatim" note still holds for the worker's own
structured logging.

**Verdict: ACCEPT, but necessary-not-sufficient — see the third shape above.** Both mechanisms
below are load-bearing and neither is redundant; they were simply not the whole set, and the
missing one was the only member of it production emits. The empirical confirmation that
follows is sound as far as it goes — its limit was the log level it ran at, not its method.

The T1a spec reviewer stood up four
real Fastify 5.8.5 instances from `buildFastifyOptions` with pino's stream captured and
injected `GET /ingress/unsubscribe/SECRET_TOK_ABC123/extra`. With the hook removed the 404
line reads `"msg":"Route GET:/ingress/unsubscribe/SECRET_TOK_ABC123/extra not found"` — raw
token present. With it shipped, `[REDACTED]`. Removing the serializer instead leaks via
`req.url`, so **both mechanisms are load-bearing** and neither is redundant. Cost measured at
465 ns/call, and pino skips `logMethod` entirely below level (2 hook fires for 4 calls at
`level:'warn'`), so the prod default is unaffected. `createWorkerLogger` is `console.*`-based
rather than pino, so it is genuinely untouched.

This was measured rather than reasoned about precisely because the plan had been wrong about
Fastify logging behaviour twice before.

---

## D3 — receipt TTL is single-sided by design

**Raised** 2026-08-03 by the T1a implementer.

`verifyUnsubscribeReceipt` rejects `age > 10 minutes` but accepts a future-dated
`issuedAtMs`, rather than enforcing a symmetric window. Rationale: a lower bound would reject
the *common* case under ordinary clock skew between serverless instances.

Assessed and **ACCEPT**. A future-dated receipt is only mintable by a holder of
`SESSION_COOKIE_SECRET`, so it is not an attacker-reachable vector — the worst case is our own
clock being wrong, which extends one receipt's window and is bounded by §1.8's rule that a
receipt is **never sufficient on its own**: the render-time ledger read still governs whether
the success claim is true.

---

## D4 — the admission gate throws on missing `SESSION_COOKIE_SECRET` (fail-closed)

**Raised** 2026-08-03 by the T1a implementer.

`isWellFormedUnsubscribeToken` propagates the config error rather than returning `false`.
Deliberate: returning `false` would silently reclassify every genuine opt-out as malformed —
a silent statutory failure, and exactly the false-neutral class this ticket keeps closing.
The error is reachable only by misconfiguration, never by hostile input.

**Carried as a constraint into T1c and T2** (not a defect):

- The ingress adapter catches it and returns 503 with a Sentry event, per §9.1.
- **Vercel does not assert it** — `src/lib/config/server.ts:104` reads it as optional. The
  landing page must therefore let this error **propagate loudly** (500) and must NOT swallow
  it into the neutral page. Rendering "we couldn't find that" when the real cause is a missing
  secret would make every opt-out fail invisibly — the precise failure mode §1.8 exists to
  prevent.

### D4 correction — the worker does NOT assert this secret at boot

My original D4 claimed "the worker asserts `SESSION_COOKIE_SECRET` at boot
(`worker/config/startup-assert.ts:449`), so the ingress cannot hit this in practice."
**That is false**, caught by the T1a spec reviewer and verified directly.

`startup-assert.ts:447` returns early unless `ACCOUNT_OFFBOARDING_ENABLED === 'true'`, and
:448 skips again under `MOCK_EXTERNAL_APIS=true`. That flag is documented **Off**
(`env-vars.md:517` — "leave off until the full 7-PR sequence lands"), so in production today
`SESSION_COOKIE_SECRET` is **never asserted at worker boot at all**. The assertion is scoped
to the delete_data flow, not to the secret in general.

**Consequence, which #644 introduces.** Before §1.4a the ingress had no need of this secret.
Now a worker deployed without it boots perfectly clean, then throws inside
`isWellFormedUnsubscribeToken` for **every well-formed token**, 503s each one, and the
provider retries forever — a statutory opt-out silently lost, with no boot signal and no
distinguishable symptom (§5.4 makes 503 the correct answer for a genuine unknown token too).

**Required in T1c, and it needs no surface amendment.** The shipped precedent is
`src/lib/account-offboarding/tokens.ts:29`, where the token module exports its own
`assertKeepMyDataTokenSecretConfigured()` and a composition root calls it. T1c does the same:
export `assertUnsubscribeTokenSecretConfigured()` from `src/lib/solicitation/unsubscribe.ts`
and call it from `worker/index.ts` at boot, alongside the seven existing `assert*Env()` calls
(`worker/index.ts:528`). Both files are already in `allowed_edit_surface`.

Deliberately NOT placed in `worker/config/startup-assert.ts`, despite that being the
conventional home for boot-time env assertions: that file is outside the edit surface and
would cost a **third** surface amendment, which the owner has to authorise explicitly. The
tokens.ts precedent achieves the same guarantee in-surface, and arguably hides information
better — callers never learn *which* secret the module needs.

---

## D7 — worker log redaction is **enumerated**, so it carries a caller contract

**Raised** 2026-08-03 by the T1a quality re-review of `8efd2b8d` (Important, approved with
this residual).

The fix redacts via pino's `redact: { paths: ['msg', 'err.message', 'err.stack'], censor }`.
That is **path-based and therefore enumerated** — any string logged outside those paths is
written raw. Three misses measured at the production `warn` lane:

1. `err.aggregateErrors[*].message` — `pino-std-serializers` emits a separate recursive array
   (`lib/err.js:24`) that the listed paths do not reach.
2. A **custom enumerable property** on an Error — the serializer's `for (const key in err)`
   copies it verbatim.
3. An error logged under **any key other than `err`**.

**Not a regression, and not a reason to revert.** The reviewer verified that its own
originally-prescribed fix — wrapping `stdSerializers.err` — redacts exactly the same two
fields and would have leaked all three identically. So the substitution is **equal on
coverage and better on dependency hygiene**: `pino` is not a direct dependency and resolves
only transitively (`.pnpm/pino@10.3.1`), so importing it would have been a phantom dep failing
at runtime on Railway. Structural-looking is not the same as structural.

**Two actions, split by what enumeration can and cannot fix:**

- **Closeable by enumeration → DONE** (`11f19966`). **The reviewer's prescribed path was
  insufficient and measurement caught it.** `err.aggregateErrors[*].message` alone does not
  close the case: an `Error`'s stack always begins with its message, so the inner entry leaks
  through `stack` independently — `"stack":"Error: inner failure at /u/SECRET_TOK\n at …"` —
  and the whole-output assertion still failed. Both `…[*].message` **and** `…[*].stack` are
  required, mirroring the existing top-level pair. Red-before-green demonstrated.
- **NOT closeable by enumeration → becomes a stated contract on T1c and T2.** No handler on
  the unsubscribe path may put a raw token or raw URL into a custom error property, or log an
  error under a non-`err` key. The §9.5 structured line goes through `createWorkerLogger` with
  a `token_hash` prefix only — never the raw token, never the raw handle. Carried verbatim
  into both prompts.

**The general lesson, worth promoting at merge:** a redaction seam that enumerates paths is
only as good as the list, and the list is invisible to the caller. Where the seam cannot be
made structural, the residual must become an explicit contract rather than an assumption —
this entry *is* that contract. The `.stack` miss above is the same lesson eating its own tail:
even the enumerated fix was under-enumerated on first attempt.

**Meta-lesson, and the strongest signal on this branch.** Reviewer claims about pino/Fastify
internals have now been **wrong three times**, each caught by an implementer who measured
instead of complying:

1. the prescribed `stdSerializers.err` import would have been a phantom dependency (`pino` is
   not a direct dep and resolves only transitively);
2. the `msg`-already-redacted repro did not reproduce — pre-fix that line leaked three fields,
   not two, so the Critical understated itself;
3. `err.aggregateErrors[*].message` alone was reported sufficient and is not.

Every one of these came from reasoning about framework behaviour that looked obvious. The
review reports are on disk and will be read as settled fact by whoever comes next, so the
corrections are annotated in place. **Treat any claim about pino or Fastify internals in this
branch's reports as a hypothesis until re-measured.**

---

## D8 — §1.8 requires a capability §1.2's interface never exposed

**Raised** 2026-08-03 while scoping T2, before dispatch. **This is a gap in the plan itself,
not in any slice's execution.**

§1.8 states the corrected invariant that revision 7 was built around:

> *A page may claim "you are unsubscribed" only from a ledger read taken during that render.*

So `GET /u/<token>?ok=<receipt>` must confirm a live `scope='global'` row **at render time**.
But §1.2's interface list — and therefore T1a's and T1b's implemented exports — contains no
function that can answer that question:

| Existing export | Why it cannot serve the render-time read |
|---|---|
| `findRedeemableUnsubscribeToken` | Filters on `redeemed_at IS NULL` by design. On the success page the token is **by definition** already redeemed, so this always returns `null`. |
| `redeemUnsubscribeToken` | Writes, and takes a `TransactionSql`. A `GET` render must write nothing (§5.3). |

The ledger existence check does exist, but only as **logic internal to
`redeemUnsubscribeToken`'s spent branch** — unreachable from a read-only render path.

**Consequence if unnoticed.** T2 would have had no way to satisfy §1.8's render-time rule and
would most likely have fallen back to trusting the verified receipt alone — which is exactly
the **third false-success vector** (owner-run #3, finding 4) that revision 7 called the root
cause of the whole class. The plan closed that vector in prose and left no seam to implement
it through.

**Resolution — scoped into T2, no surface amendment.** Add one read-only export to
`src/lib/solicitation/unsubscribe.ts` (already in `allowed_edit_surface`):

```ts
/** §1.8 render-time check. Read-only, scope='global' only. */
export async function hasLiveGlobalSuppressionForToken(
  db: SqlExecutor, rawToken: string,
): Promise<boolean>;
```

Constraints carried into T2's brief:

- Gates on `isWellFormedUnsubscribeToken` first — **zero DB work** on a forged token, same as
  every other entry point (§1.4a).
- Resolves the token by `token_hash` **regardless of `redeemed_at`**, then tests
  `scope='global'` existence on `(channel, normalized_handle)`. Returns `false` when no token
  row exists — an unknown token is not a suppression.
- **`scope='global'` only**, never `suppressionMatchSql`: an `account`-scoped row satisfies
  that fragment while falsifying the §5.5 success sentence.
- **One authoritative owner.** `redeemUnsubscribeToken`'s spent branch already performs this
  query. T2 must factor the existing check into a shared private helper and have **both** call
  it — not copy the SQL. Two hand-maintained copies of a compliance predicate is precisely the
  duplication `engineering.md` forbids.
- Needs its own `pre-auth-token` tenant-scope allowlist entries with a baseline bump.

**Sequencing:** T2 cannot be dispatched in parallel with T1c — both edit
`src/lib/solicitation/unsubscribe.ts` (T1c adds the D4 boot-gate export). T2 waits.

---

## D9 — the edit-surface guard blocked a new file; owner declined amendment #3

**Raised** 2026-08-03 by the T1c implementer. **The enforcement worked as designed** — this
entry exists because the guard stopped something, not because something slipped through.

T1c wanted `worker/ingress/unknown-token-window.ts` for the §1.6 counter. `allowed_edit_surface`
enumerates files, and that path is not among them, so the pre-edit hook refused it. The
counter therefore lives as a clearly-banded section inside `worker/ingress/unsubscribe.ts`
(315 lines), with the injectable-clock factory still exported so the window tests stay
deterministic rather than waiting 60 real seconds.

**Owner decision 2026-08-03: leave it in-file. Amendment #3 declined.** At 315 lines the file
is not unreasonable, both concerns belong to the same route, and splitting a file at the end
of a slice costs a re-review for a structural preference rather than a defect. Revisit only if
a step-7 reviewer independently flags the file as doing two jobs — the split is mechanical and
can ride a follow-up.

**Surface amendment count stands at 2 of 2.** Everything since has been resolved in-surface,
including the D4 boot gate (via the `tokens.ts` precedent) and D8's render-time seam.

---

## D10 — `createWorkerLogger` silently DROPS any key containing `token`

**Raised** 2026-08-03 by the T1c implementer. **Promote to `.claude/reference/lab-notes.md` at
merge — this generalises well beyond #644.**

`createWorkerLogger`'s object arguments pass through the analytics **blocked-key sanitizer**,
which strips any key whose name contains `token`. The §9.5 structured line was going to carry
`token_hash_prefix` — the one field that makes a redemption correlatable across retries — and
it would have been **silently removed from every log line**. No error, no warning: the field
simply would not be there, and the omission would only ever be noticed while debugging a
production incident, which is exactly when it is needed.

Renamed to `hash_prefix`, which the sanitizer passes.

The trap is that the sanitizer is doing its job: a key called `*token*` is overwhelmingly
likely to hold a secret, and dropping it is right. The collision is that a **hash prefix of** a
token is safe by construction and reads as a token by name. Invariant #5 says never log the
raw token; it does not say never log a name containing the word.

**Lab-note form:** *any deliberately-safe derived value — a hash prefix, a masked suffix, a
key id — must be NAMED so it does not collide with the blocked-key sanitizer, or
`createWorkerLogger` will drop it without a sound.*

---

## D5 — the `/u/` redaction rule over-redacts, and that is the accepted trade

**Raised** 2026-08-03 by the T1a spec reviewer (severity: low).

The `/u/` alternative in `redactSensitivePathsAndQueries` is unanchored, because the shipped
console-message contract (`GET /u/tok 200`) puts the path mid-string. So any logged string
containing `/u/` is truncated to the next whitespace — a Sentry breadcrumb
`https://www.google.com/maps/u/0/contrib/12345` becomes `…/maps/u/[REDACTED]`. In a codebase
that handles Google Business Profile and Maps URLs, that is a real diagnostics cost.

**ACCEPT.** The rule fails **safe**: over-redaction loses debugging detail, under-redaction
leaks a statutory token and violates invariant #5. Making the match precise (anchoring to the
first path segment, so `://host/u/…` and `^/u/…` match while `/maps/u/…` does not) is a
tighter regex in a code path that has already been got wrong twice across three review
rounds — and each attempt to make it cleverer is what produced those defects. The asymmetry
of the two failure modes does not justify the risk.

If it bites in practice, the scoped follow-up is anchoring the `/u/` and `/api/u/`
alternatives to a path-start boundary; `/ingress/unsubscribe/` is distinctive enough to need
nothing.

---

## D6 — `estimated_diff_size` is stale and the branch will overrun it

**Raised** 2026-08-03, tracking only — no action required yet.

The intake locks `estimated_diff_size` at `+900 / -10`. **T1a alone is +533 / -10** across
seven files, with T1b, T1c, T2 and T3 still to land. A rough projection puts the finished
branch near +2000, which crosses step 5's re-classification trigger (actual > ~2× estimate =
+1800).

**Why the estimate is stale rather than wrong.** It was written against plan revision 2. Six
review rounds later, revision 7 had added: the self-authenticating token scheme and its
admission gate (§1.4a), the signed success receipt and its render-time ledger read (§1.8),
the 60-second unknown-token aggregate with replica tagging and shutdown flush (§1.6), the
dual-sink redaction rule (§1.5), and now a boot gate (D4). Each was a review finding accepted
on merit. The scope grew because the design got more correct, not because it drifted.

**Why re-running step 0 would change nothing.** The trigger exists to catch
*under-classification* — work routed into a lane too light for its risk. This ticket is
already in the heaviest lane available (RISK=high, full pipeline, adversarial plan review,
dual step-7 review, staging ride before `main`). There is no heavier lane to escalate into.
The two amendment-based abort criteria already fired earlier and were explicitly superseded by
the owner's direction to resolve all findings in-ticket.

**RESOLVED — owner decision 2026-08-03: amend the estimate and continue.**

Raised with the measured number rather than the projection: at T1a + T1b the branch stood at
**+1612 / -12** across 8 files, with T1c, T2 and T3 outstanding. `estimated_diff_size` is
amended in **both** intake copies from `+900 / -10` to **`+2900 / -50`**, and
`state.json.intakeSha256` re-derived (`76f19e0c…`) so the resume drift-check stays honest.

Options weighed and rejected:

- **Stop and re-plan** (the literal abort-criteria reading). Rejected: it discards two
  reviewed, tested slices — 24 of 70 promised tests, one Critical already found and fixed —
  and the most probable post-mortem finding is "the estimate was stale", which is already
  known. Restarting would re-derive the same design.
- **Split T2 into a follow-up ticket** to bring the number down. Rejected as actively unsafe:
  T1c's `GET` 302s to `/u/<token>`, so without T2 that redirect 404s, and the intake's own
  rollback plan names "delivered asks advertising URLs that 404" as the principal revert risk.
  It would ship a knowingly broken statutory path to satisfy a metric.

The reasoning that decided it: the trigger exists to catch work routed into too **light** a
lane. This ticket already sits in the heaviest lane available, so re-running step 0 re-derives
the same routing and buys nothing. The growth is traceable to accepted review findings —
§1.4a, the receipt, the windowed aggregate, dual-sink redaction, the D4 boot gate — not to
drift. A metric that would have us ship a broken opt-out path to stay under a number is being
read wrongly.
