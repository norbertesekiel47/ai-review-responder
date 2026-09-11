# Evidence — Admin production readiness configuration

Runbook: `docs/runbooks/deployment-guide.md` §1.1.1. This ledger is created
before the first production configuration mutation.

## Environment and authority

- Owner explicitly approved the corrected five-setting production rollout on
  2026-09-11: "Authorize the corrected production rollout".
- This supersedes the unexecuted proposal that allowed a legacy anon key.
- Vercel team `team_8XsnodzHbwNdv5KiRVfMJ4GL`.
- Admin project `prj_ofJWgjS87xsApuw6f0s3p0OyzxKc`, production domain
  `https://admin.repworth.net`, existing merged SHA
  `44452f060f78c691cc81188b6bbd05a6d3be82c1`.
- Source project `prj_wIMnzHKefoQRdzCeMZesg2mIgNc0`, production domain
  `https://repworth.net`, existing merged SHA
  `0ad5c1bdc4375e45474d487256ebd2d34d4c74b6`.
- Production Supabase `udeyaqnvpojbwgoaxwdg`: existing public configuration
  only. No database, account, factor, role, key creation/rotation, provider,
  optional Maps/docs setting, or feature-flag mutation is authorized here.
- Staging Supabase `kubdiqdhqbhwmqfditeg` is unchanged by this rollout.
- #1179's developer production account remains deferred pending owner go-live
  date. #1192/#1201 code promotion still needs its own remaining gates.

## Preflight

| Check | Result |
|---|---|
| Existing Admin app | Owner parity approved; staging Gate A/B passed again against cutover source candidate, run 34633995382 attempt 2 |
| Production Admin login | Previously HTTP 500; production public variables absent |
| Production Admin API CORS | Previously HTTP 403 without Allow-Origin for Admin production origin |
| Modern publishable key | Existing enabled key ID `72b10d9d-1035-410c-bf82-a1e5684dc5ec`, name `default`, type `publishable`, `sb_publishable_` format, read only from the production project. Value never printed or written to this file. |
| Source main | Remote verified `0ad5c1bdc`; cutover code not merged |

## Mutation and retention ledger

Re-read the exact target metadata before each creation. If an entry already
exists, stop and inspect it rather than replacing it. Values travel in memory
through stdin, not shell arguments or files. Capture only sanitized metadata.

| Item | Prior state / intended change | Retention and rollback | Result |
|---|---|---|---|
| Admin production public configuration | Created URL `H2Z6Toh4hN90Hsib`, modern publishable key `nuUAlNOiE2LSXhsd`, API URL `8TJDEKZJXZkkwBYk` | Retain as authorized delivery configuration. All three exact values and production-only scopes verified by fresh API reads. If setup fails, remove only those new entries and verify prior state. | Created and verified |
| Admin production rebuild | Prior `dpl_Ax3TkEKVWsDXvYdPXNy25itfkLVo`; new `dpl_HAwWpQm3VSgj3KmGwAZqwhgS5ss4`, same merged SHA `44452f060f78c691cc81188b6bbd05a6d3be82c1` | Production target READY, actual `admin.repworth.net` alias and SHA verified; public `/login` now HTTP 200. | Verified |
| Source production destination and CORS | Created `ADMIN_APP_ORIGINS` ID `45MqzSLPbD7wnVL8`, `ADMIN_APP_URL` ID `k9Yrw3z1kCfSMTdy`, both exact `https://admin.repworth.net` | Retain as authorized delivery configuration; production-only scopes and exact values verified; custom-staging entries preserved. These IDs define precise rollback if needed. | Created and verified |
| Source production rebuild | Prior `dpl_APegt5YZhxuzTbMK2cPuNkqwnN4G`; new `dpl_2SzSUVuweiQsgiiHeZHHncSHnC1n`, same merged SHA `0ad5c1bdc4375e45474d487256ebd2d34d4c74b6` | Production target READY, actual `repworth.net` alias and SHA verified. Exact Admin origin preflight 204 with matching Allow-Origin; unrelated origin 403 without allowance; neither allows credentials. No cutover code promoted. | Verified 2026-09-11T20:29:34Z |

## Verification and limitations

The first batch request was rejected; a fresh metadata read confirmed no
production entries had been created. Three single-entry requests then succeeded.
The public key entered the helper through non-echoing stdin and Vercel's JSON
stdin. Its value was never printed, placed in shell arguments, or saved to disk.

Both production rebuilds, exact deployment provenance, Admin public login HTTP
200, allowed-origin CORS 204 without credential allowance, and unrelated-origin
403 are verified. These are public readiness checks; no authenticated production browser
journey or production account creation is claimed.

## Verdict

PASS — approved public runtime readiness, 2026-09-11T20:29:34Z. All five settings
are installed and verified; both production deployments run their existing merged
commits and public readiness checks pass. Configuration is intentionally retained
as authorized delivery state. No temporary account, key, role, or database fixture
was created; no optional provider setting was added. Authenticated production
journeys and #1179's developer-account go-live are outside this rollout.
