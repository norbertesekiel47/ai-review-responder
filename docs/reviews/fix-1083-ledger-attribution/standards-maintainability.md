# Standards & Maintainability — fix/1083 ledger attribution

- **Skill used:** `thermo-nuclear-code-quality-review` (loaded and applied; the
  `code-review` fallback was not needed).
- **Range:** `91b32506a694954643e9523eae3901d784a348ca..c94277bf1fe7fa789bba7bbb7208c7f7210b9188`
- **Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1083-ledger-attribution`
- **Read first:** `.claude/CLAUDE.md` §§ Working rules, Architecture invariants;
  `docs/reviews/finding-checklists/standards-maintainability.md`.
- Per the brief, docblock DENSITY is not reported. Docblocks that contradict the
  code beside them, or that have gone stale, are.

## Verdict

The structural move is right and I would not ask for it to be re-litigated.
Attribution belongs to the statement's owner; the deletion test the plan ran
(`docs/superpowers/plans/fix-1083-ledger-attribution.md:49`) is the correct
argument, and it produced a change in which five lane files were not edited at
all. Both write arms are still shallow (guard, guard, `try`/`catch`, rethrow),
nesting never exceeds two, and no new branch was bolted onto an unrelated flow.
Invariants #12 and #15 are intact: the catch bodies are 2–8 executable lines,
and `write.ts` still takes `tx` as a parameter.

What the branch got wrong is almost entirely in the layer it is loudest about —
the prose and the cross-references. Three of the seven findings below are
mechanisms asserted in a comment that the code cannot perform, and two are
citations that resolve at the fork point and were stale the moment they were
written. Both classes are already on this axis's accepted-findings list, twice
each. One finding (F1) is operational and, in my judgement, the most consequential:
the branch widened the population of `subsystem:refusal_ledger` `level:error`
Sentry events from two lanes to seven without touching the alerting runbook that
tells an operator how to page on them.

## Findings

| severity | file:line | finding |
|---|---|---|
| medium | `src/lib/refusals/write.ts:765` | Neither attribution capture carries a `fault` tag, so the two fault classes the branch is built on are indistinguishable to any Sentry alert rule — and the comment forbidding a fourth tag contradicts the convention this same module sets 100 lines above it |
| medium | `docs/runbooks/beta-launch-alerting.md:500` | The operator runbook still names `withLedgerAttribution` as the sole source of `error`-level `subsystem:refusal_ledger` events; the branch added a second, seven-lane source and did not update the runbook or its rule-design reasoning |
| medium | `worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts:89` | Three docblocks in an untouched live-DB suite attribute the write-rethrow oracle and "the branch's whole observability claim" to `withLedgerAttribution`, which no longer wraps any write on either lane |
| medium | `src/lib/refusals/write.ts:1095` | The stated reason for duplicating the lane string into `extra` — a 200-character Sentry tag truncation — describes an unreachable condition: the maximum possible value is 108 characters. Repeated verbatim in the LOCKED `CONTEXT.md:167` entry |
| medium | `docs/superpowers/plans/fix-1083-ledger-attribution-handoff.md:52` | All four `write.ts` citations in the handoff (`:791`, `:904`, `:922`, `:925`) resolve exactly at the fork point and are stale at HEAD; the handoff is a post-implementation document, so they were stale when written |
| medium | `src/lib/refusals/__tests__/write.test.ts:99` | The new citation "`write.ts:61` imports `v7 as uuidv7`" resolves at the fork point and lands at HEAD on docblock prose; the import is at `write.ts:73`, moved by this same commit |
| medium | `src/lib/refusals/write.ts:754` | `lane: string` is untyped where `RefusalSource` is imported in the same file, and the parameter carries two different concepts — one lane, and a rendered lane-set — so the join/sort determinism rule lives only in the set arm's catch |
| low | `docs/directory.md:905` | "`uuidv7()` is interpolated INSIDE both tagged templates" is false for the set arm, where it is called in the `rows` map; the two arms are protected by different mechanisms and the row conflates them |
| low | `worker/jobs/response-generation/persist.ts:1059` | `withLedgerAttribution`'s `lane` parameter now has a type admitting exactly one value, passed as a constant from its only caller — a dead parameter under "no abstractions for a single caller" |
| low | `src/lib/refusals/write.ts:897` | The single-row arm duplicates `refusal_source` into `extra`, exactly duplicating the `refusal_lane` tag, with no stated reason — while the set arm documents the same duplication at length |

---

## F1 — Neither attribution capture carries a `fault` tag

**`src/lib/refusals/write.ts:765`, `worker/jobs/response-generation/persist.ts:1066`.**

Both capture sites emit:

```ts
tags: { subsystem: 'refusal_ledger', refusal_lane: lane, flag: REFUSAL_LEDGER_FLAG }
```

For the `policy_gate_held` lane these are **byte-identical**. A writer bug (a
migration-116 CHECK violation) and a map bug (an unmapped block reason) reach
Sentry with the same three facets. The branch is explicit that only `extra`
separates them:

> `worker/jobs/response-generation/persist.ts:1035` — "Sentry tells them apart by
> `extra` — `response_id` here, the writer's five closed fields there"

Sentry alert rules and search facets key on **tags**, not on `extra`. This repo
already knows that and has already written the rule down:

> `docs/runbooks/beta-launch-alerting.md:105` — "**RULE ON THE `fault` TAG, NEVER
> ON `subsystem:refusal_ledger AND level:error`.** … A level-plus-subsystem rule
> selects all of them and pages on three different faults."

And `write.ts` itself sets the convention twice, one function above the new
helper:

- `src/lib/refusals/write.ts:657` — `tags: { subsystem: 'refusal_ledger', fault: 'unmapped_block_reason' }`
- `src/lib/refusals/write.ts:703` — `tags: { subsystem: 'refusal_ledger', fault: 'unmapped_block_reason_overflow' }`

So the comment at `write.ts:761-764` —

> "THREE TAGS, EXACTLY. … A fourth tag is a fourth facet nobody agreed to."

— is contradicted by the module it sits in. A fourth facet **was** agreed to, by
#1105, and the runbook mandates alerting on it. The consequence is concrete and
lands squarely on the ticket's own goal: an operator building the "ledger write
fault" rule the ticket exists to make possible has no tag to filter on, and any
`fault`-keyed rule silently excludes both attribution captures.

**Remedy.** Add `fault: 'ledger_write'` to `captureLedgerWriteFault` and
`fault: 'ledger_vocabulary'` to `withLedgerAttribution`, and delete the
"three tags, exactly" paragraph — it was written without reference to the two
`fault`-tagged transports above it. This also removes the need for `extra` to
carry the discriminator, which is F7's problem too.

Confidence: high. The tag sets are identical by inspection; the convention and
the runbook rule are both in-repo and cited.

## F2 — The alerting runbook was not updated

**`docs/runbooks/beta-launch-alerting.md:500` (and `:106`).**

> "Three different faults now carry `subsystem:refusal_ledger` at `error` —
> `withLedgerAttribution`'s ledger-failure attribution (since #1079) and both of
> these — so a subsystem-and-level filter pages on all three…"

At HEAD, `withLedgerAttribution` no longer produces the ledger-*failure*
attribution at all; `captureLedgerWriteFault` does, on all seven lanes and both
write arms. The runbook's inventory is wrong in both directions: it names a
source that no longer covers writes, and omits the source that does. The
volume statement is understated by design — the whole point of #1083 is that
five previously-silent lanes now emit into this exact facet.

`.claude/CLAUDE.md` § Working rules: *"When deleting a doc or ticking a checklist
item, fix its audit tick and grep the filename to clean every cross-reference in
the same change."* This branch's own architecture row goes further —
`.claude/reference/arch-review-log.md:1666` records the lesson *"grep the symbol,
not just the function"* — and then the branch greps only `persist.ts`. Neither
the plan nor the deviations document mentions `beta-launch-alerting.md`
anywhere.

**Remedy.** Update the rule-7/8 paragraph to name `captureLedgerWriteFault` as
the write-fault source, note that it now spans seven lanes, and (with F1's fix)
name its `fault` tag so rules 7/8's own filter advice stays coherent.

Confidence: high.

## F3 — Three stale docblocks in the untouched live-DB suite

**`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts:89`, `:168`, `:939`.**

The file was not touched by this branch, and the plan explicitly requires it to
RUN (`docs/superpowers/plans/fix-1083-ledger-attribution.md:327`). Three of its
docblocks now assert a mechanism that no longer exists:

- `:89` — "the rollback they observe comes from Postgres and would happen even if
  `withLedgerAttribution` SWALLOWED the error". The wrapper no longer wraps any
  write on either lane, so it cannot swallow a write error at all.
- `:168` — "`withLedgerAttribution`'s capture is the branch's whole observability
  claim". There are now two capture owners, and for a write fault it is the
  other one.
- `:939` — "The oracle for `withLedgerAttribution`'s rethrow." For `held_draft`
  there is now no wrapper whatsoever: `persist.ts:1147` is a bare
  `await writeRefusalEvent(...)`. What the case actually proves at HEAD is that
  neither `writeRefusalEvent`'s own catch nor the call site swallows.

The tests still pass — the poison mock at `:102` intercepts `writeRefusalEvent`
before the real body, so nothing captures — but a passing test with a false
stated oracle is the exact class this axis has accepted before ("a comment that
names the wrong mechanism teaches the next reader to test the wrong thing").

**Remedy.** Re-word all three against HEAD, naming the writer's own catch as the
thing whose rethrow the plain-`Error` case now guards.

Confidence: high.

## F4 — The 200-character truncation justification is unreachable

**`src/lib/refusals/write.ts:1095-1097`, and verbatim in `CONTEXT.md:167`.**

> "`refusal_lanes` duplicates the TAG on purpose — a Sentry tag value truncates
> at 200 characters and `extra` does not, so `extra` is the durable copy for a
> cohort spanning every lane."

The worst case is every one of the seven `REFUSAL_SOURCES` members, sorted and
comma-joined:

| member | chars |
|---|---|
| `ask_withheld` | 12 |
| `auto_post_revoked` | 17 |
| `autonomy_suspended` | 18 |
| `batch_halted` | 12 |
| `held_draft` | 10 |
| `outreach_withheld` | 17 |
| `policy_gate_held` | 16 |
| 6 commas | 6 |
| **total** | **108** |

108 < 200. The stated failure mode cannot occur, now or after any addition short
of roughly six more lanes. The `Set` is over a closed enum, so no unbounded
value can enter it. The duplication may still be defensible (a tag is a facet, an
`extra` is a payload; you may want both), but the reason given is not the reason.

This matters more than a normal comment slip because it is repeated in a **LOCKED**
`CONTEXT.md` term coined by this same commit — the one artifact the next agent is
told to treat as authoritative.

**Remedy.** Either delete both sentences and keep the duplication unjustified-but-cheap,
or state the real reason. Do not restate a different number.

Confidence: high (arithmetic, verifiable).

## F5 — The handoff's four `write.ts` citations are fork-relative

**`docs/superpowers/plans/fix-1083-ledger-attribution-handoff.md:52-56.**

```
1. The set-arm guard starts at the row map (`write.ts:904`), not the INSERT
   (`write.ts:925`). Round 1 F2. `toISOString()` at `:922` throws on a … 
   tagged-template interpolation at `write.ts:791`, so it already evaluates …
```

Resolution:

| citation | at fork `91b32506` | at HEAD `c94277bf` | actual HEAD location |
|---|---|---|---|
| `write.ts:791` | `${uuidv7()}::uuid,` | docblock prose about migration 034 | `:882` |
| `write.ts:904` | `const rows: RefusalEventRow[] = …` | `});` inside `captureLedgerWriteFault`'s caller | `:1019` (try at `:1017`) |
| `write.ts:922` | `occurred_at: … toISOString()` | — | `:1035` |
| `write.ts:925` | `await tx\`` | trailing comment in the single-row arm | `:1042` |

Every one resolves exactly at the fork point. `write.ts` has not changed since
commit `677f69b1`, so these were already stale when `330b938e` wrote them. This is
the accepted class verbatim: *"Nine further plan citations are fork-relative and
stale beyond the untracked one … each resolves exactly at the fork point."* The
handoff is worse than a plan, because a plan legitimately describes the tree it
was written against and a handoff describes the tree the next agent will open.
`:904` landing on a plausible-looking `});` is the "worse than landing on
nothing" case.

**Remedy.** Cite by symbol — `writeRefusalEvents`' row map, the single-row arm's
`uuidv7()` interpolation. The arch-review-log row two entries above already says
to do this.

Confidence: high (mechanically verified against three commits).

## F6 — `write.ts:61` in the test docblock

**`src/lib/refusals/__tests__/write.test.ts:99.**

> "WHY IT HAS TO BE A MOCK. `write.ts:61` imports `v7 as uuidv7` …"

At fork, `write.ts:61` is `import { v7 as uuidv7 } from 'uuid';`. At HEAD it is
docblock prose ("THE `try/catch` DECISIONS BELOW LOOK CONTRADICTORY…"), because
this same commit added twelve lines to the module docblock above the imports. The
import is at `:73`.

This is a *new* citation — it does not exist at the fork point — so the commit that
wrote it is the commit that moved its target, which is exactly the mechanism the
checklist names. The claim it supports is correct and important (the `uuidv7()`
call must stay inside the template); only the address is wrong.

**Remedy.** Drop the line number: "`write.ts` imports `v7 as uuidv7`" carries the
same weight and cannot go stale.

Confidence: high.

## F7 — `lane: string` is two concepts sharing one parameter

**`src/lib/refusals/write.ts:752-756`.** This is the brief's question 1, and my
answer is that the signature is not honest.

```ts
function captureLedgerWriteFault(
  error: unknown,
  lane: string,
  extra: Record<string, string | number | null>,
): void
```

`RefusalSource` is imported at `write.ts:79` and is the type of everything the
single-row arm passes. The set arm passes `'ask_withheld,batch_halted'`, which no
`RefusalSource` can express — so the parameter is `string` purely to admit the
second arm's rendering. The `@param` tag at `:749-750` concedes the split in
prose: *"the `RefusalSource` for the single-row arm; for the set arm, the DISTINCT
sources sorted and comma-joined"*. A `@param` that has to enumerate two meanings
is a signature that should have modelled one.

Three costs, all concrete:

1. **The type hole is open.** Nothing stops a third call site (or a careless edit
   of an existing one) passing an arbitrary string; the tag facet forks silently
   and the module's own "closed enums and UUIDs only" rule at `:743` is
   unenforced for the one field that names the lane.
2. **The determinism rule lives in the wrong place.** The sort-then-join — which
   `write.ts:1085-1091` and `CONTEXT.md:167` both call load-bearing ("sorted so one
   cohort cannot open two Sentry facets") — exists only inside `writeRefusalEvents`'
   catch. Nothing in `captureLedgerWriteFault` requires or enforces it, and the
   single-row arm bypasses it entirely.
3. **The tag name lies about the value.** `refusal_lane` (singular) can carry a
   comma-joined set. The set arm's own comment at `:1091` acknowledges this
   ("the input type permits a mixed array and the tag must not lie about one") and
   then ships the singular name anyway. `extra` gets `refusal_lanes`, plural, on
   the same event.

### The judo move

```ts
function captureLedgerWriteFault(
  error: unknown,
  lanes: readonly RefusalSource[],
  extra: Record<string, string | number | null>,
): void {
  const lane = [...new Set(lanes)].sort().join(',');
  try {
    Sentry.captureException(error, {
      level: 'error',
      tags: { subsystem: 'refusal_ledger', fault: 'ledger_write', refusal_lane: lane, flag: REFUSAL_LEDGER_FLAG },
      extra: { ...extra, refusal_lanes: lane },
    });
  } catch { /* … */ }
}
```

Call sites become `captureLedgerWriteFault(error, [input.refusalSource], { … })`
and `captureLedgerWriteFault(error, inputs.map((r) => r.refusalSource), { row_count: inputs.length })`.

What this buys: the `string` hole closes against `RefusalSource`; the sort/join
determinism rule gets exactly one owner; the `lanes` local disappears from the
set arm's catch; the tag/`extra` duplication becomes one deliberate act in one
place instead of two inconsistent ones (which is also F10); and F1's `fault` tag
lands in the same edit. The `Set` is still over closed-enum strings, so it still
cannot throw inside a catch — the property `:1088-1089` relies on is preserved.

The one thing it costs: `inputs.map(...)` allocates inside the catch. Over a
bounded 5,000-element array of enum strings, in a path that only runs when the
transaction is already dying, that is not a cost worth the type hole.

Confidence: high on the defect; the specific remedy is a proposal, not a
requirement.

## F8 — "interpolated INSIDE both tagged templates"

**`docs/directory.md:905`** (write.ts row, Trap):

> "`uuidv7()` is interpolated INSIDE both tagged templates, so it already
> evaluates within the guard"

False for the set arm. `writeRefusalEvents` calls `uuidv7()` at `write.ts:1021`,
in the `rows` map — the template at `:1041` interpolates `tx.json(rows)`. The
*conclusion* holds for both arms, but by different mechanisms: the single-row arm
is protected by lazy template evaluation, the set arm by the guard starting at the
row map (which is F2 of plan round 1 and the sharpest thing the branch found). The
row erases that distinction, and the distinction is the whole reason the set arm's
`try` starts where it does. A reader who believes "the template protects it"
could reasonably hoist `id` generation out of the set arm's map.

The arch-review-log row at `.claude/reference/arch-review-log.md:1666` repeats the
same sentence.

Confidence: high on the fact; low severity because the operational conclusion
survives.

## F9 — `withLedgerAttribution` has a dead parameter

**`worker/jobs/response-generation/persist.ts:1058-1061`.** This is the brief's
question 3. Arguing it both ways, from the repo's rules:

**For inlining.** `.claude/CLAUDE.md` § Working rules: *"no abstractions for a
single caller"*. At HEAD the function has exactly one call site
(`persist.ts:978`), and its `lane` parameter is typed `'policy_gate_held'` — a
type admitting exactly one value, always passed as that literal. The generic `<T>`
is instantiated once. The body is four executable lines. On the letter of the
rule, this is an abstraction for a single caller with a constant parameter.

**Against inlining.** The rule targets indirection that costs a reader a hop for
nothing. Here the hop buys a genuine separation: `recordPolicyGateRefusal` is a
guard ladder, and inlining a nested `try { … } catch { try { … } catch {} throw }`
into it would add two nesting levels to a function whose readability is the point.
The docblock is also a durable record of three prior review rounds; it needs a
declaration to hang on, and moving it inline would bury it in the middle of the
ladder. Invariant #12 also cuts this way — "modules own failure behaviour" — even
though the branch is well under the 30-line threshold.

**My call: keep the function, delete the parameter.** `lane` cannot vary, so
passing it is pure ceremony; spell the literal in the tag object and drop the
argument at the call site. That satisfies the rule's intent (no parameterisation
without variation) without losing the docblock's home.

Secondary, and the reason I would not simply wave this through: the name is now
ambiguous against a LOCKED term. `CONTEXT.md:167` coins **Ledger attribution** in
this same commit and assigns its primary owner as `captureLedgerWriteFault`; the
surviving wrapper covers one narrow fault class, and its own docblock title at
`persist.ts:1007` already reads "Attribute a Refusal-ledger **VOCABULARY**
failure". The identifier should say so — `withVocabularyFaultAttribution`, or
similar. `CONTEXT.md`'s own guidance is that a grep for "attribution" already
returns two unrelated subsystems; this makes it three spellings inside one.

Confidence: medium-high on the dead parameter; the rename is a judgement call.

## F10 — Undocumented tag/`extra` duplication in the single-row arm

**`src/lib/refusals/write.ts:897`.** The single-row `extra` opens with
`refusal_source: input.refusalSource` — byte-identical to the `refusal_lane` tag
that the same call sets. The set arm does the same thing and spends three comment
lines justifying it (F4 shows the justification is wrong). The single arm does it
silently, and the helper's own docblock at `:743` — "`extra` IS CLOSED ENUMS AND
UUIDs ONLY, and each arm passes its own" — does not mention that one of the fields
is a copy of a tag.

Not harmful. It is an inconsistency between two arms the module works hard to keep
symmetrical, and F7's remedy removes it by construction.

Confidence: high on the fact; low severity.

---

## Questions from the brief, answered

**Q2 — is the inline `extra` duplication?** No, and I would not ask for it to be
unified. Five closed fields against two aggregate fields is two genuinely
different payloads, and both are correctly bounded (the set arm's refusal to
carry 5,000 subject ids is right). The *only* duplication is the lane, which F7
folds into the helper.

**Q5 — complexity and nesting.** No. `writeRefusalEvent` is guard / guard /
`try`+`catch` at depth 2; `writeRefusalEvents` adds the map inside the `try` at
depth 3 (the arrow body), which is where it has to be. Neither function gained a
branch. The `git diff` line count is inflated by reindentation of two long SQL
templates — `git diff -w` puts the substance at 179 lines, which the branch's own
arch row already records.

**File size.** `src/lib/refusals/write.ts` crossed the 1,000-line threshold
(986 → 1,125), which is normally a presumptive blocker on this skill. I am **not**
reporting it. Measured: 302 code lines, 766 comment lines, 57 blank. The crossing
is entirely prose, and the brief forbids reporting docblock density. The
executable module is 302 lines and clearly sectioned by banner comments. If the
file is ever decomposed, the natural seam is the five Sentry/latch transports
(`warnLedgerDisabled`, `noteRefusalLedgerDark`, `noteUnmappedBlockReasons`,
`noteUnmappedOverflow`, `captureLedgerWriteFault` and their latch state) into a
sibling `signals.ts` — but "Default is no new file" and the `ci:directory-map`
row cost both argue against doing it now, and F1 suggests the transports should
first be made consistent with each other.

## Checked and clean

- Invariant #15 — `write.ts` takes `tx: TransactionSql`; no `@/lib/db/server`
  import added. Clean.
- Invariant #12 — both new catch bodies are 2–8 executable lines; no extraction
  owed.
- No `any`; `extra` is `Record<string, string | number | null>`; `unknown` on
  `error` is correct and narrowed nowhere it shouldn't be.
- No silent catches beyond the two guarded Sentry captures, which the repo
  requires. Both are commented as such.
- `captureLedgerWriteFault` is module-private with exactly two callers, both write
  arms — the docblock's claim at `:733-735` holds.
- "Five of the seven lanes omitted it" — verified against the seven production
  call sites (`suspension.ts:331`, `approval.ts:637`, `dispatch.ts:1474`,
  `ask-generation.ts:710` and `:1940`, `batch-builder.ts:670`,
  `auto-policy-downgrade.ts:208`, plus the two in `persist.ts`). Correct.
- "Both call sites pass a single lane" (`write.ts:1091`) — verified:
  `batch-builder.ts:670` passes `ask_withheld` only, `ask-generation.ts:1940`
  passes `outreach_withheld` only. Correct.
- "Cardinality is bounded at 127" (`write.ts:1089`) — correct; 2⁷−1 distinct
  non-empty subsets of seven lanes.
- `MAX_DATA_ROWS` = 5,000 (`src/lib/solicitation/contacts-csv.ts:22`). Correct.
- The `ON CONFLICT` predicates are still byte-for-byte identical across both arms
  and unparameterised (invariant #2). Untouched by the reindent.
- The kill-switch guard still precedes both `try` blocks and `endDisabledEpisode()`
  stays outside both — #1079's containment is preserved, and
  `persist.test.ts:285` pins it.
- `docs/directory.md` rows for `write.ts` and `persist.ts` were both updated in
  this PR (`ci:directory-map` satisfied); F8 is the only factual error in them.
- The 16 new eval titles are substantive — the `uuidv7`-hoist case
  (`write.test.ts:1766`) and the row-materialization case (`:1721`) both have real
  oracles, and `persist.test.ts:173`/`:201` assert the surviving capture's `extra`
  rather than a bare count, which is the right shape.

## Low-confidence appendix (no cited standard, or under 80%)

- `docs/superpowers/plans/fix-1083-ledger-attribution.md` carries eleven
  fork-relative `write.ts` citations (`:61`, `:752`, `:777`, `:791`, `:891`,
  `:895`, `:900`, `:904`, `:905`, `:922`, `:925`). Unlike the handoff (F5) these
  are defensible — a plan describes the tree it was written against. Flagging
  only because the accepted-findings list has taken this shape before.
- `CONTEXT.md:167` says "five lanes omitted it and nothing stopped a **sixth**";
  `write.ts:723` says "nothing stopped an **eighth** omitting it next". Both
  readings are coherent (sixth omitter vs eighth lane), but the two were written
  in the same commit and read as a contradiction.
- `docs/directory.md:905` retains the pre-existing phrase "the Sentry warning
  around it is genuinely swallowed" — `warnLedgerDisabled` is not "around" the
  INSERT. Pre-existing, not this branch's.
- The two live-DB constraint cases in `refusal-write.integration.test.ts`
  (`poison.heldDraftCategory`, `poison.breakC5`) now exercise the real
  `captureLedgerWriteFault` against a genuine `23514` and assert nothing about it.
  That is the only path in the repo that produces a real CHECK violation end to
  end, and it would be the strongest oracle available. Coverage observation
  rather than a standards defect — the unit suite covers the behaviour with mocks.
- `persist.ts:944` — "NOT CAUGHT AT THE CALL SITE, on the same terms as the
  `held_draft` write". Still literally true, but "the same terms" now means
  something different on each lane; a reader could reasonably be misled.
