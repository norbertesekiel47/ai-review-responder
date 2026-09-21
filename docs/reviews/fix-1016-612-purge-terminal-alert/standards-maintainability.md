# Review — standards & maintainability (thermo-nuclear pass)

- **Axis:** standards & maintainability (module depth, seam placement, locality,
  duplication, speculative generality, error handling, test coupling, naming,
  comment density, dependency growth)
- **MERGE_BASE:** `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **HEAD_SHA:** `6df3c95dfbabad6046b5dfbd455730233bc6e58c`
- **Source read:** committed objects only (`git show <sha>:<path>`, `git diff
  <base> <head>`). The working tree was not read for any source file (live
  mutation run in progress).

## Measured diff size

`git diff --numstat 75c8d54 6df3c95`, tests excluded:

| Bucket | Files | +/- |
|---|---|---|
| Production code | 2 (`PurgeWorker.ts`, `purge-stages.ts`) | +23 / −4 |
| Shipped docs (runbook + arch ledger) | 2 | +43 / −0 |
| **Production total (code + shipped docs)** | **4** | **+66 / −4** |
| Process plans (intake, deviations) | 2 | +198 / −0 |
| Tests (excluded from the totals above) | 2 | +171 / −11 |

No new files, no new directory, no new dependency, no migration, no env var, no
flag. Invariant #15 (client-as-parameter), #2 (outbox), #12 (entry points
orchestrate) are untouched by the diff; `alertPurgeFailure` stays one function
with both call sites, as the intake locked.

## Findings

### S1 — [P2] `PURGE_RETRY_FINGERPRINT` is an export with no importer, and its docblock states a reason that is false for it

**File:** `worker/jobs/account-offboarding/PurgeWorker.ts:47` (docblock
`:36-45`); corroborating: `.claude/reference/arch-review-log.md:3`.

**Standard:** `.claude/CLAUDE.md` → Working rules, "no abstractions for a single
caller"; `.claude/reference/lab-notes/ci-tooling.md` ("'unused export' and
'unused value' have DIFFERENT fixes"); accepted-findings class *"the docblock
credits the wrong clause / states a false mechanism"* (checklist entries T1 and
the `RankableBlockReason` entry).

**Evidence.** `git grep PURGE_RETRY_FINGERPRINT 6df3c95` returns exactly two
hits, both inside `PurgeWorker.ts` (declaration `:47`, use `:158`). The test
file imports only `PURGE_TERMINAL_FINGERPRINT` (`PurgeWorker.test.ts:266`), and
the behaviour tests spell `'retry'` as a literal on purpose (`:768`). So the
`export` keyword on the retry constant buys nothing today.

The docblock justifies *both* exports with one sentence — "Exported because
`docs/runbooks/beta-launch-alerting.md` rule 16 configures a Sentry filter
against these exact members, and a test pins the two spellings together." Rule
16 does not filter on the retry fingerprint (the filter is `terminal = true` AND
`level = error`, `beta-launch-alerting.md:589`); it only *mentions* it, and no
test pins that mention. "A test pins the two spellings together" is true of one
spelling. The same overstatement rides into the ledger line
(`arch-review-log.md:3`: "a test pinning the runbook to those constants",
plural).

This matters beyond tidiness: the runbook's claim that the retry arm groups
under `[account_offboarding_purge_failed, retry]` is the *only* unpinned half of
the terminal/retry split this branch exists to create, and the export that
exists to make such pinning possible is the one nobody uses.

**Smallest maintainable correction (preferred):** extend the doc pin to the
retry spelling — export and import `PURGE_RETRY_FINGERPRINT` in the same test,
assert `[account_offboarding_purge_failed, retry]` inside the rule-16 slice (see
S2). That makes both exports load-bearing, makes the docblock and the ledger
line true as written, and closes the unpinned half of the runbook.
**Alternative (smaller):** drop `export` from `PURGE_RETRY_FINGERPRINT`, narrow
the docblock to the terminal constant, and fix the ledger line's plural.

### S2 — [P2] The doc pin is three whole-file `toContain` calls, so it cannot fail for the defect it guards

**File:** `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts:854-856`.

**Standard:** `.claude/reference/lab-notes/ci-tooling.md` (#696, 2026-08-08) — *"a
'is it wired?' test asserting SOURCE TEXT is the same defect class as the bug it
guards … keep text assertions for genuinely textual properties and write them as
patterns not literals."* Precedent for the correct shape:
`src/__tests__/design-doc-token-pin.test.ts`, which parses the document into
table rows and asserts per row rather than over the file as a blob.

**Evidence.** The test asserts three substrings against a 1,347-line file:

```
expect(runbook).toContain('account-offboarding-purge-terminal → discord');   // :854
expect(runbook).toContain(PURGE_TERMINAL_FINGERPRINT[0]);                    // :855
expect(runbook).toContain(`[${PURGE_TERMINAL_FINGERPRINT.join(', ')}]`);     // :856
```

`grep -n` at HEAD shows `[account_offboarding_purge_failed, terminal]` occurs at
**two** places: `beta-launch-alerting.md:364` (the §1 bullet) and `:589` (the
rule-16 table row). `account-offboarding-purge-terminal → discord` occurs only at
`:589`. Nothing ties the two assertions to the same line or block. Delete the
fingerprint from the rule row — the exact edit that makes the configured Sentry
filter stop matching the worker, which is this ticket's stated `risk_reason`
("a wrong … rule row fails silent") — and the pin is still green off the §1
bullet.

The test's own comment claims more than the assertions deliver: *"the runbook and
the worker agree"* is asserted as "the file mentions both strings somewhere",
which is the same gap the checklist accepted on
`vocabulary.test.ts:712` ("the comment promises a guarantee the assertion does
not provide").

Note also that the test is not hermetic about `#1016`'s other half: the rule
name at `:854` is a hand-copied literal (contradicting the comment two lines
above it: "Read off the exported constants rather than hand-copied"). The rule
name is a genuinely textual property with no code owner, so a literal is
defensible — but it should be matched *as a pattern within the rule-16 block*,
not against the whole file, so that a reformat of the arrow or the cell spacing
is the only thing that can break it.

**Smallest maintainable correction:** slice the file to rule 16 before
asserting, e.g.

```ts
const block = runbook.slice(runbook.indexOf('**Rule 16 —'));
const rule16 = block.slice(0, block.search(/\n\*\*Rule |\n## /));
expect(rule16).toMatch(/account-offboarding-purge-terminal\s*→\s*discord/);
expect(rule16).toContain(`[${PURGE_TERMINAL_FINGERPRINT.join(', ')}]`);
```

and assert `expect(runbook).toContain('**Rule 16 —')` once so a renumbering
fails loudly rather than silently emptying the slice.

### S3 — [P3] `:855` is strictly subsumed by `:856` and can never fail independently

**File:** `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts:855`.

**Standard:** accepted-findings class *"duplicates pre-existing … with a tighter
regex"* / *"a test that compares a value to itself"* (checklist,
`vocabulary.test.ts:712` and the locked-tier entry).

**Evidence.** `PURGE_TERMINAL_FINGERPRINT[0]` is
`'account_offboarding_purge_failed'`;
`` `[${PURGE_TERMINAL_FINGERPRINT.join(', ')}]` `` is
`'[account_offboarding_purge_failed, terminal]'`, which contains it. Any file
satisfying `:856` satisfies `:855`. It is a dead assertion whose only effect is
to make the block look like it checks two things.

**Smallest maintainable correction:** delete `:855`.

### S4 — [P2] The §1 bullet and the rule-16 block are two live owners of the same three facts

**File:** `docs/runbooks/beta-launch-alerting.md:362-385` (§1 bullet) vs
`:585-599` (rule 16). Added by the same commit.

**Standard:** `docs/agents/context-layout.md` § Ownership — *"One owner per fact.
When a fact moves, the old location gets a pointer, not a copy … Two live copies
drift, and the reader cannot tell which one is current."* And the file's own
§1a-do preamble (`:427-431`): *"§1 and §1a above are authoritative for which
signals must route and why. This section adds only the click-path and the exact
field values."*

**Evidence.** Three facts are stated twice, at length, ~220 lines apart:

| Fact | §1 bullet | Rule 16 |
|---|---|---|
| RT-08: constant message + no fingerprint ⇒ one issue ⇒ first-seen fires on a retry | `:370-376` ("The fingerprint is what makes the rule possible") | `:591` ("Why every event rather than first-seen…") |
| The terminal branch returns rather than throws, so `attachJobFailureSink` never fires | `:377-380` | `:593` |
| Rule 1 carries the aggregate handle and is not a substitute | `:381-385` | `:595` |

This is not the file's established pattern; it is new. Rules 1-11 each have a §1
bullet **plus a one-line row in the §1a-do table** (`:456-459`) — the row carries
field values only, the why lives in §1. Rules 12-15 (`:461`, `:471`, `:481`,
`:522`) have **no §1 bullet at all**; their block in §1a-do is the sole owner of
their why. Rule 16 is the only rule in the file that states its rationale in both
places, so the §1a-do preamble's own tiebreak ("if the two ever disagree, §1/§1a
win") now has something to arbitrate where previously there was nothing.

The §1 **box** is right to exist — rules 12-15 lacking one is an existing gap,
not a precedent to copy. It is the three rationale paragraphs underneath it that
are the second copy.

**Smallest maintainable correction:** cut `:370-385` to the shape §1's own
backlog-probe bullet already uses (`:292-310`: identity, one sentence of
consequence, then "No new rule is needed; this box exists so the probe is
inventoried rather than invisible") — i.e. keep the identity/filter sentence and
the "unmet deletion obligation" line, replace the three rationale paragraphs with
one pointer: *"Why this needs its own rule, what the job-failure sink and rule 1
do and do not cover, and the response procedure: rule 16 in §1a-do."*

### S5 — [P3] A production comment was rewritten to dodge a test's regex; the repo's recorded answer is to scope the scan to code

**File:** `worker/jobs/account-offboarding/purge-stages.ts:260-265`.

**Standard:** `.claude/reference/lab-notes/ci-tooling.md` — *"a grep gate that
forbids an identifier forbids it in PROSE too (scope it to code with `rg … | rg
-v '^\S+:[0-9]+:\s*//'`)"*. Also `.claude/CLAUDE.md` → Working rules: entry-point
and module comments explain the code, not the harness.

**Evidence.** The comment lost its concrete example (`hashtext('csv_ingest_' ||
id)` → "`hashtext()` over the same per-business key") and gained three lines
whose entire subject is a test file:

```
// That key is deliberately not respelled in this
// comment either — ingest.test.ts scans this lane for any reconstruction of
// it, and prose that looks like one is a false positive on the guard.
```

The production comment now encodes a test's implementation detail and instructs
future authors of this file about a regex in `src/lib/solicitation/__tests__/`.
The dependency runs backwards (production → test) and the comment is strictly
less informative about the lock than the line it replaced, in the one comment
whose job is explaining the lock.

The repo has already recorded the alternative and it is inside the intake's lock
("No change to the lock-key regular expression"): filter `//`-leading lines out
of the file contents before matching, which is a change to the *scan*, not to
`LOCK_KEY_CONSTRUCTION`. The intake's `edge_cases` chose the reword instead; that
is a documented choice, so this is flagged for the owner rather than asserted as
a plain defect.

**Smallest maintainable correction:** in
`laneFilesBuildingTheLockKey` (`ingest.test.ts:110-113`) test the source with
comment lines stripped
(`source.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')`), then
revert `purge-stages.ts:260-265` to its pre-branch wording. One three-line comment
in production code disappears and the guard gets stronger, not weaker.

### S6 — [P3] The kept regex comment's prose exemption is now known to be incomplete, and this commit edited the lines beside it

**File:** `src/lib/solicitation/__tests__/ingest.test.ts:81-85`.

**Standard:** accepted-findings class *"the shipped comment's stated condition is
incomplete / states a false mechanism"* (checklist, `policy-gate-precedence`
and `vocabulary.ts` entries).

**Evidence.** The surviving comment says *"Prose mentions
(`csv_ingest_<business>`) and the unrelated `csv_ingest_exhausted` outbox reason
are deliberately outside the pattern."* The branch's own intake edge case
records the counter-example: `purge-stages.ts`'s comment spelled `'csv_ingest_'
|| id`, prose in the quote-terminated form, and *"the widened scan matches it"* —
which is why S5's reword was needed at all. So the exemption holds for the
angle-bracket prose shape and not for the quote-terminated one, and the comment
names only the first. The commit rewrote lines `:72-79` directly above it and
left the now-half-true claim.

**Smallest maintainable correction:** one clause —
"…deliberately outside the pattern; prose that spells the quote-terminated form
(`'csv_ingest_' || id`) is NOT, which is why `purge-stages.ts` states the key in
words."

### S7 — [P3] The extraction round-trips the path, and the width test pins one filename

**File:** `src/lib/solicitation/__tests__/ingest.test.ts:100-113` and `:144`.

**Standard:** `.claude/CLAUDE.md` → Working rules, "no abstractions for a single
caller" (here: two callers, so the extraction itself is justified) — but the
seam was placed so that data is converted and converted back.

**Evidence.** `walkLaneSources` yields absolute paths; `laneSourceFiles()`
converts each to a repo-relative POSIX path (`:105`); `laneFilesBuildingTheLockKey`
then re-derives the absolute path with `join(process.cwd(), file)` (`:112`) to
read it. The pre-extraction code read straight from the absolute path the walk
produced. The round-trip is invisible on POSIX and silently load-bearing on
Windows, where `.split('\\').join('/')` has already normalised the separators
that `join` will re-introduce.

Separately, `:144` asserts `toContain('worker/jobs/account-offboarding/purge-stages.ts')`
— a test titled *"the scan covers the offboarding purge lane"* that fails if that
one file is renamed or split, even though the lane is still covered. The property
the title claims is a *width* property.

**Smallest maintainable correction:** have `laneSourceFiles()` return
`{ abs, rel }` (or keep the read on the absolute path and expose only the
relative projection to the width test), and assert the width property at `:144`:
`expect(laneSourceFiles().some((f) => f.startsWith('worker/jobs/account-offboarding/'))).toBe(true)`.

## Explicitly checked and NOT reported

- **The two `as const` tuples + the spread at the call site.** The spread is not
  ceremony: `as const` yields `readonly [string, string]` and Sentry's
  `fingerprint` is `string[]`, so a copy is required, and copying also stops a
  handler from mutating a module constant. Given that the constants must be
  importable for the doc pin (S1/S2), this is an honest shape. A single
  `purgeAlertFingerprint(terminal: boolean): string[]` would be one export
  instead of two and would moot S1's unused-export half — worth considering if
  the owner takes S1's "alternative" branch rather than the preferred one.
- **Exporting from a worker job file for a test — seam or leak?** A seam. The
  fingerprint is an operator-facing contract with a document, not an internal;
  `tombstoneMissingSourceReviews` (#1360, `arch-review-log.md:5`) set the
  precedent of exporting from a worker module so a suite can drive it. The leak
  would be exporting something with no consumer — which is exactly S1.
- **Duplication between the two lock-key scans** (`ingest.test.ts` and
  `batch-builder.test.ts:835-870`). Two near-identical walks across two test
  files is the cheaper honest choice under "no abstractions for a single caller",
  the rule-of-three is not met, and the branch recorded the deferral explicitly
  (`arch-review-log.md:3`, "a candidate for one shared helper if a third key
  appears"). Nothing to fix.
- **Unwrapped long prose lines in rule 16** (`:591-599`, 870/654/683/688 chars).
  Not a deviation: rules 12-14 at `:467-495` already run 359-963 chars
  unwrapped. The file's convention is mixed and the new block sits with the
  nearest cohort.
- **Comment density in `PurgeWorker.test.ts`.** The new describe block is
  comment-heavy, but the surrounding file's norm is heavier still (the D5
  INVERTED block, `PurgeWorker.ts:92-117`). In-band.
- **`ci:directory-map`, `ci:db-imports`, `ci:static-policy`, `ci:outbox-status`,
  `ci:tenant-scope`.** No new production file, no singleton import, no
  `NEXT_PUBLIC_*`, no outbox status spelling, no SQL. Green tooling covers these
  and the diff does not circumvent any of them.
- **Missing §1a-do numbered-table row for rule 16.** Not a finding: rules 12-15
  are standalone blocks with no table row either; the numbered table stops at 11.

## Appendix — observations below 80% confidence (non-actionable)

- The new describe block drives the same fixture (redaction stage throws,
  `attemptsMade: 2/3`) in four of its six tests, with overlapping terminal
  fingerprint assertions at `:745`, `:785`, `:808` and `:842`. Each has a
  distinct oracle (tags / other call site / inequality / exactly-one-capture), so
  this reads as deliberate rather than redundant, and one of the titles was
  locked by the intake. Mentioned only so a future consolidation has a starting
  point.
- The intake cites `src/lib/refusals/__tests__/write.test.ts` as the precedent
  for "a test that reads beta-launch-alerting.md and pins a doc claim to code".
  At HEAD that file only *references* the runbook in a comment (`:1536`) and
  reads nothing; the actual doc-reading precedent in this repo is
  `src/__tests__/design-doc-token-pin.test.ts`. Not raised as a finding because
  it changes nothing about the shipped code, but it is why S2's correction points
  at the token-pin test instead.
- Both lock-key scans now read every `.ts` file under `src/lib` + `worker` on
  every run of their suite. `batch-builder.test.ts` already did this before the
  branch, so the cost is not new and the width is the locked decision; noting it
  only because a third such scan would make the cost worth a shared, cached walk.
