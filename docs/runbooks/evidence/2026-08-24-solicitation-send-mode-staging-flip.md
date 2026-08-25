# Evidence — Solicitation send-mode staging flip (#633)

Campaign: execute `docs/runbooks/solicitation-sending-domain.md` for the **staging**
domain, flip the send lane + auto-approval lane ON in staging, and prove both
lanes end-to-end. Issue: #633 (map #617). Intake:
`docs/superpowers/plans/feat-633-solicitation-staging-flip-intake.json`.
Precedent: `2026-07-26-solicitation-watch-mode-staging-flip.md`.

## Environment

| Item | Value |
|---|---|
| Environment | **staging only** |
| Supabase (staging) | `kubdiqdhqbhwmqfditeg` |
| Supabase (prod) | `udeyaqnvpojbwgoaxwdg` — **NEVER touched by this campaign** |
| Worker | `repworth-worker` @ Railway env `staging` (`58c06358-…9a10`), `https://repworth-worker-staging.up.railway.app` |
| UI | `https://staging.repworth.net` (Vercel Custom Env `staging`) |
| Stripe | test mode (`sk_test_…`) |
| Sending domain (this campaign) | `feedback.staging.repworth.net` — does not exist yet at start |
| Prod sending domain | `feedback.repworth.net` — **not touched**; prod flip rides #620 |
| Git at start | `origin/main` = `origin/staging` = `6aba0c12`; staging worker deployment `a9db25ea` SUCCESS 2026-08-25 02:34 UTC on `6aba0c12` |
| Campaign branch | `feat-633-solicitation-staging-flip` @ `1229d418` (docs-only) |
| UTC start | 2026-08-25 03:11 UTC |
| Posture | Sends go to owner-controlled seed/test inboxes ONLY. No real customer contacts. No prod env var changes. Secrets never appear in this doc — key names + set/unset only. |

## Preflight

| # | Check | Result | UTC |
|---|---|---|---|
| P1 | DNS for `feedback.staging.repworth.net`: DKIM CNAMEs, `bounce.` MX, `_dmarc` TXT | ✅ all absent — clean slate, §1–§3 run here | 03:05 |
| P2 | Staging Railway baseline: `SOLICITATION_SEND_ENABLED`, `SOLICITATION_AUTO_APPROVAL_ENABLED`, `SOLICITATION_PLATFORM_DAILY_CAP`, `SOLICITATION_RESEND_API_KEY`, `SOLICITATION_SEND_FROM_ADDRESS`, `SOLICITATION_UNSUBSCRIBE_MAILTO` | ✅ all **unset** (matches "flag exists in no environment yet") | 03:08 |
| P3 | Staging Railway autonomy flags | ✅ `JUDGE_ENABLED=false`, `GOVERNOR_ENABLED=false`, `AUTO_APPROVAL_ENABLED=false`, `TRIAGE_ENABLED=false`, `ESCALATION_ENABLED=false`, `SOLICITATION_WATCH_ENABLED=true`, `MOCK_EXTERNAL_APIS=false` | 03:08 |
| P4 | Worker deployed and healthy on current main | ✅ deployment `a9db25ea` SUCCESS on `6aba0c12` | 03:10 |
| P5 | `staging` branch aligned to `main` | ✅ both at `6aba0c12` | 03:11 |
| P6 | Migration head incl. 114 on staging | ✅ verified in #632 ship session (catalogue read-back recorded on #633) — not re-proven here | 03:11 |
| P7 | Postmark DMARC registration for `feedback.staging.repworth.net` | ⚠️ **absent** (per #633 comment) — see D-1 | 03:11 |
| P8 | Vercel staging `SOLICITATION_UNSUBSCRIBE_MAILTO` (dual-lane twin) | ⏳ read at §4 time | — |

## Deviations log

- **D-1 (03:11)** — Staging domain has no Postmark DMARC registration; runbook §3
  lists `rua` addresses only for prod + apex. Resolution: register
  `feedback.staging.repworth.net` with Postmark DMARC Digests (digests to
  `norbert.esekiel@repworth.net`) before creating the §3 record; a
  staging-specific `rua` — never reuse the prod/apex tokens (keyed per domain).
  Fallback if registration fails: create the record without `rua` (valid DMARC;
  staging loses digests only) and record it here.
  **RESOLVED 03:14 UTC** — registered via Postmark's public API (HTTP 201):
  `rua = mailto:re+c4itw8rihpd@dmarc.postmarkapp.com`, digests to
  `norbert.esekiel@repworth.net`. External-auth wildcard verified:
  `dig +short TXT feedback.staging.repworth.net._report._dmarc.dmarc.postmarkapp.com`
  → `"v=DMARC1;"`. Process note: the registration call ran ~1 min before its
  ledger row was written — recorded here rather than silently absorbed.
- **D-2 (03:11)** — Intake invariant wrote "cap=50" into the pre-flip env step.
  Runbook §7 is authoritative: before §6 the cap is the smallest value that
  admits the seed list; 50/day is ramp stage 1 and starts only after §6 passes.
  Campaign follows §7. Owner's cap decision (50/day = stage 1) applies at the
  post-§6 step.

## Teardown ledger

Every fixture gets a row AT CREATION TIME. This campaign's sanctioned END STATE
leaves the staging lane ON (that is the ticket), so flag rows record the
pre-run value for rollback reference and an intended end state — "restore" is
NOT the goal for those rows.

| Fixture | Identifier | Pre-run value | Intended end state | Remove / roll back by | Done |
|---|---|---|---|---|---|
| Postmark DMARC registration | `feedback.staging.repworth.net` → `re+c4itw8rihpd@dmarc.postmarkapp.com` | none | **keep** (staging digest sink) | Postmark record deletion via its private token (held off-repo) | n/a — kept |
| Resend domain | `feedback.staging.repworth.net` (us-east-1, custom return path `bounce`) | none | **keep** (staging Sending identity) | `DELETE /domains/{id}` with team key | n/a — kept |
| Credential file: full-access Resend key | `scratchpad/resend.key` (session scratchpad, off-repo) | none | **delete at teardown** | `rm`; user may also revoke the key in Resend | [ ] |
| Credential file: Cloudflare DNS token | `scratchpad/cloudflare.token` (session scratchpad, off-repo) | none | **delete at teardown; user revokes token** | `rm` + revoke at dash.cloudflare.com | [ ] |
| Cloudflare DNS records ×4 (zone `repworth.net`, id `59b9cc47…`) | TXT `resend._domainkey.feedback.staging`, MX `bounce.feedback.staging`, TXT `bounce.feedback.staging`, TXT `_dmarc.feedback.staging` | none | **keep** (staging Sending identity) | delete records by id via zone DNS API/console | n/a — kept |
| Cloudflare DNS: Zoho inbound MX ×3 + verification TXT on `feedback.staging` | MX `feedback.staging` → mx/mx2/mx3.zoho.com; TXT `feedback.staging` (zoho-verification) | none | **keep** (§4 inbound routing) | delete records by id via zone DNS API/console | n/a — kept |
| Zoho org: domain `feedback.staging.repworth.net` + aliases `reviews@`, `unsubscribe@` | Zoho Mail admin, org of `repworth.net` | none | **keep** (§4 monitored mailboxes → norbert.esekiel@repworth.net) | remove domain/aliases in Zoho admin | n/a — kept |
| Resend API key, domain-scoped `sending_access` | name `solicitation-staging` (id recorded at creation below) | none | **keep** (becomes `SOLICITATION_RESEND_API_KEY`) | delete key in Resend | n/a — kept |
| Railway staging vars: `SOLICITATION_UNSUBSCRIBE_MAILTO`, `SOLICITATION_RESEND_API_KEY`, `SOLICITATION_SEND_FROM_ADDRESS`, `SOLICITATION_PLATFORM_DAILY_CAP` | worker `repworth-worker` env `staging` | all **unset** | **set** (10 = seed-gate cap; →50 at stage 1) | unset the vars (worker restarts) | n/a — kept |
| Railway staging flag `JUDGE_ENABLED` | worker env `staging` | `false` | **`true`** (solicitation release precondition) | set back `false` | n/a — kept |
| Railway staging flag `SOLICITATION_SEND_ENABLED` | worker env `staging` | unset | **`true`** (lane master) | set `false` (release phase stops; sweeps continue) | n/a — kept |
| Railway staging flag `SOLICITATION_AUTO_APPROVAL_ENABLED` | worker env `staging` | unset | **`true`** after §6 | set `false` (durable downgrade `auto_approval_disabled`) | n/a — kept |
| Vercel staging vars: `SOLICITATION_UNSUBSCRIBE_MAILTO`, `SOLICITATION_SEND_ENABLED` | project `rep-worth`, custom env `staging` | unset | **set equal to Railway** + redeploy | remove vars + redeploy | n/a — kept |
| Staging business + contacts + batches (campaign fixtures) | business `01a03992-4210-77cc-8ae2-e1764bf6d29f` "Tanicia Resort" (owner-created 2026-08-25, attested postal address); seed CSVs A/B/C with owner-controlled inboxes (incl. `+tag` variants) and ONE deliberate hard-bounce address (`bounce-arm@no-mx.staging.repworth.net`) | none (staging wiped 2026-08-05) | **keep** (standing staging fixtures, like the watch-mode precedent) | offboarding flow or targeted SQL cleanup if ever needed | n/a — kept |

## Unproven paths (campaign cannot PASS while any is open)

1. §1–§3 domain verified in Resend; DNS green, grey-cloud confirmed.
2. §4 `reviews@` mailbox routes to a monitored destination.
3. §6 seed gate: `spf=pass dkim=pass dmarc=pass` raw headers per provider; placement recorded; footer renders; RFC 8058 one-click POST lands and writes a Suppression ledger row; no `links.` rewrite.
4. Owner-approved batch drips end-to-end (Copilot arm).
5. Auto-approved batch drips end-to-end with Judge available (Autopilot arm).
6. Mid-flight halt exercised.
7. Unsubscribe from a real received email writes suppression; page confirms from ledger read.
8. Attribution: one clean `attributed` match (4 evidence columns + `review_attributed` outcome).
9. Attribution: seeded two-plus match logs `ambiguous`.
10. Attribution: out-of-window send resolves `no_candidates`.
11. Attribution: bounced/complained exclusion observed; unsubscribed-stays-eligible noted.
12. B3.4 observation: withheld-children cap-slot burn count recorded.

## Step log

### §1 — Resend domain create — PASS (03:23 UTC)

- `POST /domains` → HTTP 201, id `903fde2f-511c-44a3-968f-ac9501b0465a`,
  `name=feedback.staging.repworth.net`, `region=us-east-1`,
  `custom_return_path=bounce`, `status=not_started`.
- `PATCH /domains/{id}` `{"open_tracking":false,"click_tracking":false}` →
  HTTP 200. Read-back check deferred to the §2 verification step.
- No `links.` CNAME will be created (§1 belt-and-braces).
- DNS records returned by Resend (authoritative over §2's shape table):
  | Name | Type | Value | Priority |
  |---|---|---|---|
  | `resend._domainkey.feedback.staging` | TXT | `p=MIGf…` (218-char DKIM key) | — |
  | `bounce.feedback.staging` | MX | `feedback-smtp.us-east-1.amazonses.com` | 10 |
  | `bounce.feedback.staging` | TXT | `v=spf1 include:amazonses.com ~all` | — |
- **D-3 (03:24)** — runbook §2 table shows "DKIM ×3 CNAME →
  `<selector>.dkim.amazonses.com`"; Resend actually returned ONE DKIM TXT
  record (`resend._domainkey.…`). The runbook already warns the table is the
  shape, not the values, but the shape itself is now stale — runbook fix due
  in this session (feedback-loop rule 7). Grey-cloud warning still applies to
  the MX/TXT records Cloudflare could proxy; TXT/MX records are not proxyable,
  so the trap is now largely moot for this record set — noted in the fix.

### §2 — Cloudflare DNS — PASS (03:29 UTC)

Zone `repworth.net` (`59b9cc471e9aeb33b04bf01bed93dc92`), all records created
via API with `proxied=false`, token scoped to Edit-zone-DNS only:

| Record id | Type | Name | Content |
|---|---|---|---|
| `2b6926ec…` | TXT | `resend._domainkey.feedback.staging` | `p=MIGf…` (DKIM key) |
| `53e52f28…` | MX | `bounce.feedback.staging` | `feedback-smtp.us-east-1.amazonses.com` (prio 10) |
| `c6fcb880…` | TXT | `bounce.feedback.staging` | `v=spf1 include:amazonses.com ~all` |
| `44462e9b…` | TXT | `_dmarc.feedback.staging` | §3 record below |

Verified by `dig` against BOTH authoritative nameservers (`wally`/`zahir`
`.ns.cloudflare.com`): all four answer correctly. Note: a first `dig` ~10 s
after creation returned empty for three records — Cloudflare edge propagation
lag, resolved within ~2 min; no occlusion (the `staging.repworth.net` CNAME →
`cname.vercel-dns.com` creates no zone cut).

### §3 — DMARC — PASS (03:29 UTC)

```
_dmarc.feedback.staging.repworth.net TXT
"v=DMARC1; p=reject; adkim=s; aspf=r; rua=mailto:re+c4itw8rihpd@dmarc.postmarkapp.com; pct=100"
```

- `p=reject` day one, `adkim=s`, `aspf=r` (custom return path ⇒ relaxed SPF
  alignment), staging-specific Postmark `rua` (D-1), Postmark suggested-record
  trap avoided.
- External-auth wildcard confirmed before record creation (D-1).

### §1–§3 verification — Resend domain VERIFIED (03:32 UTC)

- `POST /domains/{id}/verify` accepted; ~20 s later `GET /domains/{id}` →
  `status: "verified"`, records DKIM/SPF/SPF all `verified`.
- Tracking read-back: `open_tracking: false`, `click_tracking: false` — the §1
  PATCH held. No `links.` record exists in the zone.
- **Unproven path 1 CLOSED.**

### §4 — `reviews@` + `unsubscribe@` mailboxes — PASS (05:12 UTC)

- **D-4 (04:45)** — runbook §4 suggests a Cloudflare Email Routing forward;
  the org's actual mail stack is **Zoho** (apex MX `mx*.zoho.com`, SPF
  `include:zoho.com`). Cloudflare routing on a subdomain is plan-gated and
  risks the apex MX. Resolution (owner call): faithful §4 via Zoho — domain
  `feedback.staging.repworth.net` added to the Zoho org (ownership
  auto-verified as a subdomain of verified `repworth.net`; unique code
  `zb54732528`), three Zoho MX records on the subdomain (Cloudflare ids
  `1e638520…`/`c36a538b…`/`a065c1ca…`), aliases `reviews@` + `unsubscribe@`
  on `norbert.esekiel@repworth.net`. Runbook wording patched (rule 7).
- Probe evidence (Resend events):
  - `reviews@` probe `9868016b…` → `delivered`; owner confirmed **Inbox**
    placement in Zoho.
  - `unsubscribe@` probe `62c31ad6…` → `bounced` (sent before the alias
    existed — the owner first created the aliases on the wrong domain);
    Resend auto-suppressed the address (`01a0374a…`, origin `bounce`).
    Suppression deleted via API, re-probe `c0ee5deb…` → `delivered`.
    (The RETRY2 probe was accidentally sent twice — harmless, own alias.)
- Both mailboxes route to a monitored destination (`norbert.esekiel@repworth.net`).
  Servicing obligations noted: manual opt-out entry within 10 business days
  via `/admin/suppressions` (`admin_manual`); `unsubscribe@` daily on
  business days once advertised.
- Transient fixture handled: Resend suppression row created by the bounce
  was deleted 05:08 UTC (verified by the successful re-send).
- **Unproven path 2 CLOSED.**

### §7 — env vars, staged (05:15–05:2x UTC)

- **Baseline moved (recorded, not a deviation):** while the campaign ran,
  `main` advanced (#959 landing revamp, #961 `ci:env-registry`, #962
  tenant-scope audit — all inert for the solicitation worker lane) and
  staging was realigned by a parallel session at 05:12 UTC. Staging worker
  now deploys `ef9e9ac5`; preflight P4/P5 SHAs are superseded.
- 05:15 — Resend scoped key created: id `33ef3708-d6ec-49b2-87b8-380427ccfd47`,
  name `solicitation-staging`, `permission=sending_access`,
  `domain_id=903fde2f…` (the staging domain). Token held off-repo.
- 05:17 — Railway staging batch 1 set in ONE call (one restart):
  `SOLICITATION_UNSUBSCRIBE_MAILTO=unsubscribe@feedback.staging.repworth.net`,
  `SOLICITATION_RESEND_API_KEY=<scoped key>`,
  `SOLICITATION_SEND_FROM_ADDRESS=reviews@feedback.staging.repworth.net`,
  `SOLICITATION_PLATFORM_DAILY_CAP=10` (seed-gate value per §7; NOT stage 1).
  Deployment `c4ca3ff8` SUCCESS; boot log clean
  (`[boot] readiness cure complete`), release cycle ticking with the lane
  still off (sweeps-run-while-flag-off behavior confirmed).
- 05:18 — Vercel staging custom env: `SOLICITATION_UNSUBSCRIBE_MAILTO`
  (equal value) and `SOLICITATION_SEND_ENABLED=true` added via CLI
  (project linked from scratchpad, `.vercel/` kept out of the repo).
  **Redeploy deliberately deferred** until the Railway flags are green —
  worker-before-UI ordering for the same logical flag.
- 05:20 — Flag flip 1/2: `JUDGE_ENABLED` `false`→`true` (Railway only —
  worker-only read; WS6 governor stays `false`, not read by this lane).
  Out-of-§8.4-order enablement (TRIAGE/ESCALATION off) confirmed by owner
  in the batch sign-off; risk: judge sweep idles for the reply lane since
  `AUTO_APPROVAL_ENABLED=false`.

- **D-5 (05:28)** — the two `vercel env add` calls (CLI 54.14.5) stored
  **EMPTY values** — the exact trap deployment-guide Phase 3 records for
  v54.6.1; it is still live in 54.14.5. Detected by `vercel env pull`
  (`SOLICITATION_SEND_ENABLED=""`). Fix: REST per the guide — DELETE the two
  empty rows (both 200), `POST /v9/projects/{id}/env` with the value in the
  JSON body + `customEnvironmentIds:[env_Xdvi79…]`. Re-pull confirms
  `SOLICITATION_SEND_ENABLED="true"`,
  `SOLICITATION_UNSUBSCRIBE_MAILTO="unsubscribe@feedback.staging.repworth.net"`.
  Lesson: never trust `vercel env add` stdin on this CLI generation — pull
  and verify, or go REST from the start.
- 05:24 — Flag flip 2/2: `SOLICITATION_SEND_ENABLED` unset→`true` (Railway).
  Deployment `86045c16` SUCCESS, boot clean 05:24:23 —
  `assertSolicitationSendEnv` accepted the four §7 vars (a violation refuses
  boot). Release poller ticking; lane live at cap 10 with zero eligible
  batches (staging data was wiped 2026-08-05 — nothing can send yet).
- 05:25 — Vercel staging redeploy triggered via `POST /v13/deployments`
  (git-sourced, `target:"staging"`, ref `staging`, repoId 1202359628):
  `dpl_2swP98waDaRc9ApSRWDpUaZabiwL` → **READY 05:26:44 UTC**. UI now reads
  `SOLICITATION_SEND_ENABLED=true` + the mailto var.
- **§7 state at this point**: Railway staging = 4 vars + `JUDGE_ENABLED=true`
  + `SOLICITATION_SEND_ENABLED=true`, cap 10;
  `SOLICITATION_AUTO_APPROVAL_ENABLED` still unset (post-§6 step);
  Vercel staging = mailto + send flag, deployed. Both §7 dual-lane values
  verified equal.

### First E2E attempt — batch A withheld 4/4 — PRODUCT DEFECT FOUND (15:52–16:2x UTC)

- Owner re-seeded staging: business `01a03992…` "Tanicia Resort" (fresh
  connect, attested postal address), CSV A uploaded 15:52:00. Pipeline ran
  clean: `csv_ingest` → `build_solicitation_batch` →
  `generate_solicitation_asks`, all completed on attempt 1. Batch
  `01a0399f-175d…` built 15:52:07 with 4 send-mode asks.
- **Defect**: send parent run `01a0399f-3978…` failed
  `{"code":"generation_failed","failed_count":0,"withheld_count":4}` —
  all four Outreach rows `withheld` / `lint_failed` / `lint_detail:
  ["unverifiable_fact"]`. Batch settled 15:52:20 (13 s after build); the
  Requests panel correctly shows "This batch is finished".
- **D-6 root cause** (diagnosed from run spine + code, no content persisted
  by design): `ask-prompt-policy.ts:35` tells the model to ask for a
  "Google review"; the class-6 provenance rule requires every capitalized
  mid-sentence token to appear in an interpolation value or
  `PROVENANCE_ALLOWLIST` (ask-compliance-lint.ts:472) — which contains
  scaffolding tokens (`repworth`, `leave`, months, weekdays) but **not
  `google`**. The model echoes "Google" mid-sentence ⇒ deterministic
  withhold. Never caught earlier: the flag existed in no environment
  (lane shipped inert), and lint tests/goldens run fixture bodies, not real
  prompt output.
- False trails eliminated on the way (recorded so nobody re-walks them):
  Vercel deployment env proven correct via the unauthenticated `/u/<token>`
  Neutral-page probe (mailto renders); client staleness eliminated by
  hard-reload + re-login; the "Watch-mode · nothing sent" pill sits in
  `BatchReport`'s FunnelHero alongside the send-lane ApprovalPanel and is
  not the flag signal.
- Disposition: bug filed as **#963**; fix rides its own branch, NOT
  this docs-only campaign worktree. Campaign blocked at §6 until the fix
  deploys to staging; §1–§4 + §7 evidence unaffected.

*(further entries appended in runbook order)*
