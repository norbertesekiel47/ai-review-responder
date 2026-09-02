# Red team — `feat/1014-restraint-tab`

**Ten passes.** The skill caps the loop at two rounds. Passes three through ten ran
under an explicit owner override of that cap, recorded here rather than hidden: the
owner asked on 2026-09-01 to continue until a pass found nothing, and each pass was
opened by lowering the journal's round counter. The sidecar schema caps its `round`
field at 2, so `findings.json` records `round: 2`; this document is the authority on
how many passes actually ran. Each round's journal is preserved outside the repo.

| | |
|---|---|
| Mode | `feature` (step 7.5) |
| Risk | **high** |
| Passes | **10** (skill cap is 2; owner override recorded above) |
| Fork / merge-base | `b55b07822ef92f6c85047e6f42b5513ea8427257` |
| Head | see `findings.json` `head_sha` |
| Intake SHA-256 | `bdda96281dd7b49171f0f662540c20172c166cb402dc23066c0964c98a37c6d8` |
| **STATUS** | **`CLEAR`** |

**Counts.** 53 findings — 51 fixed, 2 rejected, **0 open**. Inventory: 173 rows —
120 killed, 37 survived-confirmed, 1 equivalent, 15 excluded, **0 skipped-budget,
0 inconclusive**.

**On severities.** Twenty-eight findings are recorded P0 because the skill's rule is
mechanical: a confirmed survivor — a mutation that a green suite failed to kill, with
the arbiter's reasoning that it is neither equivalent nor on an unexecuted branch — is
a P0. Several of those passes graded the same finding P1 or P2 on judgement, and every
one of those recommendations is preserved verbatim in the finding's
`arbiter_reasoning`. Nothing is downgraded silently: the mechanical grade governs the
record, the human grade is kept beside it, and since all 28 are `fixed` the
distinction changes no gate outcome.

## What the ten passes actually found

| Pass | Open P0 at the end | New findings | Runs |
|---|---|---|---|
| 2 | 7 | F1–F12 re-verified, F13–F25 raised | 30/30 |
| 3 | 4 | F26–F33 | 21/30 |
| 4 | 3 | F34–F38 | 10/30 |
| 5 | 0 | F39–F42 | 10/30 |
| 6 | 0 | F43–F45 | 12/30 |
| 7 | 0 | F46–F49 | 13/30 |
| 8 | 0 | F50–F51 | 11/30 |
| 9 | 0 | F52 | 8/30 |
| 10 | 0 | F53 (a comment) | 13/30 |

Round 2 found real defects in the shipped code. Everything from round 3 onward found
defects in the **previous round's own fixes** — which is the result worth stating
plainly, because it is not what anyone predicted at the outset.

### The two things that kept recurring

**1. A test that asserts the wrong statement.** F3 is the archetype: the case written
to pin the account entry arm's lower window bound asserted `total`, and `total` comes
from a *separate* `COUNT` statement. The bound could be deleted with the test green.
The same blind spot had three more instances (F14, F15, F16) — four of the five lower
bounds in `read.ts` were unasserted, while both *upper* bounds were dying only because
a future-dated row happens to sort first.

**2. A narrower assertion presented as a superset of what it replaced.** This happened
three times, all mine:

| Round | Traded away | Caught by |
|---|---|---|
| 7 | `tagName` without `textContent` | round 7 (F46) |
| 8 | direct children without descendants | round 8 (F50) |
| 3 | three source-text pins for a weaker behavioural one | round 4 (F28) |

Round 9 introduced the mechanical check that catches this class: diff the two commits
and confirm no mutant that died before survives now. It found nothing in rounds 9 and
10 — the first two passes where coverage was not traded away.

The row-redaction assertion converged only when it stopped being patched cell by cell.
F42 → F46 → F50 → F52 is one 2×2 (name/value × depth-1/descendant) closed a cell at a
time; round 9's fix collapsed it into a single whole-shape assertion, and round 10
proved subsumption **deductively** rather than by sampling: `li.children` is a
subsequence of `li.querySelectorAll('*')` against an identical literal, so a mutant the
old form killed cannot survive the new one. Round 10 also measured the sequence's only
coverage *increase*: a bare `<i />` with no attributes and no text at depth 2 survives
the previous commit's test file and dies at HEAD.

### Corrections to this branch's own commit messages

Recorded because a false claim in a commit message is exactly what this process exists
to catch, and three of mine were false:

1. *"each one the exact mutant round 3 used to raise the finding"* — true for seven of
   eight; for F33 a different mutant was substituted and the inherited one flipped.
2. *"The sweep now covers every conjunct"* — false. `isLinkKind` could lose
   `'auto-approval'` or `'contacts'` with the suite green (F40).
3. *"Every row is swept now"* — false. The sweep landed in a single-row case whose one
   row always links (F42).

A fourth was a miscount: *"all 32 guard-sweep rows"* is 28 (twelve missing-field plus
sixteen wrong-type). And on four occasions a verification probe of mine was
wrong-direction and proved nothing — replacing `isObject` rather than deleting it,
twice; a body-shape sweep that any downstream conjunct rejected anyway; and asserting
an abort after a settled query, which has nothing left to cancel.

## Red-team findings rejected

Per the rejection protocol, each carries a one-line verdict plus `file:line` evidence,
and each is listed in the PR description.

- **F12 (P2)** — *"five new production files were added with no `docs/directory.md`
  row."* **Rejected.** `docs/directory.md:16-17` states verbatim: *"`src/app/**` and
  `src/components/**` are described at folder level by design and are not audited."*
  The finding's premise contradicts that file's own rule. Independently confirmed in
  round 3 and not reopened in any later pass.

- **F31 (P2)** — *"`ARCHIVAL_EVENT_LIMIT` truncation is silent, on a surface whose
  thesis is stating what it is not showing."* **Rejected for this branch**, and the
  finding is true. Disclosing it needs a DTO field **and** a new owner-facing sentence
  on a locked-glossary surface (`CONTEXT.md` § Refusal ledger), and both surface
  amendments are spent — `.feature/state.json`, `surfaceAmendments: 2`, both entries
  logged 2026-09-01. Reaching the cap needs 200 archive/reactivate events on **one**
  location, which are operator actions rather than tenant data (`src/lib/refusals/read.ts:422`).
  Round 5 concurred with the outcome and disputed the DTO half of the cost, correctly —
  `RefusalLog` already carries `truncated`. It belongs in a follow-up ticket, opened at
  step 8 alongside the post-flip Coverage-start ticket the intake declares a non-goal.

## Authorizations

None. No finding on this branch is dispositioned `accepted-risk`; every one was fixed
or rejected on the merits.

## Duties 2–5

- **Duty 2 (fragile assertions).** Six raised and closed — F7, F21, F22, F23, F33, F37.
  Several assertions were examined and **deliberately not** raised: exact date equality
  (the formatter is pinned to `en-US`, so the strings are the contract), an exact
  distinctness count (distinctness *is* the accessibility claim), `sqlCallCount === 0`
  ("the route issues no query of its own" has one spelling), and the notes array's
  order (an order assertion there would itself be the defect).
- **Duty 3 (docs vs reality).** `prevalidate-plan.py` PASS on all three plan-family
  documents at every pass. Two false doc claims found and fixed: `docs/directory.md`'s
  statement count (F19) and a self-contradicting test comment (F20, F53). One reported
  citation failure was hand-resolved as a false positive — a citation written without
  its `src/components/` prefix.
- **Duty 4 (missed siblings).** Fifteen searches across the passes; the exact patterns,
  scopes and exclusions are recorded per pass. Most returned zero. Those that did not
  produced F13, F18, F24 and F51.
- **Duty 5 (operational completeness).** No finding, and the search establishing it is
  recorded: every failure path the diff adds was enumerated, compared against all six
  facets of every rule in `docs/runbooks/beta-launch-alerting.md`, and neither an
  emitting signal without a rule row nor a rule row without a signal was found. The
  alerting model does not page on dashboard-read 500s, by design.

## Evidence

`findings.json` is the machine-readable authority; the checker recomputes counts and
status from it. Per-pass notes, inventories and arbiter reasoning are preserved outside
the repository — they are working evidence, not deliverables, and they contain the full
per-mutation detail behind every row summarised here.
