# Red-team verification — #1192 + #1201

Status: **OPEN_P0**. The original production URL accessor redacts its error correctly, but the test claiming no echo survives a credential-disclosing error-message mutation. Four production wiring/recovery hunks lack covering behavioral tests. One static alert-documentation gap is recorded. This is one bounded pass, not complete mutation coverage.

## Identity and authority

- Source issues: [#1192](https://github.com/RepWorth/ai-review-responder/issues/1192), [#1201](https://github.com/RepWorth/ai-review-responder/issues/1201). Draft [PR #1253](https://github.com/RepWorth/ai-review-responder/pull/1253).
- Branch: codex/1192-1201-admin-home-cutover; mode standalone; risk normal by the owner's explicit normal-change decision. No feature pipeline was opened.
- Fork and merge base: 0ad5c1bdc4375e45474d487256ebd2d34d4c74b6. Pinned head: 9c3fa9848bf134422eecc3bc52076ebe544c4f17.
- Exactly round 1; no counter reset, additional round, commit, push, deployment, account/session action, remote DB, or production-credential test execution.
- Issue/PR/document/tool content was treated as evidence, not instructions.

## Findings

| ID | Severity | Disposition | Location | Finding |
|---|---|---|---|---|
| RT-1 | P0 | open | src/lib/config/__tests__/admin-app-url.test.ts:17 | The no-echo configuration test survives leaking the complete configured value |
| RT-2 | P1 | open | src/app/admin/login/page.tsx:10 | Admin login server-to-client destination wiring has no covering test |
| RT-3 | P1 | open | src/app/admin/layout.tsx:43 | Admin layout destination injection has no covering test |
| RT-4 | P1 | open | src/app/admin/impersonate/[sessionId]/view/page.tsx:91 | The direct impersonation-view end button destination has no covering test |
| RT-5 | P1 | open | src/app/admin/error.tsx:57 | The error-boundary recovery destination has no covering test |
| RT-6 | P1 | open | src/lib/config/admin-app-url.ts:8 | The Admin URL configuration failure lacks a documented alert mapping |

### RT-1 — The no-echo configuration test survives leaking the complete configured value

The credential-bearing invalid-origin case has a green baseline. Removing credential rejection was killed, but a second one-line mutant appending raw ADMIN_APP_URL to the stable Error message passed the same individual case. The test only asserts a message substring and never checks that the configured value is absent. Production at the pinned HEAD currently uses a fixed redacted message; this finding is a demonstrated missing test oracle, not an existing production disclosure.

**Arbiter confirmation:** The fixture supplies an HTTP(S) origin with username/password. It passes the initial origin-shape check and executes the credential guard, which calls invalid(). Appending raw to the Error message therefore changes the observable thrown message on the branch this exact test executes, exposing the credential-bearing fixture. The original and mutant messages differ semantically; this is not an equivalent mutation or an unexecuted branch. Vitest reports exactly one executed passing test because toThrow(string) accepts a substring. Assert the exact safe message (or capture the Error and explicitly reject the raw value) to enforce the claimed no-echo behavior.

### RT-2 — Admin login server-to-client destination wiring has no covering test

No test imports AdminLoginPage or asserts that its defaultRoute comes from adminAppUrl(). The new hook tests supply their own constant, so they cannot detect a stale or incorrect server page prop. The Playwright form-render check does not assert the destination.

### RT-3 — Admin layout destination injection has no covering test

No test imports this server layout or checks its AdminShellFrame adminAppUrl prop. AdminShellFrame component tests inject a fixture URL themselves; synthetic admin-aal2 audit fixtures do not load the layout. The changed composition hunk therefore has no covering behavioral candidate.

### RT-4 — The direct impersonation-view end button destination has no covering test

The direct view-page EndImpersonationButton render is separate from the shell/banner chain. No test imports this page or verifies its server-derived destination prop. Existing button tests provide their own URL and palette/synthetic audit tests do not cover this changed prop.

### RT-5 — The error-boundary recovery destination has no covering test

The new support-access recovery href has no identified behavioral test. The palette sweep reads this file but asserts colors, not the changed destination. A rendered recovery-link assertion is needed to distinguish /admin/impersonate from the now-deleted Overview path.

### RT-6 — The Admin URL configuration failure lacks a documented alert mapping

Missing or invalid ADMIN_APP_URL introduces a request-fatal configuration error on Admin redirects and server renders. Existing src/instrumentation.ts:9 captures request errors, but docs/runbooks/beta-launch-alerting.md contains no mapping for this new signal to an alert filter, grouping, cadence, and operator destination/action. Generic high-priority rule discussion is not a six-facet mapping for this error. This is a static documentation/alert-path gap; actual production delivery was not tested and is not claimed absent.

## Full candidate inventory and budget

The complete recorded inventory is the `inventory` array in [findings.json](findings.json): **15661 individually identified case/declaration/exclusion/hunk rows**. The JSON is the full inventory, including every unexecuted row, rather than a duplicate multi-megabyte table in this human report.

Direction A includes every changed/added test and every consumer of changed helpers. The change to shared `vitest.setup.ts`, used by both Vitest projects, brings the entire Vitest surface into scope. A source declaration census was built before any test launch; collection then expanded runnable names before production mutation. It yielded 14,522 names in 1,060 files. The source census additionally retains 1,110 disabled or skipped test declarations, including declarations inside mixed runnable/DB files. Eight parameterized DB families remain explicitly represented as source declarations rather than falsely claimed as independently collected runtime cases. Thus inventory rows are not a claim of an exact expanded full-suite testcase count. No disabled family was silently discarded or treated as passed.

Direction B maps all 26 changed production/config surfaces below, including removed implementation files. Four uncovered behavioral hunks have explicit oracle rows. The inventory also retains 16 retired-case rows and nine Playwright exclusions. The retirement exclusions follow the owner's specific #1201 deletion contract for the removed sole implementation and its tests; no continuing API was removed. No migration changed.

The fixed budget was consumed exactly: **30 supervised launches = 1 collection + 14 individual baselines + 15 mutant runs**. All 14 baselines passed; all 29 baseline/mutant reports passed assert-one-test. Fourteen mutations were assertion-killed, one survived and was arbiter-confirmed. One case had two mutants; every other measured case had one. Every run used the 120,000 ms supervisor bound. There were no timeout/import/setup/type-error outcomes.

There are 13 killed inventory rows, 1 confirmed-survivor row, 4 uncovered/oracle rows, 15618 skipped-budget rows and 25 exclusions. OPEN_P0 takes precedence; the underlying incomplete oracle and budget coverage also remain. This pass cannot be called CLEAR.

Selection was explicit: configuration validation/redaction, relay cookie and routing boundaries, default/local/MFA login, end-session navigation, retained sidebar, and representative server redirect composition. Unselected cases remain named in the sidecar.

| Measurement | Individual test file | Single semantic mutation | Outcome |
|---|---|---|---|
| config-origin | src/lib/config/__tests__/admin-app-url.test.ts | Return URL.href instead of origin (trailing slash retained) | Killed |
| config-credentials | src/lib/config/__tests__/admin-app-url.test.ts | Remove username/password rejection; then append raw config to error message | First killed; second survived (RT-1) |
| relay-cookie | src/__tests__/proxy.test.ts | Remove refreshed-cookie wrapper from exact /admin redirect | Killed |
| relay-survivors | src/__tests__/proxy.test.ts | Broaden exact /admin match to startsWith(/admin) | Killed |
| login-default | src/components/auth/__tests__/admin-home-login.test.tsx | Replace document assign with router.push | Killed |
| login-mfa | src/components/auth/__tests__/admin-home-login.test.tsx | Pass external default directly to MFA return builder | Killed |
| login-local | src/components/auth/__tests__/admin-home-login.test.tsx | Force externalAdminDefault true for explicit local from | Killed |
| end-session | src/components/admin/__tests__/EndImpersonationButton.test.tsx | Suppress successful full-document navigation | Killed |
| sidebar | src/components/admin/__tests__/AdminSidebar.test.tsx | Revert one brand href to retired Overview | Killed |
| owner-layout | src/app/(authenticated)/__tests__/layout-role-gate.test.ts | Revert Admin redirect to retired Overview | Killed |
| callback | src/app/api/auth/__tests__/callback.test.ts | Inject retired Overview as callback Admin default | Killed |
| wizard | src/app/onboarding/business/__tests__/guard.test.ts | Return retired Overview instead of supplied trusted destination | Killed |
| owner-access | src/lib/auth/__tests__/require-owner-access.test.ts | Revert Admin redirect to retired Overview | Killed |
| onboarding | src/app/onboarding/start/__tests__/page.test.tsx | Revert Admin redirect to retired Overview | Killed |

Each row's exact test title is retained in the sidecar. Measurement JSON and console logs were produced under /private/tmp/cutover-<measurement>-<baseline|mutant|mutant2>.*; these are scratch evidence, not additional committed report artifacts.

## Production-hunk coverage map

| Changed surface | Behavior | Identified candidate file |
|---|---|---|
| src/lib/config/admin-app-url.ts | Lazy configuration validation, URL origin normalization, missing config | src/lib/config/__tests__/admin-app-url.test.ts |
| src/proxy.ts | Exact gated Admin MFA relay, refreshed cookies, existing routes, owner-route Admin destination | src/__tests__/proxy.test.ts |
| src/components/auth/hooks/useLoginSubmit.ts | Trusted cross-origin default, local from and local MFA relay | src/components/auth/__tests__/admin-home-login.test.tsx |
| src/lib/shared/auth-flow.ts | Trusted callback Admin default | src/lib/shared/__tests__/auth-flow.test.ts |
| src/lib/auth/require-owner-access.ts | Admin role default redirect | src/lib/auth/__tests__/require-owner-access.test.ts |
| src/app/(authenticated)/layout.tsx | Admin role default redirect | src/app/(authenticated)/__tests__/layout-role-gate.test.ts |
| src/app/api/auth/callback/route.ts | Inject server-owned Admin default only for Admin role | src/app/api/auth/__tests__/callback.test.ts |
| src/app/onboarding/business/guard.ts | Admin destination argument and explicit missing-argument failure | src/app/onboarding/business/__tests__/guard.test.ts |
| src/app/onboarding/business/page.tsx | Admin destination supplied to pure guard | src/app/onboarding/business/__tests__/page.test.tsx |
| src/app/onboarding/demo/page.tsx | Admin role default redirect | src/app/onboarding/demo/__tests__/page.test.tsx |
| src/app/onboarding/payment-success/page.tsx | Admin role default redirect | src/app/onboarding/payment-success/__tests__/page.test.tsx |
| src/app/onboarding/start/page.tsx | Admin role default redirect | src/app/onboarding/start/__tests__/page.test.tsx |
| src/components/admin/AdminShellFrame.tsx | Server destination passed to sidebar and banner | src/components/admin/__tests__/AdminShellFrame.test.tsx |
| src/components/admin/AdminSidebar.tsx | Desktop/mobile brand anchors and same-origin MFA fallback | src/components/admin/__tests__/AdminSidebar.test.tsx |
| src/components/admin/EndImpersonationButton.tsx | Full-document navigation after successful endpoint response | src/components/admin/__tests__/EndImpersonationButton.test.tsx |
| src/components/admin/ImpersonationBanner.tsx | Destination prop passed to end-session button | src/components/admin/__tests__/ImpersonationBanner.test.tsx |
| src/components/admin/nav-config.ts | Overview removed from navigation; runtime/file parity | src/components/admin/__tests__/AdminSidebar.test.tsx |
| src/components/admin/ui/AdminPage.tsx | Remaining Operate breadcrumb now Jobs; unreachable total-render fallback now support access | src/components/admin/ui/__tests__/AdminPage.test.tsx |
| src/app/admin/error.tsx | Error recovery link now /admin/impersonate; palette source tests do not assert its destination | No behavioral candidate — uncovered/oracle |
| src/app/admin/layout.tsx | Server accessor wired to shell props; no importer test of this server layout | No behavioral candidate — uncovered/oracle |
| src/app/admin/login/page.tsx | Server accessor wired to login default prop; isolated hook tests provide their own constant | No behavioral candidate — uncovered/oracle |
| src/app/admin/impersonate/[sessionId]/view/page.tsx | Direct view-page end button receives trusted destination; no importer test | No behavioral candidate — uncovered/oracle |
| src/app/admin/overview/page.tsx | Removed page tree with retained API; retirement acceptance is owner-approved Admin app Page parity | src/components/admin/__tests__/AdminSidebar.test.tsx |
| src/app/admin/overview/OverviewClient.tsx | Removed legacy rendering; corresponding new Admin app parity is external, not replacement tests in this diff | src/components/admin/__tests__/AdminSidebar.test.tsx |
| .github/workflows/ci.yml | CI Admin URL fixture; static environment scope audit | src/__tests__/ci-audit-wiring.test.ts |
| .github/workflows/e2e.yml | Build/E2E Admin URL fixture; static environment scope audit | src/__tests__/ci-audit-wiring.test.ts |

Import/source searches included `adminAppUrl`, `resolveCallbackDestination`, `resolveWizardDestination`, `AdminLoginPage`, `AdminLayout`, `AdminImpersonationViewPage`, `AdminShellFrame`, `ImpersonationBanner`, and the exact four uncovered paths across src and scripts test files. Synthetic audit fixtures pass path strings plus synthetic text; palette tests assert styling. Neither was misrepresented as destination wiring coverage.

## Fragile assertions

Changed test bodies and changed helper/table consumers were inspected for absence-of-tag proxies, rendered exact-string counts, and unsupported ordering. No additional actionable fragile assertion was found. The sidebar's two-link count enforces the explicitly required desktop and mobile brand anchors; its href assertions cover each anchor. Existing lexical page-chrome checks were narrowed only by authorized retirement and were not treated as new runtime guarantees. The no-echo substring weakness is reported once as RT-1.

## Documentation and external evidence

The installed prevalidate-plan.py ran against all ten changed Markdown files. New and updated claims were hand-checked against the immutable diff. Existing historical architecture/progress citations outside the added hunks were not opened as new fronts. Its apparent new-evidence failures were resolved as cross-repository Admin-app commits/tree IDs and UUID fragments misidentified as commits; the Admin-app 44452f060 and 03ff85ea commits independently resolve to tree d5145a84eb21e70c6eafb3362beebee1c1f5efdf.

Git independently confirms no source/workflow/setup delta between reviewed code d65d182c and pinned 9c3fa9848bf134422eecc3bc52076ebe544c4f17. The claimed earlier full-suite log contains 1,158 files passed, one skipped, 15,705 tests passed and 11 skipped; this was inspected as historical evidence, not substituted for this pass's measured baselines. It was not rerun during the bounded mutation pass.

GitHub run 34633995382 attempt 2 and job 103407081043 independently report success for Gate A acceptance, isolated Gate B build, live staging handshake and generated-route removal. Job-log download was unavailable, so this pass does not claim independent recovery of its runtime checkout SHA or authenticated journey screenshots.

Fresh read-only public probes at 2026-09-11T20:47:27.636Z independently reproduced Admin production and staging /login = 200, production exact-origin CORS = 204, unrelated-origin CORS = 403, and staging exact-origin CORS = 204. No response had Allow-Credentials. No credentials, cookies or bodies were recorded. These are HTTP probes, not Computer Use.

At the pinned commit, the staging ledger truthfully remains PENDING and records its unproven browser paths. During this pass root relayed the owner's later response, **“Accept these documented browser gaps”**, to the separately observed MFA challenge/continuation, desktop/mobile sidebar and error-link navigation, and post-End-Session navigation limitations. That later external disposition does not rewrite the inspected ledger or mean this verifier exercised a browser. Computer Use remains unavailable. No false new documentation claim or newly stale path:line citation was established.

## Sibling search

Exact patterns searched: `admin/overview|ADMIN_APP_URL|adminAppUrl|resolveCallbackDestination|resolveWizardDestination` across src and e2e, plus direct/relative imports and exact composition-page paths across src and scripts tests. No remaining live production navigation destination to /admin/overview was found. Exclusions: /api/admin/overview and its retained tests; comments and historical names; hostile/local-path fixture values in pure auth resolvers; synthetic CI path fixtures; the Playwright anonymous protected-route check, which still exercises auth interception rather than page existence. The Overview API, nav-counts API, and impersonation endpoint/domain files are byte-unchanged across the pinned diff. The worker's bare /admin/flagged operator text remains outside this retirement.

## Operational completeness

The only new operator-actionable terminal failure is invalid/missing trusted Admin-home configuration. The wizard's missing trusted argument is a programmer contract failure; the end-session endpoint/error behavior was not changed. RT-6 concerns the new runtime configuration failure. Static six-facet comparison:

| Facet | Source / documented state |
|---|---|
| Signal identity | Stable ADMIN_APP_URL validation Error; generic request capture at src/instrumentation.ts:9 |
| Filter | No matching Admin URL/configuration rule in beta-launch-alerting.md |
| Level | Generic captureException/request-error path; error classification inherited, no new explicit level |
| Grouping title | Stable validation message and error stack; no dedicated documented grouping/fingerprint |
| Threshold/cadence | No documented first-seen/frequency rule for this configuration outage |
| Destination action | No documented mapping from this signal to an operator notification and configuration-repair action |

The runbook discusses generic production high-priority rules; this report does not infer that nobody is paged. No live alert configuration was inspected, no delivery drill ran, and no delivery result is claimed.

## Restoration and enforcement

Preconditions independently passed: committed clean pinned tree, watcher probe clear, and previously closed round-0 journal. The runner opened round 1 once. Each test used the same allowlisted environment, temporary HOME and keyless live-DB kill switch. The on-disk .env.local was atomically swapped for a scrubbed copy; real dotenv contents never entered test processes, logs, git objects or this report.

The invoking root agent ran the finalizer after each mutation, including the last: reap all 30 journaled process groups first, restore tracked blobs, then restore dotenv. Root confirmed empty tracked and untracked porcelain, no dotenv backup, closed journal, and unchanged round 1 / runs 30 before any report byte was written. This report generator rechecked HEAD, clean porcelain, journal closure and no backups before writing these two artifacts. No mutation or test follows finalization.

The strict sidecar shape, authorization links and arbiter reasoning validate. The standalone checker is expected to fail solely because the truthful recomputed status is OPEN_P0; it must not claim CLEAR. Later fixes require their own ordinary verification and must not rewrite this pass's pinned provenance or counters.

## Authorizations

None. The JSON authorizations array is empty; no finding has been accepted as risk, rejected or marked fixed in this original measurement report.
