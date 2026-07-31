# Handoff — feat-628-ask-generation-lane

**Phase:** `gate_green`, adversarial review ROUND 1 RETURNED **needs-attention**
(2026-07-31, codex thread `019fb9be-13ac-7352-b506-81f0bc2d3699`).
**Next step: fix the three Codex findings below, then re-submit to the SAME
codex thread** (`codex resume 019fb9be-13ac-7352-b506-81f0bc2d3699`) until
APPROVED. All 12 plan tasks are executed, dual-reviewed, and committed; the
full `verify-gate.sh --review` was GREEN before the review round.

## Codex round-1 findings (fix in this order; verbatim from the review)

1. **[high] Subject lint permits partial visit-note PII**
   (`src/lib/solicitation/ask-compliance-lint.ts:450-454`). The subject check
   rejects only the ENTIRE disallowed interpolation value as one substring —
   an admitted note "discussed HIV treatment" does not block the subject
   "Checking in after your HIV treatment", and provenance (class 6) separately
   allows the fragment because it appears in the note. Fix: fail closed on
   note-derived subject content (token/fragment-level detection or exclude
   visit-note provenance from subjects entirely); add partial medical/identity
   regression cases. Golden file must ride any pattern change; consider an
   ASK_LINT_VERSION bump.
2. **[high] Transient exhaustion permanently disables watchdog recovery**
   (`worker/jobs/solicitation-batch/generate-failed-hook.ts:55-81`). The
   failed hook marks every exhausted attempt `failed` without classifying —
   including `TransientLLMError`/`CostInfraUnavailableError` which the domain
   rethrows for retry. After 5 in-band attempts the watchdog can no longer
   re-drive; partially generated batches strand a running send parent. Fix:
   keep retryable classes watchdog-eligible (leave dispatched or re-pend);
   mark failed only for terminal classes; test transient exhaustion after
   partial persistence. NOTE: the sibling hooks (`failed-hook.ts`, csv-ingest,
   judge) share this shape — check whether the fix generalizes or is
   deliberately lane-local (surface! only solicitation-batch hooks are in
   surface).
3. **[medium] One transient regeneration consumes the full daily allowance**
   (`src/lib/solicitation/ask-generation.ts:1111-1118`). `checkAskRegenBudget`
   increments per processor invocation; BullMQ retries of one logical regen
   burn the 3/day budget. Fix: charge idempotently by logical request/outbox
   id (retries reuse the charge); test N transient attempts + success ⇒ one
   unit consumed. The budget primitive lives in `src/lib/costs/tracker.ts`
   (in surface).

After fixes: re-run the 3 relevant suites + full gate (`MAX_PARALLEL=2
VITEST_WORKERS=6 bash scripts/verify-gate.sh --review` — default parallelism
false-reds on this machine), append deviations entries, commit per finding or
as one review-round commit, then re-submit to the codex thread above.

## Bootstrap order (read in this order, nothing else needed)

1. **Intake (drift detector):** `docs/superpowers/plans/feat-628-ask-generation-lane-intake.json`
   — amended 4× during execution (all recorded in the deviations file,
   ALL PENDING OWNER RETROACTIVE SIGN-OFF): worker/queues.ts (Task 9);
   two requests-UI fixtures (Task 11); startup-assertion.test.ts (Task 12);
   four gate-tripwire/assertion test files + runnable verification_commands
   (Task 12 gate round).
2. **Plan:** `docs/superpowers/plans/2026-07-30-628-ask-generation-lane.md`
3. **Deviations (now the primary review artifact):**
   `docs/superpowers/plans/feat-628-ask-generation-lane-deviations.md` —
   every task's deviations were adjudicated inline by per-task spec reviewers
   (all ACCEPT); step 6.5 owner triage should confirm the verdicts, especially
   the four intake amendments and the Task 8 interface deviation
   (`business_id` in `GenerateSolicitationAsksPayload` — #629's enqueue must
   pass it).
4. Governing specs as before (banner: §5 table superseded; AMEND wins).

## Session facts

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-628-ask-generation-lane`,
  branch `feat-628-ask-generation-lane`, based on main @ 44de0a79; 13 commits
  (intake, plan, handoff, Tasks 1–12; Task 8 = two commits).
- **Merge order (owner-approved): #625 merges first; this branch REBASES over
  it before its review rounds land** — collision file `batch-builder.ts`.
  #625 had NOT merged as of this checkpoint (main still 44de0a79).
- Gate mechanics learned this run: the gate flakes under its own load on this
  machine at default `MAX_PARALLEL=4`/`VITEST_WORKERS=4` (arbitrary timeouts
  in untouched suites; three distinct false-red runs). `MAX_PARALLEL=2
  VITEST_WORKERS=6` runs clean. The 5 changed live-DB integration suites run
  GREEN via the gate's "extra" verification row (39/39) — the
  `integration-suites SKIP` warning row is redundant with it.
- `reclassify WARN` is real: actual diff 8262 lines vs 3200 estimate (~2.6×,
  test-dominated). The workflow's re-classification trigger fired; owner may
  waive or re-classify at review.
- Remaining post-review steps: step 8 rides staging first (flag-off no-op
  smoke ONLY pre-#627 — the postal-address column doesn't exist; full-path
  proof belongs to the #633 runbook campaign). `SOLICITATION_SEND_ENABLED`
  must not be set anywhere before #627 lands.

## Glossary anchors (use verbatim)

Solicitation (never "Solicitor") · ask · render/outreach row · attempt ·
supersede · withheld vs cancelled vs failed (091 vocab) · lint_failed folding
(AMEND B1) · blocked-is-terminal · generate-then-approve · byte-for-byte
stored bytes · placeholders (B4) · send parent (`solicitation_send_batch`) ·
releasable.
