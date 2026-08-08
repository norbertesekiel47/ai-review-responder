# Standards & maintainability review — `feat-695-import-consent-block-reason` (round 1)

**Scope:** `git diff 6a1af53d..HEAD`
**Method:** `thermo-nuclear-code-quality-review` skill run against the branch diff, supplemented
with the repo-standards / deep-module / Fowler / glossary / test-quality passes requested by the
orchestrator.
**Posture:** read-only. No source file was edited.

---

## 1. Verification run (evidence, not claims)

| Check | Result |
|---|---|
| `pnpm typecheck` | PASS |
| `npx eslint` on all 10 changed TS files | PASS (no output) |
| `pnpm ci:static-policy` | PASS (1123 files) |
| `pnpm ci:outbox-status` | PASS |
| `pnpm ci:outbox-seam` | PASS (15 helper-owned topics) |
| `pnpm ci:live-db-suites` | PASS |
| `pnpm ci:db-imports` | PASS (strict) |
| `vitest run` × 4 affected unit suites | 4 files / **99 tests** passed |

Live-DB integration suites were not re-run here (the step-4 gate ran them; the deviations file
records 9 passed / 0 skipped for the failover poller suite).

---

## 2. Thermo-nuclear digest

**Ambitious-restructuring pass (rule 0).** The change is already the restructuring: the branch
deletes a reason-specific writer rather than adding a sibling. There is one further code-judo move
available and it is *not* taken (see §3 and appendix A1) — collapsing
`markOutboxCompletedIfOwned` / `markOutboxCompletedWithReason` into a single parameterized CAS.
That duplication is **pre-existing** (`markOutboxOwnerUnreachable` already spelled it twice), so the
branch is net-neutral, not regressive. Not a blocker.

**Rule 1 (1k-line threshold).** No file crosses it. `ZernioBackfillWorker.test.ts` is 1296 lines but
was already 1271 at the fork point (+25). Every other touched file is ≤799 lines. **Clean.**

**Rule 2 (spaghetti growth).** Zero new conditionals in any production path. `guardImportConsent`'s
skip branch swaps one call for another at the same position, inside the same `sql.begin`, on the
same `tx` handle. `NotificationWorker` swaps one call inside an existing branch. **Clean.**

**Rule 4 (boring over magic).** No new indirection, no wrapper, no shim. The plan explicitly
forbade a `markOutboxOwnerUnreachable` compatibility shim and none exists
(`rg markOutboxOwnerUnreachable --glob '!docs/**'` → 1 hit, and it is the historical reference
inside the new function's own docblock).

**Rule 5 (type/boundary cleanliness).** `reason: OutboxCompletionReason` is a real type boundary —
a bare string does not compile, and the positional hazard (`…(tx, id, attempt)` mistaking arg 3)
is caught by TS. One optionality regression exists in a **test harness**, not production — finding
F1.

**Rule 6 (canonical layer).** `outbox-completion-reason.ts` remains the single vocabulary owner;
`importConsentStateSql` is untouched and unre-spelled; no logic leaked into a shared path.

**Rule 7 (atomicity/orchestration).** Improved-by-preservation: the reason write rides the guard's
existing transaction and `businesses` row lock. Invariant #2 holds by construction.

**Approval bar:** met. No structural regression, no file-size explosion, no spaghetti growth, no
boundary leak, no hacky abstraction.

---

## 3. Deep-module assessment — is the "interface NARROWS" claim true?

The plan's §2 depth table asserts: *"Deepening, and the interface NARROWS. One method per reason
becomes one method parameterized by the vocabulary."*

**Verified, with one honest correction.**

| Measure | Before | After |
|---|---|---|
| Exported symbols in `src/lib/shared/outbox.ts` | 9 | 9 (flat) |
| Exported symbols in `outbox-completion-reason.ts` | 2 | 3 (`+ OutboxCompletionReason` type) |
| Cost of adding reason #3 | +1 exported method, +11-line body | +1 enum member, 0 methods |
| Call sites | 1 | 2 |
| Per-call-site cost | 3 args | 4 args + 1 constant import |

- **The narrowing is real.** The per-reason growth slope goes from linear to zero, and this is not
  speculative generality: the second reason exists *in this same commit*, at a genuinely
  independent call site (`guardImportConsent`), which is the deletion test the plan named.
- **The absolute surface did not shrink** — it grew by one exported type. That type is what buys
  the compile-time guarantee, so it is a fair trade, but "NARROWS" is precise about the *growth
  slope*, not the current count. Worth saying plainly in the ADR/plan lineage rather than letting a
  future reader check and find it overstated (the ADR itself sets that standard at line 72).
- **Complexity did not move to the call sites.** Each site gained one argument and one import. The
  knowledge "which reason applies here" was always the caller's — encoding it in the method *name*
  did not hide it, it just spelled it differently. Nothing at either call site branches, and neither
  call site grew a conditional.

**The `void` return instruction was honored.** `src/lib/shared/outbox.ts:139` —
`Promise<void>`. It did **not** acquire a `boolean` "for symmetry", and the docblock at 131-132
records why (`markOutboxCompletedIfOwned` already models the shape that returns the CAS result).
Neither caller branches on a result. **Claim verified.**

**Is the seam genuinely deeper?** Marginally. The implementation behind the interface is the same
11-line CAS it always was; what got deeper is the *module*, not the function — the module now
absorbs an unbounded vocabulary behind a fixed method count. That is the correct kind of depth for
an infrastructure seam.

---

## 4. Fowler smell baseline over the diff

| Smell | Present? | Note |
|---|---|---|
| Duplicated Code | **Yes, pre-existing** | `markOutboxCompletedWithReason` (140-149) duplicates `markOutboxCompletedIfOwned`'s (106-114) UPDATE skeleton + warn guard. Inherited from `markOutboxOwnerUnreachable`; branch is net-neutral. Appendix A1. |
| Duplicated Code (tests) | **Yes, new** | The 4 new integration tests are near-identical arrange/act/assert differing only in one setup `UPDATE` and the expected pair (~90 lines). Table-driving would cost the per-case comments the repo values. Appendix A2. |
| Long Function | No | Longest new function is 16 lines. |
| Long Parameter List | Borderline | 4 params, exactly matching sibling `markOutboxFailed(exec, id, error, attempt?)`. Consistent, not a smell. |
| Speculative Generality | **No** | Two concrete callers ship in the same commit. This is the smell the generalization would have had if #695 had landed alone. |
| Shotgun Surgery | Mild, unavoidable | 4 production + 6 test files for one rename. Intrinsic to deleting a symbol. |
| Comments-as-deodorant | No | High comment volume (67-line docblock on a 28-line guard; 14-line JSDoc on one enum member) but it is the file's established convention and it explains *why*, not *what*. |
| Middle Man / Feature Envy / Divergent Change | No | — |

---

## 5. Repo-standards pass

| Standard | Verdict | Evidence |
|---|---|---|
| **Invariant #2** — transactional outbox | **PASS** | `job-eligibility.ts:215-217` — `markOutboxCompletedWithReason(tx, …)` is inside the `sql.begin` callback, on the tx handle, after the `SELECT … FOR UPDATE`. `ci:outbox-seam` + `ci:outbox-status` both pass. |
| **Invariant #12** — entry points orchestrate | **PASS** | `NotificationWorker.ts:69-71` is a 3-line call swap inside an existing branch; no error-handling branch grew. |
| **Invariant #15** — explicit DB client | **PASS** | `outbox.ts` takes `exec: SqlExecutor`; `job-eligibility.ts` takes `sql: Sql`; `outbox-completion-reason.ts` has no DB dependency. `ci:db-imports` strict PASS. |
| No `any` | **PASS** | No `any` added in production. Two pre-existing `(d: any)` in test mock factories were touched only by adjacent lines. |
| No silent catches | **PASS** | None added. |
| No string literals for vocabularies | **PASS** | Every write and assertion resolves `OUTBOX_COMPLETION_REASON.*`. The single bare literal is the wire-value contract test (`outbox.test.ts`), which the intake pre-declares as the one sanctioned exception and whose entire purpose is comparing constant to literal. |
| "Default is no new file" | **PASS** | Zero new source files. The one new file is `docs/adr/0016-*.md`, which the plan and the "one ADR per weighed rejection" convention require. |
| Every reader of `completion_reason` is topic-scoped | **PASS** (intake edge case 5) | `checks.ts:169`, `checks.ts:214`, `NotificationFailoverPoller.ts:200,237` all bind `jo.topic = QUEUE_NAMES.SEND_NOTIFICATION`. `import_consent_blocked` on a `zernio_initial_backfill` row cannot perturb `IS DISTINCT FROM 'owner_unreachable'`. |
| `existing_patterns_to_follow` actually followed | **PASS** | ADR 0016 mirrors 0010's Status/Context/Decision/Consequences and adds the earned `Alternatives considered`; the unit-test describe block was retargeted rather than duplicated; `guardImportConsent`'s `sql.begin`/`FOR UPDATE` structure is byte-identical to before. |

---

## 6. Test-quality pass (the D5 shape)

Hunting specifically for assertions that cannot fail, mocks pinned instead of behavior, and negative
pins masquerading as evidence.

**Genuinely strong:**
- The four live-DB `outboxCompletion()` assertions read what Postgres actually stored, and use a
  single `toEqual` on the `{status, completion_reason}` **pair** — the accompanying comment
  correctly notes this is what makes "completed WITHOUT a reason" fail, which two independent
  assertions would let slip one at a time. Good instinct, correctly reasoned.
- The retargeted failover-poller `Step 6b` is the strongest pin on the branch: it exercises the
  stale attempt **while the row is still `dispatched`**, so it proves the attempts guard rather than
  mere status gating, against real Postgres.
- The wire-value test closes a real self-referential hole (D3 #1) that no other test could see.
- D5's `expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledTimes(1)` additions do fix the
  three unfailable assertions, and they name the *writer*, which is what the titles claim.

**Weaknesses found:**
- **F1 (below)** — the structural cause of D5 is still present in the harness.
- `outbox.test.ts:171` loops `for (const reason of Object.values(OUTBOX_COMPLETION_REASON))`. With an
  empty vocabulary the loop body never runs and the test passes vacuously. Not a practical risk at
  2 members, and the wire-value test would catch the emptying — noted for completeness (A3).
- Two pre-existing negative pins were retargeted off the plain writer
  (`job-eligibility.test.ts:192`, `:326`), so neither still asserts `markOutboxCompleted` stayed
  silent on the accepted path. This is **covered** by the new title #10's
  `expect(completionCalls).toHaveLength(0)`, which both recorders feed. Not a gap (A4).
- The new `NotificationWorker` title overlaps the existing 3c test by ~80%; its only unique claim is
  attempt forwarding with a concrete `7`. That claim is real and was genuinely untested. Justified
  (A5).

**No new instance of the D5 failure shape was found.**

---

## 7. Glossary pass (`CONTEXT.md` 25-31)

Checked every new comment, docblock, test title and doc paragraph against **Review import**,
**Import consent**, **Import offer**, **Import window**, **Live-ingest cutoff**, and the
`_Avoid_: backfill` rule for the *act*.

- New prose consistently uses **Import consent** / **Review import** / *"a genuine completed
  import"* — e.g. `outbox-completion-reason.ts:8`, `job-eligibility.ts:178-190`, ADR 0016
  throughout, `CONTEXT.md` amendment. **Correct.**
- `zernio_initial_backfill`, `zernio_backfill_runs`, `ZernioBackfillWorker` appear as identifiers
  only — legitimate per the term's own "the mechanism keeps its existing names" clause.
- Borderline: test title `'guardImportConsent completes a refused backfill row …'` and the log line
  `'import consent blocked — skipping backfill'`. The log line is **pre-existing and unchanged**.
  The title is a **locked `tests_to_add` string** the plan mandates verbatim. Both name the
  `zernio_initial_backfill` row/job rather than the act of importing, which is defensible. **Not
  flagged** — re-litigating a locked contract string for a borderline read would be a bad trade.
- The `CONTEXT.md` **Import consent** bullet correctly updated its stale
  `markOutboxCompleted(tx, …)` symbol to `markOutboxCompletedWithReason(tx, …)`, as did
  `.claude/CLAUDE.md`. **Both authoritative documents are now accurate.**

**No glossary violations.**

---

## 8. Net-negative bias

Diff is `+2273 / -56`. Breakdown:

| Bucket | Lines | Assessment |
|---|---|---|
| Process artifacts (`docs/superpowers/plans/**`, `docs/reviews/**`) | ~1592 | Plan 1023, deviations 233, blast-radius 110, 3 plan-review rounds 155, handoff 81. Excluded from the estimate bucket by the intake's own rule. Established repo convention (see commits `8e68ac8d`, `1ad175a3`). |
| Durable docs (ADR 0016, spec §5.3, CONTEXT.md, CLAUDE.md) | ~160 | ADR 142 lines for a weighed-and-declined architectural alternative — earns its keep; it is the deliverable for half the ticket. |
| **Production code** | **~50 net** | 4 files. Nothing unjustified. |
| Tests | ~391 | Measured against a 225 estimate, under the 2× trigger. |

**Deletion of `markOutboxOwnerUnreachable` (not kept as a shim): correct**, per the orchestrator's
framing and the plan's explicit instruction. Pre-launch, two in-repo callers, no external consumer.
A shim would have been the finding.

**Is any added code unjustified?** No. The only candidate is the 14-line JSDoc on a single enum
member, which duplicates prose that also lives in the guard docblock, CONTEXT.md and ADR 0016 — four
copies of the "one marker, not one per state" rationale. That is a *fact-ownership* concern
(CLAUDE.md: "one authoritative owner per fact") more than a line-count one. Appendix A6.

---

## 9. Findings

| Severity | file:line | Finding |
|---|---|---|
| Medium | `worker/jobs/zernio/__tests__/job-eligibility.test.ts:79-81` | The comment justifying the plain recorder is factually false — `guardZernioJobEligibility` is never imported or called in this suite (only `guardImportConsent` is), so its "three skips" never run and `mockMarkOutboxCompleted` is now a dead recorder. Its only surviving effect is forcing `completionCalls[].reason` to stay `reason?: string` (line 61), which is the exact optionality that let D5's `toBe(undefined-constant)` pass while the feature was unbuilt — the bug class is structurally re-armed. Real reason to keep the key in the `vi.mock` factory (line 98) is the module's static named import, not runtime calls. Fix: `mockMarkOutboxCompleted: vi.fn()` bare, and make `reason: string` required. |
| Low | `.claude/reference/migrations-log.md:1861`, `docs/currents.md:722`, `docs/progresstracking.md:892` | Three durable/authoritative docs still name `markOutboxOwnerUnreachable`, a function this branch deleted. The branch fixed the identical class in `CONTEXT.md` and `.claude/CLAUDE.md`, but its verification grep (`rg … --glob '!docs/**'`, plan T2 Step 4) was scoped to exclude exactly where the remainder live. `migrations-log.md` is a CLAUDE.md-designated "read before any migration" inventory, so an agent greps a symbol that no longer exists. The post-merge `/document-feature` sweep is the sanctioned owner (`currents`/`progress` are its files, and `migrations-log.md` is outside `allowed_edit_surface`) — but hand it this explicit list rather than letting it be rediscovered. |

Everything else is in the appendix. **Two findings, neither blocking.**

---

## Appendix — low-confidence / sub-threshold observations

These are **not** defects. They are recorded so the next reviewer does not spend the same time
re-deriving them.

**A1 — Three near-identical completion CAS bodies in `outbox.ts`.**
`markOutboxCompletedIfOwned` (106-114) and `markOutboxCompletedWithReason` (140-149) share the
UPDATE skeleton, the `dispatchedRow` guard, and the `hasAttempt && count === 0` warn. The judo move
is one writer — `markOutboxCompletedIfOwned(exec, id, attempt?, reason?)` returning `boolean`, with
a conditional `exec\`, completion_reason = ${reason}\`` fragment (the file already composes fragments
via `dispatchedRow`, so the mechanism is proven) — collapsing 3 SQL bodies to 1. **Not flagged**
because the duplication is inherited verbatim from `markOutboxOwnerUnreachable`; this branch neither
adds nor removes it, and doing it here would exceed the ticket's declared surface. Worth its own
ticket if a third reason ever lands.

**A2 — The 4 new integration tests are ~90 lines of near-copy.** Same `resetToLivePendingOffer()` →
`UPDATE businesses` → `insertHandRow` → `guardImportConsent` → two assertions, differing only in the
setup UPDATE and the expected pair. `it.each` over a 4-row table would cut it to ~35 lines. Against:
each case carries a distinct multi-line *why* comment (derived-expiry, migration-100 default
population, the D3 rationale) that a table would strand from its case. The repo's style prefers the
explicit form. Judgment call, correctly made.

**A3 — `outbox.test.ts:171` sweep is vacuous on an empty vocabulary.** `for (const reason of
Object.values(OUTBOX_COMPLETION_REASON))` with zero members runs no assertions and passes. Guarded in
practice by the wire-value test two blocks down. Not worth an `expect(...).length` guard.

**A4 — Two negative pins moved off the plain writer.** `job-eligibility.test.ts:192` and `:326`
became `expect(mockMarkOutboxCompletedWithReason).not.toHaveBeenCalled()`, so neither still asserts
`markOutboxCompleted` stayed silent on the accepted path. Fully covered by the new title #10's
`expect(completionCalls).toHaveLength(0)` (both recorders feed that array). No gap.

**A5 — The new `NotificationWorker` title overlaps the existing 3c test.** Both drive zero
enrollments and assert `reasonArg === OWNER_UNREACHABLE`. The unique claim is attempt forwarding with
a concrete `7` (3c has `attempt === undefined`), which was genuinely untested. Justified; the
overlap is the cost of an intake-locked title.

**A6 — The "one marker, not one per state" rationale is spelled four times**
(`outbox-completion-reason.ts:9-14`, `job-eligibility.ts:183-190`, `CONTEXT.md` Import-consent
bullet, `docs/adr/0016:133-142`). CLAUDE.md's "one authoritative owner per fact" argues for the ADR
owning it and the other three citing it. Against: each audience is different (the vocabulary reader,
the guard reader, the glossary reader, the architect), and the repo's house style is
locally-complete docblocks. Not worth churning.

**A7 — Positional-optional hazard at the tail.** `markOutboxCompletedWithReason(exec, id, reason,
attempt?)` — omitting arg 4 silently degrades to the unguarded UPDATE with no compile error. Identical
to the pre-existing hazard on `markOutboxOwnerUnreachable` and `markOutboxFailed`; the growing
argument list makes tail-omission marginally likelier. Module-wide concern, not a branch defect.

**A8 — Spec §5.3 line-wrap artifact.** The edited paragraph leaves
`…future code) is \`ZernioBackfillWorker\` itself. A consent gate joins the` at a width inconsistent
with the file's ~78-column wrapping. Cosmetic; a re-wrap on next touch.

**A9 — `OutboxCompletionReason` has one consumer.** Exported from `outbox-completion-reason.ts`,
imported (type-only) by `outbox.ts` alone. Single-caller abstraction by the letter of the rule, but it
is a *type* whose existence is the compile-time guarantee the whole generalization rests on. Correct
as written.

---

## Verdict

**PASS.** The branch does what its plan says, the depth claim survives verification with one honest
correction (the growth *slope* narrows; the absolute exported surface grew by one type), the `void`
return instruction was honored, no glossary term was renamed, and every gate this reviewer could run
is green. Two findings, neither blocking: one live test-harness cleanup that de-arms the D5 bug class
at its source, and one list of stale symbol citations to hand to the post-merge documentation sweep.
