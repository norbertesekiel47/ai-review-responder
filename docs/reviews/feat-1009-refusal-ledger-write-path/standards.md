# Standards & maintainability review — `feat/1009-refusal-ledger-write-path`

**Axis:** standards & maintainability (read-only).
**Target:** worktree `RepWorth-worktrees/feat-1009-refusal-ledger-write-path`, HEAD `05e52e3f`, fork point `0494297a`.
**Diff:** `git diff 0494297a...HEAD` — 32 files, +4243 / −25.
**Reviewer route:** `/thermo-nuclear-code-quality-review` (repo skill) loaded and applied, plus the
`codebase-design` deep-module vocabulary, a Fowler smell baseline, and `.claude/CLAUDE.md`'s
15 numbered invariants and gotcha list.

---

## Verdict

**No blocker.** No architecture invariant is violated, no CI audit fails, the glossary is clean,
and the two new production files are both justified and both documented. Two Medium findings are
worth acting on before this class of change repeats across slices 3–7; the rest are Low.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| Medium | `src/lib/refusals/__tests__/eval-completeness.test.ts:43-51,126` | The completeness guard claims to cover "every test file this branch adds or extends" but omits the two files the branch *extended* — `src/lib/auto-approval/__tests__/suspension.test.ts` and `worker/background/pollers/__tests__/ArchivalPoller.test.ts` — and `expect(EVAL_FILES).toHaveLength(7)` hard-pins the wrong number, so the omission can never be detected. `suspension.test.ts` carries the ONLY unit assertions on this slice's subject statement (the four `sqlCalls[3]` checks added by D18); an `it.skip` there passes the guard silently. |
| Medium | `worker/background/pollers/ArchivalPoller.ts:386-441` | Adding one retention arm requires **five** coordinated edits in one function — the statement, a `parseInt` line, an 11-term `totalArchived` sum, an 11-key log object, an 11-branch saturation chain — plus two sibling unit-test numbers. This branch hit exactly that twice (deviations D10 and D18) and prescribed a manual `grep` for `toHaveLength`/`toHaveBeenCalledTimes` as the remedy. Shotgun surgery with a small judo move available, and it is *not* the per-arm SQL abstraction the plan correctly rejected. |
| Medium | `src/lib/refusals/write.ts:83-111` + `src/lib/auto-approval/suspension.ts:324-346` | `writeRefusalEvent` hides the SQL but not the constraint model: four of the nine input fields (`businessId`, `allRefusalCodes`, `subjectType`, `subjectId`) have exactly one legal value once `refusalSource` is chosen (C1–C4), and the sole call site restates all four plus four prose comments. Nothing at compile time stops a future lane pairing `subjectType: 'response'` with `subjectId: null`; that compiles, raises `23514`, and — by the module's deliberate no-catch policy — aborts the deciding transaction. Migration 116's own C5 comment cites #1001's standard, "make an invalid combination unrepresentable rather than merely unlikely"; it is applied in SQL and declined in the TypeScript interface where it is free. |
| Low | `worker/background/pollers/ArchivalPoller.ts:376-377` | Arm 11 puts `FOR UPDATE SKIP LOCKED` **before** `LIMIT`; all ten siblings (e.g. `:229-230`, `:253-254`, `:287-288`, `:330-331`) put it after. The only reason is that the shape test's capture regex `/SELECT id FROM refusal_events([\s\S]*?)LIMIT/` (`ArchivalPoller.integration.test.ts:584`) stops at `LIMIT` — production SQL reshaped to fit a test's parser (deviation D9 records this as "the eval won"). A maintainer normalising the arm to its siblings' order makes a green suite red for a non-behavioural reason. |
| Low | `src/lib/refusals/write.ts:258` | The one genuinely non-obvious line in a file that comments everything else carries no comment: `${input.allRefusalCodes === null ? null : [...input.allRefusalCodes]}::text[]`. The spread exists to satisfy postgres.js's mutable-array serializer against a `readonly string[]`; the explicit `null` arm exists because `null::text[]` and `'{}'::text[]` are the two facts C5 keeps apart (#1001). Both are exactly what this repo's comment standard exists for, and a "simplification" to `${input.allRefusalCodes}` breaks one or the other. |
| Low | `src/lib/refusals/write.ts:145-180` | `warnLedgerDisabled`'s docblock says "One warning per process", but `warned` latches only on a **successful Sentry capture** — so while Sentry is failing, the structured log line (which D13 added precisely to be the surviving signal, and which succeeds) re-emits every `WARN_RETRY_COOLDOWN_MS` for the process lifetime. Either the claim is scoped to the capture or the latch should account for the log line. Separately, `logger.warn` sits **inside** the `try` at `:164`, so a throwing logger loses the warning with no trace at all — the one direction the three plan-review rounds did not cover. |

---

## Answers to the four claims the plan asks a reviewer to test

### 1. Is `write.ts` a deep module?

**Partly — deep on mechanics, shallow on the constraint model.**

It genuinely hides the INSERT, the byte-for-byte `ON CONFLICT` predicate, the UUIDv7 mint, the
`'transaction_time'` sentinel, the live flag read and the warn latch. A caller writes one `await`
and gets all of it. That half of the claim holds, and the `audit/log.ts` model is the right one.

But Ousterhout's interface is "everything a caller must know", not the type signature. Here the
docblock itself enumerates four extra things a caller must know (`:20-27`), and the input type's
field docs enumerate C2, C3, C4 and C5 (`:85-99`). The call site then re-states all of them in
prose. The module is deep with respect to *how a row is written* and shallow with respect to
*which rows are legal* — and the second is the part that will be re-derived at eleven sites.

The shape that closes the gap is a discriminated union on `refusalSource`, so the helper derives
`businessId`/`subjectType`/`allRefusalCodes` from the variant instead of receiving them:

```ts
type WriteRefusalEventInput =
  | { refusalSource: 'autonomy_suspended'; accountId: string;
      refusalCode: AutonomySuspensionTrigger; refusalCategory: RefusalCategory;
      occurredAt: RefusalOccurredAt }
  | { refusalSource: 'policy_gate_held'; accountId: string; businessId: string;
      subjectId: string; refusalCode: string;
      allRefusalCodes: readonly [string, ...string[]]; /* … */ }
  | …
```

`write.ts:38-41` pre-empts this with "a TypeScript copy would be a second authority that drifts —
the precise defect #1001 cites when it declines to CHECK the 22 `AutoApprovalBlockReason`
members." That reasoning is sound about **runtime revalidation** and does not transfer to a
**type-level** encoding: a type cannot drift silently, because the only way to add a lane is a
migration, and the union's missing arm is a compile error in the same change. #1001's own rejected
case was different — it was about spelling a *TypeScript-owned enum* into SQL, i.e. the authority
running the wrong way.

**Not a change to make in this slice.** One lane exists; a seven-arm union today is speculative
generality and the repo's "no abstraction before the second use" rule applies. The recommendation
is that **#1010 add its lane as a union arm rather than as a second flat call**, and that the
decision be taken deliberately there rather than inherited.

### 2. Is `vocabulary.ts`'s deliberate shallowness sound?

**Yes — sound, not a rationalisation. Agree without reservation.**

A vocabulary's content *is* its interface. Four `as const` arrays, one `satisfies`-guarded map and
one frozen literal, with the union derived from each array, is the minimum viable shape and matches
`WITHHOLD_REASONS` in `src/lib/solicitation/restraint-policy.ts`. Hiding any of it behind a
resolver would force every reader to open the implementation to learn what a lane is — the
opposite of what depth buys. The `import type`-only discipline (`:22-28`) is a real,
non-obvious constraint correctly stated: invariant #1's ESLint ban covers `src/app/**` and
`src/components/**`, not `src/lib/**`, so the Restraint tab's `'use client'` import is genuinely
unguarded and the convention is the guard.

Two smaller calls in the same file are also right: omitting the code→category map for the six
unwritten lanes (dead code the repo gates on), and dropping `| null` from
`AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES` (D7) — every trigger in this lane is a Refusal, and
`| null` would type a state the lane cannot reach.

### 3. Is rejecting a per-arm abstraction in `ArchivalPoller` sound?

**The rejection is sound. But it does not cover the real judo move, which is a different one.**

The ten existing arms are not instances of one shape: arm 4 does a claim-delete-aggregate-upsert,
arms 9 and 10 `UPDATE` rather than `DELETE`, arms 1 and 6 carry two-clause `OR` predicates, and
each `ORDER BY` is pinned to a different index. A generic arm would have to parameterise table,
predicate, ordering, limit, action and returning shape — that is a query builder, the repo has
none, and it would be strictly harder to read than eleven literal statements. Abstracting on the
eleventh use would indeed be a rewrite of ten working arms. **Agree.**

What the rejection does *not* cover is the **count** fan-out at `:386-441` — five edit points per
arm, none of them SQL. The judo move keeps all eleven statements exactly as written and collapses
only the bookkeeping:

```ts
const arms = [
  { table: 'outbox', result: outboxResult },
  …
  { table: 'refusal_events', result: refusalEventsResult },
].map((a) => ({ table: a.table, count: parseInt(a.result?.count ?? '0', 10) }));

const totalArchived = arms.reduce((n, a) => n + a.count, 0);
// logger.log('Archived', Object.fromEntries(arms.map((a) => [a.table, a.count])))
// const saturated = arms.filter((a) => a.count >= BATCH_LIMIT).map((a) => a.table)
```

That deletes three of the five edit points and the entire D10/D18 failure class, without touching
the arms, the try/catch, or the SQL. The branch diagnosed the class twice and shipped a **process**
remedy ("grep the sibling unit suites before running the gate"); a structural remedy was available
and cheaper.

### 4. No seam, no `RefusalLedger` interface, no factory — agree or disagree?

**Agree.** `ReviewPublisher` earned its factory because a second adapter (direct Google Business
Profile) is a named plan; here there is one table, one statement and one row shape, and eleven
call sites that vary in *data*, not in *behaviour*. An interface with one implementation and one
consumer is the repo's "no abstractions for a single caller". Testability does not argue for one
either: `write.integration.test.ts` exercises the real statement against a real database and
`write.test.ts` mocks the `tx` parameter — invariant #15's explicit-client rule already provides
the seam a factory would have been introduced to provide.

---

## Standards checks — results

| Check | Result |
|---|---|
| Invariant #1 (Vercel = UI only) | Pass — no `src/app/**` or `src/components/**` change; `refusals/` is server/worker only. |
| Invariant #2 (outbox) | Pass — no new topic; `ci:outbox-seam` green. The partial-index-inference rule is honoured and explained at `write.ts:265-273`. |
| Invariant #10 (native crypto) | Pass — `uuid`'s `v7`, matching `audit/log.ts` and `suspension.ts`; `node:crypto` has no v7. `ci:static-policy` green. |
| Invariant #13 (server-authoritative flags) | Pass — no `NEXT_PUBLIC_*` companion; both registry rows present; `ci:env-registry` green (185 vars, 30 flags). |
| Invariant #15 (explicit DB client) | Pass — `writeRefusalEvent(tx, …)`; no `@/lib/db/server` import anywhere under `src/lib/refusals/`; `ci:db-imports` green (strict). |
| No `any` | Pass — zero occurrences in the new modules. |
| No silent catches | Pass — both new catches are commented and both are preceded by a surviving log line, with the one caveat at `write.ts:164` noted above. |
| No bare string literals for a typed vocabulary | Pass — `'autonomy_suspended'` is a `RefusalSource` member; the flag name is the named constant `REFUSAL_LEDGER_FLAG`. |
| "Default is no new file" | Pass — two new production files, both justified (a pure client-safe vocabulary leaf; a single writer), both with `docs/directory.md` rows; `ci:directory-map` green (584 files). |
| Live-DB suite conventions | Pass — `ci:live-db-suites` green; no run-time DDL in any of the three new/extended integration suites. |
| Tenant-scope allowlist | Pass — `ci:tenant-scope` green, 371 entries against baseline 371; one entry, correctly categorised `background-global-scan`. |
| Glossary (CONTEXT.md → Refusal ledger, four LOCKED terms) | **Clean.** No occurrence of "skip", "block", "blocked reason", "rejection" or "failure" as a synonym for a Refusal anywhere in the new code, comments or identifiers. Every hit for those words is `FOR UPDATE SKIP LOCKED` (SQL) or "skip every remaining candidate" (loop control). `refusal_source` / `refusal_code` / `refusal_category` / `subject_type` are used with the glossary's exact meanings, including the two-column trap on **Refusal source**. |

## Comment quality — both directions

The two decisions the review brief requires to be explained *are* explained, at the point they
appear and not only in a doc:

- **Why the `ON CONFLICT` predicate is re-spelled by hand** — `write.ts:268-273`, naming the
  partial-index inference failure, invariant #2, and the concrete consequence (`23505` on the
  second write, poisoning the transaction that *is* the decision). Mirrored from the owning side at
  `supabase/migrations/116_refusal_events.sql:218-224`. Correct, and the two agree.
- **Why the INSERT is uncaught while the Sentry warning is caught** — stated three times at
  increasing detail: the one-line rule at `write.ts:44-46` ("Facts propagate; observations
  swallow"), the reasoning at `:29-37`, and the inline note at `:175-179`. It also correctly
  distinguishes itself from CLAUDE.md's "best-effort work needs its own try/catch" rule, which is
  about work *after* a primary side effect. This is the strongest comment in the diff.

Citations spot-checked and accurate: `nowIf` does exist at `src/lib/solicitation/dispatch.ts:1095`
with the same `PendingQuery<Row[]>` fragment idiom; `circuit-breaker.ts:68-71` does state the
read-live-per-call rule `write.ts:223-227` attributes to it; migration 116 does carry the
`created_at`-is-not-a-retention-candidate claim the poller's arm-11 comment cites.

Gaps are the two Low findings above (`write.ts:258` uncommented; `write.ts:145-180` docblock
overstating the latch). No comment in the diff merely restates its code, with the marginal
exception of `write.ts:63`, which repeats `readFlagEnabledByDefault`'s own doc.

## Fowler smell baseline

- **Long function** — `runArchival` is ~410 lines under one `try`, carrying a
  `// fallow-ignore-next-line complexity` suppression. Pre-existing; #1009 adds ~50. The file is
  473 lines, well under the 1k threshold, and the arms are genuinely independent, so decomposition
  is not indicated — but see the count fan-out finding.
- **Shotgun surgery** — present and measured: finding 2.
- **Primitive obsession** — present and mild: nine flat fields where a discriminated union models
  the domain; finding 3.
- **Feature envy** — none. `suspension.ts` reaches into no internals; it calls one helper and one
  lookup.
- **Speculative generality** — **notably absent, and this is the diff's strongest discipline.** No
  seam, no factory, no code→category map for the six unwritten lanes, no `read.ts`, no
  compatibility shim for the parked branch's `| null`. The branch consistently shipped the one
  thing it needed.

---

## Low-confidence appendix (style / preference — deliberately not in the table)

1. **No `src/lib/refusals/flags.ts`.** Seventeen features route their flag through a
   `<feature>/flags.ts` accessor (`llm/flags.ts`, `auto-approval/flags.ts`, `publishing/flags.ts`,
   …); `write.ts:52` imports `readFlagEnabledByDefault` from `@/lib/config/flags` directly, joining
   `src/lib/db/admission.ts` as the second exception in the repo. Notably `circuit-breaker.ts` —
   which `write.ts` cites as its precedent — routes through `llm/flags.ts`. Against it: a one-line
   `flags.ts` for a single caller is exactly the new file the repo's default rule discourages. Both
   readings are defensible; not worth a change on its own.
2. **Comment-to-code ratio.** `vocabulary.ts` is 185 lines for ~25 lines of data; `write.ts` is 285
   for ~65 lines of code. That is within this repo's norm (CLAUDE.md is written the same way) but
   at its ceiling, and it is the reason the two uncommented spots stand out as much as they do.
3. **C3's rationale now has five copies.** "joined the audit log through `businesses` and
   multiplied one event by the location count" appears in `CONTEXT.md:163`,
   `supabase/migrations/116_refusal_events.sql:129`, `docs/currents.md:33`, and — new on this
   branch — `src/lib/auto-approval/suspension.ts:328` and
   `src/lib/auto-approval/__tests__/suspension.integration.test.ts:472`. All five agree today. The
   branch's own D12 lesson is "count every copy before editing"; it added two. Call-site WHY
   comments are the repo's culture, so this is a note, not a finding.
4. **Test-only exports widen the module interface.** `WARN_RETRY_COOLDOWN_MS` and
   `resetRefusalLedgerWarningForTests` exist only for `write.test.ts`. Both are precedented
   (`circuit-breaker.ts`'s `reset()`) and both buy something real (a cooldown pinned to the value
   rather than to an arbitrary margin), but they are implementation leaking into the interface.
5. **Net-negative bias.** ~590 production lines added, 0 deleted. Justified — this is a subsystem's
   first slice and the majority of both new files is comment — but it is worth naming that the
   only deletion opportunity in reach (finding 2) was declined.
6. **Deviations D1–D18, judged on code rather than record-keeping.** All eighteen produced sound
   code. D2 (the Governor Sentry sink) is a real gap closed with ten bounded lines and no new
   branch; D7 (dropping `| null`) is correct and the flag-rather-than-reconcile behaviour is the
   right one; D13 (log line before Sentry) is the right resolution of a plan self-contradiction;
   D18's repair adds four real assertions rather than renumbering. **D9 is the one departure that
   produced worse code than the plan it departed from** — see the Low finding; the correct
   precedence there was to fix the regex, not the SQL.
