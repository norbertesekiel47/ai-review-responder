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
| Credential file: full-access Resend key | `scratchpad/resend.key` (session scratchpad, off-repo) | none | **delete at teardown** | `rm`; user may also revoke the key in Resend | [x] deleted 2026-08-26 07:3x UTC |
| Credential file: Cloudflare DNS token | `scratchpad/cloudflare.token` (session scratchpad, off-repo) | none | **delete at teardown; user revokes token** | `rm` + revoke at dash.cloudflare.com | [x] file deleted 2026-08-26 07:3x UTC; [x] token revoked by owner (confirmed 2026-08-26, addendum below) |
| Cloudflare DNS records ×4 (zone `repworth.net`, id `59b9cc47…`) | TXT `resend._domainkey.feedback.staging`, MX `bounce.feedback.staging`, TXT `bounce.feedback.staging`, TXT `_dmarc.feedback.staging` | none | **keep** (staging Sending identity) | delete records by id via zone DNS API/console | n/a — kept |
| Cloudflare DNS: Zoho inbound MX ×3 + verification TXT on `feedback.staging` | MX `feedback.staging` → mx/mx2/mx3.zoho.com; TXT `feedback.staging` (zoho-verification) | none | **keep** (§4 inbound routing) | delete records by id via zone DNS API/console | n/a — kept |
| Zoho org: domain `feedback.staging.repworth.net` + aliases `reviews@`, `unsubscribe@` | Zoho Mail admin, org of `repworth.net` | none | **keep** (§4 monitored mailboxes → norbert.esekiel@repworth.net) | remove domain/aliases in Zoho admin | n/a — kept |
| Resend API key, domain-scoped `sending_access` | name `solicitation-staging` (id recorded at creation below) | none | **keep** (becomes `SOLICITATION_RESEND_API_KEY`) | delete key in Resend | n/a — kept |
| Railway staging vars: `SOLICITATION_UNSUBSCRIBE_MAILTO`, `SOLICITATION_RESEND_API_KEY`, `SOLICITATION_SEND_FROM_ADDRESS`, `SOLICITATION_PLATFORM_DAILY_CAP` | worker `repworth-worker` env `staging` | all **unset** | **set** (10 = seed-gate cap; →50 at stage 1) | unset the vars (worker restarts) | n/a — kept |
| Railway staging flag `JUDGE_ENABLED` | worker env `staging` | `false` | **`true`** (solicitation release precondition) | set back `false` | n/a — kept |
| Railway staging flag `SOLICITATION_SEND_ENABLED` | worker env `staging` | unset | **`true`** (lane master) | set `false` (release phase stops; sweeps continue) | n/a — kept |
| Railway staging flag `SOLICITATION_AUTO_APPROVAL_ENABLED` | worker env `staging` | unset | **`true`** after §6 | set `false` (durable downgrade `auto_approval_disabled`) | n/a — kept |
| Vercel staging vars: `SOLICITATION_UNSUBSCRIBE_MAILTO`, `SOLICITATION_SEND_ENABLED` | project `rep-worth`, custom env `staging` | unset | **set equal to Railway** + redeploy | remove vars + redeploy | n/a — kept |
| Staging account tier flip (D-8) | `accounts` `01a03992-…ebcfba7e0f2e` + `businesses` `01a03992-…e1764bf6d29f`: `subscription_tier` `copilot`→`autopilot` | `copilot` | **keep** (standing Autopilot staging fixture) | `UPDATE … SET subscription_tier='copilot'` on both | n/a — kept |
| Seeded solicitation `auto_approval_policies` row (D-8) | account `01a03992-…ebcfba7e0f2e`, `persona='solicitation'`, `action_class='sending'`, veto 30 min, account-level | none | **keep** (auto lane stays exercisable) | `DELETE` the row | n/a — kept |
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
- **D-7 (16:2x)** — §6 provider placement coverage is **Gmail + Zoho only**:
  the owner has no Outlook or Yahoo seed inbox. Recorded as a documented
  gap with owner sign-off; the prod run (#620 brief) should re-decide
  whether to provision Outlook/Yahoo seeds before the prod ramp.
- Process note: one evidence edit (the #963 number insertion) went through
  `sed -i` instead of the sanctioned Edit path — benign content, wrong
  mechanism, not repeated.

### #963 fix cycle (16:0x–16:2x UTC)

- Fix built on branch `fix-963-ask-lint-google` (`4fe2c0dc`): `'google'`
  admitted to `PROVENANCE_ALLOWLIST` as prompt vocabulary,
  `ASK_LINT_VERSION` → `ask_lint_2026-08-25.1`, golden regenerated,
  regression test added (mid-sentence "Google" passes class 6). Suite: 88
  lint tests green; pre-push ran the full cheap-CI set green after a
  merge-ledger row was added. PR **#964** open to `main`; merge waits for
  this campaign's evidence (RISK-high lane, owner approval).
- Staging fast-forwarded `ef9e9ac5` → `4fe2c0dc` (16:20 UTC) — worker +
  UI redeploying. Campaign resumes with seed CSV **A2** (fresh `+a2`
  identities; batch A's contacts are `over_contacted` for 30 days, the
  ADR 0020 cost — expected to surface as held-back rows in batch A2's
  report, itself a useful observation).
- **B3.4 pre-observation**: batch A's four lint-withheld Outreach rows have
  `queued_at IS NULL` — render-time withholds never enter the dispatch
  count, so they burn NO cap slots. B3.4's burn is specifically the
  DISPATCH-GATE withhold (post-queue). Staging has not yet produced one;
  the arm stays open.

### #963 second finding — Title-Case subjects (16:41–16:5x UTC)

- Batch A2 (`01a039cb-e753…`, built 16:41:04 on the google-fixed worker)
  withheld 4/4 again: `lint_failed` / `unverifiable_fact`, send parent
  `generation_failed`. Same signature, different offender.
- Render bytes ARE persisted (`solicitation_outreach.rendered_subject/_body`
  + `interpolation_inputs`) — diagnosis went straight to content this time.
  Specimen subject: `We'd Love Your Feedback!` — the model writes
  **Title-Case subjects**, and §2.4's provenance arm reads every capitalized
  mid-sentence token ("Love", "Your", "Feedback") as an invented fact.
- **Mechanical confirmation**: replaying `lintAsk` on the exact persisted
  bytes reproduces `unverifiable_fact`; the identical content with a
  sentence-case subject lints CLEAN. The google fix works; the subject was
  the second, independent deterministic offender.
- Fix (same branch, commit `f400245a`): prompt style rule — "Write the
  subject in sentence case…" — `SOLICITATION_ASK_PROMPT_VERSION` →
  `2026-08-25.1`. Lint deliberately unchanged: weakening subject provenance
  coverage is a spec-owner decision, kept as the recorded fallback if the
  model's style compliance proves flaky. Residual risk: a stochastic
  Title-Case subject still withholds (visible, owner-regenerable) — this
  campaign measures the rate.
- Batch A2's contacts burned like batch A's; campaign resumes on CSV **A3**
  (`+a3` identities).

### Batch A3 — first clean render + owner approval (17:05–17:06 UTC)

- Batch `01a039e1-dd42…` (CSV A3) built 17:05:03 on worker `f400245a`:
  **4/4 Outreach rows `rendered`** — the lint passed on the first live
  generation after both #963 fixes. All four subjects sentence-case
  ("Thank you for visiting Tanicia Resort"); prompt style rule effective,
  Title-Case rate this batch: 0/4.
- Owner approved 17:06:40 — `approval_method='owner'` recorded (invariant
  #3's Copilot form). Release drip (2/tick, cap 10) begins on the next
  poller tick; delivery evidence follows.

### Batch A3 drip — the lane sends (17:21–17:23 UTC)

- Owner veto window (15 min, `veto_deadline_at` 17:21:40) held exactly: first
  queue 17:21:52, twelve seconds after the deadline. Rate bound held: 2 per
  tick (17:21:52 pair, 17:22:52 pair), `RELEASE_PER_TICK_BUDGET=2` on the
  60 s poll as ADR 0022 pins.
- All 4 `sent`; Resend events: Gmail + Zoho primary + `reviews@` alias
  **delivered**, bounce-arm `sent` (hard bounce pending, async). From
  renders per-business: `"Tanicia Resort" <reviews@feedback.staging.repworth.net>`
  (§2.3 display-name behavior confirmed).
- Note: the upload normalizes `+tag` sub-addresses away — recipients are the
  base handles. Same inboxes; no impact on the arms.
- **Unproven paths 4 partially closed** (drip + delivery proven; §6
  placement + raw-header auth check pending owner capture).

### THIRD live finding — re-upload erases ask/outreach history (#965, 17:3x UTC)

- Investigating why `over_contacted` never fired across A/A2/A3's identical
  normalized handles: the prior-send lookup keys on `contact_id`
  (`batch-builder.ts` ~:501), AND an upload REPLACES the contact rows,
  cascading their asks + outreach away. Verified: batches A and A2 now have
  **zero children**; only A3's 4 outreach rows exist platform-wide.
- Consequences (filed as **#965**): MIN_GAP resets on any list re-upload;
  #632's attribution candidates are destroyed inside the 14-day window;
  dispatch receipts/bounce records erasable; send-breaker window under-reads.
  Design decision needed before the prod flip — named input to the #620
  brief alongside B3.4.
- **Campaign sequencing consequence**: NO further CSV uploads until every
  A3-dependent arm completes (§6 headers, unsubscribe, ALL attribution
  arms). Batch B (auto lane) and the halt arm run after, accepting that
  their upload erases A3 history — by then the evidence is captured here.
- The #963 specimen renders quoted in this doc are now the ONLY surviving
  copy — the DB rows were cascade-deleted by the A3 upload.

### §6 seed gate — Gmail auth verdicts (owner-captured raw source, 17:22 send)

```
Authentication-Results: mx.google.com;
  dkim=pass header.i=@feedback.staging.repworth.net header.s=resend
  dkim=pass header.i=@amazonses.com (SES infra signature — expected)
  spf=pass smtp.mailfrom=…@bounce.feedback.staging.repworth.net
  dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=feedback.staging.repworth.net
```

- All three verdicts PASS under `p=reject`; §3's `spf=pass + dmarc=fail`
  trap absent (aspf=r working). TLS1_3 in transit.
- **Placement**: Gmail **Promotions** (not Spam) — recorded honestly; Zoho:
  both copies in the primary Inbox. Coverage per D-7: Gmail + Zoho.
- RFC 8058: `List-Unsubscribe` = HTTPS one-click `/u/<token>` + `mailto:`;
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` present.
- Footer: identification line, attested postal address (20350 Stevens Creek
  Blvd, Cupertino, CA 95014), unsubscribe line. Review link:
  `https://search.google.com/local/writereview?placeid=ChIJqb_7RPR5UDcR…` —
  canonical Place ID, google.com property, NO `links.` rewrite.
- `Reply-To: <owner email>` (§4 stray-catcher design confirmed).
- **Unproven path 3 (auth half) CLOSED; placement recorded.** One-click POST
  half continues below.

### Unsubscribe arm — ledger writes; FOURTH live finding (#966) (17:43–17:52 UTC)

- **Human path PROVEN**: owner clicked the footer link in the Gmail copy and
  confirmed → `solicitation_suppressions` row 17:43:02, `channel=email`,
  `normalized_handle=norbertesekiel@gmail.com`, **`scope=global`**,
  `source=unsubscribe_link`.
- **Token single-use PROVEN**: re-POSTing that redeemed token returns the
  Neutral page ("may already have been used…") and writes NO second row —
  the §5.4 no-dead-end rule and idempotency, both observed.
- **#966 — the advertised one-click URI is the wrong endpoint.** Tested with
  a FRESH token from the Zoho copy:
  | POST target | Result | Ledger |
  |---|---|---|
  | `/u/<token>` (**what the header advertises**) | 200, renders the confirm-button page | **no write** |
  | `/api/u/<token>` | 303 | row written 17:50:54 |
  | worker `/ingress/unsubscribe/<token>` (invariant #6 home) | 200 `{"received":true}` | idempotent re-POST |
  So every provider-automated one-click (Gmail chip, Yahoo, Apple Mail)
  silently no-ops: 200, no suppression. Filed **#966** with the fix shape
  (dispatch mints ONE url for two consumers — `dispatch.ts:786`
  `buildUnsubscribeUrl` → `:1747`; the header half must become the worker
  ingress URL).
- Also observed: Gmail showed **no unsubscribe chip** for this message —
  consistent with a brand-new domain lacking sender reputation, and not
  itself proof of the header defect (the header IS present and well-formed).
- Unproven path 3's one-click half stays **OPEN**, now with a named cause.

### Campaign sequencing decision (#965 forces it)

Proving #966's fix needs a NEW send → a new batch → a new CSV upload →
which per #965 **erases A3's outreach rows**, i.e. the attribution
candidates. Therefore the remaining arms run in this order:
1. **Attribution arms on A3's surviving `sent` rows** (needs a real Google
   review; 14-day window is generous).
2. Then #966's fix + batch B, which also carries the **auto-approval lane**
   and **mid-flight halt** arms.

### #966 fix shipped to staging (18:0x UTC)

- Commit `d007ee80` on the same branch (PR #964 now covers #963 + #966).
  Dispatch mints TWO urls: `/u/<token>` page for the footer,
  `${WORKER_PUBLIC_URL}/ingress/unsubscribe/<token>` for the header.
  `OutboundMessage.unsubscribeOneClickUrl` added; `EmailAdapter` feeds the
  machine url to `getEmailHeaders`.
- Guard integrity: the adapter's fail-closed test asserted on the FOOTER url
  (which is how the wrong endpoint shipped) — it now asserts on the machine
  url, plus `not.toContain` on the header for the page url, plus a dispatch
  assertion that the machine url never enters body/subject. 1,236 tests green
  across `src/lib/messaging`, `src/lib/solicitation`, `worker/ingress`.
- Staging fast-forwarded to `d007ee80`. Proof of the fixed header requires a
  NEW send (batch B), which per #965 erases A3's outreach — so batch B is
  where the auto-approval lane, the halt arm, and the #966 proof all land
  TOGETHER, after the attribution arms finish on A3.

### Session resume — reconciliation + provider-state reads (18:2x–18:4x UTC)

- Resume reconciliation clean: worktree at `b0d5396b`, gate GREEN at HEAD,
  intake copies match; branch 5 commits behind `origin/main` (docs-only —
  no rebase mid-campaign). Staging worker healthy on `d007ee80`
  (deployment `4ec1b27d`, 18:07 UTC).
- A3 re-verified in DB: all 4 outreach rows `sent`, none attributed; the
  newest review detection is still the 15:42 initial import — the owner
  review for the attribution arm has not been left yet.
- **Ambiguous-arm update**: CSV A3 seeded TWO distinct contacts named
  "Alex Rivera" (different emails), both `sent` — the two-candidate
  specimen already exists inside ONE batch, so the earlier
  "MIN_GAP_DAYS blocks the natural path" concern is moot on the outreach
  side. The arm still needs the REVIEW side: a live-ingested Google review
  under the name "Alex Rivera" (second Google identity, or a seeding
  decision — owner call, open).
- **Bounce-arm status (not a defect)**: Resend shows the bounce-arm message
  (`fdc1c6c6…`) in `delivery_delayed` — SES treats the NXDOMAIN target as
  retryable and has not hard-bounced yet (`no-mx.staging.repworth.net`
  verified: no A, no MX, no wildcard). The staging webhook endpoint
  (`0e671d1f…`) is enabled and subscribed to `email.bounced` /
  `email.complained` / `email.delivered` / `email.opened` (matches
  deployment-guide §6.1); the drip's three `email.delivered` events landed
  as `processed` `inbound_events` rows. The lane works; `bounced_at` writes
  itself whenever SES gives up. The bounced-exclusion attribution arm
  waits on that.
- **Attribution enqueue scope re-confirmed in code**
  (`src/lib/reviews/process-review.ts`): NEW-review LIVE lane only — the
  15:42 imported reviews deliberately never enqueue attribution (zero
  `attribution_resolved` lines in that deployment's logs, as designed).
  `no_candidates` therefore still needs its own specimen. Natural shape
  noted for the seeding decision: a live-DETECTED review whose Review-time
  anchor PRECEDES every `sent_at` (e.g. a stranger's review left before
  17:22 today, detected by a later poll) resolves `no_candidates`, not
  `no_match`.
- **Observations, non-campaign**: (a) staging `/ingress/stripe` returns
  500s on a stream of `customer.subscription.deleted` events for test-mode
  customers erased by the 2026-08-05 staging wipe — pre-existing
  retry-by-design noise, not caused by `d007ee80`; it may pollute the
  "HealthAlertPoller stays quiet" observation window and is recorded here
  so it is not misread as a campaign regression. (b) The Resend team
  carries a second ENABLED webhook endpoint pointing at an ngrok dev
  tunnel (`unmoderated-stormy-sweer.ngrok-free.dev`), subscribed to ALL
  event types — dev leftover, hygiene flag for the owner; not touched by
  this campaign.

### Attribution arm — clean `attributed` match PROVEN (18:53–18:59 UTC)

- Owner posted a real Google review on the Tanicia Resort location:
  "Great Atmosphere", 5★, reviewer name "Norbert Esekiel",
  `review_date` 18:53:24. Zernio detected it at 18:59:20 (~6 min
  post-to-ingest). Review row `01a03a4a-92fe-73c0-af02-7fae36419282`,
  `status=new` (reply lane proceeds independently of this campaign).
- **All 4 evidence columns** written on the matching outreach row
  `01a039e2-09b4…` (the "Norbert Esekiel" contact):
  `attributed_review_id` = the review id, `attributed_at` 18:59:24.973,
  `attribution_rule='full_name'`, `attribution_detail` =
  `{rule: full_name, sent_at, star_rating: 5, candidate_count: 4,
  matcher_version: attribution_v1}` — no personal data in the detail,
  as specified. Exactly ONE row attributed; the other three rows
  untouched (verified by full-table read — only 4 outreach rows exist).
- **`review_attributed` outcome on the Lazy child**: outcome
  `01a03a4a-a3f9…`, `outcome_kind='review_attributed'`,
  `attributed_agent='solicitation'`, `unit_count=1`, on run kind
  `solicitation_ask` (subject `01a039e1-ee52…`), `occurred_at` identical
  to `attributed_at` — same transaction, as designed.
- `attribution_resolved` logged 18:59:25.398 (Railway's MCP log view
  renders only the `msg` field; the resolution facts are durable in
  `attribution_detail`, which is the authoritative record anyway).
- **Unsubscribed-stays-eligible OBSERVED (the locked rule)**:
  `candidate_count=4` includes both globally-suppressed handles (17:43
  and 17:50 ledger rows), and the ATTRIBUTED contact's own handle is the
  suppressed Gmail one — suppression did not exclude it from candidacy,
  exactly as specified. The bounced/complained-exclusion half of path 11
  still waits on the bounce stamp (SES `delivery_delayed`).
- **Unproven path 8 CLOSED.** Path 11 half-closed (eligibility half).

### Owner decision — `no_candidates` closes as a DOCUMENTED GAP (19:0x UTC)

- Owner call (this session): the `no_candidates` resolution is not exercised
  live in this campaign. Basis, recorded so the decision is auditable:
  inside the campaign window every new live-ingested review has in-window
  candidates (A3 now, batch B later), so the only natural specimen is a
  review whose Review-time anchor PRECEDES every `sent_at` detected late —
  luck-dependent, not schedulable. The resolution is a log-only abstention
  sharing `attributeReview`'s early-return path with `ambiguous`/`no_match`
  (integration-test covered); no durable row exists to verify either way
  by design (branch-review M4).
- **Unproven path 10 closed as a documented gap with owner sign-off**
  (same disposition shape as D-7 provider coverage). The #620 prod-flip
  brief should re-decide whether the prod campaign needs a live specimen.
- `ambiguous` (path 9) re-planned on owner constraint: no Google account
  rename is possible; the arm will use the name "Norbert Esekiel" —
  mechanics recorded when the second-account detail is confirmed.
- **Second-account detail confirmed (owner)**: a second Google account with
  the SAME display name "Norbert Esekiel" exists and has never reviewed
  this location. The ambiguous arm therefore rides batch B: CSV B seeds
  TWO "Norbert Esekiel" contacts (both deliverable), and the second
  account posts the review after the drip → two matching rows →
  `ambiguous` logged, nothing attributed. Full batch-B choreography:
  handoff doc, "Remaining arms" step 2.
- **Bounced-exclusion disposition (recommended, owner veto open until
  batch B)**: prove the STAMP live on A3 (webhook `email.bounced` →
  `bounced_at`/`bounce_kind` — watcher running), and close the
  candidate-query EXCLUSION half as test-covered
  (`src/lib/solicitation/attribution.ts:231-232` — `bounced_at IS NULL
  AND complained_at IS NULL`;
  `attribution.integration.test.ts:609` exercises it), rather than
  coupling batch B to a second multi-hour SES bounce clock — the same
  evidence-integrity reasoning that sequenced the arms after #965.

### Owner decision — no second alias for the ambiguous pair (19:2x UTC)

- Owner declined minting a second Zoho alias, with an architectural
  rationale worth keeping: a test design that needs one alias per
  ambiguous specimen scales infrastructure with test cases — wrong
  direction. Attribution candidacy is `sent`-based by design
  (provider-accept, not delivery), so the second same-name contact uses
  a fresh no-MX address instead (`norbert-b@no-mx.staging.repworth.net`).
- Honest limitation recorded: the ambiguous specimen's second row is
  undeliverable by design. The match test is unaffected (the matcher
  reads contact names and row timestamps, never the inbox), but the row
  will hard-bounce hours post-send. **Race control** (in the batch-B
  choreography): post the ambiguous review promptly after tick 1 and
  re-verify row 2's `bounced_at IS NULL` immediately before posting —
  a landed bounce would exclude row 2 and wrongly ATTRIBUTE to row 1,
  burning the specimen.

### Owner decision — batch B starts NOW; bounce-stamp proof retargets to batch B rows (19:4x UTC)

- Owner call: finish the campaign today. The "bounce before upload" rule
  existed to protect the stamp EVIDENCE, not the A3 row itself; batch B
  seeds two no-MX rows whose bounces land tonight on rows that survive
  the campaign (no further upload follows batch B). The live stamp proof
  (webhook `email.bounced` → `bounced_at`/`bounce_kind`) transfers to
  those rows; the watcher retargets after the drip. A3's still-pending
  bounce will arrive against a cascade-deleted row and no-op in the
  Solicitation lane — EXPECTED, recorded here in advance so the warn log
  is not misread.
- Interim state at decision time: A3 bounce-arm still `delivery_delayed`
  at the provider (~2.5 h of SES retries), `bounced_at` NULL.

### §7 final flag — `SOLICITATION_AUTO_APPROVAL_ENABLED` → `true` (20:11–20:14 UTC)

- `flag-flip` skill run: env-vars.md entry read; couplings verified —
  `SOLICITATION_SEND_ENABLED=true` (required twin) and `JUDGE_ENABLED=true`
  (Judge stays release-owned, #900). Reply-lane §8.4 ordering does not
  govern this lane's own switch; the Judge flip preceded it by design.
- Railway staging: unset → `true` in one call; deployment `e6445b3e`
  SUCCESS, boot clean 20:13:34 UTC.
- Vercel staging twin (settings routes read the flag through
  `src/lib/auto-approval/settings.ts` → `solicitation-settings.ts`):
  `vercel api` (beta, CLI 54.14.5) mangles POST bodies — three body forms
  all returned 400 "Invalid JSON"; the CLI token file is not readable in
  this session (classifier). The var is set by the OWNER interactively
  (`vercel env add` on a real TTY — D-5's empty-value trap is specifically
  the non-TTY stdin path) — completion recorded below when done.
- **COMPLETED (20:2x–20:3x UTC)** without the owner: this CLI's
  non-interactive mode exposes `--value` (a direct flag, not the D-5 stdin
  path). First attempt stored the var as SENSITIVE (read-back shows empty
  by design — NOT the D-5 signature); recreated with
  `--no-sensitive --force`, read-back now returns a non-empty ciphertext
  for the staging custom env row. Staging redeployed via
  `vercel redeploy <latest-staging-deployment> --scope …` (the `api`
  subcommand cannot POST bodies; `redeploy` needed the explicit team
  scope): new deployment `rep-worth-6vxdkokzn…` READY on `d007ee80`,
  `customEnvironment=staging` (custom envs report target class `preview`
  with the custom env attached — same shape as §7's git-sourced deploy).
  Both dual-lane reads now carry the flag.

### D-8 (20:1x) — Autopilot tier + solicitation policy seeded via SQL

- Pre-upload check of `decideAutoApproval` conditions found the Tanicia
  account `tier=copilot` with ZERO `auto_approval_policies` rows — batch B
  would silently land in the owner lane (`tier` / `no_policy_row`).
  `AUTOPILOT_PURCHASABLE=false` on staging blocks the UI seeding path.
- Precedent followed: evidence 2026-07-21 Phase C — SQL tier shortcut +
  server-side policy seed, recorded as an invariant-#14 deviation there
  and again here.
- Applied in one transaction (20:16 UTC): `accounts` + `businesses`
  `subscription_tier` → `'autopilot'`; one `auto_approval_policies` row —
  `persona='solicitation'`, `action_class='sending'`,
  `veto_window_minutes=30` (the SHORTEST legal solicitation window per
  the `persona_consistency` CHECK — {30,60}; the reply lane's {15,30} does
  not apply), `location_id` NULL (account-level), caps NULL,
  `gen_random_uuid()` id (seed row — not the UUIDv7 convention).
- Verified post-seed: `account_tier=autopilot`,
  `solicitation_policy_rows=1` (unsuspended). All `decideAutoApproval`
  conditions now pass. Teardown rows appended to the ledger.

### Batch B — Autopilot arm PROVEN; drip complete (03:17–03:50 UTC, Aug 26)

- CSV B uploaded ~03:17 UTC; batch `01a03c12-a2d2…` built 03:17:33 with
  NINE asks: the upload MERGED contacts (4 surviving A3 contacts + 6 CSV
  rows − 1 email-overlap dedup). **#965's erased-history failure did NOT
  manifest on this upload — all 4 A3 outreach rows survive**, including
  the attributed row and the bounce-arm row. The A→A2→A3 cascades hit
  identical normalized handle sets; tonight's overlap was ONE email
  (`reviews@`), and even that contact was UPDATED in place (renamed
  "Alex Rivera"→"Norbert Esekiel"), not replaced. #965's precise trigger
  conditions need the design work — named input to the #620 brief.
- Restraint observed live: all four re-contacted A3 identities withheld
  at BUILD (`over_contacted`/suppression precedence — ADR 0020's cohort
  cost, first live observation); the 5 fresh contacts rendered.
- **Auto lane**: `decideAutoApproval` passed on the D-8 seed;
  `approval_method='auto_policy'` recorded 03:17:54 (21 s post-build);
  veto notice sent; `veto_window_granted` step 03:18:34;
  `veto_deadline_at` 03:47:58 (the 30-min policy window).
- **Window held exactly**: first queue 03:48:34.8 — 36 s AFTER the
  deadline, on the next poller tick. Rate bound held: 2/tick
  (03:48:34 pair, 03:49:34 pair, 03:50:34 single).
- All 5 rows `sent`; batch settled `send_closed_at` 03:50:39; Send batch
  parent `completed` (`exhausted` disposition); `send_batch_closed` step.
- **Unproven path 5 CLOSED.**
- **Missed this batch, rescheduled to a small batch C**: the mid-flight
  halt and the B3.4 dispatch-withhold. The owner was away during the
  window (no `dw-arm@` suppression, no halt click), and the session's
  drip watcher returned a false "not started" for the whole run.
  Process note: all three background psql watchers this session failed
  SILENTLY (empty results swallowed by `2>/dev/null`) — for the rest of
  the campaign, state is verified by direct DB reads only.
- Ambiguous pair armed: A3-`reviews@` (renamed contact) + B-`norbert-b@`,
  both `sent`/unbounced/unattributed; bounce-race check GREEN 04:06;
  owner cued to post the second-account review.

### #966 one-click proof — the FIXED header endpoint writes the ledger (04:08–04:10 UTC)

- No batch-B mail reached a real inbox (`reviews@` withheld by restraint;
  the rest no-MX), so the header URL was RECONSTRUCTED instead of read
  from a delivered copy — validity chain: Resend's sent-content API
  returns the mail's HTML, whose footer carries the raw token
  (`/u/<token>`); `dispatch.ts:1781-1782` (at `d007ee80`, the deployed
  SHA) mints BOTH URLs from that ONE `minted.rawToken`, the header half
  via `buildUnsubscribeOneClickUrl` = `${WORKER_PUBLIC_URL}
  /ingress/unsubscribe/<token>`; adapter tests pin that URL into the
  `List-Unsubscribe` header. (Resend's API exposes no header fields —
  recorded as the reason a delivered-copy read was impossible.)
- RFC 8058 POST (`Content-Type: application/x-www-form-urlencoded`,
  body `List-Unsubscribe=One-Click`) to the reconstructed URL →
  HTTP 200 `{"received":true}`; Suppression ledger row 04:09:56:
  `norbert-b@no-mx.staging.repworth.net`, `channel=email`,
  `scope=global`, **`source='unsubscribe_one_click'`** — the distinct
  one-click source attribution, vs `unsubscribe_link` on the two 17:4x/
  17:50 human-path rows. Suppressing this handle cannot affect the
  ambiguous arm: unsubscribed-stays-eligible is the locked, proven rule.
- **Unproven path 3's one-click half CLOSED** — #966's fix is proven on
  staging end-to-end (advertised endpoint → worker ingress → ledger).

### Batch C — mid-flight halt + B3.4 dispatch-withhold PROVEN (06:53–07:26 UTC)

- CSV C (5 fresh no-MX contacts) uploaded ~06:53; batch `01a03cd8-ae3d…`
  built 06:53:52 — 14 asks (9 prior identities withheld by restraint,
  5 rendered). Second `auto_policy` approval 06:54:10; veto notice;
  deadline 07:24:17 — the 30-min window held again (tick 1 ≈ 07:24:5x).
- **B3.4 setup**: admin manual suppression of `c-dw@no-mx.staging.…`
  entered 06:58:17 via `/admin/suppressions` (`scope=global`,
  `source='admin_manual'` — the §4 servicing path, exercised live) —
  AFTER the row rendered, BEFORE dispatch.
- Tick 1 released rows 1–2: `c-dw@` **queued, then withheld/`suppressed`
  by the dispatch-gate consent recheck — `queued_at` SET**. The B3.4
  specimen, with its answer: a dispatch-gate withhold BURNS a released
  cap slot; a render-time withhold (batch A, `queued_at` NULL) burns
  none. Both sides observed; named input to the #620 cap-counting
  decision. `c-1@` `sent` (6th platform send of the UTC day, cap 10).
- **Mid-flight halt**: owner clicked "Stop this batch" 07:25:53 —
  `halt_reason='owner_halt'`, `halted_by` recorded; `c-2`/`c-3`/`c-4`
  cancelled `owner_halt` (never queued); the SENT row untouched ("no
  further sends", not undo). `closeBatchIfSettled` ran inside the latch
  transaction: `send_closed_at` = `halted_at` to the microsecond; parent
  run `cancelled` with `batch_halted` + `send_batch_closed` steps at the
  same instant.
- **Unproven paths 6 AND 12 CLOSED.**

### Cap ramp — stage 1 (07:28–07:29 UTC)

- §6 fully green as of the one-click proof, so the D-2-recorded owner
  decision applies: `SOLICITATION_PLATFORM_DAILY_CAP` 10 → **50**
  (ramp stage 1, runbook §5) via the `flag-flip` skill (env-vars entry
  re-read; Railway-only dial, fails closed to 0). Deployment `6e7c210c`
  SUCCESS, boot clean 07:29:26 — the boot assertion accepted the value.
- **Baseline moved again (recorded, not a deviation)**: the redeploy
  built from `bbf07d55` — the staging branch advanced under the campaign
  with unrelated parallel work (#892 purge sentinels, #895, #968 landing
  carousel). Verified: `d007ee80` (this campaign's #963+#966 fixes) is an
  ancestor of `bbf07d55` — the fixes ride along; nothing solicitation-
  facing changed. The "do not reset staging to main" rule was about
  RESETS; a forward merge is the normal integration-anchor motion.

### Bounce stamp PROVEN live (07:23 UTC)

- SES gave up on A3's bounce-arm mail after ~14 h of NXDOMAIN retries:
  `email.bounced` webhook received 07:23:04.254 (`inbound_events`
  `processed`), and the Solicitation lane wrote `bounced_at`
  07:23:04.313 + `bounce_kind='soft'` on the A3 row — 59 ms
  webhook-to-stamp. The row was alive to receive it because batch B's
  upload cascaded nothing (see the batch B entry). Honest note: SES
  classified the NXDOMAIN exhaustion as a SOFT bounce, not hard —
  recorded as observed.
- **Path 11 disposition, final**: stamp half PROVEN live;
  unsubscribed-stays-eligible PROVEN live (attribution entry); the
  candidate-query EXCLUSION half closes as test-covered
  (`src/lib/solicitation/attribution.ts:231-232`,
  `attribution.integration.test.ts:609`) per the recorded owner-visible
  disposition. **Path 11 CLOSED.**
- Timing datum for the ambiguous race: `norbert-b@` (sent 03:48) bounces
  ≈ 17:48 UTC on the same ~14 h clock — the ambiguous pair stays valid
  until then.

### Ambiguous arm — CLOSED as a documented gap, with an upgrade clause (07:3x UTC)

- The owner's second-account review ("Norbert Esekiel") was posted
  ~04:1x but is NOT publicly visible (verified logged-out) — Google's
  new-account review filter, outside this system's control. The DB-side
  specimen is fully staged and verified: TWO `sent`, unbounced,
  unattributed rows whose contact names match the reviewer
  (A3-`reviews@`, renamed contact + B-`norbert-b@`); the matcher's
  `ambiguous` logic is integration-covered, and M4's design records the
  abstention as log-only either way. Owner call: close as a documented
  gap rather than hold the campaign on Google's clock.
- **Upgrade clause**: if Google publishes the review BEFORE
  `norbert-b@`'s bounce (~17:48 UTC), live ingest will run attribution,
  the two-candidate abstention will log `ambiguous`, and this entry
  upgrades to PROVEN by appended addendum. If it publishes AFTER the
  bounce, expect a **single-match FALSE attribution to the
  A3-`reviews@` row** — pre-recorded here so a later reader does not
  misread it as a matcher defect: it is the known consequence of the
  bounce exclusion collapsing the pair, on a shadow metric that is
  never billed. **Path 9 CLOSED (documented gap).**

### VERDICT

**PASS.** Every unproven path is closed:

| # | Path | Disposition |
|---|---|---|
| 1 | §1–§3 domain verified | ✅ proven |
| 2 | §4 mailboxes routed | ✅ proven |
| 3 | §6 seed gate (auth + one-click) | ✅ proven (auth 17:22 Aug 25; one-click 04:09 Aug 26); placement recorded (Gmail Promotions); D-7 coverage gap documented |
| 4 | Copilot drip E2E | ✅ proven (batch A3) |
| 5 | Autopilot drip E2E | ✅ proven (batch B) |
| 6 | Mid-flight halt | ✅ proven (batch C) |
| 7 | Unsubscribe → ledger, page from ledger read | ✅ proven |
| 8 | Attribution clean match | ✅ proven (`full_name`, 4 columns + outcome) |
| 9 | Ambiguous | 📄 documented gap (Google filter) + upgrade clause |
| 10 | no_candidates | 📄 documented gap (owner call) |
| 11 | Bounce/complaint exclusion + unsubscribed-eligible | ✅ stamp + eligibility proven; exclusion predicate test-covered |
| 12 | B3.4 cap-slot burn | ✅ proven with the answer (dispatch-gate burns, render-time does not) |

Issues: **#963 fixed**, **#966 fixed** (both on PR #964, validated live by
this campaign); **#965 open** — design decision, named input to #620
alongside the B3.4 answer and D-7. Deviations D-1…D-8 all resolved and
recorded. End state: staging lane ON (both flags), `JUDGE_ENABLED=true`,
cap **50** (ramp stage 1), sending identity + fixtures kept per the
teardown ledger. Credential files deleted 07:3x UTC; Cloudflare token
revocation is the owner's remaining teardown action.

*(post-verdict addenda only below this line)*

### Addendum 2026-08-26 — teardown complete; #966 closed

- **Cloudflare DNS token revoked by the owner** (confirmed 2026-08-26). The
  teardown ledger's last open action is done; nothing from this campaign's
  credential set remains live.
- **#966 closed manually.** PR #964's "Closes #963 and #966" only auto-closed
  #963 — GitHub parses one closing-keyword pair per reference, and "and #966"
  is not one. The fix was already merged and proven live by this campaign's
  04:09 one-click ledger write; the issue was open on syntax alone.
- The env-vars registry rows for both lane flags were corrected the same day —
  they still claimed "the flag exists in no environment yet", which this
  campaign falsified. The registry now records ON-in-staging / prod-unset.

### Addendum 2026-09-06 — #965 cause found: the contacts were deleted by hand, the upload deleted nothing

Reconstructed from the Railway staging-worker logs (deployments `59e1faf1`,
`940efede`, `66760eda`, all 2026-08-25 UTC, business `01a03992-4210…`), the
session transcript, and the FK topology read from staging on 2026-09-06.

| UTC | Event (worker log) | Contacts |
|---|---|---|
| 15:52:02 | upload `01a0399f-0df2…` (CSV A): `contacts_created 4, merged 0` | 4 |
| 15:52:07 | batch A `01a0399f-175d…` built: `pool_count 4`, `send_count 4` | 4 |
| 16:40:04 | upload `01a039ca-fdf1…` — **CSV A uploaded a second time**: `contacts_created 0, merged 0, duplicate_visits 4` | 4 |
| 16:40:09 | batch `01a039cb-0f1d…` built: `pool_count 4`, **`over_contacted 4`**, `send_count 0` | 4 |
| 16:40:59 | upload `01a039cb-cde7…` (CSV A2, `+a2` handles): `contacts_created 4, merged 0` | **4** |
| 16:41:04 | batch A2 `01a039cb-e753…` built: `pool_count 4`, `over_contacted 0` | 4 |
| 17:04:58 | upload `01a039e1-c4a5…` (CSV A3, `+a3` handles): `contacts_created 4, merged 0` | **4** |
| 17:05:03 | batch A3 `01a039e1-dd42…` built: `pool_count 4` | 4 |

`pool_count` is `count(*) FROM solicitation_contacts WHERE business_id = …`,
logged by the batch builder. A2 created four NEW contacts and the pool was
still four, so batch A's four contacts were gone before 16:40:59. A3 created
four more and the pool was still four, so batch A2's contacts were gone before
17:04:58. Between the builds the worker logged only pollers — no purge, no
offboarding, no csv work. The Claude session issued only `SELECT`s in the
window; the owner drove the dashboard by hand ("I reuploaded but I still do
not see any approve button", 16:42:08).

**What deleted them — observed directly.** Vercel's runtime logs for the
staging UI still hold the requests (read 2026-09-06, `get_runtime_logs`,
project `rep-worth`): eight `DELETE /api/dashboard/contacts/<id>` calls, all
`204`, four between the 16:40:09 over-contacted batch and the 16:40:59 A2
upload, four between the 16:41:04 A2 batch and the 17:04:58 A3 upload. The
contact ids are uuidv7, so their prefixes date them to the upload that minted
them.

| UTC | Vercel runtime log (branch `staging`) | Contact minted by |
|---|---|---|
| 16:40:18 | `DELETE /api/dashboard/contacts/01a0399f-1281…` 204 | upload A (15:52) |
| 16:40:20 | `DELETE /api/dashboard/contacts/01a0399f-13d7…` 204 | upload A |
| 16:40:28 | `DELETE /api/dashboard/contacts/01a0399f-1502…` 204 | upload A |
| 16:40:29 | `DELETE /api/dashboard/contacts/01a0399f-162c…` 204 | upload A |
| 17:04:08 | `DELETE /api/dashboard/contacts/01a039cb-e389…` 204 | upload A2 (16:40:59) |
| 17:04:14 | `DELETE /api/dashboard/contacts/01a039cb-e488…` 204 | upload A2 |
| 17:04:22 | `DELETE /api/dashboard/contacts/01a039cb-e576…` 204 | upload A2 |
| 17:04:32 | `DELETE /api/dashboard/contacts/01a039cb-e664…` 204 | upload A2 |

That route is the per-row **Delete** control on the contacts page
(`ContactList.tsx` → `deleteContact`, the §5 hard delete). Staging's FK rules
(`pg_constraint`, 2026-09-06) explain the shape: `solicitation_batches`
cascades from `contact_csv_uploads`, `businesses` and `accounts`;
`solicitation_asks` and `solicitation_outreach` cascade from
`solicitation_contacts`. A contact delete removes the asks and outreach and
leaves the batch row standing. The 16:40:09 batch — four rows held back as
over-contacted, no approve button — is the moment the owner cleared the list
and re-uploaded; the same again before A3.

**Two claims above are wrong and stay as written for the record:**

- "an upload REPLACES the contact rows" (17:3x entry) — the 16:40:04 ingest
  matched all four existing contacts (`created 0`, `duplicate_visits 4`) and
  the next build withheld all four as `over_contacted`. Ingest merges in place;
  MIN_GAP held.
- "the upload normalizes `+tag` sub-addresses away" (17:21 entry) —
  `normalizeEmail` only trims and lowercases. Gmail and Zoho fold `+tag` mail
  into the base inbox, which is what was observed. A, A2 and A3 were three
  distinct handle sets, which is why `over_contacted` did not fire across
  them; it did fire on the identical re-upload.

**Disposition.** Not a product defect. The four consequences listed on #965
describe the owner's §5 hard delete, which is documented as erasure of the
customer record (`ContactList.tsx`, `contacts-repo.ts` §7.1 consent sweep).
Whether outreach history should outlive a per-contact delete is a design
input to #617/#620, not a bug. Batch B's upload (03:17 Aug 26) deleted
nothing because no contact was deleted before it.
