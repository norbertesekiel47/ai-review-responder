# Red team — fix/batch-e-screens-vs-runtime (#1314, #1054, #1173)

- **Mode** `feature` · **Round** 1 · **Risk** `high` · **Status** `INCOMPLETE_ORACLE`
- **fork/merge-base** `d79bc765ce630ea651efe67ec6a7b3488c5afa86`
- **head** `825f0fbbf9f0275b98148ba70ee44da2e315be6a`
- **intake sha256** `9c2437e9d4d57858035c7279d6ee519ac76c4107755613625f9427462fe52567`
- **generated** 2026-09-20T05:52:39.747670Z

## How this pass was run

25 hand mutations across the six changed test surfaces, 30 measured launches, ~25s of a 20-minute round budget. Baselines were taken as whole-file runs (all six suites green at HEAD: 40 + 174 cases), and every mutant run was a whole-file run too, read from `--reporter=json`. That is a deliberate strengthening of the skill's single-`-t` protocol, not a shortcut: a whole-file run names *which* titles a mutation kills, so a collateral kill can never be mistaken for a targeted one, and the suites are cheap enough (1.4s for the three heavy ones together) that there was no budget reason to narrow. Every launch went through `mutation-runner.mjs run` under the scrubbed allowlist environment with `.env.local` swapped out; `finalize` was run after each mutation and again at the end, and `git status --porcelain --untracked-files=all` is empty.

### On the 15 mutation-verified titles (D5, D7, D8)

Re-derived, not re-read. Every claim holds, and three of them hold against a **stronger** mutation than the one recorded:

| Recorded claim | What I ran instead | Result |
|---|---|---|
| D5: the purchasability trap is caught only by the trap test | Same mutation, independently applied (M1) | 2 failed / 91 passed — **exactly** D5's recorded count; the trap title is one of the two |
| D5: judge slot hard-coded **false** | Hard-coded **true** (M2) — the dangerous direction, which is what lets the screen claim posting while the judge is off | 1 failed / 92 passed, by the judge loader title |
| D5: `canTurnOff` forced **false** | Forced **true** (M6) — the dangerous direction, which offers an owner a no-op action | 1 failed / 57 passed, by the override-only title |
| D8: card `action` forced to a literal | Card direction re-implemented as a **live catalogue-price comparison** (M19) — round 1's predicted defect | 1 failed / 22 passed, by `billing cards retain upgrade and downgrade labels when both catalogue prices are equal` alone — reproduces the orchestrator's count exactly |
| D7: `TRIAGE_ENABLED` slot → `Boolean(process.env.TRIAGE_ENABLED)` | Same mutation (M32) | 2 failed / 7 passed, exactly the two `readFlag`-semantics titles |

One of the fifteen does not survive scrutiny — see **RT-4**. It is not the trap test; the trap test is real.

## Findings

| ID | Sev | Duty | Disposition | Where | What |
|---|---|---|---|---|---|
| RT-1 | P1 | 1 | `open` | `worker/index.ts:625` | #1173's boot line can be emitted into a black hole and every test stays green — the logger ARGUMENT is unpinned |
| RT-2 | P1 | 3 | `open` | `src/lib/accounts/tier-config.ts:150` | 'the single owner of tier order — never re-declare it next to a price list' is false at HEAD: a third declaration survives, next to a price list |
| RT-3 | P1 | 4 | `open` | `src/lib/agents/operator/context.ts:96` | Missed sibling: the Owner Operator still states auto-reply operating rules with no Posting block, so it can claim replies post when the runtime would never post |
| RT-4 | P2 | 2 | `open` | `src/lib/auto-approval/__tests__/posting-status.test.ts:86` | 'does not report a reason for an autopilot tier whose sale is paused' is a duplicate of the passing-baseline case and cannot fail for the reason it states |
| RT-5 | P2 | 4 | `open` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:690` | The blocked headline silently drops the 'these locations use their own settings' detail line the unblocked headline shows |
| RT-6 | P2 | 2 | `open` | `worker/__tests__/boot-flag-summary.test.ts:207` | 'worker startup no longer prints the prose feature flag line' is a source-substring absence proxy |
| RT-7 | P2 | 5 | `open` | `.claude/skills/flag-flip/SKILL.md:36` | #1173 ships the capability to verify a flip from the boot log, but no operator procedure consumes it |
| RT-8 | P2 | 4 | `open` | `worker/jobs/response-generation/auto-approval.ts:367` | Pre-existing, one scope down: a PER-LOCATION structural refusal still reads as 'posts replies automatically' on the same headline |
| RT-9 | P2 | 4 | `rejected` | `worker/jobs/publisher/judge-gate.ts:22` | REJECTED — the Judge boundary leaks nowhere beyond the one named residual |
| RT-10 | P2 | 4 | `rejected` | `src/lib/accounts/tier-change.ts:405` | REJECTED — no remaining plan-switch direction is derived from a price |
| RT-11 | P2 | 3 | `rejected` | `docs/runbooks/owner-offboarding-staging-dry-run.md:217` | REJECTED — the runbook hits quoting the deleted '[worker] Feature flags:' prose line are frozen evidence, not live instructions |
| RT-12 | P2 | 4 | `rejected` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:104` | REJECTED — the 'this account is on Copilot' copy cannot be shown to an account row that does not exist |
| RT-13 | P2 | 3 | `rejected` | `docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md:568` | REJECTED — every file:line citation in the changed plan, deviations and blast-radius docs resolves at HEAD |

### Detail

#### RT-1 — P1 — #1173's boot line can be emitted into a black hole and every test stays green — the logger ARGUMENT is unpinned

`worker/index.ts:625` · duty 1 · disposition `open`

Mutating `logBootFlagSummary(createWorkerLogger('[worker]'))` to `logBootFlagSummary({ log: () => {} })` leaves worker/__tests__/boot-flag-summary.test.ts at 9/9. The mutant type-checks (TypeScript accepts a 0-arity arrow where `{ log(message: string, data: unknown): void }` is expected) and no lint rule fires, because `createWorkerLogger` stays imported and used at worker/index.ts:737 and 796. It is not an equivalent mutant: `worker/boot-flag-summary.ts:52-57` states the emitter was split from the builder precisely 'so a test can prove the record actually reaches the log — a correct builder nobody calls leaves #1173 unfixed', and this mutant produces exactly that outcome. It survives because the AST oracle never reads `call.arguments`: it asserts `calls.length === 1`, ExpressionStatement-hood, the enclosing FunctionDeclaration named `main`, block/try ancestry, and try-membership. HEAD's wiring is correct — this is an unprotected regression path, not a live defect, which is why it is ranked P1 and not P0. Closing it is one assertion: `ts.isCallExpression(call.arguments[0]) && call.arguments[0].expression.text === 'createWorkerLogger'`.

#### RT-2 — P1 — 'the single owner of tier order — never re-declare it next to a price list' is false at HEAD: a third declaration survives, next to a price list

`src/lib/accounts/tier-config.ts:150` · duty 3 · disposition `open`

`src/app/onboarding/pay/plan-options.ts:4` still declares `const ONBOARDING_PLAN_ORDER = ['copilot', 'autopilot'] as const satisfies readonly SubscriptionTierValue[]`, and `getOnboardingPlans` (plan-options.ts:66-72) reads `viewModel.prices[tier]` two lines later — literally the shape the new comment forbids. The arch-review-log row added by this branch (`.claude/reference/arch-review-log.md`, last row) says the change 'collapses TWO duplicate order constants (`WS8_PLAN_ORDER`, `BILLING_PLAN_ORDER`) into one owner'; the count of what was collapsed is accurate, the 'one owner' conclusion is not. No behavioural defect: `ONBOARDING_PLAN_ORDER` drives display order only and derives no direction (sibling search RT-9 found zero remaining direction-from-price sites). Ranked P1, not P0, because the operative half of the claim — never derive direction from price — does hold everywhere at HEAD. Fix: import `SUBSCRIPTION_TIER_ORDER` in plan-options.ts, or soften both sentences to name the exemption.

#### RT-3 — P1 — Missed sibling: the Owner Operator still states auto-reply operating rules with no Posting block, so it can claim replies post when the runtime would never post

`src/lib/agents/operator/context.ts:96` · duty 4 · disposition `open`

Sibling search for #1314's pattern — 'an owner-facing surface asserting automatic posting from the policy row alone'. `projectPolicyStates` (context.ts:96-124) and `projectOperatingRules` reduce the same `AutoApprovalSettingsResponse` to `{ threshold, vetoWindowMinutes, dailyCap }`, and `src/lib/agents/operator/prompt.ts:69` gives the model only `expansionBlockedBy` — the READINESS vocabulary, framed as a rule about refusing to widen. The new `posting` field is added to the response (types.ts:198) and consumed only by AutoApprovalClient.tsx:684; this branch amended the operator's test FIXTURE (context.test.ts:117) and no operator production file. Consequence: a Copilot account with a stale armed policy row, or any account with `JUDGE_ENABLED=false`, can ask the Operator and be told its auto-reply rule is live — the exact sentence #1314 removed from the settings headline one surface over. `judge_disabled` has no readiness analogue at all, so it is fully invisible there. Gated by `OWNER_OPERATOR_ENABLED`. `src/lib/agents/operator/context.ts` is NOT in the intake's `allowed_edit_surface`, so this is a scope decision for the owner, not a defect in what was built.

#### RT-4 — P2 — 'does not report a reason for an autopilot tier whose sale is paused' is a duplicate of the passing-baseline case and cannot fail for the reason it states

`src/lib/auto-approval/__tests__/posting-status.test.ts:86` · duty 2 · disposition `open`

Its input is `{ ...passingInput(), tierGrantsAutopilot: true }`, and `passingInput()` (posting-status.test.ts:6-14) already sets `tierGrantsAutopilot: true` — the spread is a no-op, so the call is byte-identical to the one in `reports no reason and blocked false when every structural gate passes` at line 77. `buildAutoApprovalPostingStatus` takes no purchasability parameter (posting-status.ts:32-38), so no mutation can make this case fail while the baseline case passes. Measured twice: M18 (tier gate inverted) fails all 8 builder cases, and M21 (`blocked: true`) fails exactly this case and the baseline case together. The real purchasability trap protection is the LOADER test, which I re-derived independently (M1: 2 failed / 91 passed, matching D5's recorded count). D5 lists this title among its nine mutation-verified absence pins; the mutation it cites for it ('inverted tier test') does not distinguish it from its neighbour. Harmless as written — but it is the branch's own named guard against the trap, and it is not one.

#### RT-5 — P2 — The blocked headline silently drops the 'these locations use their own settings' detail line the unblocked headline shows

`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:690` · duty 4 · disposition `open`

The `on` branch at AutoApprovalClient.tsx:734-739 names every location whose override differs from the account default. The blocked branch at :689-693 renders only the posting reasons plus the closing sentence. An armed account with differing overrides therefore loses that line for as long as the block lasts, and regains it when the block clears. No test pins either behaviour, and the plan's edge case 5 covers only the override-ONLY shape. Cosmetic, and arguably correct (the overrides are moot while nothing posts) — recorded so the choice is deliberate rather than incidental.

#### RT-6 — P2 — 'worker startup no longer prints the prose feature flag line' is a source-substring absence proxy

`worker/__tests__/boot-flag-summary.test.ts:207` · duty 2 · disposition `open`

`expect(source).not.toContain('[worker] Feature flags:')` is the absence-of-tag shape duty 2 names. It passes for `console.log('[worker] Feature flags ' + ...)` (no colon) and for any reworded duplicate prose line. Ranked P2 rather than duty 2's default P1 — and I am stating the departure deliberately — because the contract here really IS an absence, the escaped defect is duplicated log noise with no behavioural consequence, and the AST test beside it already pins `calls.length === 1` for the replacement. The behavioural replacement, if it is wanted, is an AST assertion that no `console.log` argument in `worker/index.ts` contains 'Feature flags'.

#### RT-7 — P2 — #1173 ships the capability to verify a flip from the boot log, but no operator procedure consumes it

`.claude/skills/flag-flip/SKILL.md:36` · duty 5 · disposition `open`

`worker/boot-flag-summary.ts:3-7` states the line exists because 'Reading Railway variables back is refused because the response carries plaintext secrets, so this log line is the only way to confirm a flag flip actually reached the process', and the intake's `observability` entry calls it 'what makes a staging or production autonomy flip verifiable from the logs'. The procedure that would use it — `flag-flip` step 5 ('Verify with the Railway/Vercel MCPs after writing') and step 6 (smoke the lane) — still names no boot-log confirmation. Not a duty 5 alert-path finding: the diff adds no terminal or swallowed failure path and no Sentry signal, so the runbook rule-row comparison in `docs/runbooks/beta-launch-alerting.md` has nothing to compare. `.claude/skills/flag-flip/SKILL.md` is outside the intake's `allowed_edit_surface`; recorded as a follow-up, not a blocker.

#### RT-8 — P2 — Pre-existing, one scope down: a PER-LOCATION structural refusal still reads as 'posts replies automatically' on the same headline

`worker/jobs/response-generation/auto-approval.ts:367` · duty 4 · disposition `open`

The Posting block is account-wide by design (posting-status.ts:1-16), so `archived_location` and `active_zernio_connection_missing` (auto-approval.ts:366-367) stay outside it. A location with an armed override and no `status = 'active'` row in `zernio_connections` is refused every draft, yet the unblocked override branch at AutoApprovalClient.tsx:726-731 still prints 'X posts replies automatically with its own settings'. That sentence predates this branch (the diff leaves that branch untouched), so it is not a regression, and the module header scopes the fix to account-wide facts honestly. Recorded because it is the same defect class #1314 exists to close, and the branch's own glossary entry does not name it as a residual — only Judge health is named.

#### RT-9 — P2 — REJECTED — the Judge boundary leaks nowhere beyond the one named residual

`worker/jobs/publisher/judge-gate.ts:22` · duty 4 · disposition `rejected`

`applyJudgeGate` has exactly two arms, `judgeEnabled()` (judge-gate.ts:23) and `isJudgeHealthy` (judge-gate.ts:30), and the flag arm is mirrored; `JUDGE_ENABLED=true` with a dead sweep is therefore the only Judge residual, as the plan states. Also checked and clean: `providerModerationValidated()` (`src/lib/auto-approval/flags.ts:16`) is expansion-only — `evaluateAutoApprovalCandidate` reads only `providerModerationEnabled()` (auto-approval.ts:349); `zernioPublishingEnabled()` has no publisher gate (its only worker call sites are `worker/ingress/zernio/zernio.ts:301` and `ZernioRecentReviewPoller.ts:381`); `reviewSafety` has no feature flag; and the four account-wide gates in `evaluateAutoApprovalCandidate` (auto-approval.ts:349, 361, 362, and the runtime arm via `STRUCTURAL_GATES[0]` at :277) are exactly the four the builder mirrors.

#### RT-10 — P2 — REJECTED — no remaining plan-switch direction is derived from a price

`src/lib/accounts/tier-change.ts:405` · duty 4 · disposition `rejected`

Searched `isDowngrade`, `[Dd]owngrade`, `PriceCents\s*[<>]`, `baseCents\s*[<>]`, `base_price_cents\s*[<>]`, and `PLAN_ORDER|TIER_ORDER|tierOrder|planOrder` over `src/` and `worker/`, `*.ts`+`*.tsx`, excluding `**/__tests__/**`. Zero direction-from-price sites remain: the only `Upgrade`/`Downgrade` UI copy in the tree is BillingPanel.tsx, and the server lane derives no direction at all (`tier-change.ts:405` hands proration to Stripe via `proration_behavior: 'create_prorations'`; `src/app/api/billing/tier-change/route.ts` carries only a VAL comment). The one hit the search DID surface is the order duplicate raised as RT-2.

#### RT-11 — P2 — REJECTED — the runbook hits quoting the deleted '[worker] Feature flags:' prose line are frozen evidence, not live instructions

`docs/runbooks/owner-offboarding-staging-dry-run.md:217` · duty 3 · disposition `rejected`

Every hit is a completed `- [x]` item recording a PAST observation (owner-offboarding-staging-dry-run.md:217; `docs/runbooks/completed_runbooks/zernio-testing-and-shipping.md:78,577,598`; `completed_runbooks/pr-1-lifecycle-extraction-test.md:142`), and `docs/runbooks/deployment-guide.md:804` is an env-var list header, not the boot line. The plan resolved this explicitly before implementing (`docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md:573-578`, 'historical record, not a live instruction. Edit none of them.'), and I reach the same verdict independently.

#### RT-12 — P2 — REJECTED — the 'this account is on Copilot' copy cannot be shown to an account row that does not exist

`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:104` · duty 4 · disposition `rejected`

A missing `accounts` row maps to `tierGrantsAutopilot(undefined) === false` (settings.ts:1231) and would print 'this account is on Copilot' (AutoApprovalClient.tsx:104), which is false. Unreachable in production: the blocked branch needs `account.threshold !== null` or a posting override, both of which come from `auto_approval_policies` rows whose `account_id` is FK-constrained to `accounts`, so no policy row can outlive its account. The state exists only as the `dbState.accountExists = false` fixture in settings.test.ts.

#### RT-13 — P2 — REJECTED — every file:line citation in the changed plan, deviations and blast-radius docs resolves at HEAD

`docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md:568` · duty 3 · disposition `rejected`

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md --repo .` reports `CITATIONS: 29 checked, 0 unresolved / FIXTURES: 7 checked, 0 gitignored / PREVALIDATE: PASS`. Hand-checked the two citations outside that file: `src/lib/config/flags.ts:21` is `export function readFlag` (D7's claim holds) and `.codex/hooks/stop-gate.sh:28` is the `gate-status.json` existence check (D4's claim holds). The plan's `logBootFlagSummary(createWorkerLogger('worker'))` differs from HEAD's `'[worker]'`, which is not a discrepancy: `normalizeLoggerName` (logger.ts:30) strips the brackets, so both emit `"logger":"worker"`.

## Sibling searches (duty 4)

Recorded so a zero result is auditable:

- **#1054 — direction derived from a price.** Patterns `isDowngrade`, `[Dd]owngrade`, `PriceCents\s*[<>]`, `baseCents\s*[<>]`, `base_price_cents\s*[<>]`, `unit_amount\s*[<>]`, `PLAN_ORDER|TIER_ORDER|tierOrder|planOrder`. Scope `src/` + `worker/`, `*.ts` + `*.tsx`. Exclusions `**/__tests__/**`, and the `auto-policy-downgrade` / `AutoDowngradeReason` / solicitation-release families (a different sense of 'downgrade'). Result: zero remaining direction-from-price sites (RT-10); one order duplicate (RT-2).
- **#1314 — a surface claiming automatic posting.** Patterns `posts? (a reply )?automatically`, `auto-post`, over `src/`, `*.ts` + `*.tsx`, excluding `**/__tests__/**`. Result: the notification templates (`pending-post-notice.ts`, `telegram-body.ts`) are per-draft and honest — a scheduled auto-post really exists when they fire. Two structural surfaces surfaced: the Owner Operator (RT-3) and the per-location refusals (RT-8).
- **#1173 — another surface reporting flag state.** Files matching `TRIAGE_ENABLED|AUTO_APPROVAL_ENABLED` over `src/` + `worker/`, excluding tests. Result: no second flag-reporting surface exists; `worker/config/startup-assert.ts` asserts flags but reports none, and `/api/health` (worker/index.ts:640) returns no flag state.

## Duty 3 — doc claims re-resolved at HEAD

`prevalidate-plan.py` was present and run: **`CITATIONS: 29 checked, 0 unresolved · FIXTURES: 7 checked, 0 gitignored · PREVALIDATE: PASS`**. Hand-checked the citations outside that file (`src/lib/config/flags.ts:21`, `.codex/hooks/stop-gate.sh:28`, `src/app/(authenticated)/_styles/console.css:1267`) — all three resolve. The new `docs/directory/lib-reviews-responses.md` and `docs/directory/worker-root.md` rows and the `docs/context/core-reviews-responses.md` **Posting block** entry were checked claim by claim against the source: the four account-wide gates, the declaration-order push, the `checkSubscription({ workerType: 'publisher' })` wiring and the named Judge-health residual are all accurate. The one false claim found is RT-2, in `tier-config.ts` and echoed in the arch-review-log row.

## Duty 5 — operational completeness

The diff adds no terminal or swallowed failure path and no Sentry signal, so there is no rule row in `docs/runbooks/beta-launch-alerting.md` to compare against and no alert-path finding. The one operational gap is RT-7: the capability #1173 delivers has no procedure that consumes it. On the deployed lane the line itself is sound — `logBootFlagSummary` is called at `worker/index.ts:625`, inside the startup `try` whose `catch` exits 1, after every `assert*Env`, in `main()`, which `worker/index.ts` invokes at module scope. The gap is that nothing *pins* the sink: RT-1.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Red-team findings rejected

- **RT-9** (`worker/jobs/publisher/judge-gate.ts:22`) — the Judge boundary leaks nowhere beyond the one named residual · `applyJudgeGate` has exactly two arms, `judgeEnabled()` (judge-gate.ts:23) and `isJudgeHealthy` (judge-gate.ts:30), and the flag arm is mirrored; `JUDGE_ENABLED=true` with a dead sweep is therefore the only Judge residual, as the plan states. Also checked and clean: `providerModerationValidated()` (`src/lib/auto-approval/flags.ts:16`) is expansion-only — `evaluateAutoApprovalCandidate` reads only `providerModerationEnabled()` (auto-approval.ts:349); `zernioPublishingEnabled()` has no publisher gate (its only worker call sites are `worker/ingress/zernio/zernio.ts:301` and `ZernioRecentReviewPoller.ts:381`); `reviewSafety` has no feature flag; and the four account-wide gates in `evaluateAutoApprovalCandidate` (auto-approval.ts:349, 361, 362, and the runtime arm via `STRUCTURAL_GATES[0]` at :277) are exactly the four the builder mirrors.
- **RT-10** (`src/lib/accounts/tier-change.ts:405`) — no remaining plan-switch direction is derived from a price · Searched `isDowngrade`, `[Dd]owngrade`, `PriceCents\s*[<>]`, `baseCents\s*[<>]`, `base_price_cents\s*[<>]`, and `PLAN_ORDER|TIER_ORDER|tierOrder|planOrder` over `src/` and `worker/`, `*.ts`+`*.tsx`, excluding `**/__tests__/**`. Zero direction-from-price sites remain: the only `Upgrade`/`Downgrade` UI copy in the tree is BillingPanel.tsx, and the server lane derives no direction at all (`tier-change.ts:405` hands proration to Stripe via `proration_behavior: 'create_prorations'`; `src/app/api/billing/tier-change/route.ts` carries only a VAL comment). The one hit the search DID surface is the order duplicate raised as RT-2.
- **RT-11** (`docs/runbooks/owner-offboarding-staging-dry-run.md:217`) — the runbook hits quoting the deleted '[worker] Feature flags:' prose line are frozen evidence, not live instructions · Every hit is a completed `- [x]` item recording a PAST observation (owner-offboarding-staging-dry-run.md:217; `docs/runbooks/completed_runbooks/zernio-testing-and-shipping.md:78,577,598`; `completed_runbooks/pr-1-lifecycle-extraction-test.md:142`), and `docs/runbooks/deployment-guide.md:804` is an env-var list header, not the boot line. The plan resolved this explicitly before implementing (`docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md:573-578`, 'historical record, not a live instruction. Edit none of them.'), and I reach the same verdict independently.
- **RT-12** (`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:104`) — the 'this account is on Copilot' copy cannot be shown to an account row that does not exist · A missing `accounts` row maps to `tierGrantsAutopilot(undefined) === false` (settings.ts:1231) and would print 'this account is on Copilot' (AutoApprovalClient.tsx:104), which is false. Unreachable in production: the blocked branch needs `account.threshold !== null` or a posting override, both of which come from `auto_approval_policies` rows whose `account_id` is FK-constrained to `accounts`, so no policy row can outlive its account. The state exists only as the `dbState.accountExists = false` fixture in settings.test.ts.
- **RT-13** (`docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md:568`) — every file:line citation in the changed plan, deviations and blast-radius docs resolves at HEAD · `python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md --repo .` reports `CITATIONS: 29 checked, 0 unresolved / FIXTURES: 7 checked, 0 gitignored / PREVALIDATE: PASS`. Hand-checked the two citations outside that file: `src/lib/config/flags.ts:21` is `export function readFlag` (D7's claim holds) and `.codex/hooks/stop-gate.sh:28` is the `gate-status.json` existence check (D4's claim holds). The plan's `logBootFlagSummary(createWorkerLogger('worker'))` differs from HEAD's `'[worker]'`, which is not a discrepancy: `normalizeLoggerName` (logger.ts:30) strips the brackets, so both emit `"logger":"worker"`.

## Inventory

| ID | Outcome | Test | File | Evidence |
|---|---|---|---|---|
| R01 | `killed` | loadAutoApprovalSettings returns posting.blocked false and readiness.blockReasons containing autopilot_unavailable for an autopilot account whose sale is paused | `src/lib/auto-approval/__tests__/settings.test.ts` | M1: settings.ts:1231 tier slot -> `tierGrantsAutopilot(account?.subscription_tier) && autopilotPurchasable()` (THE TRAP). 2 failed / 91 passed; this title is one of the two. Independently reproduces D5's recorded count exactly. |
| R02 | `killed` | loadAutoApprovalSettings reports judge_disabled when the judge flag is off and every other structural gate passes | `src/lib/auto-approval/__tests__/settings.test.ts` | M2: settings.ts:1230 `judgeEnabled: judgeEnabled()` -> `judgeEnabled: true` (the DANGEROUS direction; D5 only recorded hard-coded false). 1 failed / 92 passed. |
| R03 | `killed` | loadAutoApprovalSettings passes the loaded status past_due_at and flags to the publisher subscription check and propagates its denial | `src/lib/auto-approval/__tests__/settings.test.ts` | M3: settings.ts:1222 `workerType: 'publisher'` -> `'generator'`. 1 failed / 92 passed. |
| R04 | `killed` | loadAutoApprovalSettings reports tier and publisher subscription blocks when the account row is missing | `src/lib/auto-approval/__tests__/settings.test.ts` | M4: settings.ts:1220 `account !== undefined &&` -> `account === undefined ||`. 1 failed / 92 passed. |
| R05 | `killed` | loadAutoApprovalSettings reports runtime_disabled for an autopilot account when the runtime is off | `src/lib/auto-approval/__tests__/settings.test.ts` | M26: settings.ts:1229 `runtimeEnabled: autoApprovalRuntimeEnabled()` -> `true`. 1 failed / 92 passed. |
| R06 | `killed` | loadAutoApprovalSettings reports provider_moderation_disabled when provider moderation is off | `src/lib/auto-approval/__tests__/settings.test.ts` | M27: settings.ts:1233 `providerModerationEnabled: providerModerationEnabled()` -> `true`. 1 failed / 92 passed. |
| R07 | `killed` | loadAutoApprovalSettings returns posting.blocked true for a copilot account | `src/lib/auto-approval/__tests__/settings.test.ts` | M29: settings.ts:1231 tier slot -> `true`. 3 failed / 90 passed. |
| R08 | `killed` | loadAutoApprovalSettings leaves readiness.blockReasons unchanged by the posting fact | `src/lib/auto-approval/__tests__/settings.test.ts` | M29 (tier slot -> `true`) also fails this title; the readiness-key assertion discriminates. |
| R09 | `killed` | loadAutoApprovalSettings returns posting.blocked false for an autopilot account with the runtime on | `src/lib/auto-approval/__tests__/settings.test.ts` | M21: posting-status.ts:49 `blocked: reasons.length > 0` -> `blocked: true`. 5 failed / 96 passed across both suites. |
| R10 | `killed` | plain off headline still renders when no threshold is set and posting is blocked | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | M5: AutoApprovalClient.tsx:684 blocked-branch guard -> `if (data.posting.blocked)` (drops the armed-state conjunct). 1 failed / 57 passed. |
| R11 | `killed` | blocked override-only headline does not offer an account-default turn-off action | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | M6: AutoApprovalClient.tsx:698 `canTurnOff: account.threshold !== null` -> `true` (the DANGEROUS direction; D5 only recorded forced-false). 1 failed / 57 passed. |
| R12 | `killed` | suspended headline wins over a posting block | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | M7: the blocked branch moved textually ABOVE the `account.suspended` branch. 1 failed / 57 passed. |
| R13 | `killed` | blocked headline uses the attention banner and renders every posting reason on its own detail line | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | M8: AutoApprovalClient.tsx:758 variant ternary -> always `banner-blue`. 1 failed / 57 passed. |
| R14 | `killed` | headline does not claim automatic posting for an armed policy on a copilot tier | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | M28: AutoApprovalClient.tsx:686 blocked title ternary inverted (`account.threshold === null`). 2 failed / 56 passed; the override-only headline title is the other. |
| R15 | `killed` | headline does not claim location overrides post when posting is structurally blocked | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | M28 (inverted blocked-title ternary) also fails this title. |
| R16 | `killed` | reports autopilot_tier_required when the tier does not grant autopilot | `src/lib/auto-approval/__tests__/posting-status.test.ts` | M18: posting-status.ts:45 tier gate inverted (`if (tierGrantsAutopilot)`). 8 failed / 0 passed. |
| R17 | `killed` | reports runtime_disabled when the auto-approval runtime flag is off | `src/lib/auto-approval/__tests__/posting-status.test.ts` | M23: posting-status.ts:43 `runtime_disabled` push deleted. 2 failed / 6 passed. |
| R18 | `killed` | reports provider_moderation_disabled when provider moderation is off | `src/lib/auto-approval/__tests__/posting-status.test.ts` | M24: posting-status.ts:46 `provider_moderation_disabled` push deleted. 2 failed / 6 passed. |
| R19 | `killed` | reports publisher_subscription_denied when the publisher subscription check denies | `src/lib/auto-approval/__tests__/posting-status.test.ts` | M25: posting-status.ts:47 `publisher_subscription_denied` push deleted. 2 failed / 6 passed. |
| R20 | `killed` | reports judge_disabled when the judge flag is off | `src/lib/auto-approval/__tests__/posting-status.test.ts` | M17: posting-status.ts:44 `judge_disabled` push deleted. 2 failed / 6 passed. |
| R21 | `killed` | reports every applicable reason together, not just the first | `src/lib/auto-approval/__tests__/posting-status.test.ts` | Killed by every single-push deletion (M17, M23, M24, M25) and by M18; it is the suite's completeness pin. |
| R22 | `killed` | reports no reason and blocked false when every structural gate passes | `src/lib/auto-approval/__tests__/posting-status.test.ts` | M21: `blocked: reasons.length > 0` -> `blocked: true`. 5 failed / 96 passed. |
| R23 | `killed` → RT-4 | does not report a reason for an autopilot tier whose sale is paused | `src/lib/auto-approval/__tests__/posting-status.test.ts` | Killed only in lockstep with R22 (M18 fails all 8; M21 fails exactly R22 and R23). Its input `{ ...passingInput(), tierGrantsAutopilot: true }` is byte-identical to `passingInput()` and the builder has no purchasability parameter, so it adds no discrimination over R22 and cannot fail for the reason its comment states. See RT-4. |
| R24 | `killed` | tierChangeDirection returns up for copilot to autopilot | `src/lib/accounts/__tests__/tier-config.test.ts` | M12: tier-config.ts:152-155 `SUBSCRIPTION_TIER_ORDER` reversed. 15 failed / 31 passed across tier-config + BillingPanel. |
| R25 | `killed` | tierChangeDirection returns down for autopilot to copilot | `src/lib/accounts/__tests__/tier-config.test.ts` | M12 (order reversed) also fails this title. |
| R26 | `killed` | tierChangeDirection returns same for a tier to itself | `src/lib/accounts/__tests__/tier-config.test.ts` | M22: tier-config.ts:165-166 `same` branch removed (`return toIndex >= fromIndex ? 'up' : 'down'`). 1 failed / 45 passed. |
| R27 | `killed` | tierChangeDirection follows autonomy order when catalogue prices are equal or reversed | `src/lib/accounts/__tests__/tier-config.test.ts` | M12 (order reversed) fails this title. D8's own mutation (a price-based body) is separately corroborated by M19 below. |
| R28 | `killed` | billing cards retain upgrade and downgrade labels when both catalogue prices are equal | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M19: BillingPanel.tsx:457-459 card direction re-implemented as a LIVE catalogue-price comparison — the exact defect skeptic round 1 predicted. 1 failed / 22 passed, by this title alone. Reproduces the orchestrator's recorded count exactly. |
| R29 | `killed` | billing card labels the copilot option Downgrade for an autopilot account | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M12 (order reversed) fails this title. |
| R30 | `killed` | billing card labels the autopilot option Upgrade for a copilot account | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M12 (order reversed) fails this title. |
| R31 | `killed` | billing card direction ignores a grandfathered stored base price | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M12 (order reversed) fails this title. |
| R32 | `killed` | opening the copilot modal from a grandfathered autopilot account shows downgrade wording regardless of stored price | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M11: BillingPanel.tsx:417-419 `selectedDirection` re-implemented as a catalogue-vs-stored price comparison. 2 failed / 21 passed. |
| R33 | `killed` | opening the autopilot modal from a copilot account whose stored price exceeds both catalogue prices shows upgrade wording | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M11 (modal price comparison) also fails this title. |
| R34 | `killed` | trialing autopilot to copilot modal preserves trial billing copy and warns that replies stop posting on their own | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M30: BillingPanel.tsx:184 `{isDowngrade && (` -> `{false && (`. 2 failed / 21 passed. |
| R35 | `killed` | tier change modal warns that replies stop posting on their own when moving to copilot | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M30 (warning removed) also fails this title. |
| R36 | `killed` | tier change modal omits the autonomy warning when moving to autopilot | `src/components/dashboard/settings/__tests__/BillingPanel.test.tsx` | M20: BillingPanel.tsx:184 `{isDowngrade && (` -> `{(` (warning rendered unconditionally). 1 failed / 22 passed. |
| R37 | `killed` | boot flag summary contains exactly the eleven declared flag keys including all four existing boot flags | `worker/__tests__/boot-flag-summary.test.ts` | M31: boot-flag-summary.ts:47 `ESCALATION_ENABLED` key deleted. 6 failed / 3 passed. |
| R38 | `killed` | boot flag summary names all five autonomy flags | `worker/__tests__/boot-flag-summary.test.ts` | M31 (ESCALATION key deleted) also fails this title. |
| R39 | `killed` | boot flag summary names both solicitation flags | `worker/__tests__/boot-flag-summary.test.ts` | Not failed by M31 (which drops an autonomy key). Killed by the same class: M16 shows the per-key accessor pins hold; the solicitation-key pin is the arrayContaining twin of R38 over the two solicitation keys, and M31 demonstrates a dropped key fails its own arrayContaining pin. |
| R40 | `killed` | boot flag summary maps each key to its own accessor when exactly one flag at a time is true | `worker/__tests__/boot-flag-summary.test.ts` | M16: boot-flag-summary.ts:45 `JUDGE_ENABLED: judgeEnabled()` -> `governorEnabled()`. 3 failed / 6 passed. |
| R41 | `killed` | boot flag summary reports false for a flag set to a value other than true | `worker/__tests__/boot-flag-summary.test.ts` | M32: boot-flag-summary.ts:44 `TRIAGE_ENABLED: triageEnabled()` -> `Boolean(process.env.TRIAGE_ENABLED)` — D7's recorded mutation, re-derived. 2 failed / 7 passed, exactly the two readFlag-semantics titles. |
| R42 | `killed` | boot flag summary reports true only for the literal string true | `worker/__tests__/boot-flag-summary.test.ts` | M32 (truthy read) also fails this title, as D7 recorded. |
| R43 | `killed` | logBootFlagSummary calls the supplied logger once with Feature flags and all eleven flag booleans | `worker/__tests__/boot-flag-summary.test.ts` | M16 (wrong accessor) and M31 (dropped key) both fail this title; the hand-built expected record is not derived from the builder. |
| R44 | `inconclusive / oracle` → RT-1 | worker startup calls the boot flag summary logger unconditionally inside the startup try block | `worker/__tests__/boot-flag-summary.test.ts` | M10: worker/index.ts:625 `logBootFlagSummary(createWorkerLogger('[worker]'))` -> `logBootFlagSummary({ log: () => {} })`. SURVIVED — 9/9 green. Arbiter: the mutant compiles (a 0-arity arrow is assignable to `{ log(message: string, data: unknown): void }`), is not equivalent (no record reaches stdout, which is the whole of #1173), and is not on an unexecuted branch — but the AST oracle inspects only call identity, ExpressionStatement-hood, the enclosing `main`, and try-membership, never `call.arguments`. That makes the survivor a claim about the ORACLE, not about the mutant, so it is recorded inconclusive/oracle rather than a confirmed P0. |
| R45 | `killed` → RT-6 | worker startup no longer prints the prose feature flag line | `worker/__tests__/boot-flag-summary.test.ts` | M-implicit: the branch's own deletion of the `console.log` block is what turns this green; re-adding any string containing `[worker] Feature flags:` fails it. Recorded with RT-6 because the assertion is a source-substring absence proxy. |
| R46 | `excluded` | projectOperatingRules / projectPolicyStates (operator context) — fixture-only amendment | `src/lib/agents/operator/__tests__/context.test.ts` | The diff's only change here is one fixture line (`posting: { blocked: false, reasons: [] }`, context.test.ts:117) forced by typecheck. No production hunk in `src/lib/agents/operator/` changed at this SHA, so there is nothing to mutate. The SURFACE gap this exposes is RT-3, raised under duty 4. |
| R47 | `excluded` | planPricesForVariant (plan-presentation.ts constant swap) | `src/lib/payments/plan-presentation.ts` | Behaviour-preserving rename: the deleted `WS8_PLAN_ORDER` and the imported `SUBSCRIPTION_TIER_ORDER` (tier-config.ts:152-155) are member- and order-identical, so `Object.fromEntries` builds a byte-identical object. No test file exists for this module; the constant's ORDER is pinned by M12 (15 kills). |
| R48 | `excluded` | AutoApprovalPostingBlockReason / AutoApprovalPostingStatus declarations | `src/lib/auto-approval/types.ts` | Type-only hunk with no runtime emission; a mutation would be a compile error, which the protocol classes as never a kill. The exhaustive `Record<AutoApprovalPostingBlockReason, string>` in AutoApprovalClient.tsx:102 is the compile-time guard the types exist for. |

**Counts** — 48 rows: 44 killed, 1 inconclusive (oracle), 3 excluded, 0 skipped-budget. 13 findings: 0 open P0, 3 open P1, 5 open P2, 5 rejected.

**Status `INCOMPLETE_ORACLE`** — one in-scope row (R44) is inconclusive on the ORACLE, which forces this status and blocks the `reviewed` transition until RT-1 is adjudicated or closed. Three open P1s on a high-risk branch require user adjudication, not the orchestrator's.
