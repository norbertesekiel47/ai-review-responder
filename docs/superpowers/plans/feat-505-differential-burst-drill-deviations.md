# Deviations — feat-505-differential-burst-drill

Running notes on anything the plan/intake didn't anticipate. Full context stays
here; the orchestrator session only reads summaries.

## D0 — Enforcement-anchor adaptation (environment, step 2)

**Symptom.** This sandbox resets the shell cwd to the parent checkout
(`/Users/norbertesekiel/Developer/startups/RepWorth`) after every command, and
`$CLAUDE_PROJECT_DIR` is pinned to the parent. The `/feature` hooks are
registered as `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/<script>.sh"`, so the
Stop gate anchors on the **parent** `.feature/`, not the worktree — the CWD-PIN
rule can't be satisfied by `cd` here.

**Two landmines found + cleared.**
1. `.feature/intake.json` + `.feature/sessions` are **git-tracked on `main`**
   (intentional audit trail per `.gitignore`), so both the parent checkout and
   this worktree carried #506's **stale** intake. Overwrote the worktree copy
   with this run's intake and committed it as the branch's first commit
   (`1b5dee9a`).
2. The parent had a **stale `.feature/gate-status.json` (`passed:true`,
   ts 1784444201)** left over from #506, which is *newer* than parent `main`
   HEAD (ts 1784444108). A Stop hook firing from the parent would have read it
   as green+fresh → **exit 0 = falsely-allowed completion**. Deleted it (plus
   stale `.feature/logs/`).

**Adaptation (Option F — symlink bridge).** Kept the sibling worktree for all
edits + trustworthy local CI (parent stays on `main`, undisturbed — avoids
switching the user's primary checkout off `main`, which ~15 other sibling
worktrees depend on). Bridged the Stop gate to the worktree:
- Left the parent `.feature/intake.json` in place — its **existence** puts the
  parent in feature-mode; the stop-gate reads only `gate-status.json` for
  pass/fail (intake content is irrelevant to it), and the edit-surface guard
  re-anchors on each edited file's own repo root (the worktree) so it uses
  *this* run's `allowed_edit_surface`.
- Symlinked parent `.feature/gate-status.json` → worktree
  `.feature/gate-status.json` (gitignored both sides). `scripts/verify-gate.sh`
  runs in the worktree and writes the worktree gate-status; the parent-anchored
  Stop hook reads it through the symlink. Freshness holds in both cwd cases
  (parent HEAD is frozen `main`; worktree HEAD advances with commits).

**ARM CHECK (from the parent anchor) — PASS.** edit-surface-guard: out-of-surface
worktree probe → exit 2, in-surface `scripts/staging-guard.ts` → exit 0 (proves
it reads *this* intake). stop-gate: empty payload → exit 2 from both parent and
worktree cwd (blocks until verify-gate populates the symlinked gate-status).

**LIVE CONFIRMATION (step 3).** The real Stop hook fired at a turn boundary and
blocked with "Stop blocked: no gate evidence" — anchoring on the parent and
reading the (still-dangling) symlinked gate-status. This proves the bridge works
end-to-end from the actual harness invocation, not just the manual ARM CHECK.
Once `scripts/verify-gate.sh` runs in the worktree at step 5, the symlink target
appears and the Stop hook will read the real gate result.

**Teardown ordering note.** Do NOT remove the worktree until after the final
green stop (or first delete the parent `.feature/intake.json` to exit
feature-mode) — otherwise the symlink dangles and the Stop hook blocks.

## D1 — OutboxPoller drain lifecycle + safe injection topic (spike, step 3)

Read-only Explore spike to resolve the one open design detail for T3. Evidence
(file:line) captured; conclusions:

- **Drain is CLAIM-bound, not completion-bound.** OutboxPoller Phase-2 CLAIM
  (`OutboxPoller.ts:188-200`) atomically moves `pending → dispatching` *before*
  any BullMQ enqueue (`FOR UPDATE SKIP LOCKED`, `LIMIT OUTBOX_BATCH_SIZE`).
  `backlog_depth` counts only `status='pending'` (`backlog-depth.ts:37`), so
  backlog drains the instant the poller claims — fully decoupled from downstream
  success. Status ladder: `pending → dispatching → dispatched → completed|failed`.
- **Claim rate:** `OUTBOX_BATCH_SIZE` 50 / `OUTBOX_POLL_INTERVAL_MS` 5000ms =
  **~600 rows/min**. 1000–2000 immediately-claimable rows drain in ~2–4 min.
- **Safe topic = `stripe_subscription_mirror_sync`** (`aggregate_type='account'`,
  fresh `uuidv7()` id, random non-existent `aggregate_id::uuid`,
  `payload={"account_id":"<same uuid>"}`). Handler
  (`StripeSubscriptionMirrorSyncWorker.ts:19-78`) is DB-only (no LLM/external
  spend), takes only an advisory lock (no contention across distinct ids), runs
  at normal concurrency, and on a missing account unconditionally calls
  `markOutboxCompleted` → row ends `completed`. Not an absolute "never `failed`":
  the worker's own test (`StripeSubscriptionMirrorSyncWorker.test.ts` — "throws
  transient database failures and leaves the outbox incomplete") proves a
  transient DB error CAN reject the job, in which case the OutboxPoller retries
  it (`max_attempts` defaults to 5). This is fine for the drill either way — the
  topic is not one of the two `checkFailedOutboxByTopic` watches
  (`publish_response`/`send_notification`), so even an exhausted-retries
  `failed` row would not trip that check or `checkStaleDispatching`. No in-flight
  dedup index → bulk distinct-id inserts don't collide. Rows self-purge via
  `ArchivalPoller` (7d).
- Insert precedent: `src/lib/shared/job-outbox-helpers.ts:558-571` (the mirror-sync
  INSERT — `uuidv7()` id, `tx.json({account_id})`, `JOB_OUTBOX_STATUS_PENDING`).
  [Corrected in D3: the round-1 note wrongly said `src/lib/shared/outbox.ts`
  (that file is only 166 lines); codex was right — the Explore spike misattributed.]

### T3 mechanism decision (resolves the plan's "per D1" placeholder)

The load script gets **two modes**, both `stripe_subscription_mirror_sync`, both
tagged with a per-run `__drill:<tag>` key in `payload` for scoped cleanup:

- **Headroom arm** (`--available-in-min 0`, default): inject 1000 immediately-
  claimable rows paced over 10 min. Drain (~600/min) outpaces the ~100/min
  inject, so pending stays low and drains ≤30 min with NO alert — the drain +
  no-false-alarm proof. Rows self-complete; no cleanup needed.
- **Over-threshold arm** (`--available-in-min <K>0>`): inject ~1600 **future-
  dated** rows. They count as `pending` (backlog_depth has no `available_at<=NOW()`
  filter) but the poller never claims them, so the backlog **holds** >1500 across
  a 5-min HealthAlertPoller tick → `backlog_depth:job_outbox` fires. A `release`
  mode then **DELETEs only this run's drill rows** (`WHERE topic=... AND
  payload->>'__drill'=<tag> AND status='pending'`) → backlog drops <1500 → alert
  clears at the next tick. Pure alert fire/clear proof (drain is proven by the
  headroom arm). The scoped-delete predicate is safety-critical: topic + drill-tag
  + status='pending' — never touches real or non-pending rows.

## D2 — Codex adversarial plan review (round 1) — triage

Codex returned `VERDICT: REVISE` with 9 findings. Triage (receiving-code-review):

1. **ACCEPT — differential fidelity.** T2 revised: **fresh client per iteration**;
   the max:2 arm matches the REAL health client options (read
   `worker/background/pollers/health-alert/health-db.ts` `buildClient()`); the
   **sequential arm calls the shipped `runHealthChecks(sql)` directly** (proves
   THE cure, not a hand-rolled sequential); the concurrent arms replicate the
   exact pre-fix `Promise.all` of the 6 exported `checkXxx`. Throwaway
   `HealthAlertConfig` literal is fine (thresholds gate emission, not query exec).
2. **ACCEPT — redesign detection.** Destructive "new-pid-since-arm-start"
   attribution over a transaction pooler is unsound (pid reuse → could miss the
   wedge or kill a foreign backend / the live poller / the #507 soak). Replace it:
   the **PRIMARY signal is whether the arm's queries RESOLVE within a bounded
   deadline** — concurrent-max2 hangs past the deadline = wedge; sequential-max2
   (`runHealthChecks`) and concurrent-max6 resolve = clean. Observed in-process;
   no pg_stat_activity attribution needed for pass/fail.
3. **ACCEPT — cleanup/crash.** Cleanup = **force-close the arm's OWN client**
   (`client.end({ timeout })`) — exactly how production recycles a wedged health
   client (`health-db.ts:53`). SIGINT/SIGTERM force-closes all live arm clients;
   process exit closes sockets → server backends released. `pg_stat_activity` is
   read ONLY as best-effort corroboration + to REPORT residual wedges — **never**
   to `pg_terminate_backend` a backend not provably ours (removes the misfire +
   soak-contamination risk entirely).
4. **ACCEPT — scope honesty (framing, not mechanism).** The drill proves **outbox
   DISPATCH-drain** of a 1000-row burst + `backlog_depth` observability — NOT full
   ingest→LLM pipeline throughput (user chose cheap/mocked rows for exactly that).
   Fix all naming/claims to "outbox dispatch drain"; state scope precisely in T4.
   **Surface the narrowing to the user at sign-off.**
5. **ACCEPT — explicit clear-evidence.** Check `health-alert/emit.ts` for recovery
   semantics; the runbook records that a subsequent HealthAlertPoller cycle emits
   NO `backlog_depth:job_outbox` finding at the sink. Keep "drain" (headroom arm)
   distinct from "fire+clear" (over-threshold arm).
6. **ACCEPT — harden release.** Release gets: unique run-tag + creation-window
   horizon + idempotent DELETE + **post-run inventory** (COUNT remaining
   drill-tagged rows, assert 0).
7. **PARTIAL.** ACCEPT positive allowlist — `assertStagingTarget` must require the
   target ref to **equal `KNOWN_STAGING_REF`** (not merely "not in the prod
   denylist"). REJECT a script-level "#507 completion" gate as over-engineering —
   handled by the runbook procedure + T5's blocking edge on the soak.
8. **ACCEPT steer.** Extract **`staging-guard.ts` only**; do NOT extract a
   destructive wedge-observer (the redesign removes destructive attribution). The
   differential owns a minimal **read-only** wedge-signature sampler, commented as
   implementing CONTEXT.md's canonical "Connection wedge" signature. Keeps churn to
   `wedge-repro.ts` to just the guard import.
9. **ACCEPT — clarify intake.** `db_touching:false` is correct for audit-gating
   (no schema / no new production query site) but the scripts do operational
   staging INSERT/DELETE at runtime → added an explicit intake note. Precedent path
   **[CORRECTED in D3] = `src/lib/shared/job-outbox-helpers.ts:558-571`** — my
   round-1 "verification" wrongly sided with the Explore spike's `outbox.ts` (an
   ambiguous `sed` over both files); `outbox.ts` is only 166 lines. Codex was right.

## D3 — Codex adversarial plan review (round 2) — triage

Round-2 verdict `REVISE` (round-1 findings only PARTIALLY resolved). All accepted
except one partial-reject. Resolutions:

- **A. Detection underspecified → SPECIFY.** Explicit **~40s deadline** (> the 30s
  server `statement_timeout`; a wedge is `ClientRead`, a wait state, so
  statement_timeout never heals it → a wedged arm's `Promise.all` never settles).
  **Four-way per-arm outcome taxonomy:** `fulfilled` (all checks resolved),
  `rejected` (a check threw), `wedged` (deadline passed AND the read-only observer
  corroborates the `ClientRead` signature on the arm's OWN backends), `hung-unknown`
  (deadline passed WITHOUT the signature → NOT the known wedge; report as
  inconclusive — slow query / pool exhaustion / network, not a repro). The read-only
  observer corroboration is **MANDATORY, not optional** — a bare timeout does not
  prove the wedge.
- **B. `client.end({timeout})` is NOT reliable → REDESIGN cleanup.** `health-db.ts:8-17`
  documents FIN-based reclamation as "plausible but not guaranteed" (backstop issue
  **#477**); postgres.js 3.4.9 `end()` initiates shutdown without waiting for the
  server backend to disappear. A leaked wedged backend would pollute later arms and
  break "clean"-arm independence. Redesign:
  1. Set a **unique per-run `application_name`** on the wedge-target client.
  2. **Startup self-check:** confirm the script's own (non-wedged) connection is
     visible in `pg_stat_activity` with that `application_name`. If the pooler
     flattens it so the script can't identify its own backends → **ABORT** (can't
     guarantee safe cleanup). This is the sound answer to round-1's "attribution is
     unsound over the pooler": we attribute by a POSITIVE unique `application_name`,
     not a timing heuristic, and only ever act on backends provably ours.
  3. Cleanup ladder per arm: `client.end({timeout})` (best-effort FIN, mirroring
     prod's `end({timeout:1})` raced against a non-cancelling `withTimeout`) →
     **backstop `pg_terminate_backend` scoped to (wedge-signature AND our unique
     `application_name`)** — reliable server-side kill of provably-own backends.
  4. **Baseline barrier between arms:** verify zero wedge-signature backends carrying
     our `application_name` before the next arm; if residuals persist after the
     backstop → **ABORT the run** (never continue on a polluted pooler, never
     terminate a backend not provably ours).
  - **PARTIAL-REJECT** codex's "per-iteration child-process isolation (mandatory)":
    child-exit FIN has the SAME #477 uncertainty as `end()`, so it does not remove
    the need for the `application_name`-scoped `pg_terminate` backstop — which
    already guarantees cleanup + independence via the barrier. In-process arms with
    fresh clients + the barrier + backstop are sufficient and simpler. Child-process
    isolation is kept as a documented FALLBACK only if `application_name` attribution
    proves unusable on Supavisor at execution (startup self-check fails).
- **C. Exact health-client construction:** mirror `health-db.ts` `buildClient()`
  options exactly (already in the plan — keep).
- **D. "Clear" definition (emit.ts has NO recovery event):** clear =
  `queryBacklogDepth`/`queue-health` shows pending < threshold **AND** a subsequent
  HealthAlertPoller cycle completes a **successful check-in emitting no
  `backlog_depth:job_outbox` finding** — not "no finding" alone.
- **E. Release inventory → HARD-FAIL:** non-zero remaining drill-tagged rows after
  `release` = non-zero exit code (not just a warning).
- **F. T5 gate → evidence-based, not time-based:** the runbook gate requires a
  RECORDED **#507 PASS/closure comment** + a **clean HealthAlertPoller baseline**
  before executing — not merely "the ~24h window has closed."
- **G. Precedent path corrected** everywhere → `job-outbox-helpers.ts:558-571` (see
  D2#9 correction above).
- **H. Contradictions removed:** intake self-clean invariant reconciled to the
  `end()` + `application_name`-scoped `pg_terminate` backstop + abort design; the
  plan's stale `wedge-observer.ts` risk-section reference removed.

## D4 — Codex round 3 (final) — BLOCKER: the cleanup design is inoperable

Round-3 verdict `REVISE`. **3-round codex cap reached → surface to user** (workflow
rule). Round-3 RESOLVED the detection classifier (40s deadline + mandatory
ClientRead-signature corroboration — confirmed sound vs the 30s `statement_timeout`
`src/lib/db/server.ts:28` and the 4s backlog timeout `backlog-depth.ts:24`). But it
found a **documented, verified** repo fact that breaks the cleanup design:

- **BLOCKER — Supavisor flattens `application_name` (ADR 0007).**
  `docs/adr/0007-supavisor-app-name-flattening.md` (verified on staging 2026-07-18):
  the Supavisor **transaction pooler** (`:6543`) rewrites EVERY client's
  `application_name` to the literal `'Supavisor'` server-side. So the round-2/3
  `application_name`-scoped ownership + `pg_terminate` backstop + self-check are
  **inoperable** — the self-check fails closed and aborts, meaning the harness
  cannot run on the real staging pooler at all. The ADR records the real solution:
  a cooperative **anchored query-comment marker** `/* rw-reapable */` in the query
  TEXT (survives the pooler via `pg_stat_activity.query`; matched anchored, not
  substring). It was on the 5 health-check queries but was **REMOVED when #505
  deleted the `PoolWedgeReaperPoller`** (checks.ts queries are currently unmarked).
- **Fidelity fix (codex #2, NOT resolved before):** the real health client is
  `buildHealthClient()` = `createDedicatedPostgresClient(DATABASE_POOL_URL, { max: 2 })`
  (`HealthAlertPoller.ts:34-35`), with a 30s client-side `withTimeout`
  (`HEALTH_CHECK_TIMEOUT_MS`). The health config values are **live SQL query
  parameters** (`checks.ts:54,92,134` — `make_interval(secs => failedWindowS)` etc.),
  NOT just finding-emission thresholds — so the concurrent arms must fire with the
  EXACT resolved config `runHealthChecks` uses, never an arbitrary literal. [My
  earlier "throwaway config literal is fine" was WRONG.] Fix regardless of the
  attribution option chosen.

### Options surfaced to the user (attribution/cleanup for a pooler-safe differential)

- **Opt 1 — ephemeral Supabase branch (lean, sidesteps attribution):** run the
  differential against a throwaway branch DB where it is the SOLE client → cleanup
  = terminate-all-wedge / drop the branch; no per-backend attribution; zero shared-
  staging/#507 contamination. Needs a feasibility check that a branch pooler
  reproduces the transaction-pooling wedge.
- **Opt 2 — query-comment marker on shared staging (ADR-0007 approach):** the
  differential injects `/* rw-diff:<runid> */` into its queries; observer attributes
  + terminates ONLY marked wedge backends over the pooler; runs in the controlled
  post-soak window. Requires marked query copies (mild single-owner tradeoff vs
  checks.ts) — no production change.
- **Opt 3 — re-add the marker to production `checks.ts`:** restore `/* rw-reapable */`
  on the health queries (re-arms the #477 reaper capability too). Production change
  (worker/, scope expansion) but restores single-owner + a documented capability.
- **Opt 4 — lighter obligation satisfaction:** checked-in harness + a formally
  recorded operator run; cleanup via pooler-connection restart / manual, no
  auto-attribution. Minimal complexity; accepts operator-driven cleanup.

Round-2 items 1/6/8/9 RESOLVED; 2/4/5/7 partial; item 3 (client/config fidelity)
NOT resolved (fix above). Nice-to-haves (non-gating): exact `40_000` constant +
observer cadence; scrub stale "ingest events"/"kill children" wording; keep
child-process isolation as optional defense-in-depth only. The "mirror-sync
worker never fails" overclaim is corrected above (D1).

## D5 — DECISION: ephemeral Supabase branch (resolves the D4 blocker)

User chose **Opt 1**. The differential runs against a **throwaway Supabase branch
off staging**, where it is the SOLE client → the ADR-0007 attribution problem
DISSOLVES (every wedge-signature backend is provably ours), and there is zero
shared-staging / #507-soak contamination. This replaces the entire
`application_name`-ownership machinery from D3-B.

### Revised T2 design (ephemeral branch)

- **Branch lifecycle is an OPERATOR step (T5 runbook), not the script's job** —
  keeps the risky infra ops with a human: operator creates a branch off STAGING
  (Supabase MCP/CLI `create_branch`), passes its **transaction-pooler URL**
  (`:6543`, transaction mode — must match staging's topology or the wedge won't
  form) + a confirm flag to the script, runs it, then `delete_branch`. The script
  focuses on the differential.
- **Safety gate adapts (supersedes D2#7's KNOWN_STAGING_REF equality — a branch has
  its OWN ref, distinct from staging):** the guard still (a) hard-rejects the prod
  denylist (defense-in-depth: never run-all / terminate-all against anything
  prod-shaped), and (b) requires an explicit `--confirm-branch <ref>` that matches
  the target AND is NEITHER the prod NOR the staging ref (it must be a throwaway
  branch, not a long-lived env). `staging-guard.ts` gains a branch-target mode;
  the wedge-repro caller keeps the equality mode.
- **Detection unchanged (D3-A):** 40s deadline + 4-way taxonomy + mandatory
  ClientRead-signature corroboration via a read-only observer on the SAME branch.
- **Cleanup simplifies (no attribution):** between arms, terminate ALL
  wedge-signature backends on the branch (safe — sole client) + verify a zero
  baseline before the next arm; on any exit incl. SIGINT/SIGTERM, `client.end()` +
  terminate-all-wedge. Final teardown = operator `delete_branch` (nukes residuals).
- **Fidelity (fixes codex #3):** each iteration builds a fresh client with the REAL
  construction — `createDedicatedPostgresClient(<branch pool url>, { max: 2 })`
  (mirrors `HealthAlertPoller.ts:34-35 buildHealthClient`), and fires with the
  EXACT resolved health config `runHealthChecks` uses (the config values are live
  query parameters, `checks.ts:54,92,134`). Sequential arm calls the shipped
  `runHealthChecks(sql)`. max:6 control arm = same construction, `max: 6`.
- **Feasibility is self-verifying:** the `concurrent-max2` arm IS the "does this
  branch's transaction pooler reproduce the wedge" test. If it does NOT wedge on
  the branch, the harness reports it honestly as inconclusive (a branch-pooler-mode
  difference to investigate — fall back to Opt 2 marker on shared staging), never a
  false "cure regression".
