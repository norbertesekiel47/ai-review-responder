# #679 — standards & maintainability review (round 3, verification-only, LAST)

Scope: the single commit `4c4e9df9` ("review round 2 — pin the savepoint, narrow
its catch, correct the docs"). Base `main@2f369582`; round-2 review commit
`3b7e0404`. Nothing outside `git show 4c4e9df9` is in play.

**Constraints honoured.** No `*.integration.test.ts` suite was run and
`pnpm test:db:setup` was never invoked (a sibling agent holds the live-DB lock).
Everything below is static analysis plus non-integration vitest, `pnpm lint`,
`pnpm typecheck`, and seven `ci:*` audits. Claims that only a live run can settle
are marked as such rather than asserted.

Gates on the worktree:

- `pnpm lint` — clean. `pnpm typecheck` — clean.
- `ci:analytics-events`, `ci:static-policy`, `ci:db-imports`, `ci:live-db-suites`,
  `ci:outbox-seam`, `ci:process-env`, `ci:feature-surface` — all PASS.
- The three non-integration suites `4c4e9df9` touched
  (`import-offer-junction.test.ts`, `import-offer-resume.test.ts`,
  `route.test.ts`) — 27/27 green, no stderr `warn` lines.
- `git status --porcelain` — clean apart from the round-3 brief and this report.

---

## 1. Verification of my round-2 findings

| # | Round-2 finding | Status | Evidence |
|---|---|---|---|
| R1 | **Medium** — `emitConsentEvent`'s `catch` is unbounded; a JS wiring error is swallowed identically to a Postgres constraint failure | **LANDED** — with three defects in the landing (F1, F2, F4 below) | `src/lib/reviews/import-consent.ts:484` now rethrows anything without a string `code`. Verified it does the thing R1 actually asked for: `enqueueAnalyticsEvent`'s plain-`Error` guard (`src/lib/analytics/enqueue.ts:24-26`) and `sanitizeAnalyticsProperties` both throw code-less errors and now propagate. The junction suite runs clean — 6/6 green, zero `warn` lines in stderr (was 5 lines). |
| R1a | Fix 1 — complete `mockTx` in the junction suite | **LANDED** | `src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts:94`. |
| R1b | Fix 2 — narrow the catch (I proposed `instanceof postgres.PostgresError`) | **LANDED, but implemented WIDER than proposed** | The shipped duck-type also swallows postgres.js connection-lifecycle errors and Node OS-socket errors. See F2. |
| R2 | **Medium** — the savepoint ships with zero coverage of its own new behaviour | **LANDED (static verification only)** | Two new titles at `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:591` and `:648`, both registered in `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json:112-113` (38 → 40). I could not execute them; the construct review is in §3. |

**Net: both of my round-2 findings LANDED. Nothing I raised REGRESSED.**

---

## 2. The narrowing — is it the right construct? (my axis's priority)

`src/lib/reviews/import-consent.ts:484`:

```ts
if (typeof (error as { code?: unknown }).code !== 'string') throw error;
```

The commit and the JSDoc justify this as the house inline-`code` pattern, citing
`src/lib/locations/duplicate-location.ts:24` and
`src/lib/onboarding/create-business.ts:62`, "rather than inventing a predicate".

**That justification does not survive reading either citation.**

### 2.1 The cited sites are predicates, and they narrow to a specific code

```ts
// duplicate-location.ts:21-25
export function isDuplicateLocationViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === '23505' && e.constraint_name === DUPLICATE_LOCATION_CONSTRAINT;
}
```

`create-business.ts:59-63` is the same shape, and its own JSDoc says so
("mirrors the constraint-name matching in
`src/lib/locations/duplicate-location.ts`"). Three differences from line 484,
each of them the load-bearing one:

1. **They are named predicate functions**, not inline checks in a `catch`. Lines
   24 and 62 are the *bodies* of `isDuplicateLocationViolation` and
   `isDuplicateEmailViolation`. Citing them as precedent for "not inventing a
   predicate" inverts what they are: the house pattern at those sites is
   *extract a named predicate with a doc comment*.
2. **They narrow to a specific SQLSTATE and constraint** (`23505` +
   `businesses_account_place_uniq` / `users_email_key`). Line 484 asserts only
   that *some* string `code` exists. `duplicate-location.ts:17-20` states in
   prose why the specificity matters — "Guarding on the CONSTRAINT name keeps any
   unrelated 23505 … from being swallowed" — which is the exact discipline line
   484 declines.
3. **They guard object-ness before the cast.** Line 484 does not.
   `(error as { code?: unknown }).code` on a `null` or `undefined` rejection
   throws `TypeError: Cannot read properties of null` **inside the catch block**,
   which escapes `emitConsentEvent` and aborts the caller — the precise failure
   class the savepoint exists to prevent. Both precedents carry
   `typeof err !== 'object' || err === null` for exactly this reason.

I do **not** claim a production path that throws a non-object here: postgres.js
always rejects with an `Error` (`node_modules/postgres/src/errors.js`). The claim
is the standards one — the guard both cited precedents carry was dropped, and the
citation that authorises dropping it does not say what it is said to say.

### 2.2 The repo already owns this exact operation

`errorStringProperty(value, property)` —
`src/lib/payments/stripe-error-inspect.ts:41-45`:

```ts
export function errorStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : undefined;
}
```

That is "does this unknown error carry a string `code`?", null-safe, with six
existing call sites — including **both** DB-error predicates the brief names:
`src/lib/db/transient-error.ts:61` (`isTransientPostgresError`) and `:102`
(`isCrashNetRecoverableDbError`), plus `worker/index.ts:894,905` and
`worker/jobs/billing/stripe-overage-error.ts:29,31`. `transient-error.ts:26`
already crosses the same `src/lib/**` boundary (`../payments/stripe-error-inspect`)
that `import-consent.ts` would.

`if (errorStringProperty(error, 'code') === undefined) throw error;` is
**byte-for-byte the same semantics** as the shipped line, minus the unguarded
cast, plus a comment-free statement of intent.

### 2.3 Weighing this against the two rules the brief says it must beat

- **"No abstraction before the second use."** Does not apply. `errorStringProperty`
  is not a new abstraction — it exists, it has six callers, and it is already the
  accessor the repo's DB-error layer is built on. This is reuse, not invention.
- **CLAUDE.md's explicit instruction to keep `isCrashNetRecoverableDbError` and
  `isTransientPostgresError` distinct.** Does not apply either. I am **not**
  recommending unification with, or reuse of, either predicate — their allowlists
  encode retry/crash policy that has nothing to do with an analytics emission, and
  CLAUDE.md's keep-distinct rule is correct. `errorStringProperty` is the shared
  *low-level accessor* those two predicates are each built on top of; using it
  does not couple this module to either policy.

So the recommendation clears both bars, which is why F1 below is a finding rather
than a preference.

### 2.4 The `as { code?: unknown }` cast against the no-`any` rule

CLAUDE.md's rule is "No `any` … use `unknown` and narrow". `error` arrives as
`unknown` (strict `useUnknownInCatchVariables`), so the letter is met — there is
no `any`. The spirit is not: the cast is an **unverified type assertion**, not a
narrowing. Both cited precedents assert only *after* a runtime `typeof … ===
'object'` check, which is what turns their cast into a narrowing. Line 484
asserts a shape it never checks. It is not "papering over an unmodelled error
type" in the strong sense — the type it needs (`PostgresError`) *is* modelled, at
`node_modules/postgres/types/index.d.ts:704`, and round 2 pointed at it — but it
is the weakest of the three forms available (`instanceof PostgresError` >
`errorStringProperty` > unguarded cast), and it is the one that shipped.

### 2.5 What the narrowing actually buys, honestly stated

The wiring bug the JSDoc names — "A handle without `.savepoint` (root `sql`,
`sql.reserve()`, a `Sql`-shaped mock)" — is **already unrepresentable in
production** under this repo's `strict` config: `savepoint` exists only on
`TransactionSql` (`node_modules/postgres/types/index.d.ts:723-725`), `Sql` does
not carry it, and every consumer is typed `tx: TransactionSql`
(`import-consent.ts:242`, `:478`). Passing the outer `sql` is a compile error, and
`pnpm typecheck` is a CI gate.

The two handles that actually lacked `savepoint` were **test mocks** (`any`-typed,
outside the type system's reach). So the narrowing's demonstrated value is mock
fidelity, bought with a production semantic change on the highest-availability
path on the branch. That trade is defensible — I am not arguing to revert it — but
it raises the bar on getting the construct exactly right, and §2.1–2.4 say it is
not exactly right.

---

## 3. The two new savepoint titles — does the `Proxy` pin for the right reason?

Read statically; **not executed** (live-DB lock). `failingEmission`
(`import-offer-analytics.integration.test.ts:317-360`) is sound, and the two
non-obvious hazards a `Proxy`-based injection usually carries are both handled:

- **It keys on the statement, not on `savepoint`.** The `apply` trap fires when
  `isAnalyticsEmission(args[0])` matches `INSERT INTO analytics_events`
  (`:294-301`), so the injection is reached on **both** mutation shapes. A hook on
  the `savepoint` method would be unreachable once the savepoint is deleted and
  would prove only that a method was called. The header says exactly this at
  `:325-332` and the code matches.
- **The savepoint handle is re-wrapped** (`:346-350`): postgres.js mints the
  savepoint's `sql` from a fresh instance inside `scope()`, so it does not inherit
  the proxy. Without the re-wrap the shipped path would escape the injection
  entirely — and the test would pass for exactly the wrong reason. It is wrapped.

The mutation reasoning checks out on inspection: with the savepoint present the
poison `23514` is issued on `sp`, postgres.js `ROLLBACK TO`s and rethrows,
line 484 swallows it (23514 carries a string `code`), the caller's later
`UPDATE businesses` at `:604` commits and `row.name` matches. With the savepoint
deleted the poison is issued on the caller's own handle, Postgres aborts the
transaction, and that same `UPDATE` fails `25P02` — RED. The `expect(...).rejects`
precondition at `:588-598` closes the "injection silently stopped firing" hole,
which is the right instinct for a test whose body is three assertions of absence.

One construct detail I checked because it would have been a silent wrong-reason
pass: for the matched statement the `apply` trap returns a bare
`Promise<void>` rather than a postgres.js `Query`. `enqueueAnalyticsEvent`
(`src/lib/analytics/enqueue.ts:29-54`) only `await`s and never destructures rows,
so nothing breaks. Safe today; the comment at `:352-353` ("callers destructure its
rows") covers the *unmatched* branch only, which is worth knowing if this proxy
is ever reused for a `RETURNING` statement.

**Verdict on the construct: correct.** Whether it goes RED on the mutation is
live-DB evidence I could not produce; the orchestrator's round-2 note records it
was mutation-verified both ways, and the code is consistent with that claim.

---

## 4. The two mock completions — faithful, or papering over?

**`import-offer-junction.test.ts:94`** — `mockTx.savepoint = vi.fn(cb => cb(mockTx))`.
Faithful for what this suite asserts. Real `TransactionSql.savepoint` passes a
*distinct* handle, but on the *same* connection and inside the same transaction,
so statements issued through it belong to `tx`. Passing `mockTx` back keeps the
emission's statements in the same `txCalls` ledger the suite reads — which is the
behaviour that matters here. The mock does not model `ROLLBACK TO`, but nothing in
these six titles injects a failure, so there is nothing to roll back. Not papering
over anything.

**`import-offer-resume.test.ts:79`** — `mockSql.savepoint = vi.fn(cb => cb(mockSql))`,
on the same object `mockSql.begin` hands back as the transaction (`:72`).

The brief asks whether "`begin` hands the same object back" is faithful to
postgres.js. **Strictly, no** — postgres.js mints a fresh `Sql` per transaction —
but that line is **pre-existing context, not part of `4c4e9df9`**, and the commit's
addition is consistent with it rather than compounding it. The one fidelity gap
the addition does introduce is worth naming and then dismissing: it puts
`savepoint` on the object that also stands in for the **root** `sql`, and the real
root `Sql` has no `savepoint`. So this mock can no longer distinguish "was handed
`tx`" from "was handed `sql`" — the very confusion the narrowing was written to
catch.

That gap is **not load-bearing**, because the type system already forecloses it in
production (§2.5): `createImportOffer(tx: TransactionSql, …)` rejects a root `Sql`
at compile time. Correct mock completion, with a limitation that costs nothing.
Recorded here so round 3 is the last time anyone derives it.

---

## 5. Comment density on `emitConsentEvent`

Asked because this branch's `reclassify` row counts comments as production lines
and the module is already comment-heavy. **Measured, and it is a non-issue.**

`4c4e9df9` grows the `emitConsentEvent` JSDoc by net +12 lines (3 removed, 15
added), taking `import-consent.ts` from 614 → 626 lines and its comment share from
~47.4% to **48.4%** (303 comment-ish lines of 626).

Repo band, measured the same way on this worktree:

| Module | lines | comment-ish | share |
|---|---|---|---|
| `src/lib/reviews/import-consent.ts` (post) | 626 | 303 | 48.4% |
| `src/lib/db/transient-error.ts` | 104 | 50 | 48.1% |
| `src/lib/locations/duplicate-location.ts` | 49 | 23 | 46.9% |
| `src/lib/solicitation/unsubscribe.ts` | 612 | 268 | 43.8% |

48.4% sits at the top of a 44–48% band, not outside it. This is a house style, and
`4c4e9df9` moves the number by one point. **Not a finding**, and the `reclassify`
WARN is out of scope per the brief regardless.

What the added prose says is a separate matter, and one point of it is wrong — see
F2 and F4.

---

## 6. Doc rewrites and citations

Spot-checked on my axis (comment accuracy is maintainability); the spec axis owns
completeness.

- **`supabase/migrations/102_….sql:16-38`**, **`.claude/reference/migrations-log.md:1002-1015`**,
  **`docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md:399-416`**,
  **`docs/analytics/events.md:279,290`** — all four now describe the SHIPPED
  behaviour (savepoint → lost metric + `warn`, not a lost decision, not a failed
  connect), all four keep migration-before-code ordering as load-bearing, and all
  four point at #697 for the missing durable sink. Consistent with each other and
  with `import-consent.ts:55-73`. **Accurate.**
- **`route.test.ts:322`** — `ZernioBackfillWorker.ts:379` → `:416` resolves:
  `worker/jobs/zernio/ZernioBackfillWorker.ts:416` is
  `SET imported_count = ${importedCount},`. **Correct.**
- **`import-consent.ts:473-474`** — `duplicate-location.ts:24` and
  `create-business.ts:62` both resolve to the lines claimed. The *line numbers*
  are right; what the JSDoc says those lines demonstrate is not (§2.1).
- **`import-consent.ts:475`** — "This is CLAUDE.md's 'assert impossible states,
  don't branch around them'." That string is **not in CLAUDE.md** — neither
  `.claude/CLAUDE.md` nor the global one. It is `.claude/commands/feature.md:55`.
  See F4.

---

## 7. Findings — defects `4c4e9df9` introduced

| Severity | file:line | Finding |
|---|---|---|
| **Medium** | `src/lib/reviews/import-consent.ts:484` | The narrowing hand-rolls `errorStringProperty` (`src/lib/payments/stripe-error-inspect.ts:41`, 6 existing callers incl. both DB-error predicates) as an unguarded `as` cast, dropping the `typeof err === 'object' && err !== null` guard that *both* cited precedents carry — so a non-object rejection makes the catch block itself throw out of `emitConsentEvent` and abort the caller. |
| **Medium** | `src/lib/reviews/import-consent.ts:465-484` | The JSDoc's contract ("ONLY a Postgres error is swallowed") is not what the code implements: any string-`code` error is swallowed, including postgres.js connection-lifecycle errors (`node_modules/postgres/src/errors.js:17-27` mints `code: 'CONNECTION_CLOSED' \| 'CONNECTION_ENDED' \| …` on plain `Error`s) and Node OS-socket codes — all logged under a `warn` the same comment frames as "migration 102 not applied". |
| **Medium** | `src/lib/reviews/import-consent.ts:484` | The narrowing is **unpinned**: no test asserts a code-less error propagates out of `emitConsentEvent`. Deleting line 484 leaves every suite green — the same "unreviewed, untested guard on the highest-risk path" defect round 2 called decisive, reintroduced by its own fix. |
| **Low** | `src/lib/reviews/import-consent.ts:475` | Misattributed citation: "This is CLAUDE.md's 'assert impossible states, don't branch around them'" — that rule lives at `.claude/commands/feature.md:55`, not in either CLAUDE.md. |

### F1 — the cast, and the precedent that does not authorise it

Full argument in §2.1–2.4. The concrete remedy is one line and one import, with
identical runtime semantics to what shipped:

```ts
import { errorStringProperty } from '@/lib/payments/stripe-error-inspect';
…
} catch (error) {
  if (errorStringProperty(error, 'code') === undefined) throw error;
```

`src/lib/db/transient-error.ts:61,102` is the in-repo precedent for reading a
string `code` off an unknown DB error from a `src/lib/**` module, and it uses this
helper. Clears "no abstraction before the second use" (reuse, six callers) and
CLAUDE.md's keep-the-predicates-distinct rule (this is the accessor beneath them,
not either policy).

If the JSDoc's stated contract is the one actually wanted, the alternative is
round 2's original proposal, `error instanceof postgres.PostgresError`
(`node_modules/postgres/types/index.d.ts:704`). It is stricter and matches the
comment exactly. **Tradeoff worth surfacing to the owner:** it would be the first
value import of `postgres` in any `src/lib/**` production module — every one today
is `import type` — and `import-consent.ts` is reached from `src/app/**` route
handlers, so it edges toward invariant #1's ESLint boundary even though that rule
matches direct imports in `src/app/**`/`src/components/**` and would not fire.
`errorStringProperty` has neither cost, which is why I recommend it.

### F2 — the comment states a narrower contract than the code

`Errors.connection()` (`node_modules/postgres/src/errors.js:17-27`) returns a
plain `Error` carrying `code: 'CONNECTION_CLOSED' | 'CONNECTION_ENDED' |
'CONNECTION_DESTROYED' | 'CONNECT_TIMEOUT'`, and `Errors.generic(code, message)`
(`:36-40`) does the same for anything else the driver raises. Node system errors
(`ECONNREFUSED`, `EPIPE`, `ETIMEDOUT`) carry string `code` too. All are swallowed
by line 484 and logged with a message whose surrounding JSDoc (`:459-463`) tells
the reader it "means the emitting code reached a database whose
`analytics_events_event_name_check` does not admit the name (migration 102 not
applied)".

**The risk call on that swallow belongs to the adversarial axis** (the brief's
"too wide" direction). My finding is narrower and independent of how that call
lands: the JSDoc — 41 lines, the most-read artefact in this module, and the one a
future maintainer will treat as the contract — asserts a discrimination the code
does not perform. Either the code should implement the comment
(`instanceof PostgresError`) or the comment should describe the code ("any error
carrying a string `code`, which includes connection-lifecycle and socket errors —
those are swallowed deliberately, because a dropped connection kills the caller's
next statement anyway"). Both are cheap. Shipping them contradictory is the defect.

### F3 — the narrowing has no test

Evidence, all static:

- `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json:112-113`
  adds exactly two `tests_to_add` rows, both about the savepoint's *failure*
  direction. Neither covers rethrow.
- No unit-test file exists for `import-consent.ts`; the only suites touching
  `emitConsentEvent` are the two live-DB ones.
- Both new integration titles inject `23514`, which **carries a string `code`** and
  is therefore swallowed identically with or without line 484.
- Both unit mocks now carry `savepoint`, so no code-less error is ever produced.

Therefore deleting line 484 leaves every suite green. I could not execute the
integration suites to demonstrate this, so it is a static inference — but it
follows from the injected SQLSTATE alone and does not depend on anything I could
not read.

This is the same shape as round 2's decisive finding ("the savepoint shipped
UNPINNED. Deleting it entirely left all 37 live-DB and 42 unit tests GREEN"), and
it is worth one row rather than a shrug precisely because the branch already paid
a full review round to learn it. The pin is cheap and needs no live DB: a
non-integration test that calls the module's exported writer with a
`TransactionSql`-shaped stub whose `savepoint` rejects with `new Error('boom')`
(no `code`) and asserts the call rejects. If the owner prefers zero new test
surface, the honest alternative is to record the gap as a deviation rather than
leave it implicit.

### F4 — misattributed rule

`import-consent.ts:475`. The rule is real and the code arguably honours it; only
the attribution is wrong (`.claude/commands/feature.md:55`). Filed because this
branch's rounds 1 and 2 each caught a stale citation and the round-3 brief asks
specifically for citation accuracy. One-word fix.

---

## 8. Anti-slop sweep on `4c4e9df9`

Checked and clear:

- **No new file.** `4c4e9df9` adds none outside `docs/reviews/**`.
- **No new `any`, `@ts-expect-error`, or `eslint-disable`.** The `: any` in both
  mock files is pre-existing idiom. `pnpm lint` and `pnpm typecheck` clean.
- **No new abstraction.** The narrowing is inline (the complaint in F1 is the
  opposite — an existing abstraction was *not* reused). `failingEmission` /
  `failingEmissionExecutor` are two functions with one caller each, but they are
  test injection harnesses mirroring the file's existing `abortingExecutor`, which
  is precedent, not invention.
- **Net-negative bias.** The doc rewrites replace wrong prose rather than
  appending corrections beside it — migration 102's header, migrations-log and
  `events.md` all *edit* the false claim out. That is the right direction.
- **`docs/directory.md`** owes nothing: no new file, no moved module.
- **Deleted-doc hygiene** — not applicable; nothing was deleted.

## 9. Appendix — new, untriaged

Per the brief, observations outside `4c4e9df9`'s delta, filed rather than argued:

- `emitConsentEvent`'s `warn` is emitted by `createWorkerLogger`, but this module's
  hottest producer runs in a **Next.js route** (`finalize-tx.ts:208`), so the line
  lands in Vercel function logs, not Railway. Carried over from my round-2 note;
  it is the shape of the residual risk **#697** tracks, not a separate item.
- `src/lib/analytics/enqueue.ts:24-26` throws a bare `Error` for an unregistered
  event name. Post-narrowing that now aborts the caller's flow. It is guarded by
  the `AnalyticsEventName` type so it is an assert-impossible-state path, and the
  narrowing treating it as fatal is arguably correct — noted only because it is a
  behaviour change `4c4e9df9` makes that no doc mentions.

---

## Verdict

The two findings I raised in round 2 both landed, and R2 landed well: the
`failingEmission` proxy is built the hard, correct way — keyed on the statement so
it survives the mutation it exists to kill, with the savepoint handle explicitly
re-wrapped and an `expect(...).rejects` precondition guarding three assertions of
absence. The four doc rewrites are accurate to shipped behaviour, the citation
round 1 flagged now resolves, the mock completions are faithful, and comment
density is inside the repo's own band. None of that is in question.

What is in question is the construct chosen for R1's fix. The commit changed
production semantics on the branch's highest-availability path, justified it by a
precedent that on inspection says the opposite of what it is quoted for, dropped
the one guard both cited sites carry, bypassed a six-caller helper that already
owns this exact operation, described the result in a 41-line comment whose
headline the code does not implement, and shipped it with no test — the same
unpinned-guard shape round 2 spent a full round establishing. Every one of those is
a one-line fix, none is a correctness bug in the shipped hazard path, and I would
not block a merge over any single one. Together, on the standards axis, they are a
revise.

**VERDICT: REVISE**

---

## 10. Addendum — a concurrent uncommitted fix appeared mid-review

Recorded so `git status --porcelain` is not misread and so the orchestrator does
not action findings that are already remedied.

**My output is `review-standards-round-3.md` alone.** I made no source edits (the
one mutation-testing Edit I attempted was denied by the permission system, so the
mutation claims in F3 and §3 are static inferences, stated as such). At the start
of this review `git status --porcelain` showed only the round-3 brief. On
completion it showed:

```
 M docs/superpowers/plans/feat-679-import-consent-worker-guard-deviations.md
 M src/lib/reviews/import-consent.ts
?? docs/reviews/.../branch-review-brief-round-3.md
?? docs/reviews/.../review-adversarial-round-3.md
?? docs/reviews/.../review-spec-correctness-round-3.md
?? docs/reviews/.../review-standards-round-3.md
```

The two `M` entries are not mine. `git diff -- src/lib/reviews/import-consent.ts`
shows a sibling axis has already applied, uncommitted:

```diff
+import { errorStringProperty } from '@/lib/payments/stripe-error-inspect';
...
-    if (typeof (error as { code?: unknown }).code !== 'string') throw error;
+    if (errorStringProperty(error, 'code') === undefined) throw error;
```

plus a JSDoc rewrite that (a) drops the `duplicate-location.ts:24` /
`create-business.ts:62` claim and replaces it with the correct one — "It is NOT
the `duplicate-location.ts:24` / `create-business.ts:62` shape: those narrow to
one SPECIFIC code, this one only asks whether a code exists" — and (b) enumerates
the three error classes that reach the catch, naming `CONNECTION_*` and the Node
socket codes as deliberately swallowed.

**Effect on my findings, against the working tree rather than `4c4e9df9`:**

| Finding | Status in the uncommitted tree |
|---|---|
| F1 (hand-rolled cast, dropped object guard) | **RESOLVED** — this is exactly the remedy §7/F1 recommends, including the `transient-error.ts:61` precedent citation. |
| F2 (JSDoc contract ≠ code) | **RESOLVED** — the comment now says what the code does, and says why the wide swallow is safe. |
| F3 (narrowing unpinned) | **NOT RESOLVED** — still no test asserts a code-less error propagates; the intake `tests_to_add` list is unchanged at 40. |
| F4 (misattributed CLAUDE.md rule) | **NOT RESOLVED** — `"This is CLAUDE.md's \"assert impossible states, don't branch around them\""` survives the rewrite verbatim. The rule is at `.claude/commands/feature.md:55`. |

Re-ran the gates against the modified tree: `pnpm typecheck` clean, and the three
non-integration suites `4c4e9df9` touched are 27/27 green. I did not re-run lint
or the `ci:*` audits against it.

**My verdict stands as a verdict on `4c4e9df9`,** which is the scope I was given
and which does contain F1–F4. If the orchestrator treats the uncommitted change as
part of the delta, the standards axis reduces to **F3 (Medium) and F4 (Low)** —
and F4 is a word.

## Orchestrator triage — 2026-08-08 (branch review round 3)

All four findings **ACCEPTED**. This was the strongest of the three round-3 axes.

| # | Verdict | Disposition |
|---|---|---|
| **F1** — hand-rolled `errorStringProperty` as an unguarded `as` cast | **ACCEPTED — FIXED** | Real: `(null as {code?}).code` throws, so a non-object rejection made the catch block itself abort the caller. Now uses the established `errorStringProperty` (`src/lib/payments/stripe-error-inspect.ts:41`), which carries the object-ness guard. Landed mid-review, before this report — the agent detected it and said so. |
| **F2** — JSDoc contract does not match the code | **ACCEPTED — FIXED** | "ONLY a Postgres error is swallowed" was wrong. The comment now states the real contract (any string-`code` error), names `CONNECTION_*` and Node socket codes explicitly, and points at **#697** for the imprecise `warn` signal. |
| **F3** — the narrowing is **unpinned** | **ACCEPTED — FIXED** | The finding of the round. Both existing failure tests inject `23514`, which carries a string `code` and is swallowed either way, so deleting the guard left every suite green. Coverage added asserting a **code-less** error propagates, mutation-verified against deletion of the guard line. |
| **F4** — misattributed rule citation | **ACCEPTED — FIXED** | Verified: the rule is at `.claude/commands/feature.md:55`, absent from both CLAUDE.md files. Corrected at all **three** sites carrying it — `import-consent.ts`, deviations `:756`, and plan `:300` — not just the one cited. |

### On R1b — "implemented WIDER than proposed"

The round-2 proposal was `instanceof postgres.PostgresError`; the shipped duck-type
also swallows `CONNECTION_*` and Node socket codes. **Keeping the wider form**, on
the adversarial axis's independently-derived driver taxonomy (round-3 report,
codex session `019fdfbb-e197-7f32-a4c0-5538f8c5c6bb`): a lost connection
independently rejects the enclosing `begin`, so swallowing it locally cannot
manufacture a quiet success, whereas `instanceof` would rethrow a transient blip
straight into `finalizeConnectionTx` — reintroducing the connect outage in the
narrow direction. The two axes reached opposite recommendations from the same
evidence; the driver-source analysis decides it.

### Note on method

Two of this agent's conclusions (F3 and the §3 Proxy analysis) were **static
inferences, not executed** — its mutation Edit was denied by the permission
system, and it flagged that rather than claiming otherwise. F3 was independently
confirmed by mutation before being accepted. Worth stating plainly: the finding
was right, and it was right without being run.

Round-3 verdict for this axis: **REVISE → resolved.**
