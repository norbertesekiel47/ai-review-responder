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
`reconcileTurnForFailedOutbox`, which stays gated by the
`array_agg(...) FILTER (WHERE topic = AGENT_TURN)` at `OutboxPoller.ts:156`
(post-change; it was `:152` at the HEAD the intake was locked against).
The case therefore keeps its meaning and gains precision — it now pins the
topic-scoping of the RECONCILIATION rather than of the TERMINALIZATION.

**Amendment class.** One file, inside
`worker/background/pollers/__tests__/` — a tree `allowed_edit_surface`
already covers. Auto-approved under step 2's ≤2-file rule. Counted:
`surfaceAmendments=1`.

**Verdict:** ACCEPT

## D3 — `reclassify` WARN: 16 production lines against an estimate of 6

**The trigger.** The gate's re-classification trigger fires at 2× a bucket's
estimate. `estimated_prod_lines` was 6; the measured production diff is 16.

**Re-run of step 0 with the real numbers.** SIZE stays `small`, RISK stays
`high`, SURFACE stays `backend`. The predicate change itself is 2 lines
(`OutboxPoller.ts:158-159`, one topic filter removed). The remaining 14 are the
replacement comment above it. No new module, seam, interface or control-flow
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

## D4 — `build` gate row fails in this worktree; cause NOT established

**Status: OPEN — this is the one thing blocking a green gate.**

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
