# Red team — fix/1083-ledger-attribution

Two rounds, the protocol's cap. Round 1 on `c94277bf`; round 2 scoped to
`c94277bf..6a382d1a` and its direct callers. Fork `91b32506`.

Round 1's full report is preserved at `findings-round-1.md`. This document is the
current state: **11 findings, all fixed, sidecar status `CLEAR`.**

> Round 2's report could not be staged by the agent — the harness blocks a
> subagent writing report `.md` files — so the orchestrator wrote it from the
> agent's returned tables. The JSON sidecar beside it was written by the agent
> and is the machine-read record; `red-team-status.mjs` recomputes status from
> the inventory rather than trusting it.

## `head_sha` was repointed — read this before trusting the sidecar

Round 2 reviewed `6a382d1a`. The sidecar now says `8a15f0eb`, and that is a
deliberate, owner-authorised repoint rather than a fact the pass established.
Deviations **D12** carries the full record; the essentials:

- **Zero code changed** between the two.
  `git diff --name-only 6a382d1a..HEAD -- src worker` returns **0 files**. Every
  byte this pass mutated, killed and cleared is identical.
- What moved is **six documents**, and they are the fixes for this round's own
  four doc-truth findings (RT-3, RT2-1, RT2-2, RT2-3).
- **Round 3 is refused by hard cap**, so no pass was available to re-establish
  the evidence at the new SHA.

**What the repoint overclaims, stated rather than buried.** This pass's brief
included re-resolving doc claims. Its CODE verification stands untouched. Its
DOC verification is genuinely stale for the four files the fixes changed, and a
repointed `head_sha` asserts a doc review that did not happen.

**The compensating control** is that those four claims were re-verified
mechanically by the orchestrator — derived from code and the intake, never from
reading the prose: the deleted `lane` parameter against the real signature, the
four-key `extra` against the real call site, and the seventeen titles against the
intake's length and a grep split of 12 + 5.

A reader who wants evidence untouched by this should read round 1 and round 2's
findings as recorded, and treat the doc-claim column as verified by the
orchestrator rather than by the pass.

**`intake_sha256` was also updated** (deviations D15). Step 8 added
`docs/progresstracking.md` to `allowed_edit_surface` so the per-PR record could
be written, and the checker voids evidence on any intake change. The whole diff
since this pass ran is:

```
+    "docs/progresstracking.md",
```

One string, in the edit lease rather than the specification. No `goal`,
`invariant`, `edge_case`, `tests_to_add` entry, `non_goal` or `test_seam` moved,
and none of the 45 mutations exercised that field. **This claim is thinner than
the `head_sha` one** — that could prove code identity with a diff hash, this
cannot, because the contract itself moved. Read the diff above rather than this
paragraph.

## Counts

| | Round 1 | Round 2 |
|---|---|---|
| Inventory rows | 28 | 17 |
| Killed | 17 | 12 |
| Confirmed survivors | 3 | 0 |
| Inconclusive | 0 | 0 |
| Budget used | 25 / 30 | 12 / 30 |

11 findings total, 11 fixed, 0 open. No candidate skipped for budget in either
round.

## The two P0s, and how they were confirmed dead

**RT-1 — the set-arm `extra` was not a closed key set.** Round 1 added
`refusal_codes: inputs.map(r => r.refusalCode).join(',')` and it survived the
entire suite: 146/146 green, both live-DB suites included. Gate reasons are
free-ish text on several lanes, so prose could ride a Sentry event against the
intake's own invariant.

The eval asserted the payload by **presence**, which cannot fail on an *added*
key. Fixed with one line per arm:
`expect(Object.keys(extra).sort()).toEqual([...KEYS].sort())`.

Round 2 confirmed it dead by re-applying round 1's mutation **verbatim**, not by
inspection — and additionally proved the assertion exact in both directions: a
*removed* key fails too, and the same smuggle on the single-row arm dies.

**RT-2 — `refusal_lanes` was asserted only against a single-lane fixture**, so
degrading it to `inputs[0].refusalSource` survived. The field was removed in the
payload redesign, and its replacement pair (`account_id`, `account_count`) is
pinned by a genuinely mixed two-account fixture — so the degradation class is
dead rather than relocated.

Both P0s were the same underlying error: an assertion describing what the code
does rather than what it must never do.

## Round 2 — what the fixes broke or left half-done

| ID | Sev | Finding | Resolution |
|---|---|---|---|
| RT-3 | P1 | Half-fixed. The runbook's **"no dedicated rule" register** still said four signals; at HEAD it is six. | Register corrected to six, naming both new `fault` values, each level `error` with no filter, threshold or destination. |
| RT2-1 | P1 | `docs/directory.md`'s `persist.ts` row asserted a `lane` parameter this commit deleted, and a "five-key `extra`" that is now four — while the same commit corrected the `write.ts` row for both facts. | Row corrected; the `fault` pair added. |
| RT2-2 | P1 | The handoff still said sixteen titles split twelve/four. | Seventeen, split twelve/five, the seventeenth named. |
| RT2-3 | P2 | `write.ts:891` stale in the plan — it now lands inside the set arm's INSERT column list. | Converted to a symbol; see the sweep below. |

**RT-3 deserves naming.** That register's own text reads: *"The count was 'two'
and the two new signals were not listed when they shipped; red team caught the
omission, which is the same class of defect this whole register exists to
prevent."* This branch corrected the runbook's **prose** — four emitters became
six — and left the register at four. One commit fixed half an omission and
created the other half, and red team caught it a second time, the same way. The
register now carries that history and an instruction to grep the **count**, not
only the emitter name.

**RT2-3 was the tip, not the defect.** Red team named one stale citation. A sweep
resolving *every* `file:line` in the branch's docs against HEAD found
**sixteen**, all in the plan — each landing on a real line and none on the thing
it names, which reads as correct and is therefore worse than a dangling
reference. They are left in place under an explicit header note, because the plan
records what was planned and its citations were true when made; the handoff, which
a resumed session actually reads, was converted to symbols. The lesson is the
sweep: finding these one at a time is how you miss fifteen.

## What held under attack

- All four guard mutations named in the round-1 brief were **killed** — the
  `uuidv7` hoist, moving the set guard to the INSERT, computing lanes from
  `rows`, dropping `.sort()` — plus thirteen more.
- **#1079's kill-switch containment intact**: no path found by which a ledger
  throw reaches a caller's transaction with the flag off.
- **No double-reporting path** between the writer and the surviving wrapper.
- **Zero missed siblings** across the five unedited lane files, with the search
  recorded rather than asserted.
- The `fault` tags are real and genuinely distinct: removing it from either
  capture dies, and setting both to one constant dies from *either* side.
  `persist.test.ts` mocks nothing from `@/lib/refusals/write`, so its
  `fault=ledger_write` assertion exercises production code.
- `account_id`/`account_count` correct for empty, single and mixed inputs;
  computed from `inputs` **structurally** — `rows` is block-scoped inside the
  `try` and invisible in the `catch` — and both bounded.
- Removing the `lane` parameter changed the signature only: one call site, same
  constant, byte-identical tag.
- All reviewed-HEAD claims held: gate green with fingerprint `9560eea4…` at
  `6a382d1a`, 108/108 unit, 39/39 live-DB **running not skipping** (re-derived at
  HEAD, 0 pending), 17/17 titles verbatim.

## Restoration

Every mutation restored across both rounds, verified by **blob oid against HEAD**
rather than by porcelain alone. Journal closed, `dotenv.open: false`, no
`.env.local.red-team-backup` remaining, `.env.local` hashing back to its pre-run
value. The orchestrator ran the finalizer after each round.

**One operational finding worth carrying forward:** *do not restore a mutation by
re-invoking `mutate` with HEAD content.* That appends a journal entry whose
`original` is the previous mutant, so `finalize` correctly re-plants an
intermediate mutant; repeated passes walk it backwards. The finalizer's
foreign-content abort behaved exactly as designed and never overwrote content it
had not written. The last two entries were resolved by hand with
`git checkout -- <named paths>` and marked restored.

## Rejected findings

One, from the adversarial axis rather than red team, recorded here because the PR
must list it: **no latch or cap on `captureLedgerWriteFault`**. Owner decision,
2026-09-04. Full reasoning in
`docs/reviews/fix-1083-ledger-attribution/adversarial-approach.md`.
