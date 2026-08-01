# Handoff — feat-628-ask-generation-lane

**Phase:** `gate_green`, adversarial review ROUND 4 RETURNED
**needs-attention** (2026-07-31; rounds 1–3 fixed in `0d0fd1b0`, `e54f99fa`,
`5d12e403`). **Next step: fix the three round-4 findings below, re-run the
suites + full gate (`MAX_PARALLEL=2 VITEST_WORKERS=6 bash
scripts/verify-gate.sh --review`), then the OWNER runs
`/codex:adversarial-review` round 5.** After APPROVED: step 8 (high-risk
lane: staging ride first, flag-off no-op smoke only pre-#627).

## Codex round-4 findings (verbatim guidance; fix in this order)

1. **[high] Final-attempt settlement failure permanently strands batch
   state** (`worker/jobs/solicitation-batch/generate-failed-hook.ts:171-179`).
   The whole-batch dead-letter's catch suppresses a `settleGenerationExhaustion`
   failure; on the FINAL outbox attempt the row stays `dispatched` and the
   generic OutboxPoller terminalizer later strands the lane. Fix: make
   terminal settlement durably retryable independently of the exhausted
   outbox budget (e.g. on the final attempt, retry the settlement itself
   bounded, or leave the row dispatched ONLY when watchdog budget remains —
   the catch currently cannot tell the two cases apart). Add a test for
   settlement failure when `attempts === max_attempts`. NOTE the prior
   residual (deviations round-3 entry): crash-mid-final-attempt still
   reaches the generic terminalizer — OutboxPoller is out of surface.
2. **[high] Separator-formatted phone numbers are admitted into the
   prompt** (`ask-compliance-lint.ts` note admissibility, contact_channel
   rules — `/\d{7,}/` only catches CONTIGUOUS digits). "Spoke with Jane at
   555-123-4567 about the repair" is admissible today. Fix: test the
   digit-run rule against the separator-stripped note (the class-5 subject
   check already does exactly this: strip `[\s().-]` then `\d{7,}`), or a
   bounded phone matcher incl. country prefixes. Regression: formatted
   phone/paren/space/+1 forms are rejected `contact_channel`. Note
   admissibility is versioned under ASK_LINT_VERSION — bump to
   `ask_lint_2026-07-31.3` (or date of fix) and regenerate the golden file.
3. **[high] Written-out percentages pass the incentive lint**
   (`ask-compliance-lint.ts` class 1 — `\d+\s*%\s*off` only). "we'll take
   ten percent off your next visit" passes. Fix: written-number percent
   forms (`(?:ten|fifteen|twenty|…|half)\s*(?:percent|per cent)\s*off`, plus
   `percent off` generally and `half off/half price`), golden + version
   ride along; Codex's exact sentence is the regression case. Codex also
   re-recommends the semantic verifier before dispatch — the deviations
   round-3 finding-4 entry records that boundary as #631's decision; keep
   deterministic here unless the owner overrules.

After fixes: lint suite + generate/ask-generation suites + the five
integration suites with `TEST_DATABASE_POOL_URL` exported, then the full
gate, deviations entries, one review-round commit, and round 5.

## Codex round-1 fixes (full rationale in the deviations file, entries dated 2026-07-31)

1. **[high] Subject lint partial PII → FIXED.** Fragment-level detection in
   `deceptiveSubject`: any content token of a disallowed value blocks the
   subject (possessive+plural folded, shared class-6 tokenizer). Exemptions:
   golden-filed `SUBJECT_NOTE_TOKEN_ALLOWLIST` (function words + ask-copy
   scaffolding) and tokens also present in a subject-safe interpolation
   value. Whole-value check retained. `ASK_LINT_VERSION` →
   `ask_lint_2026-07-31.1`, golden file updated, 6 regression cases added.
2. **[high] Transient exhaustion killed watchdog recovery → FIXED.**
   `generate-failed-hook` classifies before terminalizing:
   `TransientLLMError`/`CostInfraUnavailableError` leave the row
   `dispatched` (watchdog re-pends, bounded by `max_attempts`;
   `recordOutboxTransientError` stamps `last_error`); all other classes keep
   the terminal CAS. Deliberately lane-local; csv-ingest/judge sibling audit
   flagged as follow-up (out of surface).
3. **[medium] Regen budget burned per retry → FIXED.**
   `checkAskRegenBudget(askId, outboxId)`: SET-NX charge marker keyed by
   outbox id (the logical request); replays are free; refusal releases the
   marker; shared Lua untouched. Tests prove one unit per logical regen.

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
