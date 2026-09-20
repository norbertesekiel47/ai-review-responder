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

---

# Red team round 2 — scoped to the fix hunks (`825f0fbbf..9a7a459f9`)

**Round 2 found two P0s, both introduced by round 1's own fixes.** That is the
case the scoped second round exists for, and it is the strongest argument in
this run's record for not skipping it. Neither was in the original branch.

## P0 — fixed

| ID | Verdict |
|---|---|
| RT2-1 | **FIXED.** Step 5b's boot-log example named four fields the logger does not emit. The real record is `{"timestamp","level","service","logger","message","data":{"flags"}}`; the doc said `prefix` / `"[worker]"` / `msg` / top-level `flags`. `createWorkerLogger`'s docblock states "the prefix becomes `logger`", and `normalizeLoggerName` (`logger.ts:29`) strips the brackets, so `logger` reads `worker` even though the call passes `'[worker]'`. An operator following the step would have grepped a field that does not exist and, per the step's own wording, waited forever. **The procedure written to close RT-7 did not work.** Corrected in both parity-checked copies, with the grep target named explicitly. |
| RT2-2 | **PARTIALLY FIXED in round 2 — see the round-3 section below, which corrects this row.** Round 2's account was: The std-M3 suppression keyed on `posting.blocked`, but the blocked banner also requires `!suspended` and an armed policy. In the gap the reason was suppressed while nothing said it, `readinessCopy` fell to zero items, and `ReadinessBlock` (`:1403`) rendered the green "✓ You can widen or narrow auto-posting whenever you like" — while `canExpand` was computed server-side from the UNFILTERED list (`readiness.ts:45`). A false capability claim, newly introduced, on the exact surface #1314 exists to fix. Root cause was two predicates for one question, so the fix makes that unrepresentable: `describePolicyStatus` is now computed ONCE in the parent and both the banner and the suppression read the same `status.tone`. Two tests added and verified against the re-applied bug — 2 failed / 58 passed. **Both claims in the previous sentence were wrong, and round 3 proved it:** the fix closed only the sub-case where the blocked banner is NOT rendering, and the test that claimed to pin the invariant never reached the blocked branch at all. Corrected in round 3. |

## P1 — fixed or adjudicated

| ID | Verdict |
|---|---|
| RT-2 | **FIXED (claim), duplicate NAMED.** Round 1's "FIXED" was overstated and this record said so wrongly. A fourth copy exists at `scripts/verify-stripe-price-parity.ts:16` — literally re-declared beside a Stripe Price iteration, which is the pattern the docblock forbade. The docblock now states what is true: it owns tier order for PRODUCT code (three copies collapsed), and names the script copy as a known remaining one to fold in when that file is next touched. `TiersSection.tsx:13` is **not** a copy — its `ORDER` is over a local `Mode` animation union, a different concept sharing two element names. |
| RT2-3 | **FIXED.** The module header still claimed "never a second `readFlag` call site" after line 79 became exactly that. Header now states the one documented exception. The directory row was worse: it claimed thirteen keys while naming five autonomy flags, omitted the moderation flag entirely, and repeated the false `readFlag` claim. Rewritten to name all thirteen, state the inclusion RULE, and explain the `AUTOPILOT_PURCHASABLE` exception. |
| RT2-5 | **FIXED.** The AP-1/AP-2 softening never reached the override-only unblocked headline, which still said "posts replies automatically" with no supporting line. Reachable whenever the account default is off and an override is armed. Now "is/are set to post", with the same supporting line. |
| RT-3 | **ACCEPTED RISK — owner-authorized, recorded here verbatim.** The owner was shown the finding and chose "Follow-up ticket": the Owner Operator surface is production code outside the locked edit surface, fixing it needs its own tests and review pass, and the branch fixed the surface the issue named. Filed as **#1352** carrying the red-team evidence, the readiness-cannot-substitute reasoning, and the trap warning. |

## P2 — fixed

| ID | Verdict |
|---|---|
| RT2-7 | **FIXED.** `differingNames`' skip keyed on `threshold` alone, so a differing-but-OFF override was dropped from the blocked headline: the title names the ARMED overrides while the helper covers every differing one. Added `differingExceeds` so the skip happens only when the title already printed the same names. |
| RT2-8 | **ADDRESSED as documentation.** The `'[worker]'` literal is a CONSISTENCY pin, not a behaviour pin — `normalizeLoggerName` strips brackets, so `'worker'` emits identical output. Kept deliberately (every other call in that file is bracketed; one prefix style for an operator grepping boot output) and the test now says so, which is what the finding was really about. |
| RT2-9 | **ADDRESSED.** The go-live oracle reads one line, so a wrapped continuation would pass silently. It now pins the count at 6 with a legible failure message, so a reword that splits the line or drops a flag fails loudly instead of going quiet. |
| RT2-6 | **ACCEPTED as a partial oracle, knowingly.** The RT-4 replacement pins the builder's parameter list and never invokes the builder, so it fires only for a REQUIRED added param, via typecheck. That is strictly better than the byte-equivalent duplicate it replaced, and the behavioural trap protection was always the mutation-verified loader test. Recorded rather than over-built. |
| RT-6 | Carried from round 1, out of round 2's scope. The prose-absence check is a source-substring proxy for a contract that genuinely is an absence; escaped defect is log noise. |

## Residuals carried to the PR

1. `JUDGE_ENABLED=true` with a dead judge sweep still reads as set-up-to-post.
2. `archived_location` and `active_zernio_connection_missing` are per-location; a single-location account can be blocked while the headline reads as set up.
3. The settings page reads flags in the Vercel process; the gates read them on Railway. Pre-existing, mitigated by copy, not eliminated.
4. The Owner Operator surface still makes the #1314 claim — **#1352**, owner-authorized deferral.
5. `scripts/verify-stripe-price-parity.ts:16` keeps its own tier-order copy.

---

# Red team round 3 — owner-authorized, scoped to round 2's fix hunks

Round 3 was authorized because round 2's fixes moved the tree, making its own
sidecar stale by construction — the wall #1184 raised the cap from 2 to 3 to
clear. It found that **round 2's headline fix was half a fix, and that three
committed documents said otherwise.**

| ID | Verdict |
|---|---|
| RT2-2 | **NOW FIXED, structurally.** Round 2 closed only the sub-case where the blocked banner is not rendering. Round 3's probe C — armed default, `posting.blocked`, `blockReasons: ['provider_moderation_disabled']`, `canExpand: false` — reaches `tone === 'blocked'`, the filter suppresses the reason, and the green affirmative renders **beside the blocked banner with the widen control disabled**. Reachable in production: `providerModerationValidated()` is an independent flag, so `OPENAI_MODERATION_ENABLED=false` yields exactly that one reason. Probe D showed the pre-existing `policy_suspended` filter does the same. The real fix is not another filter condition: `ReadinessBlock` now takes `canExpand` and renders the affirmative only when the SERVER says expansion is open, so no filter can produce a false one. Verified by removing the guard: the test fails on probe C by name. |
| RT3-1 | **FIXED (the claims).** `triage-verdicts.md` said "the fix removes the whole class" and D12 said the test "pins the real invariant". Both false. Corrected in place rather than quietly dropped, because a review record that overstates a fix is worse than one that omits it. |
| RT3-2 | **FIXED.** The invariant test was vacuous for its stated purpose: it spread `baseState` (`threshold: null`, one inheriting location), so `overrideNames` was empty, the blocked branch was never taken and `tone` was `'off'` in all three iterations. **It failed under the re-applied bug only because that bug keyed on `posting.blocked`, which the fixture does set** — so my "2 failed / 58 passed" proof was real but measured the wrong thing. Rewritten to drive the `blocked()` helper plus the suspended path, covering both filters that can empty the list, and re-verified against the surviving defect. |
| RT3-3 | **FIXED.** `differingExceeds` and the RT2-5 supporting line shipped with no covering assertion. Both now pinned, and both mutation-checked in both directions. |
| RT2-R3 | **Rejection correctly overturned; now FIXED.** The RT2-7 correction traded a dropped name for a duplicated one — the title names the armed overrides while the helper covered every differing one. `differingNames` now takes an exclusion list keyed by `locationId`, not display name, so two locations sharing a name do not collapse. |
| RT2-1, RT-2, RT2-3, RT2-5, RT2-7, RT2-9 | **Verified FIXED** by round 3, independently re-derived. Notably RT2-1's record shape was re-derived from `buildBaseRecord`/`emit`/`sanitizeAnalyticsProperties`, and round 3 added a fact worth keeping: `service` reads `LOG_SERVICE` if Railway sets it, so `"message":"Feature flags"` is the only safe grep key — which is the key the step already names. |
| RT2-8 | **Rejected** — a deliberate style pin, and the bracketed-prefix convention claim verified. |
| RT-3 | **accepted-risk**, corroborated: #1352 exists, is OPEN, and was created *before* the fix commit. The deferral is executed, not merely asserted. |
| RT2-6 | **open, NOT accepted-risk** — and round 3 was right to refuse my disposition. `accepted-risk` requires an authorization entry naming the finding; none exists for RT2-6. It is P2 and blocks nothing. |

## The lesson this round is worth keeping

Round 1's fixes created two P0s. Round 2's fix for one of them was half a fix,
and the test proving it was vacuous. **Three times on this branch, a fix applied
under review pressure got less scrutiny than the code it corrected** — and each
time the evidence looked green.

The pattern is not carelessness; it is that a fix is written with the failing
case in mind and tested against that case alone. The corrections that held were
the ones that changed the SHAPE rather than the condition: computing
`describePolicyStatus` once instead of aligning two predicates, and keying the
affirmative on `canExpand` instead of adding a third filter clause.
