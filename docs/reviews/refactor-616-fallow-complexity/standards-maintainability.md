# Standards & Maintainability — `refactor/616-fallow-complexity`

Path taken: repository skill `thermo-nuclear-code-quality-review` (invoked and
applied), plus the brief's checklist inputs. Read-only throughout — no gate
script, no `pnpm test`, no `pnpm lint`, no file edits. The orchestrator owns
gate evidence.

Merge-base `eba43bcc` → HEAD `6c95db21`.
Diff read in full: 5 production/script files, 3 test files, 4 docs files, plus
the plan / deviations / handoff / intake artefacts.

---

## Verdict

**The refactor is sound and the test work is unusually good.** Behavior
preservation is real, not asserted: the key-order contract survives statement
for statement, the four pre-existing worker tests are green unmodified, and the
root tests drive the *real* extracted modules (`OnboardingDemoWorker.test.ts`
mocks `demo-source`, `place-resolution`, `reservation` and `terminal` but
deliberately does **not** mock `subscription-guard` or `cost-reconcile`), so
the new seams are exercised end-to-end rather than mocked away. Two of my
candidate findings died on contact with that suite — see "Candidates that
died" below.

What I am flagging is one real structural miss inside the new package, and a
set of justification/record defects around the two one-caller extractions the
brief asked me to judge hardest.

---

## Findings

### F1 · medium · `worker/jobs/onboarding-demo/cost-reconcile.ts:15-41`

**Standard:** thermo-nuclear "copy-pasted logic instead of extracted helpers" /
"bespoke helper where the codebase already has a canonical utility for the
job"; `.claude/CLAUDE.md` Working rules, "no near-duplicate dependencies… no
abstractions for a single caller".

**Evidence.** `finalizeOnboardingDemoSpend` is a structural clone of its
sibling `worker/jobs/onboarding-demo/reservation.ts:1-14`, which already
existed in the same package:

| | `releaseOnboardingDemoReservation` | `finalizeOnboardingDemoSpend` |
|---|---|---|
| input | `{ reservationDate, logger, finalizeCost }` | same three + `totalCostUsd` |
| guard | `if (!input.reservationDate) return;` | `if (!input.reservationDate) return;` |
| body | `await input.finalizeCost(date, 0)` | `await input.finalizeCost(date, Math.round(totalCostUsd * 100))` |
| catch | `logger.error(\`Failed to release cost reservation: …\`)` | `logger.error(\`Failed to finalize cost reservation: …\`)` |

The only divergence is the cents argument and one word in the log message.
Both wrap the *same* non-idempotent collaborator
(`finalizeOnboardingDemoCost`, which applies `actual − RESERVATION_CENTS` on
every call — deviations D3).

**Maintenance consequence.** The 20¢ reserve accounting now has two owners in
one package. Any change to how the reserve is settled — a retry, an
idempotency key, a second cost lane, a different rounding rule — has to be
made twice, and the "invoke exactly once" contract is stated in
`cost-reconcile.ts:12-14` about a helper that `reservation.ts` also calls
without restating it. That is precisely the drift this repo's directory-map and
single-owner conventions exist to prevent.

**Smallest maintainable correction.** One settle function in `reservation.ts`:

```ts
export async function settleOnboardingDemoReservation(input: {
  reservationDate: string | undefined;
  actualCents: number;
  logger: { error(message: string): void };
  finalizeCost: (date: string, actualCents: number) => Promise<void>;
}): Promise<void>
```

Release is `actualCents: 0`; the success path passes
`Math.round(totalCostUsd * 100)`. Keep both log verbs byte-identical with one
ternary (`input.actualCents === 0 ? 'release' : 'finalize'`), so the emitted
strings do not move on a behavior-preserving branch. Net: one function fewer,
one concept fewer, one owner for the non-idempotence rule.

---

### F2 · medium · `worker/jobs/onboarding-demo/cost-reconcile.ts:15` and `:45`

**Standard:** the branch's own stated package precedent —
`docs/superpowers/plans/refactor-616-fallow-complexity-plan.md:76-79`: *"two
new modules in an existing package. Precedent: `reservation.ts` and
`terminal.ts` — one exported async function per file."* Plus thermo-nuclear
"feature-specific logic leaking into general-purpose modules" / cohesion.

**Evidence.** Verified export counts across the package:

```
cost-reconcile.ts     2 exported functions   ← the only one
demo-source.ts        1 function (+ 1 interface it returns)
place-resolution.ts   1
reservation.ts        1
subscription-guard.ts 1
terminal.ts           1
```

The two exports share nothing: no helper, no type, no collaborator.
`finalizeOnboardingDemoSpend` is cost reconciliation over an injected
`finalizeCost`; `reportOnboardingDemoCostThresholds` is Sentry alerting over an
injected `checkThreshold` plus a direct `@sentry/node` import — it is the only
Sentry dependency in the package. Their cohesion is *temporal* ("both run after
`completeDemo`, both are best-effort"), not functional, and the file name
describes only the first of them.

**Maintenance consequence.** A reader looking for the threshold ladder
`[50, 90, 100]` or the alert tag contract has no reason to open a file called
`cost-reconcile`. A file organised by "when it runs" rather than "what it owns"
is the place where the next best-effort post-completion step gets dropped
regardless of what it does.

**Smallest maintainable correction — composes with F1.** Fold
`finalizeOnboardingDemoSpend` into `reservation.ts` per F1, then rename what
remains to `cost-thresholds.ts` with its single export. Every file in the
package is back to one exported function, both file names are honest, and the
`docs/directory/worker-jobs-c.md` row splits into two rows that each describe
one thing.

---

### F3 · medium · `worker/jobs/OnboardingDemoWorker.ts:48` + `docs/superpowers/plans/refactor-616-fallow-complexity-deviations.md:243`

**Standard:** the repo's most frequently accepted defect class on this axis —
a shipped claim that states a mechanism the code does not have (see the
checklist's `[high]` "anti-vacuity docblock states a FALSE mechanism" and
`[low]` "credits `as const satisfies` for preserving the literals"). Also
`.claude/CLAUDE.md` Working rules, "no abstractions for a single caller".

**Evidence.** D7 keeps a one-caller predicate against the project rule, and
gives two justifications. The second is false:

> It takes the shared `ClaimResult` type, so adding a sixth outcome is a
> compile error here rather than a silent fall-through.
> — deviations.md:243, repeated in the verdict paragraph

`leavesNoWorkToDo` is `(claimResult: ClaimResult): boolean` over three `===`
comparisons. `ClaimResult` (`src/lib/demos/types.ts:79-84`) is a plain
five-member string union with no exhaustiveness device — no `switch`, no
`Record<ClaimResult, …>`, no `never` assertion. Adding a sixth member produces
**zero diagnostics** in `OnboardingDemoWorker.ts`; the predicate returns
`false`, `claimResult === 'reset_to_queued'` is false, and control falls
through to `// claimResult === 'claimed' — proceed.` — exactly the silent
fall-through D7 claims is prevented.

It is worse than neutral. The inline chain it replaced *did* carry type
information: after the two early-exit `if`s, TypeScript narrowed `claimResult`
to `'claimed'` at the proceed comment. A boolean-returning function is not a
type guard, so that narrowing is now gone. The extraction **weakened** the
type-level signal on the very axis cited to keep it. Nothing consumes the
narrowed type today, which is why nothing broke — and why this will only be
discovered by the person who adds the sixth outcome.

With justification #2 void, only justification #1 survives (the name states why
the three outcomes are grouped), which is exactly what the single-caller rule
disfavours — so the honest reading of D7 is "kept to move cyclomatic 10 → 8 so
the fallow check passes without coverage data", i.e. the metric, not the design.

**Smallest maintainable correction — make the promise true rather than delete
the helper.** Replace the predicate with a total map, which costs the same
cyclomatic reduction and delivers what D7 says:

```ts
const CLAIM_DISPOSITION: Record<ClaimResult, 'proceed' | 'drop' | 'redispatch'> = {
  claimed: 'proceed',
  reset_to_queued: 'redispatch',
  not_found: 'drop',
  already_terminal: 'drop',
  race_lost: 'drop',
};
```

A sixth `ClaimResult` member is now a compile error at the map, the root
dispatches on one value instead of two predicates, and the grouping rationale
lives in the data. If the map is judged out of scope for a
behavior-preserving branch, the minimum is: make `leavesNoWorkToDo` a type
predicate (`c is 'not_found' | 'already_terminal' | 'race_lost'`) to restore
the narrowing, and correct D7's sentence to say what the code actually
guarantees.

---

### F4 · low · `src/lib/shared/logger.ts:85`

**Standard:** the branch's own convention that an unplanned in-surface addition
gets a deviations entry (D7 exists for exactly this); plus thermo-nuclear "thin
abstractions / pass-through helpers that add indirection without buying
clarity".

**Evidence.** The plan's target shape is **five** unexported helpers
(plan.md:72 *"The five new helpers are module-private and unexported"*;
plan.md:171 *"Target shape — five unexported helpers"*, followed by the exact
five signatures). `messagePart` is not among them. HEAD ships **six**
(`logger.ts:56, 85, 92, 110, 144, 153`). Two shipped docs already say six
(`.claude/reference/arch-review-log.md` new row;
`docs/directory/lib-db-config-shared.md` logger row), so the plan is the odd
one out — and nothing in `deviations.md` records the addition, while the
directly comparable unplanned addition in the same branch (`leavesNoWorkToDo`)
got a full D7 entry. The asymmetry is the finding: a reader reconciling plan to
code finds one unexplained helper and no note saying it was deliberate.

On its merits `messagePart` is the weakest of the six and the brief's suspicion
is fair. It converts a direct `typeof` dispatch into a sentinel-`undefined`
protocol at the call site (`const part = messagePart(arg); if (part !==
undefined)`), and it handles **one** of the loop's three arg classes while
`Error` and plain-object stay inline. `collectLogArgs` now dispatches three arg
classes through two different mechanisms with no stated rule for which a fourth
class should use. The other five helpers each own a whole concern (base record,
fail-open merge, fail-open stringify, sink selection, the arg loop) and survive
the deletion test; this one only moves two branches across a function boundary.

**Smallest maintainable correction.** Either (a) record it in `deviations.md`
the way D7 records its sibling, and correct plan.md:72/:171 to six — or (b)
delete it and collapse the two branches into one, which is byte-identical
because `String(s) === s` for a string:

```ts
if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
  messageParts.push(String(arg));
  continue;
}
```

That deletes the helper *and* the sentinel protocol. Note the honest caveat:
(b) may move `collectLogArgs` back over the cyclomatic target, which is itself
the evidence for the threshold-chasing reading — if so, (a) is the right answer
and the record should say so plainly.

---

### F5 · low · `worker/jobs/onboarding-demo/subscription-guard.ts:14-16`

**Standard:** thermo-nuclear "unnecessary optionality/parameters that muddy the
real contract"; the repo checklist's recurring "the comment states a reason the
code does not carry".

**Evidence.** The production docblock justifies a production parameter by the
test file's organisation:

> `failTerminal` is injected rather than imported so the package's single test
> file can drive this guard while its own `failOnboardingDemoTerminal` describe
> block keeps testing the real implementation.

The module already imports `./terminal` for the type
(`failTerminal: typeof failOnboardingDemoTerminal`), so the injection buys no
decoupling — only mockability. The parameter has exactly one production value,
forever, threaded from the root.

**My verdict on the trade itself (brief item 5): keep the injection.** It
matches the package precedent (`reservation.ts` injects `finalizeCost`, also
with one production value), and the root suite drives the real guard unmocked,
so the seam is genuinely covered. What I object to is the *record*: the reason
given is a self-imposed constraint from `plan.md:53-58` ("No new test files"),
not a design property of the guard, and `docs/directory/worker-jobs-c.md`
repeats it as if it were one. A future reader has no way to tell whether the
parameter is a seam or scaffolding.

**Smallest maintainable correction.** Reword the docblock to the design reason
that is true independent of the test layout — "collaborator injected, matching
`reservation.ts`; the module never reaches for a singleton (invariant #15)" —
and leave the test-organisation rationale in the plan, where it belongs. Same
edit in the directory row.

---

### F6 · low · `worker/jobs/onboarding-demo/__tests__/stages.test.ts:414, 434, 457, 483, 504, 528, 559, 574, 618, 636, 665`

**Standard:** file-local precedent; the checklist's accepted
`[low]` "Catalog test description must include prepare operations" class
(test naming held to the same bar as production naming).

**Evidence.** Every one of the 11 new `it()` titles restates the enclosing
`describe` name, e.g.

```
describe('guardOnboardingDemoSubscription', …)
  it('guardOnboardingDemoSubscription reports not handled when the account is still pending_payment', …)
```

which reports as `guardOnboardingDemoSubscription >
guardOnboardingDemoSubscription reports not handled when…`. The three
pre-existing describes in the same file do not do this — `:77` *"does not call
finalize when reservation date is missing"*, `:302` *"calls failDemo for
onboarding demos with the provided outbox handle and error"*.

**Maintenance consequence.** The file now carries two naming conventions with
no rule, so the next contributor picks by coin flip; reporter output and
`-t` filters are noisier than the file's own precedent.

**Smallest maintainable correction.** Drop the leading function name from the
11 new titles.

---

## Candidates that died on inspection — recorded so they are not re-raised

1. **"The one-try-wraps-the-whole-capture-loop claim has no oracle."** False.
   `worker/jobs/__tests__/OnboardingDemoWorker.test.ts:376` makes
   `Sentry.captureMessage` throw with two crossed thresholds and asserts
   `toHaveBeenCalledTimes(1)`, the exact error log, `completeDemo` called and
   no terminal write. The claim in `cost-reconcile.ts:44-51` and in the
   directory row is pinned.

2. **"The `input.sql` → destructured `sql` comment (#592) is folklore."**
   Verified true. `scripts/ci/tenant-scope-audit.ts:1932-1953`
   (`extractSqlTagNames`) builds a set of **bare identifier** tag names
   (`sql`, `tx`, `db`, plus db/server import aliases); a property-access tag
   would not match. The destructure at `subscription-guard.ts:29` is
   load-bearing and the three `tenant-scope-allowlist.ts` entries were
   correctly re-pointed at the new file with the matching `${input.demoId}`
   snippet text.

3. **Logger behavior divergence.** Walked every arg class. Multi-Error
   last-wins, `error_stack` persistence when a later Error has none, the
   `data` accumulate-not-replace spread, the empty-`data` key omission, the
   two fail-open paths and the seeded-`message` key position all reproduce
   exactly. `Object.assign(record, errorFields)` before `record.message =`
   before `record.data =` is the contract and it is in that order, with a
   byte-exact raw-line test (`logger.test.ts`, the compact-JSON case) plus a
   `Object.keys(...)` order test behind it.

4. **Invariant checks.** #15 holds — `subscription-guard.ts` takes `sql: Sql`
   as a parameter and imports no `db/server`; the root stays the composition
   root. #1 unaffected. #12 improved: the root is now orchestration only.
   Both new files ship their `docs/directory/worker-jobs-c.md` rows in the
   same PR, as `ci:directory-map` requires.

---

## Judgements the brief asked for, stated plainly

1. **Six private helpers in a 190-line file — decomposition or fragmentation?**
   Decomposition, with one exception. `buildBaseRecord`, `mergeObjectArg`,
   `collectLogArgs`, `stringifyRecord` and `writeLine` each own a whole
   concern and each survives the deletion test — delete any one and the
   complexity does not vanish, it returns to a function that was previously
   the repo's worst fallow finding (cognitive 24, CRAP 106.4). They are
   unexported and `createWorkerLogger` stays the only test surface, which is
   the right call: the interface did not widen. `messagePart` is the
   exception — see F4.

2. **Does `messagePart` earn its place, or is it threshold-chasing?**
   Threshold-chasing, dressed as design. F4 gives the evidence: it is absent
   from the plan's target shape, unrecorded in deviations, and it is the only
   helper that splits a dispatch rather than owning a concern. The plan says
   the quiet part out loud about its sibling — *"`mergeObjectArg` exists to
   pull the sanitizer try/catch out of the arg loop. Without it
   `collectLogArgs` lands near the cognitive threshold"* (plan.md:183-185).
   `mergeObjectArg` survives on merits anyway (it owns a fail-open path);
   `messagePart` does not.

3. **Is D7's justification for `leavesNoWorkToDo` sound?** Half of it is
   false — see F3, which is the most substantive finding on this axis. The
   predicate is the rule being bent for a metric, and the stated type-safety
   benefit is inverted from the truth.

4. **`cost-reconcile.ts` — one seam or two?** Two, and they should be split —
   F2 — with the first half merged into `reservation.ts` — F1.

5. **Injection-for-testability in `subscription-guard.ts`?** Right trade,
   wrong record — F5.

6. **Comment density.** Measured: `subscription-guard.ts` 27 comment / 41 code
   lines, `cost-reconcile.ts` 24 / 42, `logger.ts` 50 / 136. High, and
   *earned* in almost every case — these comments carry traps that cost real
   money to rediscover (the partial-unique-on-completed index, the
   `AND attempts = $n` predicate, the release-before-rethrow ordering, the
   `#592` tag spelling, `typeof` vs truthiness, the key-order contract,
   `finalizeOnboardingDemoCost`'s non-idempotence). Nothing here narrates
   the obvious; the closest is `mergeObjectArg`'s one-liner, which still adds
   "accumulate, never replace". The only comment I would cut is the one in
   F5, because it documents the test layout rather than the code. **No
   finding on density as such.**

---

## Low-confidence appendix (below the 80% bar — not in the returned table)

- **`guardOnboardingDemoSubscription`'s seven-field input object.** The root
  passes `sql`, `demoId`, `outboxId`, `outboxAttempt`, `logger`,
  `releaseReservation`, `failTerminal` to get one boolean back, and still has
  to write `if (handled) return;`. By Ousterhout's measure the interface is
  wide relative to the ~25 lines it hides. It does hide a real query plus a
  decision plus a failure posture, and the package precedent is the same
  shape, so I am not calling it shallow — but if a third caller ever appears,
  this is the module that should grow a narrower entry point.

- **`finalizeOnboardingDemoSpend` has no resolving-`finalizeCost` test of its
  own.** Both tests in its describe either skip the call (no reservation
  date) or reject. The call arguments *are* asserted on the rejecting path,
  and the root suite covers the success path with
  `toHaveBeenCalledTimes(1)`, so coverage is real — it is only oddly placed.

- **`emit`'s comment says error fields "append after the context block".**
  True only while no error field name collides with a `CONTEXT_FIELDS` entry,
  which is true today and would be a strange future change. Not worth an edit.

- **The `stages.test.ts` file-wide `vi.mock('@sentry/node')`** is safe today
  (verified: `cost-reconcile.ts` is the package's only Sentry importer) and
  the comment says so — but that is a fact about the package at HEAD, not an
  enforced invariant. If a second Sentry user lands in this package the
  file-wide mock silently widens. A one-line note is all this warrants.
