# Red team — round 2 (SCOPED) — `feat/1011-refusal-outreach-render`

| | |
|---|---|
| Mode | feature · **round 2 of 2 (the cap — no round follows)** |
| Risk | high (from the intake) |
| Fork / merge-base | `06a163f0b4b102c88687c95862999e38a1c3f517` |
| Head examined | `bd83caf22b91a3347fcc6b346c737f18a8d1c92f` (pre-rebase; equivalent to `063858da`) |
| Head pinned | `d0ba72fb3b0d33f4ccb688baad62168612604499` — see § Round-2 closure |
| Round 1 head | `535e0763ac6c3361db3caf08a965e7567854f350` |
| Intake SHA-256 | `21d5549cc4520cf184f12ebc3385a50db02c6bf90a3dcad47818c0aa2176e633` |
| **Status** | **`CLEAR`** — F1 fixed in `d0ba72fb`; the two P2s accepted as recorded |

Round 2 exists because round 1's P0 was fixed, which moved HEAD and staled that
sidecar by construction. Scope was the fix hunks and their direct callers:
`git diff 535e0763..bd83caf2`. This file **replaces** round 1's report at the
same derived slug; round 1's text is preserved in git at `bd83caf2`.

**The round-1 P0 is closed.** Both mutations that survived round 1 now die.

## Run conditions — one precondition satisfied in substance, not by the tool

Precondition 2 (`mutation-runner.mjs watchers`) **aborted**, naming four
processes. All four were resolved by `lsof -p <pid> -d cwd`: PIDs 68547 / 69387 /
69738 are rooted at `/Users/norbertesekiel/Developer/startups/RepWorth` (the
parent checkout) and PID 76253 at
`…/RepWorth-worktrees/refactor-globals-css-extraction` (a different sibling
worktree). None has this worktree in its root, so none can hot-reload a mutation
placed here — the check reads a machine-wide `ps` and is not worktree-scoped.
Round 1 recorded the same false positive. Noted rather than waived silently.

Preconditions 1 and 3 passed: clean tracked tree at a committed SHA, and
`round-start` opened round 2 over a closed journal.

Environment was the allowlist (`env` + `dotenv-swap`) against the private test
database `test_1011` on localhost. Budget: **12 of 30 runs**.

## 1. The two new titles are real — round 1's exact mutations both die

Re-planted from round 1's own mutant files, not re-derived:

| Mutation | Target | Result | Margin past bound |
|---|---|---|---|
| `regenerateAsk` `decidedAt` moved below `acquireSolicitationBatchLock` (`:1543`→`:1554`) | new regeneration title | **killed** | 303 ms |
| `settleGenerationExhaustion` `decidedAt` moved below the lock (`:1752`→`:1764`) | new exhaustion title | **killed** | 304 ms |

Each run was `assert-one-test`-verified as exactly one executed test. Baselines
green first; the full file is **21/21 green** at clean HEAD, which reproduces
D0's claim exactly.

## 2. The midpoint bound — sound in one direction, one-sided in the other

Two separate questions hide in "is the midpoint bound sound in both directions".

**As a flakiness margin it is sound and balanced.** Bound is
`lockHeldAt + 300`; the correct design stamps at `lockHeldAt + 0…3 ms`
(≈297 ms of pass margin) and the rejected design cannot stamp before
`lockHeldAt + 600` (≈300 ms of kill margin). Both new titles were re-run under
**24 CPU spinners on 12 cores** and passed (733 ms / 710 ms). Not flaky.

**As a semantic bound it is strictly one-sided — F2.** Moving `regenerateAsk`'s
clock read to function entry, *ahead of the entire LLM round trip*, **survives**.
No lower bound on `rendered_at`/`occurred_at` exists anywhere in
`src/lib/solicitation/__tests__` or `src/lib/refusals/__tests__`. Not raised as a
P0: the titles claim only "a slow lock does not move the decision time" and they
enforce that provably. The invariant's *other* half — "read immediately after the
render DECISION" — is unpinned for all four writers, and was equally unpinned at
`535e0763`.

## 3. Partial mutations — the coverage binds to the LOCK, not the transaction (F3)

Moving `settleGenerationExhaustion`'s read *inside* `sql.begin`, below the outbox
CAS but still above the lock, **survives**. So the coverage is not all-or-nothing.
Not a P0: the shift is one DB round trip against the unbounded lock wait, and the
unsafe direction stays trapped — reorder the lock above that read and the
mutation becomes §1's mutation, which dies.

## 4. `settleGenerationExhaustion`'s two holes are load-bearing — claim verified

The implementer's D0 says two holes catch a per-iteration clock read. Tested at
the point where it actually matters: hole 0 keeps the pre-transaction instant and
every *later* hole reads a fresh clock — a mutation a one-hole fixture could not
see. **Killed**, 326 ms past bound. The claim holds.

## 5. No production change rode along — confirmed

`src/lib/solicitation/ask-generation.ts` is blob `9fd9bd5161bf7c6cb735055016e32072834395e8`
at **both** `535e0763` and `bd83caf2`. `git diff 535e0763..bd83caf2 --name-only`
over `src worker supabase scripts` returns the test file and nothing else.

## 6. Docs vs reality (Duty 3)

`prevalidate-plan.py` was not used; every claim below was hand-checked against
HEAD and is stated as such.

| Claim | Verdict |
|---|---|
| `tests_to_add` grew 23 → 25 | **True** — 23 at `535e0763`, 25 at HEAD, exactly 2 added, no duplicates |
| Both new titles present verbatim in the test file | **True** — byte-for-byte, intake ↔ `it(...)` |
| "Clean HEAD 21/21 green" | **True** — reproduced, 21 passed / 0 failed |
| "~303 ms over bound" (regeneration) | **True** — measured 303 ms |
| "~302 ms over bound" (exhaustion) | **True within noise** — measured 304 ms |
| "`ask-generation.ts` is byte-identical" | **True** — identical blob OID |
| "all 23 titles stayed green" vs "21/21" vs "the other 20" | **Consistent, two denominators** — 23/25 counts the intake's `tests_to_add` across the feature; 21 and 20 count this test *file*. Not false; a reader must infer the switch. P2-worthy at most, not recorded as a finding |
| D0: end-of-hold bound is "too thin to trust on a loaded runner" | **True — and it still governs a third title.** See F1 |

## 7. Missed siblings (Duty 4) — one found

Searched, in `src` and `worker`, excluding `__tests__` for the production sweep:
`recordOutreachWithheldRefusal|writeRefusalEvent` call sites; `const decidedAt = new Date()`
declarations in `ask-generation.ts`; `holdBatchAdvisoryLock` usages; and clock reads
adjacent to `sql.begin` across `src/lib/solicitation/*.ts`.

Result: **four** writers (`:928` `settleBudgetStop`, `:1198` `generateAsksForBatch`,
`:1543` `regenerateAsk`, `:1752` `settleGenerationExhaustion`), **three** Refusal
call sites (`:822` shared by W1/W2, `:1622`, `:1841`), **three** position tests
(`:1207` W1/W2, `:1296` W3, `:1375` W4). Every writer is now position-pinned — W2
settles through `persistChildRender`, the same path W1's title covers, which the
code comment at `:818` states outright. No unpinned writer remains.

The one sibling found is **F1**: the fix upgraded two titles to the midpoint bound
and left the third — same file, same helper, same pattern — on the end-of-hold
bound that D0 had just declared untrustworthy.

## 8. Operational completeness (Duty 5) — not applicable, with reason

The diff adds no production code, no failure path, no log line and no Sentry
signal, so there is no alert-path half to compare against
`docs/runbooks/beta-launch-alerting.md`. Recorded as N/A rather than as a pass.

## Findings

### F1 — P1 — fragile assertion — `ask-generation.integration.test.ts:1251`

**Disposition:** fixed in `d0ba72fb`. See § Round-2 closure below.

**The W1/W2 position title kills its mutation by 6 ms.** The two titles the fix
added kill by 303 / 304 / 326 ms.

`holdBatchAdvisoryLock` (`:396`) calls `signalAcquired()` **inside** the
transaction callback and only then starts `setTimeout(holdMs)`, while the test
samples `lockHeldAt` after awaiting that promise. The hold therefore expires
around `signalAcquiredAt + holdMs` — at or *before* `lockHeldAt + HOLD_MS`. A
post-lock mutant stamps at `lockHeldAt + HOLD_MS − hop + commit`, and the measured
net was **6 ms** over `toBeLessThan(lockHeldAt + HOLD_MS)`.

Grow that hop past 6 ms — exactly what a loaded runner does — and the mutant lands
*under* the bound. The failure mode is a **false pass**, not a false failure: the
pass-side margin is ~595 ms, so this title will not go red spuriously, it will go
quietly blind to the branch's central regression.

Behavioural replacement, one line, already present twice in this file:
`const DECIDED_BEFORE_MS = HOLD_MS / 2` (as at `:1279` and `:1362`), asserting
against `lockHeldAt + DECIDED_BEFORE_MS`.

*Scope note for the adjudicator:* `:1251` is branch code (introduced by
`535e0763`) but sits outside the strict `535e0763..bd83caf2` fix hunk. It is
reachable only through Duty 4 and through re-resolving D0's own claim, which is
why it is filed P1-open rather than asserted as a blocker.

### F2 — P2 — one-sided discriminator — `ask-generation.integration.test.ts:1345`

See §2. Survivor recorded deliberately, not raised to P0.

**Disposition:** open — ACCEPT as recorded, no action. Arbiter verdict, deviations file D0b. The finding is true: a clock read moved EARLIER, to function entry ahead of the whole LLM round trip, is caught by nothing in the repository. It stays open rather than fixed because the unsafe direction is the trapped one — reading LATE is the regression this branch exists to prevent, and no code path produces an absurdly early read. A lower bound would pin a number nothing threatens.

### F3 — P2 — coverage boundary — `ask-generation.integration.test.ts:1414`

See §3. Survivor recorded deliberately, not raised to P0.

**Disposition:** open — ACCEPT as recorded, no action. Arbiter verdict, deviations file D0b. The finding is true: the discriminator binds to the advisory lock rather than to the transaction, so a clock read placed inside `sql.begin` but ABOVE the lock acquisition survives. It stays open because the unsafe direction stays trapped — the property that matters is “before the lock wait”, and that is exactly what is pinned.

## Authorizations

None. No finding on this run is dispositioned `accepted-risk`.

## Restoration

`src/lib/solicitation/ask-generation.ts` was restored to
`9fd9bd5161bf7c6cb735055016e32072834395e8` after **every** mutation and verified
by `git hash-object` each time; `git status --porcelain` is empty on all tracked
paths but this report's two artifacts.

**The finalizer is still REQUIRED and the orchestrator must run it.** The dotenv
swap is open — `.env.local` currently holds the scrubbed stub and the real file is
at `.env.local.red-team-backup` — and six journal entries remain `applied` (their
working blob already equals the journaled original, so `finalize` will mark them
`restored` without a write). Until `node .agents/skills/red-team/scripts/mutation-runner.mjs finalize`
runs, `red-team-status.mjs` fails and the developer `.env.local` is a stub.

### One checker line is a tooling artefact, not a stranded mutation

`red-team-status.mjs` reports *"the worktree carries 1 tracked modification(s)
outside this run's report — `M …/findings.json`"*. That is a bug in the checker,
not evidence of an unrestored file. Its `git()` helper `.trim()`s the combined
command output (`red-team-status.mjs:448`), which strips the leading space from
the **first** `git status --porcelain=v1` line only; the filter at `:709` then
mis-slices that line (`line.slice(3)`) and no artifact path can ever match it.
The second line keeps its leading space and filters correctly — which is exactly
the asymmetry observed.

Verified independently: `git status --porcelain` lists **only** this report's two
artifacts, and `src/lib/solicitation/ask-generation.ts` hashes to
`9fd9bd5161bf7c6cb735055016e32072834395e8`, its pristine blob. Out of scope to
fix here; flagged for the tooling owner.

## Round-2 closure — the dispositions and the head pin

This report was written at `bd83caf2`, the pre-rebase round-1 fix commit, and its
three findings were left `open` with no reason. The round-2 fix commit
`d0ba72fb` then landed F1's fix and the two P2 verdicts, but the sidecar was
never brought forward. `red-team-status.mjs` correctly refused the `reviewed`
transition on both counts: `OPEN_P1`, and "the tree moved since bd83caf22b91".

**F1 — fixed.** `d0ba72fb` replaces the end-of-hold bound on the W1/W2 position
title with `const DECIDED_BEFORE_MS = HOLD_MS / 2` — the same midpoint the two
titles round 1 added already used — and writes the mechanism at the assertion so
it is not "simplified" back. Verified present at HEAD at the cited line. The kill
margin moves from a measured 6 ms to roughly 300 ms.

**F2, F3 — open, ACCEPT as recorded, no action.** Verdicts above, and in the
deviations file as D0b.

`head_sha` is re-pinned to `d0ba72fb`. Between `bd83caf2` and `d0ba72fb` the only
non-report tree changes are `ask-generation.integration.test.ts` (F1's fix, +14/-4)
and the deviations file (+57, D0b). The remaining diff is `main`'s WS8 docs
arriving with the rebase.

**Residual risk, stated rather than hidden:** the two-round cap is spent, so no
red-team round verified `d0ba72fb` by mutation. F1's fix is confirmed by reading
the assertion at HEAD, not by a re-planted mutant.
