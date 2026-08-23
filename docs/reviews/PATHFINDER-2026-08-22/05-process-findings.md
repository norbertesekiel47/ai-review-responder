# Pathfinder 2026-08-22 — process findings

Findings about how the work is done, not about the code. Each is evidenced; each
names what a reader should do differently.

## P1. The counter was wrong for the FOURTH consecutive pass — and the log undercounts its own recurrence

`.claude/reference/arch-review-log.md:17-19` calls this *"the THIRD consecutive
pass to find this counter wrong by its own rule."* Counting the passes that
measured it: 2026-08-10 (3 missed increments), 2026-08-15 (PR #803 invisible),
2026-08-18 (read 8, measured 11), and 2026-08-22 (read 3, corrected to 7 by hand
in #929 the same evening). **This is the fourth. The log's own recurrence counter
has the same defect as the thing it counts.**

`#896` is the mechanical fix and **it is unexecuted**, so the correction was
performed by hand for the third recorded time. The log states the honest position
itself at `:19-20`: *"until it lands, this number is hand-kept and should be
re-derived, not believed."*

**Do differently:** treat item 2 of `04-handoff-prompts.md` as the highest-leverage
item in the backlog after the send-path tests. Nothing else changes the *rate*.

## P2. A handoff was silently delivered and the tracker does not know

`#895(b)` — `latchHalt`'s unpinned CAS — was **fixed by #920/#900**, and
`src/lib/solicitation/approval.ts:518-524` now cites *"Issue #895(b)"* **by
number** while explaining that `latchSystemHalt` is what makes the line
load-bearing. Two tests were added for it. **The issue is still open.**

F4's agent confirmed by mutation: deleting the CAS makes
`approval-system-halt.integration.test.ts:363` and `:433` go RED.

**This is worse than an unexecuted handoff.** Anyone re-deriving H6 from the issue
text alone will re-do finished work, and the bundle's own stated rationale — *"if
the bundle has to shrink, keep (b)"* — is now an argument for shipping five
cosmetic fixes.

**Do differently:** when a branch delivers a handoff item it did not set out to
deliver, close or annotate the issue in the same PR. A docstring that cites an
issue number is not a substitute for touching the issue.

## P3. fallow's complexity gate has no unit-size axis — and the terminal view hid it

**Two findings, and the orchestrator got the first one wrong.**

`00-health-baseline.md` originally asserted that `dispatch.ts` (2,001 lines)
*"appears in NONE of fallow's lists."* **False.** It contributes **six of the
repo's 461 large functions**, and `runDispatchTx` at 202 lines ranks **25th
repo-wide**. `release.ts` contributes five more. The error came from reading the
terminal renderer, which prints `● Large functions (10 shown, 463 total)` — and
`--top 463` does not expand that section. The correct reading needs
`--format json`.

**The real finding is structural.** Across all 121 findings the `exceeded` field
takes only `crap`, `cognitive`, `cognitive_crap`, `all`, `both`, `cyclomatic`.
**`line_count` never appears.** `functions_over_60_loc_per_k` and
`unit_size_profile` are reported as *vital signs* — narrative metrics with no gate
— while `ci:fallow:coverage` gates on CRAP. **A 202-line flat orchestrator with
high coverage is invisible to the PR gate by construction, in any file, forever**,
because cognitive complexity penalises nesting and a straight run of guard clauses
scores nearly nothing regardless of length.

**Do differently:** never read fallow's sectioned lists from the terminal when the
question is "does file X appear". Use `--format json`. And do not treat a silent
fallow as evidence that a large file is fine — ask which axis would have spoken.

## P4. `ci:directory-map` is structurally predicate-blind, and four rows are false

`scripts/ci/directory-map-audit.ts:13-16` declares exactly two checks — COVERAGE
(every production file has a row) and STALENESS (every row's path exists). **Both
are path-level. Nothing reads a row's description cell.**

Four rows are false at HEAD and **all four pass by construction**:

| Row | Claim | Reality |
|---|---|---|
| `:919` | *"`readSendBreaker` gets no try/catch"* | `release.ts:945-956` wraps it — in the file this row describes |
| `:931` | *"exactly the two system reasons"* | Three since migration 111 |
| `:934` | *"no try/catch and no `unknown` verdict"* | Three catching call sites |
| `:1210` | *"27 columns … two are not residue checks"* | 29 written, 28 predicates, three restored-default checks |

**Do differently:** do not propose a row-content audit — Phase 2 rejected it and
the DO-NOT-UNIFY register records why. **Make the facts unwritable-wrongly
instead**: handoff H11's split of `readSendBreaker` retires two of the four rows
structurally.

## P5. The false-rationale class — three new instances, and one important NEGATIVE result

The lab notes record this class with eight instances, all claims about a module's
own internals. **Three more, found across three features:**

- **`judge-health.ts:23`** — *"Fleet-wide Judge health used only by the auto-policy
  publisher gate."* Since #920 there are two consumers. **A single-consumer
  rationale invalidated by a second consumer.**
- **`dispatch.ts:1865-1866`** — *"The exact-attempt guard now lives in
  `completeOutboxNoop`"* — written directly above a re-spelling of that guard and
  its literal. **A consolidation claim that is false within its own file.**
- **`job-failure-sink.ts:53-58`** — reasons explicitly about *"diverging from the
  sibling helper readers will compare this against"* and **identifies the wrong
  sibling**, adopting the unhardened body while stating the threat the hardened
  one defends against.

**The negative result matters as much.** F3 was asked to test whether the
`node:async_hooks` rationale at `admin/solicitation/page.tsx:20-27` was a ninth
instance. It is **REAL**, verified three ways: the static import chain exists in
three hops; the module-scope `createWorkerLogger` call defeats tree-shaking; and a
transitive-import walk over **all 228 `'use client'` files** found zero reaching
`node:async_hooks` at runtime. **The class is real, and it is not a licence to
disbelieve every rationale.** Only the precise mechanism was slightly mis-stated.

## P6. The tree moved under this pass

At ~22:10 on 2026-08-22, **while this pass was running**, a concurrent session
began editing F6's exact surface — 21 modified files plus a **staged `git mv`** of
`Reveal.tsx` into `src/components/ui/`. `HEAD` never moved.

Two consequences worth recording:
1. **It is implementing S4.** The rename is X20's consolidation. Either the same
   finding was reached independently, or the session read this pass's artifacts.
   Either way **S4 must be re-anchored against the tree before it is worked.**
2. **The guard-integrity axis had to prove restoration by byte-comparison against
   `HEAD` rather than by `git status`**, because the contract's "clean tree"
   assumption no longer held. That worked, and it is the technique to use whenever
   a mutation experiment runs on a shared checkout.

**Theme A was verified clean throughout.** Every `src/lib/solicitation/`,
`worker/`, `supabase/`, `scripts/ci/`, `src/lib/shared/`, `src/lib/agents/`,
`src/app/admin/` and `src/app/api/` file was untouched, so F1–F4, F7 and F8 stand
exactly as measured.

## P7. The arch log's own entry for #920 is wrong on the count AND the category

The log records *"`tenant-scope-allowlist` (+4 platform-wide predicates under a
standing sign-off)"*. Measured:

- The move is **381 → 383 (#904) → 390 (#920)** — split across **two** merges, and
  the log names only one.
- #920 added **seven**, not four.
- All seven are category `background-global-scan`. **Only #904's two carry
  `platform-cross-account`** — the category the log's phrase describes.

**And the allowlist file is not the artefact at fault.** Its header narrative
(`:150-202`) records all nine steps individually, with predicate ids and tickets,
including why the two-table entries are two. **The log is wrong; the code is
right.**

**A related measurement problem worth naming.** The baseline counts
**table-bindings, not decisions**: nine entries encode **seven** statements,
because the audit attributes one statement per table it binds, and two of the nine
describe correlated subqueries that are not cross-account in themselves. **A
reviewer asked to sign off "nine new exemptions" is shown a unit that does not
match the unit they reason about — which is how the log's number drifted from four
to nine in the first place.**

## P8. Guard integrity inverted the expected severity

The brief predicted that `readSendBreaker`'s fail-closed throw would be the
pass's highest-severity finding if unpinned. **It is pinned three ways.**

What is unpinned is the opposite half of the lane. **Decision logic:** gate order
survives two independent swaps; governor order caught by a four-round differential;
outbox status contract caught by a CI audit with a precise message. **Integrity
spine:** both send-path CAS predicates and the A4 bytes-identity check are
unpinned, and a whole-repo grep returns **zero test-file references** for
`cas_lost`, `in_flight_elsewhere` and `bytes_changed_under_gate`.

**Those three are exactly the guards whose failure mode is silent** — a double
send, a value-ledger row with no join key, moderating one artifact and sending
another.

**Do differently:** when a lane is reviewed for "is the logic right", that is not
the same question as "is the logic *held*". This window's three review rounds
produced correct decision code and zero tests for its concurrency invariants.
**Ask for the second question explicitly.**

## P9. The pass's own error rate, recorded honestly

This pass **refuted or corrected ten of its own Phase 1 leads** in Phase 2, and
the orchestrator corrected two of its own artifacts mid-pass. The corrections:

| What | Who caught it |
|---|---|
| `dispatch.ts` "appears in none of fallow's lists" — **false** | F2's agent |
| `/pricing` derives a `signupCtaLabel` — **false** | F6's agent |
| Four new allowlist constant pairs — **five** | F8's agent |
| `ci:tenant-scope` "passes at 390 findings" — **zero findings** | F8's agent |
| `how-it-works/Reveal.tsx` — **no such path** | Phase 2 |
| "three terminal-attempt copies" — **five** | Phase 2 |
| "five 091-predicate spellings" — **one plus four supersets** | Phase 2 |
| `pricing.css` FAQ fork — **no fork exists** | Phase 2 |
| `pricing.css` 332 lines — **387** | Phase 2 |
| Five `.rw-dl-rv` selector line numbers | Phase 2 |

**The adversarial second pass is what produced them.** Nine of the ten came from
an agent re-reading source that a Phase 1 agent had summarised. **A pass that only
fans out and synthesises would have shipped all ten.**
