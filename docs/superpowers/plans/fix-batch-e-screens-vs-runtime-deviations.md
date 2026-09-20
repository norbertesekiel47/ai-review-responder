# Deviations — fix/batch-e-screens-vs-runtime

Entries the plan did not anticipate. Each carries a **Verdict:** line, resolved
at step 6 before the review wave. ACCEPT = the adaptation is sound.
RE-PLAN = it invalidates a locked decision.

---

## D1 — The ladder in the main checkout carried stale Batch A state

`progress.mjs init` did not reset `.feature/progress.json`; it kept Batch A's
`intake: done` note ("batch A: #1107 #1108 #1199 implement, #1305 verify+close")
and left the run reading 31% complete before this feature had started. Batch A
merged in #1345/#1347, so the state was dead. Backed the file up to the
scratchpad, removed it, and re-ran `init`, which then produced a clean ladder.

**Verdict:** ACCEPT — the reset was correct and lost nothing. Durable lesson for
step 8: `progress.mjs init` is not idempotent against a completed prior run.

---

## D2 — `progress.mjs init` rejects the classification vocabulary `/feature` uses

`/feature` step 0 names sizes `trivial | small | feature | epic` and surfaces
`ui | backend | full-stack`. `progress.mjs init` accepts
`trivial|small|standard|epic` and `ui|backend|mixed`. Two failed invocations
before the mapping was clear: `feature` → `standard`, `full-stack` → `mixed`.

**Verdict:** ACCEPT — mapped and proceeded; the axes mean the same thing.
Durable lesson for step 8: the command doc and the script disagree on two
vocabularies.

---

## D3 — `codex exec resume` does not accept `--sandbox`

`.agents/skills/feature/references/review-prompts.md` gives the verification
round as `codex exec resume <session-id> "<delta>"`. Carrying round 1's
`--sandbox read-only` across to the resume fails:

```
error: unexpected argument '--sandbox' found
Usage: codex exec resume --model <MODEL> <SESSION_ID> [PROMPT]
```

`codex exec resume` takes `-c 'sandbox_mode="read-only"'` instead. The wrapper
exits 0 while codex itself errored, so the failure is silent unless the output
file is checked — it was zero bytes. Round 2 was re-dispatched with the correct
flag. `codex-cli 0.153.2`.

**Verdict:** ACCEPT — a flag correction, no plan impact. Durable lesson for
step 8: record the flag difference, and always check the resume's output size
before reading a verdict from it.

---

## D4 — The Codex stop-gate hook demands gate evidence from a read-only plan review

Round 1's session was told to write nothing and implement nothing. On finishing,
`.codex/hooks/stop-gate.sh:28` demanded a green `.feature/gate-status.json`
because `.feature/intake.json` exists. The hook does not distinguish a read-only
plan review from completed implementation. The session correctly refused to run
`verified-gate.sh` (which writes logs, gate status and a fingerprint, and can
advance workflow phase) and returned its verdict anyway, so no evidence was
forged and no phase moved.

**Verdict:** ACCEPT — the reviewer's refusal was the right call and the round
completed. Durable lesson for step 8: a read-only reviewer session inside an
armed worktree trips the stop gate; brief it to ignore the demand, as round 2's
brief now does.

---

## D5 — Nine of T1's 31 titles are absence pins that cannot start RED

T1's TDD contract says every test must first fail because the behavior is
missing. Nine titles assert an **absence** or a **composition of already-tested
behavior**, so a correct implementation satisfies them the moment the slice they
belong to lands — there is no state of the code in which they fail for the right
reason without first writing a defect on purpose:

- builder: `reports every applicable reason together, not just the first`,
  `reports no reason and blocked false when every structural gate passes`,
  `does not report a reason for an autopilot tier whose sale is paused`
- loader: `…returns posting.blocked false for an autopilot account with the
  runtime on`, `…leaves readiness.blockReasons unchanged by the posting fact`,
  `…returns posting.blocked false and readiness.blockReasons containing
  autopilot_unavailable…` (the trap test), `…reports tier and publisher
  subscription blocks when the account row is missing`
- headline: `headline still claims automatic posting for an autopilot tier whose
  sale is paused`, `suspended headline wins over a posting block`, `headline
  remains on when posting is unblocked but readiness blocks expansion…`

Each was instead verified by **mutation**: the guarded wiring was broken, the
suite re-run, and exactly the expected titles observed failing, then reverted.
The mutations run, all caught: builder — first-reason-only, always-blocked,
inverted tier test. Loader — `tierGrantsAutopilot(tier) && autopilotPurchasable()`
(the trap, caught only by the trap test), `workerType: 'generator'`, missing
account row treated as allowed, judge slot hard-coded false, judge slot wired to
`autoApprovalRuntimeEnabled()`. Headline — branch keyed on
`!readiness.canExpand`, blocked branch moved above suspension, `canTurnOff`
forced false.

Every other title was driven RED first in the ordinary way. Two production edits
were deliberately backed out mid-tracer (the loader's five inputs, and the
headline branch) after being written ahead of their tests, and re-driven one
input / one behavior at a time.

**Verdict:** ACCEPT. The nine titles are genuinely absence or composition pins:
a test referencing `data.posting` cannot even be written before the type exists,
so it would ERROR rather than FAIL, which the TDD rule explicitly forbids as a
RED. Mutation is the correct substitute, and the mutation list is the right set
— it includes the trap. **Independently re-verified by the orchestrator**, not
taken on trust: `tierGrantsAutopilot(tier) && autopilotPurchasable()` was
re-applied and caught by the trap test by name (2 failed / 91 passed), and
`judgeEnabled: autoApprovalRuntimeEnabled()` was caught by the judge loader test
by name. Tree restored to 93/93 after each. Durable lesson for step 8: an
absence pin on a NEW response field can never start RED; plan it as a mutation
obligation from the outset rather than discovering it mid-tracer.

---

## D6 — `enableReadiness()` in the settings suite now also sets `JUDGE_ENABLED`

`judgeEnabled()` is a Posting-block input, not a readiness one, but
`src/lib/auto-approval/__tests__/settings.test.ts`'s shared `enableReadiness()`
helper is the suite's single "every structural flag on" setup and every
`beforeEach` calls it. Setting `JUDGE_ENABLED=true` anywhere else would leak
across tests, because the helper is also what resets the other four flags. The
helper keeps its name (renaming it would touch four unrelated `describe`
blocks) and carries a comment saying the judge flag is not a readiness input.
The plan named the fixture amendment in `context.test.ts` as "surface amendment
1 of 1" and did not anticipate this one; it is test-only and adds no surface.

**Verdict:** ACCEPT. Test-only, no surface change, and the helper is the suite's
single "every structural flag on" setup — setting the judge flag anywhere else
would leak across tests. Verified that it does not neuter the new coverage: the
judge loader test sets `JUDGE_ENABLED` false explicitly after the helper runs,
and the orchestrator's independent judge-slot mutation was caught by that test,
which proves it still discriminates.

---

## D7 — Two of T3's titles pin `readFlag` semantics and cannot start RED

`boot flag summary reports false for a flag set to a value other than true` and
`boot flag summary reports true only for the literal string true` both pin the
`=== 'true'` comparison, which lives in `readFlag`
(`src/lib/config/flags.ts:21`) — a file outside this tracer's edit lease and one
the plan forbids touching (every value must come from a feature's existing
`flags.ts` accessor). With the accessors wired, both titles are green on
arrival; no code this tracer is allowed to write could make them RED.

Verified instead by **mutation inside `worker/boot-flag-summary.ts`**: the
`TRIAGE_ENABLED` slot was temporarily changed from `triageEnabled()` to
`Boolean(process.env.TRIAGE_ENABLED)` (a truthy read rather than a literal-`true`
compare). Exactly those two titles failed; the other four builder titles stayed
green. The mutation was reverted immediately and none remains in the tree.

The other seven T3 titles were driven RED first in the ordinary way. One
production edit was deliberately backed out mid-tracer: the eleven-key mapping
was written ahead of
`boot flag summary maps each key to its own accessor when exactly one flag at a time is true`,
so the builder was rewound to the simplest form that passed the three key-list
titles (every key assigned one accessor) until that title was observed failing,
then re-implemented.

**Verdict:** ACCEPT. The two titles pin `readFlag`'s `=== 'true'` semantics,
which lives in `src/lib/config/flags.ts` — outside T3's lease, and correctly so;
widening the lease to force a RED would have been the worse choice. Mutating the
TRIAGE slot inside its own module to `Boolean(process.env.TRIAGE_ENABLED)` is
the right local substitute, and exactly those two titles failed. Escalating
instead of quietly editing another tracer's file was the correct instinct.

---

## D8 — Four of T2's 13 titles could not start RED and were verified by mutation

T2's TDD contract says every title must first fail because the behavior is
missing. Four assert an **absence**, or pin a property that today's catalogue
already satisfies for the wrong reason, so no honest defect-free state of the
code fails them:

| Title | Why it cannot start RED | Mutation run | Result |
|---|---|---|---|
| `tierChangeDirection follows autonomy order when catalogue prices are equal or reversed` | The function is new; once it exists at all, an index-based body satisfies it | `tierChangeDirection` re-implemented over `TIER_CONFIG[...].baseByVariant.list` | exactly that title failed (22 others green); reverted |
| `billing card labels the copilot option Downgrade for an autopilot account` | Today's catalogue order agrees with autonomy order, so the pre-change price comparison already produces "Downgrade" | card `action` forced to `'Upgrade'` | that title failed, plus the two price-independence card titles as expected; reverted |
| `billing card labels the autopilot option Upgrade for a copilot account` | Same — the pre-change comparison already produces "Upgrade" | card `action` forced to `'Downgrade'` | that title failed, plus five label-dependent titles as expected; reverted |
| `tier change modal omits the autonomy warning when moving to autopilot` | Pins an absence; before the warning exists nothing can show it | warning rendered unconditionally (`{true && …}`) | exactly that title failed (22 others green); reverted |

No mutation was left in the tree; the suites are green at both revert points.

Every other T2 title was driven RED in the ordinary way. Two production edits
were deliberately backed out mid-tracer after being written ahead of their
tests, and re-driven from the test:

1. `selectedDirection` (the modal's own comparison) was rewritten from
   `tierChangeDirection` in the same edit as the card fix. It was reverted to a
   price comparison, the three modal titles were then observed failing, and the
   fix re-applied.
2. The autonomy warning was first written ungated on `trialing`. It was
   re-gated to `!trialing && isDowngrade` so that
   `trialing autopilot to copilot modal preserves trial billing copy and warns
   that replies stop posting on their own` could fail for the right reason,
   then the gate was removed again (invariant #11: a `trialing` account has
   real autonomy to lose).

One assertion was corrected while RED, not to make a test pass: the modal title
was queried with `getByText('Downgrade plan')`, but `SettingsModal` exposes its
`title` as the dialog's `aria-label`. The query became
`findByRole('dialog', { name: 'Downgrade plan' })`; the two titles were
re-confirmed RED against the price-based body with the corrected query before
the fix was restored.

**Verdict:** ACCEPT. All four are honest absence or already-satisfied pins, and
the reasoning for the two card-label titles is the important one: today's
catalogue order happens to agree with autonomy order, which is precisely why the
plan gate demanded the equal-and-reversed price tests. **Independently
re-verified by the orchestrator** with a stronger mutation than the one recorded
here — the card's direction was re-implemented as a live catalogue-price
comparison, the exact implementation skeptic round 1 predicted would pass
everything. It was caught by `billing cards retain upgrade and downgrade labels
when both catalogue prices are equal`, and by that title alone (1 failed / 22
passed). Without round 1, #1054 would have shipped looking fixed.

Both mid-tracer back-outs were the right call, and the second is the better one:
writing the warning ungated, re-gating it so the trialing title could fail for
the right reason, then removing the gate again, is TDD used to interrogate a
decision rather than to satisfy a checklist. The `aria-label` query correction
was made while RED and re-confirmed RED before the fix landed, so it did not
weaken the assertion.

---

## D9 — The gate the command names does not write the fingerprint the Stop hook requires

`/feature` steps 5 and 7.5 both say to run `scripts/verify-gate.sh --review`.
That script runs every row and writes `.feature/gate-status.json`, but it does
NOT write `.feature/codex-gate-fingerprint.json`. The Stop hook requires a
matching fingerprint from `gate-fingerprint.mjs check`, so a branch can be
34/34 green and still be refused:

```
gate fingerprint failed: missing .feature/codex-gate-fingerprint.json;
  run verified-gate.sh
```

The wrapper `.agents/skills/feature/scripts/verified-gate.sh` is the one that
produces evidence: it delegates to `scripts/verify-gate.sh`, then runs
`gate-fingerprint.mjs write` followed by `check`. It deliberately does NOT
fingerprint `--baseline`, `--fast` or `--status`, because none of those is
evidence. `gate-summary.sh`'s own failure banner names the wrapper correctly;
the command text does not.

Cost here: one full gate re-run (~2 min) that a correct first invocation would
have avoided.

**Verdict:** ACCEPT — use the wrapper for any gate meant as evidence. Durable
lesson for step 8: the `/feature` command text should name
`.agents/skills/feature/scripts/verified-gate.sh --review` at steps 5 and 7.5,
as `gate-summary.sh` already does.

---

## D10 — `gate-status.json` records `mode: "full"` for a review-mode run

`bash scripts/verify-gate.sh --review` writes `"mode":"full"` into
`.feature/gate-status.json`. The run really was review mode: the review-only
`diff-coverage` row is present and PASS, and `verify-gate.sh --status` reported
`mode review` while it was still running. So the label is wrong, not the run.

Consequence is reporting only — a reader of `gate-status.json` cannot tell a
review gate from a full one, and `--status` after the fact repeats the wrong
label. No check is skipped.

**Verdict:** ACCEPT — no impact on this branch's evidence; `diff-coverage`'s
presence is the reliable signal that review mode ran. Durable lesson for step 8:
this is the same discrepancy a prior session raised during Batch A; it is worth
a ticket rather than a third rediscovery.

---

## D11 — Four surface amendments, all one class: workflow-mandated artifacts the intake under-declared

None of the four was feature scope. Every one was a file some gate or rule
requires for a change of this shape, and every one was discovered by a gate
failing rather than by planning:

| # | File | Forced by | Discoverable up front? |
|---|---|---|---|
| 1 | `src/lib/agents/operator/__tests__/context.test.ts` | typecheck | Yes — the plan skeptic predicted it in round 1 and the intake still missed it |
| 2 | `.claude/reference/arch-review-log.md` | `ci:merge-ledger` | Yes — `/feature` step 8 mandates this file for any production diff |
| 3 | `src/app/onboarding/pay/plan-options.ts` | red team RT-2 | No — a genuine review finding |
| 4 | `.agents/skills/flag-flip/SKILL.md` | `ci:agent-config` | Yes — skills are parity-checked in pairs |

Three of the four were mechanically predictable. The abort criteria treat a
second amendment as a restart trigger, which fires on exactly this pattern and
would have torn down a branch whose problem was an incomplete checklist, not a
misunderstood design. The owner waived it twice on that reasoning.

**Verdict:** ACCEPT. Durable lesson for step 8, and the useful one from this
run: an intake for a branch that touches any production file under `src/` or
`worker/` should declare `.claude/reference/arch-review-log.md` from the start,
and any intake touching `.claude/skills/<name>/SKILL.md` should declare
`.agents/skills/<name>/SKILL.md` in the same entry. Both are derivable from the
diff's shape before a line is written. Worth a line in the intake contract
rather than four amendments per run.

---

## D12 — The scoped red-team round 2 found two P0s that round 1's fixes created

Round 1 found no P0. Round 2, scoped to `825f0fbbf..9a7a459f9` — the fix hunks
alone — found two, and both were introduced by the round-1 triage:

- A documentation procedure (`flag-flip` step 5b) that named four log fields the
  logger does not emit, so the verification step written to close RT-7 could
  never succeed.
- A de-duplication filter that keyed on a second predicate for "is the blocked
  banner rendering?", emptying the readiness list in the gap and rendering an
  affirmative capability claim while the server said the capability was absent.

Both were cheap to fix and neither existed before the review. The pattern is
that **fixes applied under review pressure, to a branch already declared green,
get less scrutiny than the original code** — the original had TDD, a plan gate
and three axes; the fixes had none of that until round 2.

**Verdict:** ACCEPT. Durable lesson: the `/feature` rule that round 2 "is not
optional" is load-bearing and should not be traded away for wall clock. On this
branch it was the only thing standing between a false capability claim and
`main`. Note also that the second P0's root cause was two predicates for one question.
**The round-2 fix removed one of them and I claimed that removed the class. It
did not** — round 3 found the affirmative still rendering beside a blocked
banner, and found that the test I had cited as proof never reached the blocked
branch. The class was only removed when `ReadinessBlock` was keyed on the
server's `canExpand` instead of on an incidentally empty list. **Recorded as a
lesson in its own right: "removes the class" is a claim about every path, and
I asserted it twice from a green suite that exercised one.**

---

## D13 — The production bucket finished at 2.13× estimate, tripping the re-classification trigger

Measured at the final gate: **prod 512 against an estimate of 240 (2.13×)**;
test 1028 against 580 (1.77×, under). The `reclassify` row warned; the gate
still passed, because the row is a WARN.

Step 0 re-run with the real numbers, as the trigger requires:

- **size** — still `standard`. The honest `allowed_edit_surface` is still
  declarable file by file (30 entries, no globs), it still decomposes into the
  same three tracers, and no investigation question is open. Nothing about 512
  lines makes it an epic.
- **risk** — still `high`. Unchanged triggers: `worker/`, the auto-approval
  surface, the billing screen.
- **surface** — still `mixed`.

**The lane does not change.** That is the point of re-running rather than
assuming: the trigger exists to catch a feature that was mis-sized into too
light a lane, and this one was already in the heaviest lane available.

Where the overage came from, since "we underestimated" would be the wrong
lesson: the three tracers landed close to estimate. The growth is review work —
two Codex plan rounds took the test contract from 30 titles to 54, the round-1
wave produced ten fixes across four axes, and round 2 produced two P0 fixes plus
five more. A `posting-status.ts` of 50 lines did not become 512; the branch
acquired a second and third pass of corrections, each with its own tests.

**Verdict:** ACCEPT. Durable lesson for step 8: `estimated_prod_lines` is an
estimate of the IMPLEMENTATION, and on a high-risk branch the review rounds are
a comparable second cost that the estimate does not model at all. Either
estimate the review's fixes as their own bucket, or read the 2× trigger as
"re-confirm the lane", not "the plan was wrong" — on this branch it was the
latter, and re-running step 0 cost one paragraph.

---

## D14 — A verification subagent hung for 4.5 hours; doing the check inline took two minutes

The independent pass over the round-3 fixes was dispatched as a subagent. It ran
the suite (63/63), reported it was about to instrument the test cases, and then
wrote nothing for **16,129 seconds**. 165 bytes of output total. No error, no
completion notification — from the orchestrator's side it was indistinguishable
from a long review, which is exactly why it cost so much: a hung agent and a
thorough one look the same until someone checks the output file's mtime.

Killed with `TaskStop`. The kill result surfaced its last state, which is how we
know where it stalled.

The check it was asked to perform — "does each test case actually reach
`tone === 'blocked'`?" — took **two minutes inline**: install a probe writing
`status.tone` to a scratch file, run the one test, read the counts
(`blocked` ×2, `off`, `suspended`, all `canExpand=false`), remove the probe.
That is stronger evidence than a subagent's prose assertion would have been,
and it is reproducible.

**Verdict:** ACCEPT. Two durable lessons for step 8:

1. **Check a long-running subagent's output mtime before waiting on it.**
   `ls -la <output-file>` costs nothing. Anything over a few minutes with a
   static size is hung, not thinking.
2. **A question with a mechanical answer should not be delegated.** "Does this
   test reach this branch?" is answerable with a probe and a `uniq -c`, not with
   a reviewer's judgement. Delegation is for questions that need judgement —
   the three review axes and the red-team rounds earned their cost precisely
   because their findings were judgements I could not have reached alone. This
   one was a measurement.
