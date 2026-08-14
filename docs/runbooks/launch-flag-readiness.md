# Launch-Flag Readiness Gate

Per-flag readiness for the seven GA launch flags. The point of this doc is to
separate what the **repo can prove** (migrations shipped, boot assertion
present, code merged) from what **only the owner can confirm at flip time**
against live production state (Stripe price IDs live, SMTP configured, thresholds
tuned, Meta verification, SerpAPI key live). Nothing here flips a flag — every
prod flip is the owner's call.

> **Default-off posture:** all seven default to `false`. Flip only after both the
> repo-verifiable column AND the owner-verify-at-flip column are satisfied.
> Anything touching the worker, a webhook, a migration, or billing rides
> `staging` first (project rule).

Legend for "Owner-verify-at-flip": these are **live prod facts not present in the
repo** — the repo cannot prove them; the owner verifies them live.

## Flag table

| Flag | Prerequisite | Repo-verifiable status | Owner-verify-at-flip (live prod state) | Flip action |
|---|---|---|---|---|
| `SELF_SERVE_SIGNUP_ENABLED` | Migration 064 applied; SMTP confirmation template + Stripe price IDs live | **Green.** Migration 064 IS applied to prod (per the tier3 GA-unblocks spec §1, #288 closed/verified). Boot assertion `assertSelfServeSignupEnv` present (`worker/config/startup-assert.ts:193`) and wired at boot (`worker/index.ts:317`) — requires `REDIS_CACHE_URL`, `NEXT_PUBLIC_APP_URL`, `STRIPE_PRICE_*`. Code merged. **Re-scoped 2026-08-14** — see the row note below. | owner verifies live (not in repo): Supabase Auth confirmation email template uses `{{ .Token }}` (6-digit OTP, not `{{ .ConfirmationURL }}` — CLAUDE.md gotcha); Stripe price IDs are live; SMTP sender configured. **Also worth a read for its own sake:** confirm the *current* prod value — the beta design assumed it has always been `false` there | Set `true` on Vercel + Railway after live verify; redeploy both |
| `OPENAI_MODERATION_ENABLED` | Moderation thresholds tuned against real samples | **Green (code).** No boot assertion by design (fail-open). Provider layer merged: `src/lib/moderation/moderate.ts` (+ `flags.ts`); when off, only the local regex filter runs. Worker-only (never called from Vercel). | owner verifies live (not in repo): OpenAI API key present in prod worker env; thresholds tuned vs real review/response samples before flip | Set `true` on Railway worker; redeploy worker. Fail-open means a provider error degrades to the local decision — never approves silently |
| `MFA_ENFORCEMENT_ENABLED` | Owner/admin MFA regression tests pass | **Green (code).** No boot assertion. Merged (Wave 2, PR #87) — `src/lib/auth/flags.ts`. Note: enrollment UI is already live and AAL2 is **already hard-required** at the sensitive API routes even with the flag OFF; the flag only adds page-navigation redirect to `/mfa/challenge`. MFA *unenroll* always requires AAL2 regardless of this flag. | owner verifies live (not in repo): owner + admin login/enroll/challenge regression pass in prod before enabling the nav-redirect | Set `true` on Vercel + Railway; redeploy. Flip on only after the regression pass |
| `MULTI_LOCATION_ENABLED` | Per-location overage billing wired | **Green (code).** No boot assertion. Merged — `src/lib/locations/flags.ts` + three-gate helpers in `src/lib/locations/multi-location-mode.ts` (`shouldShowLocationsSettings` / `shouldUseMultiLocationSettings` / `canAddLocationForAccount` — invariant #9b, do not collapse). When OFF, all multi-location routes 404 and the UI is the legacy single-location flow. | owner verifies live (not in repo): per-location overage billing (Stripe) validated against live prices; account quota/grandfather columns correct on prod `accounts` | Set `true` on Vercel + Railway; redeploy |
| `CHANNELS_WHATSAPP_ENABLED` | Meta verification + WABA + template HX SID approved | **Green (code).** Boot assertion `assertChannelsWhatsAppEnv` present (`startup-assert.ts:264`) and wired (`worker/index.ts:316`) — enforces 7 vars + `whatsapp:+<digits>` format + `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL + '/approve/'`. Renderer + variable-map gate documented (`docs/runbooks/whatsapp-templates.md`). | owner verifies live (not in repo): Meta business verification complete; WABA active; `repworth_approval_request_v1` template Meta-approved with its `HX…` Content SID; the 7 env vars set on BOTH Vercel + Railway | Run the runbook 8-point ship gate (single-location canary) → set `true` on both platforms → redeploy → confirm `assertChannelsWhatsAppEnv` logs clean |
| `CHANNELS_TELEGRAM_ENABLED` | Bot registered + `setWebhook` called | **Green (code).** Boot assertion `assertChannelsTelegramEnv` present (`startup-assert.ts:243`) and wired (`worker/index.ts:315`) — requires `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`. Code merged. | owner verifies live (not in repo): Telegram bot created with @BotFather; `setWebhook` pointed at the prod worker ingress; both env vars set on Vercel + Railway | Set `true` on both platforms; redeploy; confirm boot assertion clean |
| `RANKING_TRACKING_ENABLED` | SerpAPI key live; 1-keyword cap acknowledged | **Green (code), capped.** No boot assertion. Merged — `src/lib/ranking/flags.ts`. `worker/jobs/RankingTrackingWorker.ts:172-173` caps to **1 keyword per business** (`rawKeywords.slice(0, 1)`, Sprint 5B initial rollout) — lift the cap as a follow-up when scaling. Ranking tracking is active-subscription-only (SerpAPI stays active-only; `trialing` is excluded — invariant #11). | owner verifies live (not in repo): SerpAPI key present + funded in prod worker env; per-keyword budget acceptable at the 1-keyword cap | Set `true` on Railway worker; redeploy. Plan the cap-lift PR before widening keyword volume |

### Row note — `SELF_SERVE_SIGNUP_ENABLED` was re-scoped on 2026-08-14

**The go-live sequence changed, and it got simpler.** This flag used to gate the
whole owner funnel — signup, login, password recovery, and every onboarding step
— so "flip it on" was effectively the switch that made owner-facing product
reachable at all, and the beta could not run without either flipping it or
building a separate path.

It now means exactly one thing: **strangers may mint accounts.** It gates
`/signup` + sub-pages and the account-minting APIs (plus the marketing copy that
advertises anonymous signup). `/login`, `/forgot-password`, `/reset-password` are
**always on**, and every de-flagged funnel surface enforces its own authenticated
session + `role = 'owner'` + per-route allowed-state guard instead.

Consequences for launch sequencing:

- **The beta does not need this flag flipped.** Admin-invited owners walk the
  entire funnel — login, place capture, AI demo, Stripe checkout, wizard — with
  it `false`. Keep it `false` until public-release readiness is genuinely
  decided; there is no beta-driven pressure to flip it early.
- **Flipping it on is now a much smaller act** than the old prerequisite list
  implies: it opens anonymous signup. The prerequisites in the row above still
  apply (they are what an anonymous signup needs), but the blast radius of
  getting it wrong is confined to strangers, not existing customers.
- **Flipping it OFF is now safe mid-beta** — see `rollback.md` §1. It no longer
  locks invited owners out of login or password recovery, which was the old
  behaviour and the reason the rollback lever was effectively unusable once
  anyone had been invited.

Authoritative per-call-site inventory (kept vs removed gates, with the
replacement guard for every removal):
`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`.

## Repo evidence pointers

- Boot assertions: `worker/config/startup-assert.ts` (functions) wired in
  `worker/index.ts:315-319`. Only WhatsApp / Telegram / Self-serve (+ Zernio,
  Account-offboarding) have dedicated boot assertions; Moderation / MFA /
  Multi-location / Ranking are guarded by per-call flag reads, not boot gates.
- Flag readers: `src/lib/auth/flags.ts` (MFA), `src/lib/locations/flags.ts`
  (multi-location), `src/lib/ranking/flags.ts` (ranking),
  `src/lib/moderation/flags.ts` (moderation), `src/lib/auth/flags.ts`
  (self-serve inline reads).
- Flag invariant: feature flags are server-authoritative (CLAUDE.md invariant
  #13) — there is **no** `NEXT_PUBLIC_*` companion for any of these; the browser
  learns flag state via API responses. `ci:static-policy` fails CI on a new
  `NEXT_PUBLIC_*`.
- Env-var reference: `.claude/reference/env-vars.md` (flag rows ~L400-407).

## Live verification snapshot

> The owner/orchestrator appends live-state reads here at flip time. This is the
> hand-off surface for verification that cannot be done from the repo.

### 2026-06-26 — worker-side (Railway) flag read

Source: `railway variables` via the Railway CLI (project `repworth`), worker
service `repworth-worker`, both environments. **Scope caveat:** these are the
**worker (Railway)** env values. Flags whose authoritative consumer is the UI —
`SELF_SERVE_SIGNUP_ENABLED`, `MFA_ENFORCEMENT_ENABLED`, `MULTI_LOCATION_ENABLED`
(display) — are set on **Vercel**, which is NOT covered by this read; treat their
prod UI state as **still unverified** (needs a `vercel env` read). Secrets were
filtered out and never displayed.

| Flag | Prod worker | Staging worker | Authoritative consumer | Note |
|---|---|---|---|---|
| `SELF_SERVE_SIGNUP_ENABLED` | unset → **off** | `true` | UI (Vercel) + worker | Prod UI state pending Vercel read; matches pre-GA (#288 era) |
| `OPENAI_MODERATION_ENABLED` | unset → **off** | `true` | Worker | Worker-authoritative; prod confirmed OFF (local regex still runs, fail-open) |
| `MFA_ENFORCEMENT_ENABLED` | unset → **off** | `false` | UI (Vercel) | Prod UI nav-redirect state pending Vercel read; AAL2 already hard-required at sensitive routes regardless |
| `MULTI_LOCATION_ENABLED` | unset → **off** | `true` | UI (Vercel) + worker | Prod UI state pending Vercel read |
| `CHANNELS_WHATSAPP_ENABLED` | unset → **off** | `true` | Worker (dispatch) + UI | Prod worker OFF — matches "not live"; this PR's #134 prep targets this |
| `CHANNELS_TELEGRAM_ENABLED` | unset → **off** | `true` | Worker (dispatch) + UI | Prod worker OFF |
| `RANKING_TRACKING_ENABLED` | unset → **off** | `false` | Worker | Worker-authoritative; OFF in both (1-keyword cap still in code) |

Bonus GA-posture flags verified in the **prod worker** (same read):
`ZERNIO_PUBLISHING_ENABLED` → **off**, `AUTO_APPROVAL_ENABLED` → **off**
(matches invariant #3 default-off), `EDIT_REPLIES_ENABLED` → **off** (matches
#355 blocked), `TRIAL_ENABLED` → **off**. Staging has all of these `true` for
full-pipeline integration testing.

**Verifier:** Claude (orchestrator), Railway CLI. **Still owner-to-verify:**
Vercel UI-side prod flag state; Stripe price liveness; Meta/WABA/SerpAPI status.
