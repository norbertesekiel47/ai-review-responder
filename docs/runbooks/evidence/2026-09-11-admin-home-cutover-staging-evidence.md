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
- Candidate source SHA: pending implementation and gates.
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

No fixtures or environment changes have been created yet. The following rows
record planned setup, prior state, and rollback before execution.

| Item | Identifier / prior state | Cleanup or retained delivery state | Verified UTC |
|---|---|---|---|
| [x] Source staging `ADMIN_APP_URL` | Created `FrDfGVWVmn4xsGyC`; project `prj_wIMnzHKefoQRdzCeMZesg2mIgNc0`, custom env `env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT` only | Retain `https://admin.staging.repworth.net` as cutover delivery config. If cutover abandoned, delete only this created entry and verify absent. Exact value, empty target list, and custom env verified by API. | 2026-09-11T19:47Z |
| [ ] Source cutover preview `ADMIN_APP_URL` | Branch `codex/1192-1201-admin-home-cutover` not yet on remote; creation failed and metadata confirms no preview entry | Deferred until branch exists. Delete any subsequently created branch entry after merged PR/preview retirement and verify absent. | Not created, verified 2026-09-11T19:47Z |

## Deviations

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
  API error if it still fails. No source deployment has been requested yet.

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

- Candidate staging deployment and exact deployed SHA.
- Server redirect sites, including admin on onboarding paths.
- Admin login default reaches external Admin app; explicit
  `from=/admin/impersonate` stays on the source app.
- MFA challenge keeps its existing same-origin return restrictions and completes
  the new default destination without a login loop.
- End-impersonation navigation changes to a single full document navigation;
  endpoint/session behavior remains unchanged.
- Desktop/mobile retained sidebar brand links and retirement-safe error link.
- Overview page retired while its API remains available to the Admin app.
- Staging Gate A/B remain green against the candidate source deployment.
- Computer Use journey evidence or explicit owner disposition of this gap.

## Verdict

PENDING. No staging ride, production cutover, or browser verification is claimed.
