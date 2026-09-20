# Review wave round 1 — triage verdicts

Four axes, dispatched in one message against pinned
`825f0fbbf9f0275b98148ba70ee44da2e315be6a`, fork `d79bc765`.
Production diff 323 lines, so the standards axis ran on both triggers
(RISK = high, and > 300 lines).

**No P0 from any axis.** Three axes independently found the
`AUTOPILOT_PURCHASABLE` omission; three independently found the vacuous
builder test; two found the third tier-order copy.

## Fixed in this branch

| ID | Axis | Verdict |
|---|---|---|
| RT-1 | red team | **FIXED.** The AST oracle asserted call identity, statement-hood, enclosing `main` and try-membership but never `call.arguments`, so `logBootFlagSummary({ log: () => {} })` survived 9/9 — the boot line emitted into a black hole, the exact outcome the builder/emitter split exists to prevent. The test now pins the argument to `createWorkerLogger('[worker]')`. |
| RT-2 / std-M1 | red team + standards | **FIXED.** The docblock claimed "the single owner of tier order" and that was false at HEAD: `plan-options.ts:4` declared a third element-identical copy with bare tier literals. It now imports `SUBSCRIPTION_TIER_ORDER`. Surface amendment 3, owner-approved. |
| std-M2 / spec-M1 | standards + spec | **FIXED.** `AUTOPILOT_PURCHASABLE` was missing. `.claude/rules/agentic-platform.md:23` and `.claude/skills/flag-flip/SKILL.md:3` both own the term "autonomy flags" and both include it; `SKILL.md:17` makes it the LAST step of the go-live order. Issue #1173 listed five and the module inherited that. **Found while fixing: `autopilotPurchasable()` is a COMPOSITE** (`AUTOPILOT_PURCHASABLE === 'true' && autoApprovalRuntimeEnabled()`) routed through `getServerConfig()`, so logging it under an env-var-named key would have reported something other than that env var — the key uses `readFlag` instead. A new test derives the expected set from `flag-flip/SKILL.md`'s go-live line, so the next flag added to the order and forgotten here fails. |
| AP-3 | adversarial | **FIXED.** `OPENAI_MODERATION_ENABLED` was also absent, though this branch's own Posting block treats it as an account-wide veto — a boot record could show all six autonomy flags on while a required safety gate was off. The audited set is now stated as a rule ("flags gating an autonomous external action, plus their safety prerequisites"), not a historical grouping. Thirteen keys. |
| std-M3 | standards | **FIXED.** With `AUTO_APPROVAL_ENABLED=false` plus an armed policy — production's default — the owner read the same sentence twice, in the banner and the notice below. `readinessCopy` now suppresses the two reasons the blocked banner restates. |
| RT-5 | red team | **FIXED.** The blocked headline dropped the "X uses its own settings" line the unblocked one shows, so a temporary block hid a persistent setting. Extracted `differingNames` and shared it; skipped where the title already names those locations. |
| RT-4 / spec-L4 | red team + spec | **FIXED.** `does not report a reason for an autopilot tier whose sale is paused` was byte-equivalent to the passing-baseline case and could not fail for the reason its comment named. It now pins the builder's parameter list — which fails for a real defect: a future edit threading purchasability in. The behavioural trap protection was always the loader test, which is mutation-verified. |
| RT-8 / spec-M2 | red team + spec | **FIXED (definition).** The Posting block definition over-claimed — "declines every draft" — and that sentence had been copied into the glossary and two directory rows. `archived_location` and `active_zernio_connection_missing` are structural but PER-LOCATION, so a single-location account can be blocked while the headline claims posting. The module, glossary and directory now scope the claim to account-wide and name three residual classes. The spec axis named Zernio; `archived_location` one line above is the same class and is named too. |
| RT-7 | red team | **FIXED.** `flag-flip/SKILL.md` gained step 5b: read the flag back from the boot log. #1173 shipped the capability; the runbook that exists to verify flips did not use it. |
| AP-1 + AP-2 | adversarial | **FIXED (copy), owner-adjudicated.** This page runs in the Vercel process and reads the flags from ITS env, while the gates that refuse a draft read them on Railway — the two can disagree until both are set and Vercel redeploys. **The exposure is pre-existing**: readiness already read the same flags on Vercel at the fork point (`d79bc765:settings.ts:1184`). This branch does not introduce the split; it built a stronger claim on it. Owner chose to soften the claim in both directions rather than build a worker-owned observation. "are set to post", never "posts"; "not set up to post automatically", never "no reply posts". A supporting line now says safety checks and service availability can still route a reply to the owner. |

## Rejected, with evidence

| ID | Verdict |
|---|---|
| RT-1b (Judge health) | **REJECTED**, and independently confirmed by RT-9: `applyJudgeGate` has exactly two arms, `providerModerationValidated()` is expansion-only, `zernioPublishingEnabled()` has no publisher gate, `reviewSafety` has no flag. `JUDGE_ENABLED=true` + dead sweep is the only health residual, as claimed. `isJudgeHealthy` is three fleet-wide queries scoped by its own docblock to the publisher gate; the screen reports configured eligibility, the publisher owns the live decision. |
| RT-3 | **DEFERRED to a follow-up ticket**, owner-adjudicated. `src/lib/agents/operator/context.ts:96` reduces the same response without reading `posting`, so the Owner Operator can still claim a rule is live — the same defect class, one surface over, and `judge_disabled` has no readiness analogue so it is fully invisible there. Production code outside the locked surface; fixing it needs its own tests and review pass. |
| RT-9, RT-10, RT-11, RT-12, RT-13 | **REJECTED by red team itself**, each with evidence. Of note: RT-12 — "this account is on Copilot" for a missing account row is unreachable, because `auto_approval_policies.account_id` is FK-constrained, so no policy row outlives its account. |
| AP low-confidence appendix | **NOTED, not actioned.** A third tier might change location limits without changing auto-posting entitlement, at which point the modal's autonomy warning should derive from the entitlement transition rather than from order. No third-tier contract exists, so this is not a present defect. |

## Named residuals, carried to the PR

1. `JUDGE_ENABLED=true` with a dead judge sweep still reads as set-up-to-post.
2. `archived_location` and `active_zernio_connection_missing` are per-location; a single-location account can be blocked while the headline reads as set up.
3. The settings page reads flags in the Vercel process; the gates read them on Railway. Pre-existing, mitigated by copy, not eliminated.
4. The Owner Operator surface still makes the #1314 claim (RT-3, ticketed).
