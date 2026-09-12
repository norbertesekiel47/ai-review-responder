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
- Worktree: `codex-1203-admin-bearer-only`; reviewed implementation `732548997f725ac9e1bc42225dfd01664b058de8`; staging candidate `0bca6b38c9dea35cf59008c9946d96d9127053a2` (PR [#1266](https://github.com/RepWorth/ai-review-responder/pull/1266)).
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
| Computer Use | Owner supplied the installed Computer plugin. Its documented `@oai/sky` call fails with `Trusted RPC service is not configured: sky`, including after a fresh kernel. No UI access or browser proof obtained. | 2026-09-12T02:21Z |
| Live alias/environment pins | Source READY `dpl_G6php8zX64yu5XmKT7tVeCcnVmzQ` at `f747cb7b`; Admin READY `dpl_5Mq5BLSYQ9rVAnM2YCiFPSQEkJv1` at `44452f060`; both expected custom environments and aliases verified. All nine public baseline checks passed. | 2026-09-12T01:57:44Z |

## Verification procedure

1. Finish local lint, typecheck, tests, build and relevant audits; record committed candidate and one code-review pass.
2. Resolve both staging aliases to READY deployments with exact Git SHAs and custom environment IDs.
3. Push the candidate to the disposable source staging branch, then require the source alias to serve that exact candidate.
4. Run read-only anonymous API/refusal/CORS checks. Ordinary routes must reach canonical bearer refusal without a cookie refresh. Disallowed Origins must remain 403.
5. Rerun the existing Admin app Gate A/B E2E job serially on the designated staging accounts; require success and generated-proof-route cleanup. Recheck both deployment pins afterward.
6. Record live source-cookie rejection and permanent impersonation-cookie behavior independently. Gate A/B alone do not prove these paths. An accepted browser gap must explicitly apply to #1203.
7. Execute the single required red-team pass on a clean committed candidate, restore all mutations/environment files, record findings and dispositions, then require fresh PR CI before merge.

## Staging results

- **Candidate identity (2026-09-12T02:13:48Z; rechecked after Gate B at 02:22:19Z):** source alias resolves to READY deployment `dpl_B2dxCggUq1EUe7M5HmbDv3euBjdW`, SHA `0bca6b38c9dea35cf59008c9946d96d9127053a2`, custom environment `env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT`. Admin alias remains READY `dpl_5Mq5BLSYQ9rVAnM2YCiFPSQEkJv1`, SHA `44452f060f78c691cc81188b6bbd05a6d3be82c1`, custom environment `env_TL3MujrjZCSGGoRSj0LLnDA5KHjo`.
- **Nine public checks PASS:** both login pages 200; anonymous source Admin home and impersonation page redirect to source Admin login; expired MFA returns to source Admin login; anonymous overview/nav-counts 401; allowed-origin preflight 204 with exact Allow-Origin and no credentials allowance; unrelated-origin preflight 403.
- **Five additional refusal checks PASS (02:14:25Z):** overview with no credentials and nav-counts with a fabricated cookie return exact `401 {"error":"Unauthorized"}`, no-store, no redirect or Set-Cookie. Invalid Basic authorization with a fabricated cookie also returns 401 and the allowed-origin CORS header. An unauthenticated autonomy POST with malformed JSON returns 401 before parsing. An unrelated Origin returns exact `403 {"error":"origin"}` without an Allow-Origin header. Fabricated cookies are not evidence of a valid source session.
- **Gate A/B PASS:** [run 34633995382, attempt 3](https://github.com/RepWorth/admin-app/actions/runs/34633995382/attempts/3), job `103481124867`. Gate A completed 02:15:35Z; Gate B's live staging handshake completed 02:16:34Z; generated-route cleanup succeeded 02:16:35Z. This covers continued bearer access and the ADR 0025 D9 retry-on-`mfa_required` loop. The CI commit `4af120ee928258a970ca18cbfb21979c0af94330` and deployed Admin main `44452f060f78c691cc81188b6bbd05a6d3be82c1` have the same Git tree, `d5145a84eb21e70c6eafb3362beebee1c1f5efdf`.
- **Single red-team measurement pass:** root finalizer at 02:21Z confirmed all 30 recorded process groups empty, zero outstanding mutated files, one dotenv file restored, journal closed, and empty `git status --porcelain`. [Report](../../reviews/red-team/codex-1203-admin-bearer-only-018e02/findings.md): 14 mutations killed, 1,531 current candidates unmeasured, four retired-wrapper cases excluded; zero P0/P1 findings. Status remains `INCOMPLETE_BUDGET`, with no second round or reset. The single P2 stale channel-test comment is corrected after the report commit; its original report provenance is preserved.

## In-app browser continuation — 2026-09-12T03:26–03:31Z

- The owner explicitly selected the in-app browser after Computer Use failed and the separate Chrome DevTools login received a pre-authentication 403. Browser connection succeeded. Both deployed staging SHAs were rechecked at 03:17:59Z and remained the pinned candidate/target above.
- The owner signed in through the source login with `from=/admin/impersonate`. The source MFA challenge completed and returned to `/admin/impersonate`, which displayed `Step-up verified (AAL2)`. No credentials or MFA values are retained in this evidence.
- Submitted the surviving form with deliberately invalid UUID strings for both IDs. The live API returned the displayed error `Invalid UUID`; the page did not navigate. The unchanged handler validates the body after the canonical cookie/AAL2 gate and same-origin wrapper, before any owner lookup or session write. This demonstrates same-origin cookie authentication and validation without creating an impersonation session.
- Sanitized form-only screenshots: [1440px](../../../e2e/evidence/admin-bearer-only-1203/impersonation-cookie-1440.png), [390px](../../../e2e/evidence/admin-bearer-only-1203/impersonation-cookie-390.png). Header identity is excluded by cropping; the form layout and validation error remain visible at both widths.
- Direct browser-controller navigation to `/api/admin/overview` failed with `net::ERR_BLOCKED_BY_CLIENT` and left a blank tab. The owner subsequently opened the URL manually in the same signed-in in-app browser and reported exact `{"error":"Unauthorized"}`. This closes ordinary cookie-only refusal as owner-observed browser evidence; no controller screenshot or independent HTTP-status capture is claimed for that navigation.
- The owner completed the remaining manual browser probe in the same Chrome session: a credentialed `POST /api/admin/impersonation/start` with `Content-Type: text/plain` and deliberately malformed JSON body `{` returned `400 {"error":"invalid_body"}` from the source origin. Repeating that request from `https://admin.staging.repworth.net` returned **POST 403 Forbidden**, verified in Network → Headers; Console also reported the expected missing `Access-Control-Allow-Credentials` CORS error. The actual POST status, not the Console error alone, closes cross-origin CSRF refusal. The same-origin control demonstrates a valid session reaching body validation. Neither request can reach a session write. These are owner-reported live browser results, not Computer Use captures.
- The temporary blank tab was closed, viewport override reset, and synthetic form inputs cleared by reloading the surviving page. The owner's normal signed-in staging session is left available for their continuation; no account, factor, impersonation session, or environment fixture was created.

## Teardown ledger

| Item | Prior state / identifier | Required cleanup | Status |
|---|---|---|---|
| Source candidate staging ref | Prior `f747cb7b64f8af5a7b74691110b0d10d9d8ff897`; candidate now `0bca6b38c9dea35cf59008c9946d96d9127053a2` | After authorized squash merge, realign staging to main with exact lease if divergent; verify the deployed alias | [ ] Await authorized merge |
| Gate A/B own sessions and generated proof route | Existing sealed CI fixtures; no new account or MFA factor | Require own-session cleanup and generated-route removal; no global logout | [x] Run attempt 3 succeeded; generated route removed 2026-09-12T02:16:35Z |
| Mutation measurements | One pass, 30 supervised launches | Root finalizer restores all tracked mutations and dotenv files; verify closed journal | [x] Root finalizer: journal closed, dotenv restored, tracked tree clean at 2026-09-12T02:21Z |
| Environment/flag fixtures | None required or created | No variable/flag change planned; record any deviation before changing state | [x] None |

## Deviations

- D-1 (2026-09-12T01:56Z): Initial local validation exposed stale cookie-route expectations, unused imports and a documentation word-cap breach; corrected before staging. The contract generator does not follow a plain identifier alias after removing a wrapper, so ordinary routes now use direct exported functions. Generated schema changes contain source-line citations only, with request/response shapes unchanged.
- D-2 (2026-09-12T01:56Z): Computer Use was unavailable. The owner explicitly switched to the in-app browser and then supplied manual browser results for the controller's unsupported API-navigation and cross-origin checks. All named #1203 browser paths are now demonstrated; no #1253 waiver or new browser-gap acceptance is used.

- D-3 (2026-09-12T02:07Z): Standards review found that removing the proxy's token syntax refusal let absent/malformed credentials reach the channel runners' feature/environment checks. The proxy now uses the existing bearer parser to refuse these requests with no-store 401 before any route work. Valid-shaped bearers still reach the canonical verification gate, with no cookie fallback. New regressions cover disabled/missing-environment channel states.

## Unproven paths

None. Ordinary cookie-only refusal, source MFA continuation, same-origin impersonation cookie authentication/body validation, cross-origin CSRF refusal, and continued Admin app bearer access are covered by the separately attributed evidence above.

## Verdict

Acceptance checks PASS, with zero unproven paths. Candidate deployment, public checks, Gate A/B, the in-app browser journey and the owner's manual cookie/CSRF results all meet their expectations. The single red-team report remains honestly `INCOMPLETE_BUDGET`, with no open P0/P1 and its P2 comment corrected. Overall campaign closure is PENDING only final evidence CI and the post-merge staging-ref teardown; the resolution record will carry the merge SHA and verified realignment.
