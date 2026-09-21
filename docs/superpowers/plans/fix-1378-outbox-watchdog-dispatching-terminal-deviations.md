# Deviations — fix/1378-outbox-watchdog-dispatching-terminal

## D1 — surface amendment #1: `OutboxPoller.operator.integration.test.ts`

**What the plan assumed.** The intake declared three files. It assumed the
only live-DB coverage of the terminalizer's `dispatching` branch lived in
`OutboxPoller.watchdog.integration.test.ts`.

**What was actually there.** `OutboxPoller.operator.integration.test.ts:161-178`
(`watchdog recovery of exhausted dispatching Operator work preserves live
claims and other topics`) seeds an `otherTopic` fixture — an Operator turn
whose `job_outbox` row is relabelled `generate_response`, aged 3 minutes, at
`attempts = max_attempts` — and asserts `outbox_status: 'dispatching'`. That
assertion **is** #1378 written down as expected behavior, so the fix turns it
red by construction.

**What changed.** The fixture's expected `outbox_status` moves
`'dispatching'` → `'failed'` with a non-null `outbox_completed`. The other
half of the same assertion, `turn_status: 'accepted'`, is UNCHANGED and is the
invariant the case actually exists to protect: a non-`agent_turn` row is
terminalized by the widened arm but must never reach
`reconcileTurnForFailedOutbox`. The guard that holds that line is that
function's OWN re-select, `AND topic = AGENT_TURN` at `turns.ts:58`, which
returns `'unchanged'` for anything else. An earlier draft of this entry named
the `array_agg(...) FILTER` at `OutboxPoller.ts:176` instead; that was wrong,
and the FILTER is only a redundant pre-filter — see D6.
The case therefore keeps its meaning and gains precision — it now pins the
topic-scoping of the RECONCILIATION rather than of the TERMINALIZATION. The
fixture's age also moved from 3 to 20 minutes when the terminal arm took its
own 15-minute window (D5).

**Amendment class.** One file, inside
`worker/background/pollers/__tests__/` — a tree `allowed_edit_surface`
already covers. Auto-approved under step 2's ≤2-file rule. Counted:
`surfaceAmendments=1`.

**Verdict:** ACCEPT

## D5 — review round 1 reversed a signed-off intake decision (the 2-min window)

**Status: RESOLVED by owner decision.**

The spec-correctness and red-team axes independently found the same defect:
the terminal arm's 2-minute window is smaller than the dispatch path's own
worst case. `dispatchBatch` walks topic groups SERIALLY with `markDispatched`
per group, so the claim→dispatched gap is bounded only by
(topics × `OUTBOX_DISPATCH_TIMEOUT_MS`) ≈ 6 min, while the 60 s overlap guard
lets a superseding cycle's watchdog run against that live batch. At 2 minutes
the widened arm terminalizes work still in flight; the row then falls out of
every `status IN ('pending','dispatching','dispatched')` dedup guard, which
for `publish_response` means a reply can post to Google twice.

**Why the original sign-off was wrong, and whose fault that is.** The intake
argued 2 minutes was safe because `agent_turn` already used it. That premise
was incomplete and it was the load-bearing half of the recommendation put to
the owner: `agent_turn` tolerates the narrow window because it alone has a
rollback valve — `reconcileTurnForFailedOutbox` returning `'deferred'` rolls
the row back to `dispatched`. Widening the arm gave ~30 topics the terminal
write with no valve. The orchestrator surfaced the correction rather than
patching around it, and the owner reversed the decision.

**Resolution.** The terminal arm now uses `watchdogStaleSecs` (15 min);
arm 3's re-pend stays at 2 minutes. Pinned by
`leaves a dispatching row at max_attempts alone in the gap between the two
windows`, mutation-verified: collapsing the terminal arm back to 2 minutes
turns that case red and NOTHING else. Operator recovery latency moves from
2 to 15 minutes, which is a real behavior change the owner accepted.

**Verdict:** ACCEPT

## D6 — the intake and the first draft named the WRONG reconciliation guard

Red-team P1. The code comment, the **Watchdog** glossary entry and D1 all
claimed the `array_agg(id) FILTER (WHERE topic = AGENT_TURN)` is what keeps
`reconcileTurnForFailedOutbox` Operator-only. It is not. Red-team deleted the
FILTER and all 19 cases stayed green. The real boundary is that function's own
re-select — `AND topic = AGENT_TURN` at `turns.ts:58` — which returns
`'unchanged'` for any other topic. The FILTER is a redundant pre-filter that
saves a round trip per non-Operator row.

The claim was stated in three places and verified in none. All three are
corrected to name `turns.ts:58` and to describe the FILTER as redundant.
The FILTER is KEPT (it is a real optimization) but is no longer described as
a safety boundary.

**Verdict:** ACCEPT

## D7 — the alerting half was folded in after the observability claim proved wrong

Red-team P1. The intake's acknowledgement of the alerting gap was accurate but
incomplete: it omitted that terminalizing an orphan REMOVES the
`outbox_stale_dispatching` error those rows raised, and that a
watchdog-terminated row fires no BullMQ `'failed'` event, so the Job-failure
sink never covers it either. For ~30 topics the change as first written traded
a misleading alert for silence — a net observability regression. It also named
a symbol that does not exist (`checkFailedOutboxJobs`; the real name is
`checkFailedOutboxByTopic`), a wrong name that reached the intake, the PR body
and the owner conversation.

The owner reversed the earlier "separate issue" decision. `checkFailedOutboxByTopic`'s
seven-topic allowlist is now OPEN — the `topic IN (...)` clause is removed, and
`failedThreshold` still applies per topic, so the bar for the original seven is
unchanged. The file's own comment already named the closed list as the trap
(`generate_solicitation_asks` shipped invisible, #628 round 5).

**Weakened-check accounting.** Four tests asserted allowlist MEMBERSHIP via
bound values. Those assertions are removed, not silently: they are replaced by
`covers every topic — the query binds no topic allowlist`, which asserts the
SQL contains no `topic IN` and binds NO `QUEUE_NAMES` value at all — strictly
stronger than "these seven are present", and it also catches an allowlist
reintroduced under a different spelling. Each of the four behavioral halves is
untouched, and a new case pins a topic the old list never covered.

**Verdict:** ACCEPT

## D3 — `reclassify` WARN: production diff far over an estimate of 6

**The trigger.** The gate's re-classification trigger fires at 2× a bucket's
estimate. `estimated_prod_lines` was 6. It measured 16 at review round 1 and
61 after the round-1 fixes (the 15-min window, its comment, and the alerting
half folded in per D5/D7). The WARN fired at the first number and stands at
the second.

**Re-run of step 0 with the real numbers.** SIZE stays `small`, RISK stays
`high`, SURFACE stays `backend`. The behavioral change is still tiny: three
lines of predicate in `OutboxPoller.ts` (the topic filter removed, the window
switched to `watchdogStaleSecs`) plus the `topic IN (...)` clause deleted from
`checks.ts` (numstat `12+ 11-`, its comment included). Everything else is
comment explaining two reversed decisions. No new module, seam, interface or control-flow
branch exists that did not exist at lock time, so no axis moves and the lane is
unchanged.

**What the miss actually says.** The estimate counted the predicate and forgot
that a topic-scoping decision reversed by a later issue needs its reasoning
written down next to it. The first draft of that comment was 15 lines and
duplicated the glossary; it was cut to 7 and now points at
`docs/context/core-platform-runtime.md` as the single owner. The estimate is
deliberately NOT amended after the fact — the WARN is left standing as the
record of the miss.

**Verdict:** ACCEPT

## D4 — `build` gate row fails in EVERY worktree; CI is the authoritative verdict

**Status: RESOLVED — cause established, and CI settled the verdict.**

`pnpm build` fails cold in this worktree with `Cannot find module
'@vercel/turbopack/postcss'`, repeated across 567 Turbopack errors, all in
landing-page components (`HeroSection`, `PersonasSection`, `PageShell`,
`CtaSection`, `MfaChallengeForm`).

**Why it is not this change.** The diff touches `worker/background/pollers/`
and `docs/` only. Next does not compile `worker/` into the application bundle,
and no named failing component imports anything on the edit surface.

**What was ruled out.** Stale `.next` cache (deleted; failure reproduced cold).
Missing dependency (`@tailwindcss/postcss`, `tailwindcss`, `postcss` all
present). Divergent `next` install (both checkouts symlink the identical pnpm
hash for `next@16.3.0`).

**Cause, established.** `pnpm build` fails in EVERY git worktree and succeeds
only in a real checkout. Measured by `.next/BUILD_ID`, the marker a successful
Next build writes:

| checkout | BUILD_ID | verdict |
|---|---|---|
| parent `main` (real clone) | present | succeeded COLD in 8.5s |
| `fix-1361-locations-route-fault-status` | absent | failed |
| `fix-1363-drip-alert-email-idempotency` | absent | failed |
| `fix-1378-…` (this branch) | absent | failed |

Two of the failing worktrees carry unrelated branches, so the defect is
independent of this change. The earlier 5.1s parent "success" was a WARM
1.9 GB cache and was discarded as invalid; the owner authorized deleting it,
and the cold rebuild then succeeded in 8.5s — which is what makes the
worktree/real-checkout split the actual variable.

**Ruled out by direct comparison against the parent checkout:** stale `.next`,
missing dependencies (`@tailwindcss/postcss`, `tailwindcss`, `postcss` all
present in both), divergent `next` install (identical pnpm hash for
`next@16.3.0`), the agent sandbox (same failure with it disabled), an
interfering `node_modules` above the worktree (none on either path), `.npmrc`
(identical), `.env.local` keys (identical). Dependency trees are
byte-identical: 48 top-level packages, 753 `.pnpm` entries, and `next/dist`
checksums to `f946256a00c828d218c96f900cb90f43` in both.

**Mechanism.** From the head of the build log, not the repeated symptom:
Turbopack spawns a Node child process for the postcss transform
(`[turbopack-node]/child_process/evaluate.ts`), and that child cannot resolve
the virtual module `@vercel/turbopack/postcss`. A Turbopack runtime failure
under a git worktree root — not a dependency or configuration fault.

**Why it does not gate this change.** The Next build compiles neither
`worker/` nor `docs/`, the only trees this diff touches. CI checks out a real
clone, so the `build` check is unaffected: it passed in 1m9s on PR #1389, the
run that produced this branch's base commit 650f625e7.

**Disposition.** Out of scope here and filed separately; it blocks a green
local gate on every parallel branch, so it is worth its own fix. The `build`
row's verdict for THIS branch is delegated to CI, on owner instruction.

**Verdict:** ACCEPT

## D2 — the glossary entry for **Watchdog** was stale before this change

**What was found.** `docs/context/core-platform-runtime.md:9` stated the
terminate arm writes `last_error` "**unconditionally**, overwriting whatever
was there", citing `OutboxPoller.ts:140-143`. #736 replaced that with
`COALESCE(NULLIF(last_error, ''), …)`, so a bounded error class now survives.
`.claude/rules/worker-layout.md` already carried the corrected statement, and
the **Job-failure sink** entry at `:11` repeats the stale claim as a premise.

**Why it is in scope.** Step 1 requires challenging the glossary term the
change touches. **Watchdog** is that term, and this run adds an arm to it.
Leaving a contradicted definition next to a freshly sharpened one is the drift
the context files exist to prevent.

**What changed.** The stale clause in both entries is corrected to the #736
behavior, and the **Watchdog** entry records the #1378 topic-blind terminal
arm. No code claim is repeated that was not re-read at this HEAD.

**Verdict:** ACCEPT
