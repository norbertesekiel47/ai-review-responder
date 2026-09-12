# Evidence — Admin API bearer-only (#1203)

Runbook: [deployment-guide.md](../deployment-guide.md), §II.5.
Execution contract: [.agents/skills/runbook/SKILL.md](../../../.agents/skills/runbook/SKILL.md).

## Environment

- Staging only: source UI/API https://staging.repworth.net; Admin UI https://admin.staging.repworth.net.
- Staging Supabase: `kubdiqdhqbhwmqfditeg`; production `udeyaqnvpojbwgoaxwdg` is NEVER touched by this campaign.
- Worker: https://repworth-worker-staging.up.railway.app; no worker-specific operation is exercised.
- Stripe: no billing or provider operation; test environment only.
- Starting source main/staging: `f747cb7b64f8af5a7b74691110b0d10d9d8ff897` (#1193, PR #1264).
- Expected Admin app main/staging: `44452f060f78c691cc81188b6bbd05a6d3be82c1`.
- Worktree: `codex-1203-admin-bearer-only`; reviewed implementation `732548997f725ac9e1bc42225dfd01664b058de8`; staging candidate/deployment pins pending.
- Preparation UTC: 2026-09-12T01:56:38Z.
- Designated existing staging CI accounts: Gate A admin/non-admin; credentials stay sealed in GitHub Actions.
- No account creation, role/factor changes, global logout, impersonation session creation, provider actions or production configuration writes are part of this campaign.

## Preflight

| Check | Result | UTC |
|---|---|---|
| Prerequisite retirements | #1193 merged after all ten tranche-4 retirements | Before campaign |
| Vercel CLI | Existing authenticated session confirmed | 2026-09-12T01:56Z |
| Local validation | Full suite: 15,454 passed / 11 expected skips; final export slice 535 passed; refusal-order fix slice 166 passed; lint/typecheck/build pass | 2026-09-12T01:56Z |
| Canonical gates and contract | 37 routes / 5 pages pass; 19 generated artifacts match | 2026-09-12T01:56Z |
| Single code-review pass | Spec 0 findings at `239e8ed3`; Standards refusal-order finding fixed and rechecked at `73254899`, no open finding | 2026-09-12T02:08Z |
| Computer Use | Unavailable; automated checks must not be described as Computer Use | 2026-09-12T01:56Z |
| Live alias/environment pins | Source READY `dpl_G6php8zX64yu5XmKT7tVeCcnVmzQ` at `f747cb7b`; Admin READY `dpl_5Mq5BLSYQ9rVAnM2YCiFPSQEkJv1` at `44452f060`; both expected custom environments and aliases verified. All nine public baseline checks passed. | 2026-09-12T01:57:44Z |

## Verification procedure

1. Finish local lint, typecheck, tests, build and relevant audits; record committed candidate and one code-review pass.
2. Resolve both staging aliases to READY deployments with exact Git SHAs and custom environment IDs.
3. Push the candidate to the disposable source staging branch, then require the source alias to serve that exact candidate.
4. Run read-only anonymous API/refusal/CORS checks. Ordinary routes must reach canonical bearer refusal without a cookie refresh. Disallowed Origins must remain 403.
5. Rerun the existing Admin app Gate A/B E2E job serially on the designated staging accounts; require success and generated-proof-route cleanup. Recheck both deployment pins afterward.
6. Record live source-cookie rejection and permanent impersonation-cookie behavior independently. Gate A/B alone do not prove these paths. An accepted browser gap must explicitly apply to #1203.
7. Execute the single required red-team pass on a clean committed candidate, restore all mutations/environment files, record findings and dispositions, then require fresh PR CI before merge.

## Teardown ledger

| Item | Prior state / identifier | Required cleanup | Status |
|---|---|---|---|
| Source candidate staging ref | `f747cb7b64f8af5a7b74691110b0d10d9d8ff897`; no candidate push yet | After authorized squash merge, realign staging to main with exact lease if divergent; verify the deployed alias | [ ] Pending setup |
| Gate A/B own sessions and generated proof route | Existing sealed CI fixtures; no new account or MFA factor | Require own-session cleanup and generated-route removal; no global logout | [ ] Pending run |
| Mutation measurements | None created yet | Root finalizer restores all tracked mutations and dotenv files; verify closed journal | [ ] Pending single pass |
| Environment/flag fixtures | None required or created | No variable/flag change planned; record any deviation before changing state | [x] None |

## Deviations

- D-1 (2026-09-12T01:56Z): Initial local validation exposed stale cookie-route expectations, unused imports and a documentation word-cap breach; corrected before staging. The contract generator does not follow a plain identifier alias after removing a wrapper, so ordinary routes now use direct exported functions. Generated schema changes contain source-line citations only, with request/response shapes unchanged.
- D-2 (2026-09-12T01:56Z): Computer Use is unavailable. The owner acceptance of browser gaps for #1253 does not apply to this ticket. The separate #1203 live-cookie checks remain open until demonstrated or explicitly accepted.

- D-3 (2026-09-12T02:07Z): Standards review found that removing the proxy's token syntax refusal let absent/malformed credentials reach the channel runners' feature/environment checks. The proxy now uses the existing bearer parser to refuse these requests with no-store 401 before any route work. Valid-shaped bearers still reach the canonical verification gate, with no cookie fallback. New regressions cover disabled/missing-environment channel states.

## Unproven paths

- Live ordinary Admin API refusal with a valid source Admin cookie and no bearer.
- Live permanent impersonation-cookie acceptance with same-origin CSRF still enforced.
- Continued Admin app bearer/AAL2 access through staging Gate A/B.
- Candidate-specific live browser journey; no Computer Use evidence claimed.

## Verdict

PENDING — no staging PASS or completion claimed. Candidate deployment, live proof,
one red-team pass, fresh CI and teardown remain.
