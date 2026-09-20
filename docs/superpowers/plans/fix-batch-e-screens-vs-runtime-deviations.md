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

**Verdict:** PENDING

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

**Verdict:** PENDING

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

**Verdict:** PENDING

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

**Verdict:** PENDING
