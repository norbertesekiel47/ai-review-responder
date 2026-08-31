# Standards & maintainability review — `feat/refusal-lane-vocabulary`

Range: `fab6a49cf9e457885b1ead724c2135a04384f2d2..a7ff420b` · read-only · no tests run.
Axis: will this stay right as the repo changes, and does it follow this repo's own
documented standards (`.claude/CLAUDE.md`, `.agents/skills/feature/references/working-rules.md`)?
Spec/correctness is out of scope and was not re-verified.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| MEDIUM | `worker/jobs/publisher/auto-policy-downgrade.ts:17-19` + `:28` | The re-export is a zero-consumer shim and its docblock names consumers that do not exist. |
| MEDIUM | `src/lib/refusals/vocabulary.ts:184-185` and `:207-208` | The `\| null` rule is justified by a TypeScript guarantee that does not exist — omission is a compile error either way. |
| MEDIUM | `src/lib/refusals/__tests__/vocabulary.test.ts:381-385` | The sole guard for the file's client-safety invariant misses `export … from` and dynamic `import()`. |
| MEDIUM | `docs/directory.md:889` | The new code-map row contradicts itself on `\| null` three sentences apart, and repeats the false omission claim. |
| LOW | `src/lib/solicitation/approval.ts:453-456` | The weaker of the two halt-reason guards has no signpost at the site a future author will be standing. |
| LOW | `src/lib/refusals/__tests__/vocabulary.test.ts:177-178` + `:181` | "A union name is unique in its module, so the looser anchor cannot match something else" is not true of an unanchored raw-text regex. |
| LOW | `src/lib/refusals/vocabulary.ts:230`, `:253`, `:270`, `:321`, `:350` | Nothing mechanical marks a map orphaned if #1010/#1011/#1012 is abandoned or re-scoped. |
| LOW | `docs/directory.md:692` and `:1548` | `AutoPolicyDowngradeReason`'s relocation is recorded in neither the origin nor the destination row. |

---

## Detail

### MEDIUM — the `AutoPolicyDowngradeReason` re-export is a shim with no named consumer

`worker/jobs/publisher/auto-policy-downgrade.ts:28` re-exports a type the module
now imports from `src/lib/shared/worker-types.ts:150`. The docblock at `:17-19`
justifies it as:

> so every existing `import type { AutoPolicyDowngradeReason } from './auto-policy-downgrade'` still resolves

There are **no such imports**, and there never were. At the merge-base:

```
$ git grep -n AutoPolicyDowngradeReason fab6a49c -- worker src
worker/jobs/publisher/auto-policy-downgrade.ts:15   (the declaration)
worker/jobs/publisher/auto-policy-downgrade.ts:32   (same file)
worker/jobs/publisher/auto-policy-downgrade.ts:47   (same file)
worker/jobs/publisher/auto-policy-downgrade.ts:169  (same file)
```

At HEAD the only consumers are that same file — which binds the name from its own
`import type` at `:14`, not from the re-export — `src/lib/refusals/vocabulary.ts`
(which imports from `@/lib/shared/worker-types`), and the eval (which reads
`worker-types.ts` as text). Deleting `:28` breaks nothing.

The precedent the docblock cites cuts the other way. `AutonomySuspensionTrigger`
lives in `worker-types.ts` for the identical reason and is **not** re-exported
from any worker module; all four consumers
(`worker/jobs/autonomy-suspended-notice/context.ts:11`,
`src/lib/shared/job-outbox-helpers.ts:9`, `src/lib/auto-approval/suspension.ts:18`,
`src/lib/auto-approval/governor.ts:3`) import it from `@/lib/shared/worker-types`
directly. Following the named precedent means no re-export.

The docblock's "NOT A COMPATIBILITY SHIM" assertion at `:22` is the specific
problem: it pre-emptively defends the line against the exact rule that would
remove it (`working-rules.md` § Anti-slop — *"No backwards-compatibility shim
without a named external consumer. This is a pre-launch codebase — delete the old
path and update the callers."*). No CI check will ever flag it either:
`.claude/CLAUDE.md` records that `ci:fallow` "is the developer-facing sweep and
gates nothing", and the PR gate `ci:fallow:coverage` is CRAP-over-coverage, which
a type re-export cannot move.

Concrete cost: a future author deleting the import from `worker-types.ts` — or
consolidating publisher types — reads `:22` and concludes external callers depend
on it, and keeps a dead line indefinitely.

**Fix:** delete `:16-28` entirely. No call site changes.

### MEDIUM — the `| null` rule cites a guarantee TypeScript does not give

Two places state the same mechanism:

`src/lib/refusals/vocabulary.ts:183-186`:
> `| null` APPEARS ONLY WHERE A NULL MEMBER ACTUALLY EXISTS. A lane whose codes
> are all Refusals is typed `Record<Enum, RefusalCategory>`, **so an omission
> cannot type-check as a decision**

`src/lib/refusals/vocabulary.ts:205-208`:
> No `| null` in the constraint … **widening the type to admit one would invite an
> omission to type-check as a decision.**

That is not how `satisfies Record<K, V>` behaves. `Record<K, V>` requires **every**
key in `K` regardless of `V`; a missing key is `Property 'x' is missing in type …
but required in type 'Record<…>'` whether or not `V` includes `null`. The two maps
that *do* carry `| null` — `ASK_WITHHELD_REFUSAL_CATEGORIES:230` and
`BATCH_HALTED_REFUSAL_CATEGORIES:321` — are exactly as strong against omission as
the four that do not.

What `| null` actually admits is an explicit `null` **value** for a member, i.e. a
positive "this code is not a Refusal" decision. The design conclusion (don't let a
lane with no null arm spell one) is right; the stated reason is wrong.

Why it matters beyond pedantry: this file's deliverable *is* its prose, and the
claim has already propagated into `docs/directory.md:889`. A future author who
believes the `| null` maps are the weak ones will either add redundant
completeness assertions for them, or — worse — narrow one of them to
`Record<Enum, RefusalCategory>` to "strengthen" it, which is a compile error the
moment `velocity_banked: null` or the four halt nulls are present, and reads as a
mystery until they work out the comment was wrong.

**Fix:** restate as "`| null` widens the VALUE type only — a missing key is a
compile error under both forms; the narrow constraint is what stops a lane with no
deferral arm from spelling one."

### MEDIUM — the runtime-import guard has a hole shaped like a re-export

`src/lib/refusals/__tests__/vocabulary.test.ts:381-385`:

```ts
const runtimeImports = readRepoFile(VOCABULARY_MODULE)
  .split('\n')
  .filter((line) => /^import\s/.test(line) && !/^import type\s/.test(line));
expect(runtimeImports, 'every import in vocabulary.ts must be `import type`').toEqual([]);
```

The file's own header (`vocabulary.ts:22-28`) calls all-`import type` "a
REQUIREMENT rather than a coincidence", and the test's comment at `:376-377`
states there is no ESLint rule behind it — invariant #1's runtime-import ban
covers `src/app/**` and `src/components/**`, not `src/lib/refusals/`. So this
assertion is the **only** guard for the invariant.

It matches only lines beginning with `import`. These are runtime edges it does not
see:

- `export { SOMETHING } from '@/lib/…';` — a value re-export, a real runtime edge.
- `export * from '…';` — likewise.
- `const x = await import('…')` — dynamic.

`export type { … } from` is safe, and a bare `import './side-effect'` *is* caught
(it starts with `import ` and is not `import type `). The gap is specifically the
`export … from` form — and this very branch demonstrates that re-exports are a
shape this codebase reaches for (`auto-policy-downgrade.ts:28`). A vocabulary
module is a plausible place for someone to add
`export { REFUSAL_CATEGORY_META } from './meta'` when #1014 lands.

Failure mode: the eval stays green, and the breakage surfaces as a Next client
bundle resolving `node:crypto` in #1014 — loud, but at build time, in a different
issue, far from the cause.

**Fix:** widen the filter to `/^(import|export)\s/` minus the `type` forms, or
assert the negative directly (`expect(source).not.toMatch(/^export\s+(?!type)[^;]*\bfrom\b/m)`).

### MEDIUM — `docs/directory.md:889` contradicts itself inside one row

The row the branch spent surface amendment 2 on (D6) says:

> Each is `satisfies Record<Enum, RefusalCategory | null>` against the enum its
> lane already owns …

and, three sentences later in the same row:

> `| null` in a map's constraint appears ONLY where a null member exists, so an
> omission cannot type-check as a decision …

Four of the six maps (`:210`, `:253`, `:270`, `:350`) are
`Record<Enum, RefusalCategory>` with no `| null`. The first sentence is false and
the second contradicts it. The second also carries the same incorrect omission
claim as the previous finding.

D6's whole argument for spending the amendment was that a row `ci:directory-map`
cannot verify must be *true*, not merely present. This one is not.

**Fix:** "Each is `satisfies Record<Enum, RefusalCategory>` — `| null` only on the
two lanes that have a non-Refusal member."

### LOW — the weaker halt-reason guard is signposted at the guard, not at the guarded site

`vocabulary.ts:283-300` is exact and honest about the asymmetry: a reason added to
`OwnerHaltReason` (`approval.ts:90`) or `SystemHaltReason` (`approval.ts:121`)
widens `BatchHaltedRefusalCode:301` and is a compile error in
`BATCH_HALTED_REFUSAL_CATEGORIES:321`; a reason added as a **bare literal** to the
private `LatchHaltReason` (`approval.ts:456`) widens neither import, compiles, and
fails only in the eval.

The type alias itself is the right call — D2 shows the alternative (exporting
`LatchHaltReason`) turns `approval.test.ts` red for a reason that is a real actor
boundary, and the alias is a required key type for one map, not an abstraction, so
"no abstraction before the second use" is not engaged.

The gap is direction. A future author adding a seventh reason stands at
`approval.ts:453-456`, whose docblock says only *"The writable Halt latch reasons
— all five, one mechanism. NOT exported"* — stale (six, per D4) and with no
mention of the Refusal ledger. Nothing there points at
`BATCH_HALTED_REFUSAL_CATEGORIES`. The failure is loud (a test), but it is a test
in `src/lib/refusals/` failing from a `src/lib/solicitation/` edit.

Mitigating: the likely path (adding to a public union) is a compile error located
in the map itself, and D4 already routes a comment fix on those exact lines to
#1010. **Fix:** have #1010's one-word "all five → all six" correction also add one
clause naming `BATCH_HALTED_REFUSAL_CATEGORIES` as a downstream consumer.

### LOW — `unionMembers`' uniqueness claim over-states what an unanchored regex gives

`vocabulary.test.ts:177-178`:
> A union name is unique in its module, so the looser anchor cannot match
> something else.

The pattern at `:181` is `new RegExp(\`(?:export )?type ${typeName}\\s*=([^;]*);\`)`
— unanchored, applied to raw file text, with `.exec` returning the **first** match
in file order. Comments and string literals are matched too, and comments precede
declarations. Dropping the mandatory `export` widens this specifically: a
documentation example written without `export` now matches where before it did not.

Named collision risk: D4 records that `approval.ts:453`'s stale "all five" comment
is deferred to #1010, which "edits `approval.ts` anyway and can carry the one-word
fix". A rewrite of that docblock that spells the union inline — the natural way to
document six reasons — would be read as the declaration by `latchHaltMembers():161`.

Consequence is bounded: `[^;]*` truncation and comment-shadowing both change the
parsed member count, and every call site pins a count
(`:197`, `:211`, `:218`, `:282`, `:291`, `:299`, `:316`) or asserts
`toBeGreaterThan(0)` (`:224`, `:130`). So the failure is loud — but it points at
the wrong line, and the comment tells the person diagnosing it that this cannot
happen. **Fix:** soften the claim, or anchor with `^\s*` + the `m` flag.

### LOW — no mechanism marks an orphaned map

Five exported constants (`:230`, `:253`, `:270`, `:321`, `:350`) have no
production caller by design. `ci:fallow --gate new-only` judged the diff once, at
land time; nothing re-runs that judgement later, and per `.claude/CLAUDE.md` the
full `ci:fallow` sweep "gates nothing" while `ci:fallow:coverage` measures CRAP
over covered code, which a fully-asserted constant object will always pass.

So if #1011 is re-scoped or abandoned,
`OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES:270` stays exported forever with a
docblock at `:268` reading *"Written by all four writers in `ask-generation.ts`
(#1011)"* — present tense for a write that never arrives — and nothing in CI
notices.

The mitigation is real and worth crediting: every map docblock names its owing
function and issue (`commitAskDecisions` #1010, `commitWithhold` #1010, the
`ask-generation.ts` writers #1011, `latchHalt` #1010,
`downgradeAutoApprovedResponseForManualReviewInTx` #1012), and each of those
functions exists at HEAD, so the pointer resolves. The header at `:38-45` states
the cost explicitly. This is about as well-signposted as an un-gated cost gets;
the residual is that a reader arriving at, say,
`src/lib/solicitation/batch-builder.ts:573` finds a `commitAskDecisions` that does
not write a Refusal, and cannot tell from there whether the write was removed or
never landed. **Fix (cheap):** phrase the docblocks as "Writer: X (#1010, not yet
landed)" rather than "Written by X (#1010)".

### LOW — the type's relocation is absent from both code-map rows

`docs/directory.md:692` still describes `worker-types.ts` as owning "the
suspension-trigger/evidence vocabulary and the three judge/suspension payloads";
`AutoPolicyDowngradeReason` moved in and is not mentioned. `:1548`
(`auto-policy-downgrade.ts`) does not mention that it no longer declares the union.
Neither row is *falsified* by the move, so `ci:directory-map` — which checks that a
row exists, not that it is true, the same gap D6 identified — stays green.

Minor on its own; noted because the branch spent an amendment on exactly this class
of staleness one row away, and because the `worker-types.ts` row is where someone
would look to find out why a worker union lives under `src/lib/`.

---

## What I checked and found sound

- **Comment-to-code ratio is in family, not an outlier.** Comment-lines /
  total: `vocabulary.ts` 259/357 (73%), sibling `write.ts` 291/434 (67%), model
  `restraint-policy.ts` 171/467 (37%). The two `src/lib/refusals/` files are
  deliberately prose-dense and this diff does not change that character. The
  reclassification to `standard` (D8) is the honest read; the line count is
  docblock, and the executable surface is six constant objects, one type alias and
  one re-export.
- **`BatchHaltedRefusalCode:301` is the narrow choice, not premature abstraction.**
  D2's evidence (`approval.test.ts` red on the export) shows the alternative
  weakens a real actor boundary that migration 091's
  `solicitation_batches_halt_consistency` CHECK backs. A key type used by one map
  is not an abstraction awaiting a second use.
- **Map naming is consistent.** `<REFUSAL_SOURCE>_REFUSAL_CATEGORIES` throughout,
  with `DISPATCH`/`RENDER` inserted for the one lane with two writers. The
  `DISPATCH` half-name is enough of a signal at an import line that a counterpart
  exists, and `:243-248` states the "must never be merged" rule at the definition.
- **The `| null` asymmetry across the six maps is deliberate and stated** (aside
  from the incorrect justification called out above) — a reader is not left
  guessing why four maps differ from two.
- **Text-parsing the four source modules is load-bearing, not fragile.** Nothing
  at run time can enumerate a bare TS union, and every parse is fenced by a count
  or a `toBeGreaterThan(0)`, so truncation (`[^;]*`), a dropped member
  (`quotedMembers`' `/'([a-z_]+)'/` misses digits and hyphens) and a missing file
  all fail loudly rather than vacuously. The one soft spot is the uniqueness claim
  above.
- **`expectLaneMap:124-145` does not hide which case failed.** Every assertion
  carries the `label`, and the per-member loop names the member
  (`` `${label}: '${member}' has no entry` ``). The key-set equality at `:131`
  yields a normal array diff.
- **The `import type` invariant's premise holds.** No production file under
  `src/lib/**` imports from `worker/` (`rg "from '.*worker/" src/lib
  --glob '!**/__tests__/**'` → empty), so the sentence at `worker-types.ts:131-137`
  is accurate as narrowed.
- **`working-rules.md` § Anti-slop, remaining rules.** No new file; no new
  dependency; no new env var or flag; net-negative bias addressed explicitly in D8;
  precedent named (`WITHHOLD_REASONS`, `AutonomySuspensionTrigger`,
  `RESTRAINT_POLICY_VERSION`) and followed. The only Anti-slop rule broken is the
  compatibility-shim one, above.
- **D7's `**/` gotcha is guarded in place.** `worker-types.ts:140-142` explains
  the glob-star-in-block-comment trap on the very line that would re-introduce it.
  That is the right location for a signpost, and is the pattern the halt-reason
  finding above asks for.

## Low-confidence appendix (preferences and speculation — not findings)

- **Map declaration order.** The six maps sit in `REFUSAL_SOURCES` order except
  `AUTO_POST_REVOKED_REFUSAL_CATEGORIES:350`, which is second in the source array
  and last in the file (presumably because its type had to move). A reader
  cross-checking "which lanes have maps" against `:79-87` scans past it. Cosmetic;
  the header already enumerates what is missing.
- **`REFUSAL_SOURCES:79` inline comments.** `'held_draft', // A high-severity
  moderation flag. No code axis at all (C4).` — the C4 reference is useful; the
  first clause is close to restating the identifier. Marginal.
- **Test-file title coupling.** `vocabulary.test.ts:3-5` records that titles are
  verbatim from `.feature/intake.json` because `promised-tests` matches exact text.
  That couples test titles to a workflow artifact that will not exist after merge.
  Probably intentional and harmless; noted only because a future author renaming a
  title for clarity will not know why the comment objects.
- **`REFUSAL_VOCABULARY_VERSION:172` is dated `2026-08-30`, today.** The docblock
  says it is "dated the day map #994 closed". If #994 closed earlier, the date is a
  branch date wearing a decision date's meaning. I could not establish #994's close
  date from the worktree, so this is speculation.
- **Header prose length.** `vocabulary.ts:1-45` is a 45-line file header before the
  first import. It is all load-bearing on my read, but it is the sort of block that
  accretes; a future author adding "why the sixth map arrived" will make it 55.
