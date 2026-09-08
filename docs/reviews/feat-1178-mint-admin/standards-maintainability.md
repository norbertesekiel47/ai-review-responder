# Standards & Maintainability — `feat/1178-mint-admin`

- **Skill used:** `thermo-nuclear-code-quality-review` (invoked successfully; no
  fallback to `code-review` was needed).
- **Range:** `b23172836bc5c435dc429f1fa7505812c168fa87..8c4108b4bd2a6a50a2a63b5b7a044fd050719a39`
- **Production changed lines (added+deleted outside `__tests__/`, `*.test.*`, `*.spec.*`):**
  **1639**, measured from the fork point. Above the 300-line threshold; risk is
  high; this axis is required.
- **Read method:** every file read via `git show <SHA>:<path>`. The working tree
  was never read (a red-team pass is mutating it concurrently).
- **Scope note:** lint, typecheck and 24 `ci:*` audits are green at this SHA.
  Nothing below is a restatement of a green tool, and nothing below is a
  circumvention of one.

## Surface

| File | Lines | Note |
|---|---|---|
| `scripts/mint-admin.ts` | 810 (553 code / 182 comment / 75 blank) | the only new production module |
| `docs/runbooks/mint-admin.md` | 172 | counted as production by the gate |
| `scripts/ci/__tests__/mint-admin.test.ts` | 548 | 28 cases |
| `scripts/ci/__tests__/mint-admin.integration.test.ts` | 228 | 3 cases |
| `.claude/reference/arch-review-log.md` | +29 | surface amendment #1 (D3) |
| `docs/superpowers/plans/…` ×4 | +628 | workflow artifacts |

---

## Findings (>= 80% confidence)

| # | Sev | file:line | Named standard / smell | Finding |
|---|---|---|---|---|
| F1 | medium | `scripts/ci/__tests__/mint-admin.integration.test.ts:170-186` | Canonical-helper duplication; reintroduction of a previously-reviewed defect (`.claude/rules/live-db-tests.md` § Traps) | The abort injection is re-implemented inline as the exact `{ begin } as unknown as Sql` cast the canonical helper forbids, and its `begin` drops leading `begin(options, cb)` arguments. |
| F2 | medium | `scripts/mint-admin.ts:205-211` | Bespoke helper where a canonical one exists and is already imported | `refFromDatabaseTarget` re-parses what `extractProjectRefForLog` (`scripts/staging-guard.ts:154`) owns; `main()` calls both on the same value two lines apart, so the printed ref and the validated ref come from different parsers. |
| F3 | medium | `scripts/mint-admin.ts:235`, `scripts/staging-guard.ts:1-18` | Logic outside its canonical layer; a docblock made false by the diff | A third connection-target assertion mode lives away from the module that declares itself the SINGLE owner of that concern and enumerates "Two modes". |
| F4 | medium | `scripts/mint-admin.ts:70,159,308,365` | Exported surface with no consumer ("no abstraction before the second use") | `confirmsRollback`, `MintRefusal`, `MINT_ADMIN_USAGE`, `readMintConfig` are imported by nothing; the plan's claim that every export is a test-driven seam is measurably false, and the branch's subtlest predicate has no direct test. |
| F5 | low | `scripts/mint-admin.ts:329-330,500` | Unnecessary optionality obscuring one contract | `orphanAuthId` is `?: string` on one union arm and `: string \| null` on the other, forcing a conditional spread beside a plain assignment. |
| F6 | low | `scripts/mint-admin.ts:450,655` | Dead parameter | `reconcileAfterTransaction`'s `context.email` is declared and passed, never read. |
| F7 | low | `scripts/ci/__tests__/mint-admin.test.ts:538-540` | Test coupled to a collaborator's SQL text; harness used against its own docstring | The audit assertion greps `INSERT INTO admin_audit_log` out of the real `writeAdminAuditLog`; `createMockSql`'s docstring prescribes mocking the audit writer and calling `isInTransaction()` for exactly this claim. |
| F8 | low | `docs/runbooks/mint-admin.md:3-4,39,43-46` | One authoritative owner per fact | Three environment facts owned (with evidence and dates) by `docs/runbooks/mfa-factor-reset.md` are restated uncited; the `source` warning is advice for a procedure this runbook does not contain. |
| F9 | low | `docs/directory/repo-surfaces.md:5-19` | Working rule: check the code map before adding a file | The plan counts "costs no `docs/directory/` row" as a placement benefit; that file does carry a per-file `scripts/` table, so the repo's only admin-minting path is missing from the code map. |

---

### F1 — the abort injection re-implements the repo's canonical helper, cast and all

`scripts/ci/__tests__/mint-admin.integration.test.ts:170-186`

```ts
const failing = Object.assign(
  (...args: Parameters<postgresType.Sql>) => db!(...args),
  db!,
  {
    begin: (callback: (tx: postgresType.TransactionSql) => Promise<unknown>) =>
      db!.begin(async (tx) => { const result = await callback(tx); await tx`…`; return result; }),
  },
) as unknown as postgresType.Sql;
```

`src/lib/shared/__tests__/helpers/abort-injection.ts` exports
`abortingExecutor(base, poison)`, which does precisely this. It is not an
obscure corner: **ten** live-DB suites call it, and
`.claude/rules/live-db-tests.md` § Traps names it by path — *"force aborts via
`helpers/abort-injection.ts`, never a temporary constraint."* The plan never
mentions it (zero occurrences of "abort" in `feat-1178-mint-admin-plan.md`
outside an unrelated Supabase quote), so this was not a considered departure.

Two defects the helper's own docblock records — each one a finding a previous
review already paid for — are reintroduced verbatim:

1. *"A `Proxy` over a REAL `Sql`, **never a `{ begin } as unknown as Sql`
   cast**: a bare object cast would typecheck the caller against a local
   restatement of the interface instead of the shipped one (#679 deviations
   D22)."* The new code is that cast, plus an `Object.assign` that copies
   postgres.js's own enumerable properties onto a bare function with the wrong
   `this` — every method on the result other than `begin` and the call form is
   unexercised and unsound.
2. *"EVERY LEADING ARGUMENT IS FORWARDED — do not re-simplify this to
   `target.begin(wrapped)` … Passing only the wrapped callback would silently
   DROP a writer's isolation level, and the test would still pass — the worst
   failure mode a test helper can have (review round 1, B1)."* The new `begin`
   takes a single `callback` parameter. `mintAdmin` calls `sql.begin(cb)`
   today, so the bug is latent rather than live — but it is latent in a
   hand-rolled copy of a helper that exists because the repo decided this
   must not be hand-rolled.

**Smallest correction** (17 lines → 1, same poison, same 23503, same intent):

```ts
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
…
const failing = abortingExecutor(db, (tx) => tx`
  INSERT INTO admin_audit_log (id, actor_user_id, event_type, payload)
  VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid, 'forced_failure', '{}'::jsonb)
`);
```

The existing comment's claim ("No DDL, no temporary constraint") stays true —
that is what `abortingExecutor` is for.

---

### F2 — two parsers for one fact, both live in `main()`

`scripts/mint-admin.ts:205-211` adds:

```ts
function refFromDatabaseTarget(dbTarget: string): string | null {
  const hostMatch = /(?:^|@)db\.([a-z0-9]{20})\./.exec(lowered);
  if (hostMatch?.[1]) return hostMatch[1];
  const userMatch = /(?:^|[^a-z0-9.])[a-z0-9_]+\.([a-z0-9]{20})@/.exec(lowered);
  return userMatch?.[1] ?? null;
}
```

`scripts/staging-guard.ts:154-165` — which this file already imports from —
owns the same parse over the same two forms:

```ts
export function extractProjectRefForLog(url: string): string {
  const hostMatch = /^db\.([a-z0-9]{16,})\./i.exec(parsed.hostname);
  …
  const userMatch = /^[^.]+\.([a-z0-9]{16,})$/i.exec(parsed.username);
```

`main()` calls both, on the same value, four lines apart:

```
:756  const databaseTarget = describeConnectionTarget(config.databasePoolUrl);
:758  assertMintTarget({ …, dbTarget: databaseTarget, … });   // → refFromDatabaseTarget
:765  projectRef: extractProjectRefForLog(config.databasePoolUrl),
```

Two definitions of "the project ref of this connection", with different
accepted ref lengths (`{16,}` vs `{20}`) and different case handling, and no
owner. The concrete consequence: the `TARGET:` line the runbook tells the
operator is *"the only thing standing between you and the wrong project"* prints
a ref produced by the parser that was **not** the one the guard validated.

**Smallest correction:** parse once. Widen `MintTargetInput` to take the already-
extracted `databaseRef` (or the raw URL), have `main()` pass
`extractProjectRefForLog(config.databasePoolUrl)` into both the guard and the
report, and delete `refFromDatabaseTarget`. `extractProjectRefForLog`'s
sentinel returns (`(ref-not-found)`, `(unparseable)`) can never equal a
20-character `confirmRef`, so the "unparseable target is a refusal" property
survives unchanged.

---

### F3 — a third target mode, placed away from the module that claims to own them

`scripts/staging-guard.ts:2-18` is unambiguous about its own scope:

> "the SINGLE owner of 'is this connection target safe to run destructive
> staging tooling against.' … **Two modes**, both PURE and unit-tested:
> `assertStagingTarget` … `assertEphemeralBranchTarget` … In BOTH modes the
> prod denylist is checked FIRST and wins over every flag."

`assertMintTarget` (`scripts/mint-admin.ts:235`) is a third mode of exactly that
concern, obeying exactly that ordering rule, over exactly that denylist — and
it lives in a different file, with a private re-spelling of the denylist scan
(`containsProdRef:213`) and the ref parse (F2). Nothing in `staging-guard.ts`
points at it, so the next person adding an operator script reads "two modes"
and reproduces the omission a fourth time.

The plan (§1 "Reused guards") argues at length why `assertStagingTarget` is the
wrong *mode* — that argument is correct and I do not dispute it. It never
argues the *placement*, and there is no deviations entry for it.

**Smallest correction (preferred):** move `PROJECT_REF_PATTERN`,
`refFromSupabaseUrl`, `assertMintTarget` and the `MintTargetInput` type into
`scripts/staging-guard.ts` as the third mode, calling the existing private
`rejectProdTarget`, and update the "Two modes" docblock to three. This is not
an abstraction for a single caller — the abstraction already exists; this puts
one more instance of it in its declared home, and it deletes F2's duplicate
parser as a side effect.

**Minimum acceptable:** leave the code where it is and amend
`staging-guard.ts`'s docblock so "SINGLE owner" and "Two modes" stop being
false.

---

### F4 — four exports nothing imports, including the one the plan built for testing

Measured across the whole tree at this SHA, the unit suite imports eight
symbols (`assertMintTarget`, `buildAdminRecoveryUrl`, `formatMintReport`,
`mintAdmin`, `MintAdminUsageError`, `parseMintAdminArgs`, `resolveMintEnv`,
`MintAdminResult`) and the live-DB suite two. Nothing else imports this module.
That leaves these exported with zero consumers:

| Export | Line | Used |
|---|---|---|
| `MINT_ADMIN_USAGE` | 70 | internally, by `runDirectCli`'s `onError` |
| `readMintConfig` / `MintConfig` | 159 / 137 | internally, by `main()` |
| `MintRefusal` | 308 | internally, thrown inside `sql.begin` |
| `confirmsRollback` | 365 | internally, by `reconcileAfterTransaction` |

The plan's §1 closes with: *"No abstraction is introduced for a single caller:
every export below is a seam the test suites drive directly."* Its §3 surface
lists `MintRefusal` and `confirmsRollback`. Neither is driven by any suite.

`confirmsRollback` is the one that matters. It encodes the branch's most subtle
rule — the `/^(22|23|42)\d{3}$/` classification that three Codex plan rounds
converged on (F1 → G1 → G2′), and the rule on which "delete the Auth identity"
turns. It is a pure, total predicate over `unknown`: the cheapest thing in the
diff to pin exhaustively. It is exported *so that* it can be pinned, and
instead it is sampled indirectly through `mintAdmin` at three points —
`23514` (`:366`), `08006` (`:381`), and a code-less `Error` (`:397`). The
boundaries the plan argued hardest about — `08007` (the named
`transaction_resolution_unknown`), `57014`, a non-string `code`, a `code` of
the right class but wrong length — are unasserted anywhere.

**Smallest correction:** unexport `MINT_ADMIN_USAGE`, `readMintConfig`/
`MintConfig` and `MintRefusal` (all three are internal); keep `confirmsRollback`
exported and add the table test its export exists for:

```ts
it.each([
  ['23505', true], ['22P02', true], ['42703', true],
  ['08007', false], ['08006', false], ['57014', false],
  ['CONNECTION_CLOSED', false], ['2350', false],
])('confirmsRollback(%s) === %s', (code, expected) => {
  expect(confirmsRollback(Object.assign(new Error('x'), { code }))).toBe(expected);
});
it('is false for a code-less error and for null', () => { … });
it('is true for a MintRefusal', () => { … });
```

---

### F5 — one field, two shapes, in one union

```
:329  | { status: 'refused'; reason: MintRefusalReason; detail: string; orphanAuthId?: string }
:330  | { status: 'failed';  detail: string; orphanAuthId: string | null };
```

which forces this at `:500`, one line above a plain assignment at `:505`:

```ts
return { status: 'refused', reason: refusal.reason, detail: refusal.detail, ...(orphanAuthId ? { orphanAuthId } : {}) };
```

`formatMintReport` reads both with the same `if (result.orphanAuthId)`
truthiness test, so the optionality buys nothing and the two spellings have to
be held in the reader's head at once. (Worth noting for the spec axis: the
plan's §3 declares the `refused` arm *without* `orphanAuthId` at all, and no
deviation records the addition.)

**Smallest correction:** `orphanAuthId: string | null` on both arms; `:500`
becomes `{ status: 'refused', reason: refusal.reason, detail: refusal.detail, orphanAuthId }`.

---

### F6 — dead parameter

```
:450    context: { authId: string; userId: string; email: string; error: unknown },
:452    const { authId, userId, error } = context;
:655        email,
```

`email` is declared, passed, and never read. Lint cannot see it (it is an
object property, not a binding). Drop it from both.

---

### F7 — the audit assertion pins another module's SQL spelling

`scripts/ci/__tests__/mint-admin.test.ts:538-540`:

```ts
const auditCall = harness.sqlCalls.find((call) =>
  call.text.includes('INSERT INTO admin_audit_log'),
);
```

`writeAdminAuditLog` is real here, not mocked, so this couples a mint-admin
test to the exact statement text in `src/lib/audit/log.ts:81-103`. Rewriting
that INSERT (a CTE, a lowercased verb, a column reorder that splits the
literal) fails a mint-admin test whose subject did not change — and
`src/lib/audit/log.ts` has its own suite that owns the SQL.

`createMockSql`'s docstring prescribes the decoupled shape for precisely this
claim:

> "`isInTransaction()` … call it from a mocked collaborator (a run-spine
> writer, **an audit-log writer**) to assert that collaborator ran inside the
> SAME transaction as the state change — invariant #2's actual claim."

Everything else in the suite uses the harness as documented — a fresh
`createMockSql()` per `beforeEach`, `sqlReturnQueue` FIFO, `mkTaggedResult`,
pre-handled rejections via `queuedRejection`, and no `vi.hoisted` dance
(correctly, since `mintAdmin` takes `sql` as a parameter and no `vi.mock` of
`db/server` is needed). This one assertion is the exception.

**Smallest correction:**

```ts
vi.mock('../../../src/lib/audit/log', () => ({
  writeAdminAuditLog: vi.fn(async () => { auditRanInTransaction = harness.isInTransaction(); }),
}));
```

then assert `auditRanInTransaction === true` plus the input object
(`actorUserId === result.userId`, `eventType === 'admin_minted'`). The live-DB
suite already owns the real-SQL / real-FK claim, which is the right split.

The sibling assertion at `:472` —
`harness.sqlCalls.every((call) => /^\s*SELECT/i.test(call.text))` — is fine:
it pins *this module's own* statements and is the direct expression of "a dry
run writes nothing."

---

### F8 — three facts restated from the runbook that owns them

`docs/runbooks/mfa-factor-reset.md` is the recorded owner of all three, with
observation dates and confirmed output:

| Fact | Owner | Restated at |
|---|---|---|
| run from the repo root, "or, worse, silently resolves a different file" | `mfa-factor-reset.md:3-6` | `mint-admin.md:3-4` (near-verbatim) |
| `STAGING_SUPABASE_URL` empty → fall back to `STAGING_NEXT_PUBLIC_SUPABASE_URL` | `mfa-factor-reset.md` § step 2 "Staging" (with the 2026-08-04 observation and the end-to-end confirmation) | `mint-admin.md:39` |
| never `source .env.staging.local` (`<`/`>` read as redirections) | same (names `.env.staging.local:13`, `STAGING_RESEND_FROM_EMAIL`, and the stuck-`allexport` consequence) | `mint-admin.md:43-46` |

`scripts/mint-admin.ts:108-121` states facts 2 and 3 a third time — but it
*cites* `mfa-factor-reset.md` as the owner, which is the right shape. The
runbook does not cite it for any of the three, so there are now three copies
and the middle one looks authoritative.

The `source` paragraph is the weakest of the three: this runbook contains no
step where an operator sources anything — the script parses the file with
`dotenv.parse` itself — so it is a warning against a procedure the document
does not describe.

**Smallest correction:** in the Staging cell, keep `--env staging. Parses
.env.staging.local and maps STAGING_X → X.` and replace the rest with *"the
empty-`STAGING_SUPABASE_URL` fallback and the never-`source` trap are owned by
`docs/runbooks/mfa-factor-reset.md` § step 2; the script applies them for
you."* Delete the standalone paragraph. The "Sibling runbook" line at `:17-19`
already establishes the pointer.

---

### F9 — a missing code-map row, on a premise that does not hold

The plan's §1 placement row reads: *"Keeping it out of `src/lib/` also … costs
no `docs/directory/` row (`ci:directory-map` scans `worker/` + `src/lib/`)."*

The CI claim is true; the conclusion is not. `docs/directory/repo-surfaces.md`
opens with a per-file `scripts/` table (`:5-19`, twelve rows) covering
`redis.ts`, `clear-signup-rate-limits.ts`, `zernio-count-reviews.ts`,
`verify-stripe-price-parity.ts` and the `ci/` audits. The absence of a CI gate
made "no row" invisible rather than correct: the repo's **only** admin-minting
path is off the code map while `zernio-count-reviews.ts` ("one-shot
diagnostic") is on it.

(The table has pre-existing drift — `staging-guard.ts`, `ws8-staging-smoke.ts`,
`wedge-repro.ts` and others are also missing. That is not this branch's debt,
and I am not asking it to be repaid here. One row for the file this branch
adds is.)

**Smallest correction:** one row —

```
| `mint-admin.ts` | The single admin-minting path (#1178). Creates the Supabase Auth
identity, then the `users` row (`role='admin'`, `account_id` NULL) and its
`admin_audit_log` row in ONE transaction, or leaves neither. Refuses a
production project ref (#1179). Procedure: `docs/runbooks/mint-admin.md`. |
```

---

## Answers to the seven questions asked

**Q1 — is the composition-root argument sound, and is it honoured?**
Yes to both. Verified against `src/lib/db/server.ts` at this SHA: `sql` is a
module-scope `const` built from `process.env.DATABASE_POOL_URL!` (`:58-70`), and
`supabaseServer` from `process.env.SUPABASE_URL!`/`SUPABASE_SERVICE_KEY!`
(`:300-303`). ESM hoists the import above any statement that would populate
those, so `--env staging` genuinely could not reach the singleton — the header
comment's reasoning at `:22-27` is correct, and `scripts/ws8-staging-smoke.ts`'s
`connect()` is the right named precedent. The file imports nothing forbidden:
`src/lib/audit/log` (pure, takes its executor as a parameter) and
`src/lib/shared/auth-flow` (pure), plus `scripts/staging-guard` and
`scripts/run-direct-cli`. No `@/lib/db/server`, so `ci:db-imports` is not
circumvented — it simply has nothing to say. Invariant #15's *inner* seam is
also honoured: `mintAdmin(sql, supabase, input)` receives both clients; only
`main()` constructs them.

**Q2 — is 810 lines with a heavy comment ratio the house style, or bloat?**
House style, measured rather than assumed. Comment share of non-blank lines:

| File | Lines | Comment share |
|---|---|---|
| `scripts/staging-guard.ts` | 165 | 42% |
| `scripts/burst-drill-load.ts` | 491 | 26% |
| `scripts/health-bundle-differential.ts` | 483 | 26% |
| `scripts/wedge-repro.ts` | 712 | 23% |
| `scripts/ws8-staging-smoke.ts` | 1318 | 12% |
| **`scripts/mint-admin.ts`** | **810** | **25%** |

25% sits in the middle of the operator-script band, and 810 lines is well under
the 1000-line threshold and well under the largest sibling. The comments are
load-bearing rather than decorative — the conditional-compensation rule, the
SQLSTATE classification and the self-actor justification are each a decision a
reader cannot re-derive from the code. I would not ask for cuts.

The one seam that wants extracting is the target guard (F3) — and it wants
*relocating to an existing module*, not wrapping in a new one. Everything else
(CLI contract ~55 lines, env selection ~70, minting ~385, reporting ~125) is
cohesive around one operation and reads top-to-bottom in execution order.
Splitting `mintAdmin` further would be an abstraction for a single caller.

**Q3 — the anti-slop rules, one by one.**

| Rule | Verdict |
|---|---|
| no new file without justification | **Pass.** One new production file, argued in plan §1 against the one adjacent module (`admin-onboarding-service.ts`) and rejected for a real reason (it would put a `role` branch through the invite funnel). |
| no abstraction before the second use | **F4.** Four exports with zero consumers. Everything with a consumer earns it. |
| no new dependency without justification | **Pass.** Zero new dependencies. `dotenv`, `postgres`, `@supabase/supabase-js`, `uuid` (transitively) are all existing entries in `package.json`. |
| assert impossible states | **Pass.** `createUser` returning neither user nor error is caught explicitly (`:597-604`); an unparseable target is a refusal, never a pass (`:264,:272`); an absent `auth.users` relation reports `unavailable` rather than "no such identity" (`:405`). One gap, appendix A3: `formatMintReport`'s switch has no exhaustiveness assertion — but the repo has no `never`-exhaustiveness precedent in production code at all, so requiring one would be inventing a convention. |
| no silent catches | **Pass.** Three catches. `refFromSupabaseUrl:193` returns `null`, which the caller turns into a named refusal. `deleteOrphanAuthUser:425` logs and returns the still-orphaned id. `reconcileAfterTransaction:460` logs and returns a `failed` result that names the runbook section. None swallow. |
| no `any` | **Pass.** Zero `any`, zero `@ts-expect-error`, zero `eslint-disable` in the diff. Two `(error as { code?: unknown }).code` narrowings (`:368`, `:511`) — the sanctioned shape, following `src/lib/channels/unique-violation.ts`'s private `asPostgresError` (which is not exported, so re-spelling it is correct, not duplication). Appendix A4 notes it is spelled twice. |
| no string literals for job names / statuses | **Pass.** `'admin_minted'` is hoisted to `ADMIN_MINTED_EVENT` (`:339`), which is *above* repo precedent — `src/app/api/auth/mfa/challenge/route.ts:293` uses a bare `'mfa_factor_enrolled'` literal, and there is no admin-audit event-type registry to import from. The `role, 'admin'` literal at `:633` is inside SQL and has no TS constant anywhere in the repo (`git grep USER_ROLE` returns nothing). `MintRefusalReason` and `AuthProbeState` are closed unions, not loose strings. |

**Q4 — is `formatMintReport` earning its place?**
Yes. It is called by `main()` at `:790` (production) and by one test. Its
separation is what makes the "never prints a password" property an assertion
over a returned value instead of over captured stdout — the test at
`:514-525` asserts the exact `createUser` key set *and* greps the rendered
report, and neither would be possible if the printing were inlined into
`main()`. That is a real seam, not test-only surface. Contrast with F4, which
lists the exports that genuinely are surface without a consumer.

**Q5 — do the unit tests pin implementation, and is the harness used as its
docstring prescribes?**
Mostly behaviour, with one exception. The harness usage is otherwise correct
and idiomatic: a fresh `createMockSql()` per `beforeEach`, FIFO
`sqlReturnQueue` with `mkTaggedResult`, pre-handled rejections via the
`queuedRejection` helper (which correctly avoids the unhandled-rejection
warning), and no `vi.hoisted` block — right, because `mintAdmin` takes `sql` as
a parameter and there is no `db/server` module to mock. The two SQL-text
assertions are:

- `:472` `sqlCalls.every(call => /^\s*SELECT/i.test(call.text))` — fine. This
  pins *this module's own* statements and is the most direct available
  expression of "a dry run writes nothing."
- `:538-540` `call.text.includes('INSERT INTO admin_audit_log')` — **F7.** This
  pins *another module's* SQL spelling, and the harness docstring names the
  decoupled alternative for this exact claim.

No test asserts on argument order, bound-value positions, or whitespace, so the
suite is not brittle in the usual ways.

**Q6 — does the new runbook duplicate `mfa-factor-reset.md`?**
Yes, three times — **F8**. Two of the three (the fallback and the `source`
trap) also appear a third time in the code comment at
`scripts/mint-admin.ts:108-121`, which does cite the owner; the runbook cites
it for none. The rest of the runbook is genuinely new and does not overlap:
the pre-mint authorisation checklist, the dry-run-first procedure, the refusal
table, the "Reconciling an uncertain run" section and the re-issue-never-re-mint
rule are this script's own material.

**Q7 — naming.**
Good, with one reservation.

- `confirmsRollback(error)` — the best name in the diff. Reads as the predicate
  it is, and the verb "confirms" carries the whole conservative bias (an
  ambiguous outcome does not *confirm*) that the plan spent three rounds on.
- `probeAuthIdentity` — "probe" is the right register for a read-only,
  best-effort lookup that can come back `unavailable`.
- `reconcileAfterTransaction` — matches the plan's and the runbook's
  vocabulary ("Reconciling an uncertain run"), and `src/lib/db/transient-error.ts:74`
  already uses "reconciler" for this concept. Consistent.
- `MintAdminUsageError` — conventional, and the `runDirectCli` `onError` branch
  gives it a real job (exit 2 vs exit 4).
- `MintRefusal` / `MintRefusalReason` / `status: 'refused'` — the reservation.
  **Refusal** is a LOCKED domain term (`docs/context/refusal-ledger.md:10`)
  meaning something the *product* decided not to do and recorded in
  `refusal_events`. This is a different concept wearing the same word, so a
  grep for `Refusal` now returns two unrelated subsystems — a cost the same
  context file elsewhere warns about explicitly for the `Attribution` family.
  Mitigating: the `Mint` prefix namespaces it, and `staging-guard.ts` already
  established "REFUSING TO RUN" as operator-script vocabulary, so the collision
  predates this branch. I am not confident enough to put it in the table;
  see appendix A2.

---

## Appendix — below the 80% bar

**A1 — `containsProdRef` (`scripts/mint-admin.ts:213`) re-implements
`rejectProdTarget` (`scripts/staging-guard.ts:35`).** Weak on its own:
`rejectProdTarget` is not exported, the shapes genuinely differ (return the
matching ref for a three-label message vs throw), and the canonical *datum*
(`PROD_PROJECT_REFS`) is reused. Folded into F3's remedy rather than reported
separately — if `assertMintTarget` moves into `staging-guard.ts` it can call the
private function directly and `containsProdRef` disappears.

**A2 — `MintRefusal` vs the LOCKED `Refusal` term.** See Q7. Real vocabulary
collision, real grep cost, but namespaced by the `Mint` prefix and preceded by
`staging-guard.ts`'s "REFUSING TO RUN". Would need an owner ruling on whether
the lock is subsystem-scoped or global; I am not going to invent one.

**A3 — `formatMintReport`'s switch has no exhaustiveness assertion**
(`scripts/mint-admin.ts:705-743`). A fifth `MintAdminResult` arm would compile
and print only the `TARGET:` line — silent, and exactly the class the plan
worried about elsewhere. But `git grep ': never = |satisfies never|assertNever'`
over `src/`, `worker/` and `scripts/` (excluding tests) returns **nothing**, so
there is no production precedent and asking for one is inventing a convention
on this branch. Noted for whoever decides whether the repo wants that
convention at all.

**A4 — the `code` narrowing is spelled twice**
(`scripts/mint-admin.ts:368` and `:511`). Two lines, in two functions with
different jobs (classify vs describe). Extracting a shared
`postgresCode(error): string | undefined` would be marginally cleaner and
marginally more indirect. Genuinely a coin flip; not worth a table row.

**A5 — a malformed `DATABASE_POOL_URL` exits 4, not 2.**
`describeConnectionTarget` (`:756`) throws a bare `Error('connection URL is not
parseable')`, which `runDirectCli`'s `onError` maps to `EXIT_FAILED`. It is a
usage fault reported as a run failure, and the operator does not get
`MINT_ADMIN_USAGE`. Small, and arguably right (the URL comes from a file, not
from the command line).

**A6 — should `mintAdmin` live in `src/lib/admin/` with the script as a thin
root?** ~65% confidence, so not in the table. The argument for: 553 code lines
carrying the repo's only admin-minting logic sit outside every code-map,
coverage and import audit that governs `src/lib/`, and `mintAdmin` itself
touches no service key and reads no env — it receives both clients — so two of
the plan's four placement reasons apply only to `main()`. The argument against,
and it is a good one: `scripts/ws8-staging-smoke.ts` is 1318 lines of exactly
this shape and is real, load-bearing precedent for keeping an operator script
whole. I would not block on it. What I *would* fix is the third stated reason —
"costs no `docs/directory/` row" — which is F9: a code-map gap is not a
benefit.

---

## Verdict

No structural regression, no spaghetti growth, no file-size explosion, no
`any`, no new dependency, no silent catch, and no architecture-invariant
violation. The composition-root reasoning is sound and verified against the
tree; the conditional-compensation design is the branch's strongest work and
the comment density that carries it is house style, not bloat.

What is left is duplication and placement, and it clusters: **F1** (a canonical
test helper re-implemented with the exact cast and the exact dropped-argument
bug its docblock forbids), **F2** and **F3** (a connection-target parse and a
third target-assertion mode duplicated away from the module that declares
itself their single owner), and **F4** (four exports nothing consumes, one of
them the file's subtlest predicate, exported precisely so it could be pinned and
then not pinned). F1 and F4 are the two I would want fixed before merge — F1
because it reintroduces a defect class the repo has already paid for once, F4
because the fix is a table test over the rule the whole branch turns on.
