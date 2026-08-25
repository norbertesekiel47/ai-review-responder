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
| *(none yet — rows are added before each fixture is created)* | | | | | |

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

*(entries appended in runbook order)*
