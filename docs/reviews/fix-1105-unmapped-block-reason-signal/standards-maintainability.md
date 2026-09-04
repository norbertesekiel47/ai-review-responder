# Standards & maintainability review — fix/1105-unmapped-block-reason-signal

Merge-base `313a3e01` → HEAD `01aa07f3`. Method: `thermo-nuclear-code-quality-review`
applied to the diff, plus the branch-specific questions, plus a line-by-line pass
against `docs/reviews/finding-checklists/standards-maintainability.md`.

Read-only review. No file outside this report was modified.

---

## Findings (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| medium | `worker/jobs/response-generation/persist.ts:786` | The `_PrecedenceIsTotal` citation credits the wrong type-level guard. Totality of `POLICY_GATE_HELD_REFUSAL_CATEGORIES` is owned by its own `satisfies Record<AutoApprovalBlockReason, RefusalCategory \| null>` (`vocabulary.ts:487`, TS1360); `_PrecedenceIsTotal` (`vocabulary.ts:658`) asserts totality of `AUTO_APPROVAL_BLOCK_PRECEDENCE` and fires on a map hole only as *fallout* — `vocabulary.ts:650-652` says so in those words ("the `TS1360` on the map's own `satisfies` clause is the primary report and this one is fallout"). |
| medium | `worker/jobs/response-generation/__tests__/persist.test.ts:1259-1260` | Comment states the opposite of the shipped design: "The helper owns the membership test, so the call site hands it everything and does not pre-filter." The call site *does* pre-filter (`persist.ts:958-959`), and that reversal is the branch's central decision — recorded in D5, `persist.ts:780-786`, `write.ts:479-489` and `docs/directory.md`. Leftover prose from the refuted first draft. |
| medium | `worker/jobs/response-generation/__tests__/persist.test.ts:1294-1306` | No case anywhere in the eval asserts that the *filtered subset* — rather than the whole `blockReasons` array — reaches `noteUnmappedBlockReasons`. The mixed case asserts only `toHaveBeenCalledTimes(1)`. A mutant passing `autoDecision.blockReasons` verbatim survives all six lane cases and both write-suite blocks. |
| low | `.claude/reference/arch-review-log.md:1663` | "ABOVE this area's own 2-3:1 norm" is not supported by the method the same row prescribes. Per-diff added-line ratios for the two nearest prior fixes in this lane: #1080 `b9fb9601` = 7.82:1, #1079 `7adabe10` = 5.40:1. The 2-3:1 figure matches the *large feature* commits (#1013 `9d26c5a3` = 2.31, #1009 `dbc66c61` = 2.84), not fix-sized ones. |
| low | `docs/superpowers/plans/fix-1105-unmapped-block-reason-signal-deviations.md:D5` vs `worker/jobs/response-generation/persist.ts:783` | Two durable documents give incompatible accounts of the same event. D5: "Four of the five lane cases then **failed**." The docblocks, `docs/directory.md` and the arch-log row: "four of its five cases **asserted a count that discriminates nothing**." A case that failed discriminated; a case that discriminated nothing passed. Both cannot be true, and the claim is now restated in four places. |
| low | `worker/jobs/response-generation/persist.ts:946-957` | The 11-line inline block comment at the call site restates `persist.ts:878-883` (the guard-4 docblock addendum for the function it sits inside, ~65 lines above) near-verbatim: two signals, no `else`, exclusivity in the predicates not the control flow, an `else` would hide a future break. 11 comment lines guarding 3 executable ones, none of it new. |
| low | `src/lib/refusals/__tests__/write.test.ts:84-86` | The spy's delegating `mockImplementation` — and the `as (c: readonly string[]) => unknown` cast it needs — is never executed: no case in the file invokes `resolvePolicyGateRefusal`, and the module under test does not import it. A bare `vi.fn()` is behaviourally identical, and the `mockClear`/`mockReset` hazard comment at :82-83 documents a path nothing uses. |

---

## The ratio question

### Both figures, re-derived

Classified by first non-whitespace token over added lines only
(`git diff 313a3e01..01aa07f3 -- <file>`):

| file | comment | code | blank |
|---|---:|---:|---:|
| `worker/jobs/response-generation/persist.ts` | 80 | 8 | 1 |
| `src/lib/refusals/write.ts` | 112 | 30 | 7 |
| **total** | **192** | **38** | 8 |

**5.05 : 1.** The orchestrator's figures are confirmed exactly.

### The norm is not 2-3:1 for a change this size

Same classifier, added lines of the four prior commits touching these files:

| commit | ticket | comment | code | ratio |
|---|---|---:|---:|---:|
| `b9fb9601` | #1080 | 86 | 11 | **7.82** |
| `7adabe10` | #1079 | 227 | 42 | **5.40** |
| `9d26c5a3` | #1013 | 351 | 152 | 2.31 |
| `dbc66c61` | #1009 | 429 | 151 | 2.84 |

Whole-file ratios at the merge-base, for completeness: `vocabulary.ts` 3.61,
`write.ts` 2.23, `persist.ts` 0.62.

The 2-3:1 figure is real, but it belongs to the two **large feature** commits
that shipped 150 lines of code apiece. The two **surgical fixes** immediately
preceding this branch — in this exact lane, on these exact files — run 5.40:1
and 7.82:1. The mechanism is arithmetic, not culture: a fix adds one predicate
and one transport, and each still needs its full "why this and not the obvious
alternative" block. The denominator collapses; the numerator does not.

At 5.05:1 this branch is **below both of its nearest comparable neighbours**.
The arch-log row flags itself for exceeding a norm it does not actually exceed
(finding 4 above).

### Which blocks earn their length

**Earn it — do not cut:**

- `write.ts:501-508` — the `sanitizeAnalyticsProperties` note. I verified it
  against `src/lib/analytics/events.ts:111-127`: an array value fails
  `!Array.isArray(value)` so it skips the nested branch, then fails the
  `string|number|boolean|null` test, and is dropped with no diagnostic. A
  `codes: unmapped` array really does log as an absent key. This is a true,
  non-obvious, *silent* failure mode and it is the sole justification for the
  `.join(', ')`. Best comment in the diff.
- `write.ts:330-345` (`unmappedSignalledThisProcess`) — "ONE BOOLEAN, NOT A SET
  OF CODES" records an accepted limitation and the reason a per-code set was
  rejected (unbounded against uncontrolled input). A decision, not narration.
- `write.ts:352-361` (the second reset) — records D3. I verified the load-bearing
  claim: `refusal-write.integration.test.ts:1209` and `:1232` do call
  `resetRefusalLedgerWarningForTests` mid-`it`, twice inside one case.
- `persist.ts:780-786` and `write.ts:479-489` — both record the *falsified*
  first draft (membership test inside the helper) and why the eval refuted it.
  This is exactly the convention `.claude/reference/arch-review-log.md` exists to
  enforce, and it is the reason the checklist's stale-prose findings keep
  landing on branches that skip it.
- `persist.ts:1008-1018` — the `withLedgerAttribution` correction. It quotes the
  now-false sentence and corrects it in place rather than deleting it. Correct
  handling; deleting would erase the record that the claim was ever made.
- `write.ts:155-163` (the "IT HAS A SIBLING" addendum). Overlaps other blocks,
  but it is the only one a reader who lands on `noteRefusalLedgerDark` and never
  scrolls will see. Disambiguation at the point of confusion — keep.

**Cut or trim (~23 comment lines, 5.05:1 → ~4.45:1):**

| block | lines | why |
|---|---|---|
| `persist.ts:946-957` | 11 | Pure duplication of `persist.ts:878-883`. Replace with `// Two signals, two `if`s, never an `else` — see the docblock.` |
| `persist.ts:772-777` | 6 | Third statement of mutual exclusivity. The predicate's own docblock only needs the `some`/`every` asymmetry; exclusivity is the *call site's* property and `persist.ts:878-883` owns it. |
| `write.ts:466-473` | 6 | "IT IS NOT `noteRefusalLedgerDark`, AND MUST NOT BECOME IT" duplicates the sibling addendum at `:155-163`. One of the two is enough, and `:155-163` is the one a confused reader reaches first. |

### Verdict on the ratio

**Defensible.** The inflation is not verbose individual blocks — it is two facts
restated across five and four sites respectively:

- *mutual exclusivity* — `write.ts:159`, `write.ts:470`, `persist.ts:772`,
  `persist.ts:878`, `persist.ts:949`
- *latch-lifetime asymmetry* — `write.ts:161-163`, `write.ts:337-339`,
  `persist.ts:872-873`, plus `docs/directory.md`

Each individual statement is defensible where it sits; the aggregate is not. Cut
the three blocks above and the branch lands at ~4.45:1 — comfortably inside the
band its two immediate predecessors set, with nothing load-bearing lost.

I am not treating the residual as a blocker. Per the checklist, this lane's
recorded defect classes are *stale citations*, *false mechanisms*, and *comments
promising guarantees the assertions do not provide* — all three are failures of
comment **accuracy**, none of comment **volume**. This branch has zero
line-number citations in added code (verified by regex over the added lines:
every reference is by symbol), which is a direct and successful response to three
separate accepted findings on the sibling branch. Three of my seven findings are
nonetheless accuracy failures of exactly the recorded classes, which is where the
attention should go.

---

## Branch-specific questions

### 1. `unmappedBlockReasons` (`some`-like) vs `wouldRecordRefusal` (`every`) — a trap?

**No.** The naming already carries the asymmetry: `wouldRecordRefusal` is a
`would…` verb phrase returning `boolean`; `unmappedBlockReasons` is a noun phrase
returning an array. A reader cannot confuse them at the call site because the
array form forces an explicit `unmapped.length > 0`, which is visibly not the
same shape as `if (wouldRecordRefusal(...))`.

One wording nit: `persist.ts:756` and `:762` both call `unmappedBlockReasons` a
"predicate" and describe it as "`some`-SHAPED". It is a filter, not a predicate.
Harmless today; it is the kind of loose word that invites the collapse the
docblock is trying to prevent. Not filed — below the bar.

### 2. Two independent `if`s and no `else`

**Right call.** The exclusivity is genuinely a theorem about the predicates —
`unmappedBlockReasons(xs)` non-empty ⟹ `wouldRecordRefusal(xs)` false, because
the `Object.hasOwn` conjunct is shared — and an `else` would be dead defensive
handling of a state that cannot occur. The stated reason ("an `else` would move
the guarantee into control flow, where a later edit could break it without
failing the case that asserts it") is sound and is the reason a reader should
accept it.

The caveat is that the argument is only as good as the case that asserts it, and
that case is `persist.test.ts:1294-1306` — which asserts call *counts* only.
The exclusivity itself is genuinely pinned (`noteRefusalLedgerDarkSpy` is
asserted not-called there). What is *not* pinned is the argument's contents,
which is finding 3. Fix that and the no-`else` argument is fully carried.

### 3. Two near-identical transports in `write.ts` — duplication or correct restraint?

**Partly duplication, and D3 does not cover it.** `warnLedgerDisabled` and
`noteUnmappedBlockReasons` share the same five-part skeleton: latch-or-cooldown
early return, `try { logger.warn } catch {}`, `try { Sentry.captureMessage; latch
= true } catch { cooldown = now + WARN_RETRY_COOLDOWN_MS }`, same
`subsystem: 'refusal_ledger'` tag, same cooldown constant. ~15 executable lines,
near-verbatim.

D3's recorded reason is that `refusal-write.integration.test.ts` calls
`resetRefusalLedgerWarningForTests` mid-test, so folding the new latch into the
existing reset would clear a process-lifetime signal at an episode boundary. I
verified that claim and it is **true** (`:1209`, `:1232`). But it justifies
**two resets**, not **two transport bodies** — a shared
`createLatchedSignal({ logMessage, sentryMessage, level, tags })` factory would
give each signal its own latch pair and its own reset function, and the mid-test
call would be just as safe.

I am **not** filing this as a finding, for three reasons that I think outweigh
it: there are exactly two instances (the third would change my answer); the two
differ in level, message, tag shape, latch lifetime and payload arity, so the
config object would carry nearly as many concepts as the duplication; and
`write.ts`'s own module header commits to "NO SEAM, DELIBERATELY" for this
module. It stays below the 80% bar as a defect. It is worth recording that the
*stated* justification does not reach the duplication, so the next reviewer does
not read D3 as having settled it.

### 4. Test-only exports

**Acceptable.** `resetUnmappedBlockReasonSignalForTests` follows the established
`circuit-breaker.ts` `reset()` precedent that `resetRefusalLedgerWarningForTests`
already cites, the state is genuinely module-private and process-local, and
there is no way to reach it otherwise. Both are `…ForTests`-suffixed, so the
contract is legible at the call site. No repo rule forbids them and one already
shipped.

### 5. Does `vi.mock('../vocabulary')` weaken pre-existing cases in `write.test.ts`?

**No.** Checked in three directions:

- The factory is a *partial* mock (`{ ...actual, resolvePolicyGateRefusal: spy }`)
  and the spy delegates to `actual.resolvePolicyGateRefusal`, so every other
  export — including `POLICY_GATE_HELD_REFUSAL_CATEGORIES` at `:45` and
  `REFUSAL_VOCABULARY_VERSION`, which `write.ts` itself imports — is the real
  value.
- The known hazard (a global `mockReset`/`resetAllMocks` stripping the
  implementation) does not apply: `vitest.config.ts` sets no `mockReset`,
  `clearMocks` or `restoreMocks`, and the file's top-level `beforeEach` at `:267`
  resets only `sentryStub.captureMessage` / `captureException` by name. The spy
  is cleared exactly once, inside the one case that asserts on it.
- No pre-existing case in the file invokes `resolvePolicyGateRefusal` at all
  (grep-confirmed), so there is no behaviour to lose.

The corollary is finding 7: because nothing invokes it, the delegating
implementation and its cast are dead. A bare `vi.fn()` would pass every case.

---

## Checklist pass (`docs/reviews/finding-checklists/standards-maintainability.md`)

| recorded class | this branch |
|---|---|
| Stale line-number citations (3 entries) | **Clean.** Zero `file.ts:NNN` citations in added code; every reference is by symbol. `persist.ts:888` even records *why* ("a line range here went stale inside its own commit"). |
| Comment states a FALSE mechanism (`[high]`) | **Two hits** — findings 1 and 2. |
| Comment promises a guarantee the assertion does not provide (`[medium]`) | **One hit** — finding 3. |
| Counting claims wrong (`[low]`) | **Two hits** — findings 4 and 5. |
| Test compares a value to itself / cannot detect the mutant (`[medium]`) | **Clean** on the vacuity axis; the `mappedBlockReasons` / `mappedNonNullReason` / `vetoReason` fixtures are read off the map rather than typed out, which is the corrected pattern. The gap is argument coverage, not vacuity (finding 3). |
| Duplicated helper with no owner (`[medium]`) | See Q3. Below the bar, reasoning recorded. |
| Wrong attribution of a type-level guarantee (`[low]`) | **One hit** — finding 1, same defect class as the sibling branch's "credits `as const satisfies`… `satisfies` alone carries it". |
| Departure from precedent unrecorded (`[low]`) | **Clean.** D3 and D5 record both reversals; the `circuit-breaker.ts` reset precedent is named. |

## Architecture invariants

- **#12** (entry points orchestrate; extract error branches >~30 lines) — guard
  4's off-arm is 3 executable lines calling two named helpers. Compliant, and
  strengthened relative to the merge-base.
- **#15** (domain modules receive the DB client explicitly) — not engaged; no new
  code touches a DB handle.
- **"No abstractions for a single caller"** — `unmappedBlockReasons` has one
  caller, but so does the already-shipped `wouldRecordRefusal` beside it, for the
  same stated reason (guard 4's predicates must be individually named and
  individually testable under the cannot-throw rule). Precedent established;
  not a violation.
- **No new file, no new top-level directory, no new dependency, no schema
  change.** `docs/directory.md` row updated in the same change, as required.

---

## Low-confidence appendix (NOT in the table)

1. **Double length guard.** The call site checks `unmapped.length > 0`
   (`persist.ts:959`) and `noteUnmappedBlockReasons` checks
   `unmapped.length === 0` (`write.ts:495`). Both are individually justified —
   the call-site check is what makes the lane spy's count discriminate, the
   helper's is its own contract — but the production control flow is shaped in
   part to serve a mock-based oracle, which is worth knowing. `wouldRecordRefusal`
   has the same pattern with a recorded "proven-equivalent" mutant, so this is
   house style rather than drift.
2. **`readonly string[]` at the module boundary.** `noteUnmappedBlockReasons`
   takes `readonly string[]` rather than `readonly AutoApprovalBlockReason[]`.
   This is deliberate and correct — D5's second argument is that `write.ts` ends
   up with no coupling to the category map — but it means the helper cannot
   type-check that it was handed block reasons at all. Accepted; the alternative
   is worse.
3. **`docs/directory.md` row length.** The `write.ts` row gained ~200 words and
   now runs well past any other row in the file. `.claude/CLAUDE.md`'s shape
   guard covers only that file's own "Where things live" table, so there is no
   rule to violate, but the row is approaching the point where a reader cannot
   scan it. No action proposed.
4. **The "four of five" claim's provenance.** Beyond the D5-vs-docblock
   inconsistency in finding 5, I could not reconstruct the count under any
   reading of the refuted draft (D5 notes two test titles also changed). The
   safest fix for both is to drop the specific number in all four places — the
   *mechanism* ("the lane suite mocks the write module, so its spy could not
   discriminate") is what a later reader needs, and it does not go stale.

---

## Verdict

**No structural regression, no missed code-judo move, no file-size problem, no
spaghetti growth.** The design is right: the two predicates are correctly
asymmetric, the no-`else` argument is sound, the two latch lifetimes are
genuinely different, and the reversal that moved the membership test into
`persist.ts` improved both the layering and the oracle.

The ratio does not block. It is above the large-feature norm and below both of
this lane's comparable fixes, and the residual inflation is three restatement
blocks totalling ~23 lines.

What should be fixed before merge is accuracy, not volume: findings 1, 2 and 3.
Finding 1 sends a reader to the wrong type-level guard; finding 2 documents the
refuted draft as if it shipped; finding 3 leaves the one behaviour those two
comments disagree about unpinned by any assertion. All three are the defect
classes this lane's own checklist already records, and all three are small edits.
