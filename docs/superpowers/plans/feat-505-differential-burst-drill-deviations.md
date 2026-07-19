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
  `markOutboxCompleted` → row ends `completed`, **never `failed`**. So it never
  trips `checkFailedOutboxByTopic` (scoped to `publish_response`/`send_notification`
  only) or `checkStaleDispatching`. No in-flight dedup index → bulk distinct-id
  inserts don't collide. Rows self-purge via `ArchivalPoller` (7d).
- Insert precedent: `src/lib/shared/outbox.ts:554-571` (uses `tx.json(payload)`).

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
   staging INSERT/DELETE at runtime → add an explicit intake note. Precedent path
   **verified = `src/lib/shared/outbox.ts` (~558-570)** (codex's
   `job-outbox-helpers.ts` was wrong; the Explore spike was right).
