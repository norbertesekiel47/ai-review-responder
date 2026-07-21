# F1 Owner-Unreachable Escalation — Handoff

**Branch:** `f1-owner-unreachable-escalation` · **Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/f1-owner-unreachable-escalation` · **RISK:** high · **SURFACE:** backend · **db_touching:** true (migration 083).

Resume with `/feature-resume f1-owner-unreachable-escalation` from a fresh session **cd'd into the worktree**. Bootstrap order below. Do NOT re-read the grilling conversation — everything is on disk.

## Bootstrap (read in order)
1. **Intake contract (locked):** `.feature/intake.json` — scope, invariants, edge cases, `allowed_edit_surface` (includes `src/lib/shared/worker-types.ts` per mid-plan amendment), `tests_to_add`.
2. **Plan (rev 2, authoritative):** `docs/superpowers/plans/2026-07-20-f1-owner-unreachable-escalation.md` — 5 tracer tickets T1–T5 with concrete code + the **shared predicate** block. Committed `bb526da8`.
3. **Ticket source:** `docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md` ticket F1.
4. **Glossary:** `CONTEXT.md` (term to be ADDED in T5: *Owner-unreachable outcome*).
5. This handoff.

## What's decided (don't re-litigate)
- Marker = new nullable `job_outbox.completion_reason` column (migration 083, **pure ADD COLUMN, no index** — 082 already provides the lookups). NOT a new `responses.status`.
- Owner-unreachable is **current-state**: predicates read the **latest completed `send_notification` reason**, not mere marker presence (supersedes on subscription-skip retry / delivery).
- Escalation = BOTH: durable Sentry `checkOwnerUnreachable` (4h age floor) + best-effort 24h-deduped admin email via a new `NotificationFailoverPoller` arm.
- Retry = poller-driven, **advisory-locked** re-enqueue (at-most-once across concurrent pollers). Self-clearing.
- Age floor reconciled: health default `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S=14400` (4h) == poller `INTERVAL '4 hours'`.

## Map-level correction made (recorded in ADR 0010, T5)
The F1 ticket's "no health check can see it" premise was **stale** — `checkZeroDeliveryNotifications` already partially observed the zero-enrollment case within its 1h window (blanket `NOT EXISTS(notification_deliveries)`). F1's value: distinct + **durable** (age floor, not window) + de-conflated marker. This was surfaced to and accepted by the owner.

## Current step: 4–7 DONE → resume at step 8 (SHIP, RISK=high lane)

**Steps 6 + 7 complete; verify gate GREEN (16/16, `gate-status.json` newer than HEAD).** Ready to ship.

**Step 6 (adversarial review) — DONE.** `/codex:adversarial-review` returned needs-attention (1 high, 2 medium). Triaged in `docs/reviews/f1-owner-unreachable-escalation/codex-adversarial-review-round0.md`:
- **Finding 2 (medium) FIXED** (`96fe61cd`): candidate SELECT now excludes in-flight `send_notification` (matches all-failed/stale precedent; kills 200-batch starvation). Partially reverts R3-B (admin email waits ~1 retry cycle when in-flight; durable Sentry COUNT covers meanwhile). ADR 0010 updated.
- **Finding 1 (high) ACCEPTED AS SCOPED** — premise partly wrong (subscription-skip NULL-reason completion is still counted by `checkZeroDeliveryNotifications` via `NULL IS DISTINCT FROM 'owner_unreachable'`); the lost durable/retry properties are the intake's designed supersession + the "no event-driven re-notify" non-goal; not a regression. Follow-up ticket F1-followup-A.
- **Finding 3 (medium) ACCEPTED AS SCOPED** — re-raise of owner-decided R3-A archival coupling; follow-up F1-followup-C (failover liveness monitoring).

**Step 7 (dual review) — DONE.** Spec & correctness: **CLEAN (0 findings ≥80%)** — full field-by-field intake check passed (`docs/reviews/.../spec-correctness-review.md`). Standards & maintainability: 1 medium — triplicated owner-unreachable predicate (`docs/reviews/.../standards-maintainability-review.md`). Triaged: kept the deliberate duplication (heterogeneous query shapes; codex-reviewed plan decision) but FIXED the real sub-issue — the age floor was config-driven in the health check yet hardcoded `INTERVAL '4 hours'` in both poller sites (`9050ba39`): now a single `OWNER_UNREACHABLE_AGE_FLOOR_SECONDS` constant + shared `num()` resolver bind all three to the same env source. Behavior byte-identical (14400s = 4h).

**Branch commits (newest→oldest):** `9050ba39` age-floor bind · `ee346965` step-6 docs · `96fe61cd` finding-2 fix · `3feba107` handoff · `38d9abfe` lint · `dd4bfe7f` tenant-scope allowlist (baseline 405) · `c3c2f7a0` T5 · `87b0f9f0` deviations · `36e14b72` T4 · `5cbfa115` T3 · `f17330dd` T2 · `a469e8bc` T1.

### NEXT: step 8 SHIP (RISK=high — worker + migration) — staging-first lane
1. **Migration 083 to STAGING Supabase FIRST** (`ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS completion_reason TEXT` — additive, `lock_timeout 3s`). Then land the branch on `staging` (push → full stack auto-deploys the Railway staging worker + Vercel staging).
2. **Smoke on staging**: health-alert finding path + failover owner-unreachable arm (a live business with zero verified enrollments → marker recorded → `checkOwnerUnreachable` fires → poller retries + admin email). Runbook: `docs/runbooks/beta-launch-alerting.md`. Integration tests (`*.integration.test.ts`) run in CI (CI provisions `TEST_DATABASE_POOL_URL` + applies migrations).
3. **Open PR to `main`**, confirm all 4 GitHub CI checks green (+ fallow in its own workflow), then **PAUSE for owner merge approval**. Apply migration 083 to **prod Supabase in lockstep** at promotion.
4. **After merge:** `git pull --ff-only` local main; fast-forward `staging` onto `main`; remove the sibling worktree + delete branch; `document-feature` sweep; final `domain-modeling` fold; increment the merge counter in `.claude/reference/arch-review-log.md` (architecture-review reminder at ≥5).
5. **File the 3 follow-up tickets** (F1-followup-A/B/C) from the step-6 review doc.

**Migration lockstep reminder:** apply to BOTH Supabase projects, **staging first**; "applied to prod, not staging" is a bug (CLAUDE.md).

### (historical) Current step: 4 + 5 DONE → PAUSED at step 6 (REVIEW 0, adversarial)

**Execution complete, verify gate GREEN.** As of 2026-07-21 all 5 tracer tickets are implemented + committed and `scripts/verify-gate.sh` is GREEN (16/16; `gate-status.json` newer than HEAD). Branch commits (oldest→newest): `a469e8bc` T1 marker foundation · `f17330dd` T2 NotificationWorker · `5cbfa115` T3 health check + de-conflation · `36e14b72` T4 failover arm · `87b0f9f0` deviations log · `c3c2f7a0` T5 glossary+ADR · `dd4bfe7f` tenant-scope allowlist · `38d9abfe` lint fix.

**Mid-execution surface amendment (owner-approved 2026-07-21):** the new `checkOwnerUnreachable` + `processOwnerUnreachable` are platform-wide ops scans, inherently cross-tenant like the existing `checkZeroDeliveryNotifications`/all-failed/stale arms. `scripts/ci/tenant-scope-allowlist.ts` was added to `allowed_edit_surface`; 10 new `background-global-scan` entries added + `ALLOWLIST_BASELINE` 395→405; the intake tenant-scope invariant was corrected (the original "no cross-tenant read introduced" wording was a plan misjudgment). See `.feature/intake.json` (untracked — `.feature/` gitignored) + commit `dd4bfe7f`.

**Deviations recorded** in `docs/superpowers/plans/f1-owner-unreachable-escalation-deviations.md`: T3 delta-count integration assertions (global COUNT queries) + `threshold:-1` probe; T4 integration case-(b) wording-vs-R3-B reconciliation (in-flight-only draft has NULL latest-completed-reason → not selected; real in-flight retry-gate proven by twice-run case c) + local test-DB `ADD COLUMN IF NOT EXISTS` bootstrap for migration 083 + `tx.json(payload as never)` matches existing arm precedent.

**NEXT (step 6, RISK=high):** owner must run `/codex:adversarial-review` on the branch (user-invocable only) — it challenges the built approach/design, not defects. Triage findings via `superpowers:receiving-code-review`; a valid approach-level finding may reopen the plan (step 3). Re-run the gate after any change. THEN step 7 dual review (spec+correctness ‖ standards) → triage → re-gate → step 8 staging-first ship. Two reviewer focus areas to flag: (1) T4 in_flight/email gating semantics (R3-B), (2) the tenant-scope allowlist additions are narrow per-(file,table) entries, not a blanket exemption.

### (historical) Current step: 3 DONE → resume at step 4 (EXECUTE)
- **PLAN APPROVED by owner** (2026-07-21) at **rev 4**, committed on branch. Codex ran its full 3-round cap (R1 REVISE→R2 REVISE→R3 REVISE, each round smaller; R3 was 8/10 confirmed-fixed + edge cases). Rev 4 resolves every concrete R3 finding: email-starvation split (unreachable vs in_flight flags, R3-B), commit-state via sql.begin return (R3-C), null-safe reviewer_name (R3-D), age floor in locked re-check (R3 #1), CAS test order (R3 #8). Codex loop is CLOSED — do NOT re-submit.
- **Owner decision R3-A (archival):** ACCEPT + DOCUMENT. `owner_unreachable` markers are archived at 7d but the retry loop refreshes them (<7d while running); a stalled retry >7d is caught by `checkStaleDispatching`/`checkOldestPendingOutbox`. No `ArchivalPoller` change. Recorded in the plan residual-risks + to be recorded in ADR 0010 (T5).
- **NEXT: step 4 execution.** Dispatch fresh per-task subagents (T1 → T2‖T3‖T4 → T5) via `superpowers:subagent-driven-development`; each prompt carries the CONTEXT.md glossary excerpt + the ticket's spec slice + blocking edges. Commit per task. Then step 5 verify gate, step 6 (ask owner to run `/codex:adversarial-review`), step 7 dual review, step 8 staging-first ship. **Uphold the manual gate discipline** (Stop hook won't auto-arm; paste green `scripts/verify-gate.sh` before any done-claim).

## (historical) Codex plan-gate rounds
- **Grill + intake:** DONE, owner-signed-off. 4 decisions locked (scope; marker=column; both surfaces; poller retry) + surface amendment (worker-types.ts) signed off.
- **Worktree + ARM CHECK:** DONE. Edit-surface guard **ARMED**. ⚠️ **Stop gate does NOT auto-arm** (harness resets cwd to parent; `CLAUDE_PROJECT_DIR` unset → gate can't find the worktree's `.feature/intake.json` at stop time). `.feature/` is gitignored (repo policy) so intake is present-but-untracked. **Mitigation: uphold gate discipline MANUALLY — never claim done without pasting green `scripts/verify-gate.sh` output.**
- **Plan is now rev 3, committed `7dddc2a5`.**
- **Codex round 1:** REVISE (7 sections) → rev 2. 6 accepted, 3 rejected (schema-wide unique in-flight index = pre-existing race, out of scope; full subscription/flag de-conflation = needs own markers, out of scope; churn-backoff = optimization). Session `019f834b-840c-7213-8607-b87c014dabff`.
- **Codex round 2:** REVISE (10 findings), ALL accepted → rev 3. Key fixes: `ORDER BY created_at DESC` (not completed_at — NULLs bug + uses 082 index) [#2/#3]; advisory-locked FULL-predicate re-check gating the admin email [#1]; `escapeHtml(business_name)` in bodyHtml [#9, XSS]; test-harness fixes — `mockSql.json`, matcher (no `expect.anything()` for undefined attempt), full runHealthChecks fixture shift, property test models attempt-vs-attempts + real-PG CAS case, extended poller integration cases [#5/#6/#7/#8/#10]; cadence clarified 4h floor vs 2h interval [#4].
- **Codex round 3 (FINAL):** RUNNING (agent `a6a063c5b014d9805`). Retrieve via `node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" result <job-id>` where `$CODEX_PLUGIN_ROOT=/Users/norbertesekiel/.claude/plugins/cache/openai-codex/codex/1.0.4` (list jobs: `... status`). **This is the 3-round cap** — if round 3 is APPROVED → proceed to owner plan sign-off; if still REVISE → do NOT loop again; triage, apply any clearly-correct fixes, and SURFACE the residual disagreement to the owner for a decision.

## Next steps
1. Triage codex round-2 verdict (`superpowers:receiving-code-review`). If APPROVED → step 3 done. If REVISE → revise plan, re-submit (round 3 cap).
2. **Show the approved plan to the owner for final sign-off** (required before any code).
3. Step 4 EXECUTE via `superpowers:subagent-driven-development`: fresh subagent per ticket T1→(T2‖T3‖T4)→T5, each prompt carrying the CONTEXT.md glossary excerpt + the ticket's spec slice + blocking edges. Commit per task. Deviations → `docs/superpowers/plans/f1-owner-unreachable-escalation-deviations.md`.
4. Step 5 VERIFY GATE: `scripts/verify-gate.sh` (reads `.feature/intake.json`; runs lint+typecheck+test, all `ci:*` except fallow, plus `ci:tenant-scope`/`ci:rls-audit`). Property-test requirement satisfied by the outbox CAS fast-check test (escalation logic).
5. Step 6 REVIEW 0 (RISK=high): PAUSE, ask owner to run `/codex:adversarial-review` on the branch.
6. Step 7 dual review (spec+correctness ‖ standards) → triage → re-gate.
7. Step 8 SHIP (RISK=high lane): ride `staging` first (migration 083 to staging Supabase FIRST), smoke via `docs/runbooks/beta-launch-alerting.md` (health finding) + failover behavior; PR to `main`; owner merge approval; prod migration in lockstep. Then post-merge sweep (`document-feature`, domain sweep, entropy counter).

## Verification commands (beyond standard gate)
`pnpm ci:tenant-scope` · `pnpm ci:rls-audit` (db-touching). Integration tests (`*.integration.test.ts`) run in CI (CI provisions `TEST_DATABASE_POOL_URL` + applies migrations).
