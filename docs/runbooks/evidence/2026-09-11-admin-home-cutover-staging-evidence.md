# Evidence — Admin home cutover (#1192 + #1201)

Runbook: `docs/runbooks/deployment-guide.md`; execution contract:
`.agents/skills/runbook/SKILL.md`. This record is prepared before staging setup.

## Environment

- Environment: staging only.
- Source UI/API: `https://staging.repworth.net`.
- Admin UI: `https://admin.staging.repworth.net`.
- Supabase: `kubdiqdhqbhwmqfditeg`.
- Production Supabase: `udeyaqnvpojbwgoaxwdg` — NEVER touched by this campaign.
- Production configuration/deployment changes require separate owner approval.
- Starting source main/staging: `0ad5c1bdc4375e45474d487256ebd2d34d4c74b6`
  (#1202, PR #1252); worktree `codex-1192-1201-admin-home-cutover`.
- Starting Admin app main/staging: `44452f060f78c691cc81188b6bbd05a6d3be82c1`.
- Preparation UTC: 2026-09-11T18:55:00Z.
- Reviewed code SHA: `d65d182c669554a26fd29e7ae8fa88cdb37e5c92`; the staging
  candidate is `5f437245026a23fb3614c6b7cd4dce495dade5a9`, with only preparation
  ledger and required review-log documentation added after review.
- Draft source PR: https://github.com/RepWorth/ai-review-responder/pull/1253.
- Designated staging account: `gate-a-admin-20260907@repworth.net` only if
  authenticated verification is needed. Credentials stay in sealed CI inputs.
- No provider actions, customer edits, global logout, or impersonation session
  creation is authorized by this evidence record.

## Preflight

| Check | Result | UTC |
|---|---|---|
| Overview Page parity | Approved by owner; Admin app PR #6 merged | Before campaign |
| Business Page parity | Approved by owner; Admin app PR #10 merged | Before campaign |
| #1202 prerequisite | PR #1252 merged; main/staging aligned; final CI 34639254954 passed | 2026-09-11T19:44Z |
| Admin staging login | HTTP 200, read-only public request | 2026-09-11T18:54Z |
| Source staging login | HTTP 200, read-only public request | 2026-09-11T18:54Z |
| Production readiness | HTTP 500 at Admin app /login; required public vars absent from production targets | 2026-09-11T18:54Z |
| Admin API CORS, staging | OPTIONS `/api/admin/overview` from `https://admin.staging.repworth.net`: 204, exact matching Allow-Origin, existing methods/headers | 2026-09-11T18:55Z |
| Admin API CORS, production | Read-only OPTIONS from `https://admin.repworth.net`: 403, no Allow-Origin; production allowlist is not ready | 2026-09-11T18:55Z |
| Vercel CLI access | Device sign-in pending; no environment mutation performed | 2026-09-11T18:55Z |
| Vercel CLI restored | Owner completed renewed device sign-in; authenticated metadata reads succeeded for both expected project IDs/team | 2026-09-11T19:21Z |
| Source URL setting | `ADMIN_APP_URL` absent in all targets; staging creation payload prepared, not executed | 2026-09-11T19:21Z |
| Environment isolation | Both custom environments map exactly to their `staging` branch; source CORS variable is custom-staging-only | 2026-09-11T19:21Z |
| Computer Use | Unavailable in this session; other browser tools do not satisfy this check | 2026-09-11T18:55Z |
| Source staging baseline deployment | `dpl_BVG4ZwXR1AwtXz2E2AY1S4qKm1JM`, READY; alias `staging.repworth.net`, source SHA `0ad5c1bdc4375e45474d487256ebd2d34d4c74b6`; expected custom env | 2026-09-11T19:50Z |
| Admin staging baseline deployment | `dpl_5Mq5BLSYQ9rVAnM2YCiFPSQEkJv1`, READY; alias `admin.staging.repworth.net`, SHA `44452f060f78c691cc81188b6bbd05a6d3be82c1`; expected custom env | 2026-09-11T19:50Z |
| Public baseline (before candidate) | Nine read-only checks passed: both login pages 200; anonymous `/admin`, `/admin/impersonate`, and expired `/mfa/challenge?next=%2Fadmin` each 307 to same-origin `/admin/login`; Overview/nav-counts APIs 401; allowed CORS 204 with exact origin and no credentials header; unrelated origin 403 without allowance | 2026-09-11T19:51:38Z |
| Candidate local gates | `d65d182c`: lint/typecheck/build + nine relevant audits passed; full suite with both DB variables pinned to validated local test DB: 15,705 passed, 11 skipped, 1,158 files passed | Before staging push |
| Single code-review pass | Spec: zero actionable findings; Standards: zero actionable findings at `0ad5c1bdc...d65d182c` | Before staging push |
| Candidate deployed/public probes | `staging.repworth.net` resolves to READY deployment `dpl_AB2f4BksJ6PBR265hxn4e1WZRVfo`, exact SHA `5f437245026a23fb3614c6b7cd4dce495dade5a9`, expected custom env. All nine baseline public checks also pass against this candidate. Target alias remains at `44452f060`. | 2026-09-11T20:12:56Z |
| Candidate Gate A/B | Run `34633995382`, attempt 2, E2E job `103407081043`: Gate A acceptance, isolated Gate B build, live staging handshake, and generated-route cleanup all succeeded. Artifact `gate-a-evidence` ID `10281070114` was created at 20:14:20Z. | 2026-09-11T20:16Z |
| Post-proof deployment pins | Source alias still READY at `5f437245` / `dpl_AB2f4BksJ6PBR265hxn4e1WZRVfo`; Admin alias still READY at `44452f060` / `dpl_5Mq5BLSYQ9rVAnM2YCiFPSQEkJv1` | After Gate A/B completion |

## Candidate verification procedure

1. Wait for the cutover implementation, local gates and review. Record its full
   committed SHA and the preceding staging ref before pushing to staging.
2. Resolve the staging alias to its deployment ID, then read deployment metadata;
   require READY, the candidate SHA, and the expected custom environment. A
   successful deployment on another URL does not prove this alias is current.
3. Run read-only anonymous login/relay/MFA-expiry/API-refusal and CORS checks.
   Record statuses and sanitized redirect paths without cookies or bodies.
4. Rerun Admin app CI `34633995382`, E2E job `103378110118`, without debug logging.
   Its checkout `03ff85ea85b43410895eb5a47da3c8129124fca2` and target main
   `44452f060f78c691cc81188b6bbd05a6d3be82c1` share tree
   `d5145a84eb21e70c6eafb3362beebee1c1f5efdf` (verified via GitHub commit metadata).
   Record the new attempt; verify the source alias SHA immediately before and
   after. Gate A exercises the deployed Admin app; Gate B exercises the checked
   out frontend against the live staging API. Gate B signs out only the session
   it created and removes its temporary proof route; no global logout.
5. Separately verify the source authenticated redirect/MFA/default-link journey.
   Gate A/B do not cover it. Automated source login previously hit BotID refusal;
   the owner's everyday browser works. Computer Use is unavailable. Any manual
   evidence or accepted gap must be recorded explicitly before claiming PASS.
6. Finish and record the single required red-team pass before promotion. No
   production deployment or config mutation follows merely from staging success.

## Teardown ledger

The following rows were opened before setup and now record the actual retained
configuration, cleanup, and remaining post-merge work.

| Item | Identifier / prior state | Cleanup or retained delivery state | Verified UTC |
|---|---|---|---|
| [x] Source staging `ADMIN_APP_URL` | Created `FrDfGVWVmn4xsGyC`; project `prj_wIMnzHKefoQRdzCeMZesg2mIgNc0`, custom env `env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT` only | Retain `https://admin.staging.repworth.net` as cutover delivery config. If cutover abandoned, delete only this created entry and verify absent. Exact value, empty target list, and custom env verified by API. | 2026-09-11T19:47Z |
| [ ] Source cutover preview `ADMIN_APP_URL` | Created `gVOKy6rduUBNrXhV`, only preview branch `codex/1192-1201-admin-home-cutover`, exact staging Admin URL verified after remote branch creation | Delete this created branch entry after merged PR/preview retirement and verify absent. | Value/scope verified after push; cleanup pending |
| [ ] Candidate source staging deployment | Prior branch `0ad5c1bdc4375e45474d487256ebd2d34d4c74b6`, deployment `dpl_BVG4ZwXR1AwtXz2E2AY1S4qKm1JM`; candidate `5f437245026a23fb3614c6b7cd4dce495dade5a9`, READY deployment `dpl_AB2f4BksJ6PBR265hxn4e1WZRVfo` | Normal atomic feature/staging push passed all hooks. After authorized merge, realign staging to main per deployment guide. If candidate abandoned, restore recorded prior staging ref with exact lease and verify deployment. | Alias/deployment SHA verified 2026-09-11T20:12:56Z; post-merge alignment pending |
| [x] Sealed Gate A/B rerun | Existing disposable staging CI accounts; run `34633995382`, attempt 2, E2E job `103407081043`; no new account, factor, role, or impersonation session | Gate A closed its ephemeral browser contexts; Gate B's own-session sign-out and generated-route removal succeeded. Existing fixture accounts retained. No global session revocation is claimed or performed. | Successful job/cleanup and stable deployment pins verified |

## Deviations

- D-6: The first normal atomic push was rejected by `ci:merge-ledger` because
  the committed diff lacked a descriptive architecture review-log addition.
  No ref moved. Two documentation lines were added, no counter or journal was
  changed, the audit passed, and the normal atomic retry succeeded. Staging
  and the feature branch now equal `5f437245`; main remains `0ad5c1bdc`.

- D-7: Source authenticated browser verification is pending owner input on the
  actual staging candidate: default admin login/MFA to the new Admin origin and
  explicit `from=/admin/impersonate` remaining on the source origin. The request
  also identifies unverified desktop/mobile sidebar and live post-End-Session
  navigation. Existing port parity approvals do not claim those new paths. No
  new real impersonation session is needed or requested for the manual check.

- D-7 update: The owner reported the default source login reached
  `https://admin.staging.repworth.net/login?next=%2F`, and the explicit return
  reached `https://staging.repworth.net/admin/impersonate` correctly. Both match
  the intended destinations: the new Admin app has its own session and may
  require sign-in. No particular viewport or separate MFA challenge observation
  was reported. Desktop/mobile sidebar and live post-End-Session navigation
  remain unverified in a live browser.

- D-5 update: The owner explicitly approved the corrected production rollout:
  "Authorize the corrected production rollout". Execution has its own
  `2026-09-11-admin-production-readiness-evidence.md` ledger. This does not
  authorize #1179's developer account or waive the cutover's remaining gates.

- D-5 completion (2026-09-11T20:29:34Z): The corrected production readiness
  rollout passed. Both existing merged versions were rebuilt, Admin `/login`
  returns 200, and source exact-origin CORS returns 204 while unrelated-origin
  requests return 403. Details and all five created setting IDs are recorded in
  the separate production evidence ledger. No cutover code or developer account
  was promoted by that rollout.

- D-5 (2026-09-11T19:58Z): The prepared production proposal incorrectly allowed
  the source app's legacy anon JWT. ADR 0030 D4 requires a modern publishable key.
  That proposal was withdrawn before any production write. Read-only Supabase
  metadata confirms an existing enabled modern production publishable key, ID
  `72b10d9d-1035-410c-bf82-a1e5684dc5ec`. The corrected proposal uses it without
  creating or rotating any key and awaits explicit owner approval. No key value
  was displayed or persisted; staging is unaffected.

- D-4 (2026-09-11T19:51Z): The temporary read-only probe initially assumed every
  Location header was absolute. Vercel correctly returned relative same-origin
  login locations. Resolve Location against the request URL before checking its
  origin. The corrected probe passed all nine baseline checks; no app change.

- D-3 (2026-09-11T19:47Z): Branch-scoped preview config creation returned a CLI
  failure before the branch was pushed. A fresh metadata read confirms only the
  intended custom-staging entry exists; no preview or production entry was
  created. Retry only after the remote branch is present and preserve a sanitized
  API error if it still fails. After the remote branch existed, creation succeeded
  and its exact branch-only scope/value were verified; see the ledger.

- D-1: Production Admin app is not ready for the redirect cutover. Its existing
  merged pages are independently proven by owner parity and staging Gate A/B,
  so a concrete public-configuration rollout is prepared at
  `/private/tmp/admin-home-cutover-production-rollout.md` and awaits explicit
  owner approval. The source redirect code still needs its own staging ride and
  red-team pass before promotion. Do not infer production approval from CLI
  sign-in.
- D-2: Two Vercel device sign-in attempts ended without stored credentials. No
  further short-lived link will be opened until the owner is ready. Neither
  attempt changed project configuration. The connected Chrome session also
  requires authentication; its regular Vercel login page is now open so dashboard
  access can be used without an expiring device code. The owner subsequently
  requested a renewed CLI link and completed it. Authenticated CLI metadata
  reads now succeed; no dashboard sign-in is required.

## Unproven paths

- Server redirect sites and retirement boundaries have local regression/audit
  coverage; source default login and the explicit impersonation return also
  have the owner's two reported live observations above. Gate A/B exercises
  the separate Admin app and source APIs, not every source redirect caller.
- The source MFA challenge/continuation, desktop/mobile retained sidebar and
  error-link navigation, and live post-End-Session navigation remain unobserved
  in a live browser. The owner explicitly accepted these gaps on 2026-09-11:
  **"Accept these documented browser gaps"**. This is owner disposition, not
  Computer Use evidence or a claim that a real impersonation session was run.
- The Overview page retirement is covered by the accepted #1225 port parity,
  local filesystem/navigation checks, and retained API/Gate B checks. No
  authenticated live legacy Overview rendering after deletion is claimed.

## Single red-team pass and subsequent fixes

The [immutable pass report](../../reviews/red-team/codex-1192-1201-admin-home-cutover-435ef1/findings.md)
and its complete JSON inventory inspect `9c3fa9848bf134422eecc3bc52076ebe544c4f17`.
They were committed separately as `4cca3306` before any fix. Round 1 used exactly
30 supervised launches: collection, 14 green individual baselines, and 15
mutants. Fourteen mutants were caught; one demonstrated a missing redaction
assertion. Root restored all mutated files and dotenv swaps, verified no backup
or dirty path remained, and preserved the round/run counters.

The pass has 15,661 inventory rows, including 15,618 skipped-budget rows and
four uncovered wiring rows. Its historical `OPEN_P0` status is preserved; it
must not be represented as a clean or exhaustive pass after later changes.
No second mutation round is authorized or performed. The normal LEAN release
needs an explicit disposition of this partial-pass limitation.

| Finding | Subsequent correction | Verification |
|---|---|---|
| RT-1: no-echo assertion accepted a leaked suffix | Require the entire fixed safe error message, anchored at both ends; production accessor unchanged | All 16 accessor cases pass, including the credential-containing fixture |
| RT-2: login destination wiring untested | Execute the real Admin login page with two configured origins | Both cases assert the actual default destination and Admin portal prop |
| RT-3: retained layout destination wiring untested | Execute the real server layout with two configured origins | Both cases assert the shell destination and retained children |
| RT-4: direct impersonation view destination wiring untested | Execute the real view page with two configured origins and mocked existing auth/data boundaries | Both cases assert the end-button destination and existing session-resolution arguments; no live session or endpoint behavior changed |
| RT-5: error recovery destination untested | Render the real error boundary with Admin configuration absent | Recovery link remains the local support-access path |
| RT-6: configuration failure lacks an alert mapping | Add exact emitted identity, project/environment filter, level, default grouping limits, cadence, and repair/delivery action to alerting rule 10 | Static documentation correction only; no live Sentry rule or delivery test is claimed |

The focused regression run passed 23 tests in two files. Full normal checks and
the same review pass's targeted fix continuation are pending. These tests and
documentation are later changes to the inspected tree; the original sidecar's
head, outcomes and counters are not rewritten to imply re-verification.

## Verdict

Staging functional acceptance is complete with the owner's explicit browser-gap
disposition and the automated evidence above. Overall release/teardown remains
PENDING: the post-merge preview-setting cleanup and staging realignment are
still open, and the red-team fixes, partial-pass disposition, and fresh cloud CI
must be completed before merge. No complete Computer Use or authenticated
production browser verification is claimed.
