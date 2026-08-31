# Infisical `production` — variable manifest

> **Purpose.** The complete list of what goes into the Infisical `production`
> environment, what each value is, which platform reads it, and which variables
> must stay out. This is the input to Phase I of the production cutover.
>
> **Derived from code**, not from a runbook. Every gate row cites the function
> that throws. Derivation SHA: `f6695494` (`main`, 2026-08-30).
>
> **Owner split.** `docs/eservices-variables.md` owns the flat inventory of every
> variable the code reads. `.claude/reference/env-vars.md` owns per-flag
> behaviour. This file owns one thing only: **what production needs, and where.**
> It does not restate behaviour. When it disagrees with a runbook, this file was
> derived from code and the runbook was not — fix the runbook.

---

## How this was derived

1. `scripts/ci/env-registry-audit.ts` extracts the declared-variable set from
   three lanes: the config schemas, `readFlag`/`readFlagEnabledByDefault` call
   sites, and literal `process.env` reads across `src/` + `worker/`. It returns
   **174 declared variables**, of which 29 are flags.
2. An import-reachability pass classifies each reader file. Vercel seeds are
   `src/app/**`, `src/components/**`, `src/instrumentation*.ts`, `src/proxy.ts`
   and `next.config.mjs`. Railway seeds are `worker/**`. A variable targets a
   platform when a reader of it is reachable from that platform's seeds.
3. Boot gates were read directly from `worker/config/startup-assert.ts`,
   `worker/index.ts`, `src/lib/config/{server,client,worker}.ts` and
   `src/instrumentation.ts`.
4. Current platform state is a **name-only** live read taken 2026-08-30:
   `railway variables --json | jq -r 'keys[]'` and `vercel env ls production`.
   No value was read or printed.

**Cross-check.** The derivation independently reproduces the recorded count of
**6 missing hard boot gates** on the Railway production worker. See §7.

---

## 1. Unconditional worker boot gates

Missing any one of these throws at boot. The worker then exhausts
`restartPolicyMaxRetries = 10` and stays down.

`assertWorkerStartupEnv()` runs 1–7 below. `worker/index.ts` calls
`assertWorkerConfig()` and `assertUnsubscribeIngressConfigured()` separately, at
lines 583 and 596. All are unconditional on a deployed lane.

| # | Variable | Gate | Value source | Platforms | Today (Railway) |
|---|---|---|---|---|---|
| 1 | `DATABASE_POOL_URL` | `assertCoreInfraEnv` | ROTATE — roll the Supabase DB password | Railway + Vercel | set |
| 2 | `SUPABASE_URL` | `assertCoreInfraEnv` | CARRY | Railway + Vercel | set |
| 3 | `SUPABASE_SERVICE_KEY` | `assertCoreInfraEnv` | ROTATE at Supabase | Railway + Vercel | set |
| 4 | `REDIS_QUEUE_URL` | `assertCoreInfraEnv` | Phase A.2 | Railway only | **missing** |
| 5 | `STRIPE_SECRET_KEY` | `assertStripeWorkerEnv` | ROTATE at Stripe (live) | Railway + Vercel | set |
| 6 | `STRIPE_WEBHOOK_SECRET` | `assertStripeWorkerEnv` | Phase D.3 | Railway only | **missing** |
| 7 | `STRIPE_PRICE_COPILOT_LIST` | `assertStripeWorkerEnv` | CARRY (live ID) | Railway + Vercel | set |
| 8 | `STRIPE_PRICE_COPILOT_FOUNDING` | `assertStripeWorkerEnv` | CARRY | Railway + Vercel | set |
| 9 | `STRIPE_PRICE_AUTOPILOT_LIST` | `assertStripeWorkerEnv` | CARRY | Railway + Vercel | set |
| 10 | `STRIPE_PRICE_AUTOPILOT_FOUNDING` | `assertStripeWorkerEnv` | CARRY | Railway + Vercel | set |
| 11 | `STRIPE_PRICE_COPILOT_OVERAGE` | `assertStripeWorkerEnv` | CARRY | Railway + Vercel | set |
| 12 | `STRIPE_PRICE_AUTOPILOT_OVERAGE` | `assertStripeWorkerEnv` | CARRY | Railway + Vercel | set |
| 13 | `DAILY_COST_LIMIT_CENTS_COPILOT` | `assertTierDailyCostLimitsConfigured` | CARRY `500` | Railway + Vercel | set |
| 14 | `DAILY_COST_LIMIT_CENTS_AUTOPILOT` | `assertTierDailyCostLimitsConfigured` | CARRY `1500` | Railway + Vercel | set |
| 15 | `ADMIN_NOTIFICATION_EMAIL` | `assertAdminNotificationEmail` | FIXED `alerts@repworth.net` | Railway only | **missing** |
| 16 | `SENTRY_DSN` | `assertAlertSinkEnv` | Phase A.1 | Railway + Vercel | **missing** |
| 17 | `SESSION_COOKIE_SECRET` | `assertUnsubscribeIngressConfigured` | MINT `openssl rand -hex 32` | Railway + Vercel | **missing** |
| 18 | `NEXT_PUBLIC_APP_URL` | `assertUnsubscribeIngressConfigured` | FIXED `https://repworth.net` | Railway + Vercel | **missing** |

Six gates are missing on Railway today: rows 4, 6, 15, 16, 17, 18.

### Gate details that decide a value

- **`SESSION_COOKIE_SECRET` must be at least 32 bytes.** `getSessionCookieSecret`
  (`src/lib/shared/session-cookie-secret.ts:12`) rejects a shorter key.
  `openssl rand -hex 32` produces 64 characters, so it passes.
- **`SESSION_COOKIE_SECRET_PREVIOUS` is asserted too, but only when set.** The
  same boot gate calls `getPreviousSessionCookieSecret`, which throws on a
  configured-but-short value (`src/lib/solicitation/unsubscribe.ts:536`). Leave it
  unset. Set it only during a key rollover.
- **`DAILY_COST_LIMIT_CENTS_*` must be a positive decimal integer.** `0`, a
  decimal, and a blank all throw (`parseRequiredPositiveCostLimitCents`).
- **The six Stripe Price IDs must be distinct.** `assertStripePriceIdsUnique`
  runs inside `assertStripeWorkerEnv`.
- **`MOCK_EXTERNAL_APIS` is a value gate, not a presence gate.**
  `assertProductionMockModeEnv` throws when it equals `true` on a deployed lane.
  Do not create the entry. Absence is correct.

### The exact-boolean format gate

`assertServerOnlyFeatureOptionalBooleansEnv` throws unless the value is literally
`true` or `false`. It covers seven names:

`ACCOUNT_OFFBOARDING_ENABLED`, `AUTOPILOT_PURCHASABLE`, `AUTO_APPROVAL_ENABLED`,
`AUTO_APPROVAL_PROVIDER_MODERATION_READY`, `GOVERNOR_ENABLED`, `JUDGE_ENABLED`,
`STRIPE_TAX_ENABLED`.

`TRUE`, `1`, `yes` and a trailing space are boot failures, not "on". Unset is
allowed and means off.

---

## 2. Conditional worker boot gates

These fire only because Phase B turns a flag on. Each is a hard gate once its
flag is `true`.

| Trigger | Then required | Gate |
|---|---|---|
| `ZERNIO_PUBLISHING_ENABLED=true` | `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `WORKER_PUBLIC_URL`, `NEXT_PUBLIC_APP_URL` | `assertZernioPublishingEnv` |
| `ACCOUNT_OFFBOARDING_ENABLED=true` | `SESSION_COOKIE_SECRET` (≥32 bytes), `NEXT_PUBLIC_APP_URL` | `assertAccountOffboardingEnv` |
| `SELF_SERVE_SIGNUP_ENABLED=true` | `REDIS_CACHE_URL`, `NEXT_PUBLIC_APP_URL`, six `STRIPE_PRICE_*` | `assertSelfServeSignupEnv` |
| `CHANNELS_TELEGRAM_ENABLED=true` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `assertChannelsTelegramEnv` |
| `CHANNELS_WHATSAPP_ENABLED=true` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`, `WHATSAPP_APPROVAL_URL_BASE`, `WORKER_PUBLIC_URL`, `NEXT_PUBLIC_APP_URL` | `assertChannelsWhatsAppEnv` |
| `SOLICITATION_SEND_ENABLED=true` | `SOLICITATION_RESEND_API_KEY`, `SOLICITATION_SEND_FROM_ADDRESS`, `SOLICITATION_PLATFORM_DAILY_CAP`, `SOLICITATION_UNSUBSCRIBE_MAILTO` | `assertSolicitationSendEnv` |

**Beta turns on exactly one of these: Zernio publishing.** The other five stay
off, so their variables are optional in production today.

### `WORKER_PUBLIC_URL` has a format gate

`assertWorkerPublicUrlFormat` requires an **origin-only https URL** on a deployed
lane. No path, no query, no fragment, **no trailing slash**, no userinfo. The
check is `raw === new URL(raw).origin`. `https://worker.repworth.net` passes;
`https://worker.repworth.net/` fails.

### `WHATSAPP_APPROVAL_URL_BASE` is a derived value

It must equal `NEXT_PUBLIC_APP_URL` with any trailing slash stripped, plus
`/approve/`. Only checked when the WhatsApp channel is on.

---

## 3. Vercel gates

| Variable | Gate | When it fires |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `assertClientConfig`, then `assertCoreAppConfig` | prebuild, then every server process at `register()` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same | same |
| `NEXT_PUBLIC_APP_URL` | same | same |
| `SUPABASE_URL` | `getServerDbConfig` | first DB-backed route, not at boot |
| `SUPABASE_SERVICE_KEY` | `getServerDbConfig` | same |
| `DATABASE_POOL_URL` | `getServerDbConfig` | same |

`src/instrumentation.ts` only **warns** when `SENTRY_DSN` is unset on Vercel. It
does not throw. The hard `SENTRY_DSN` gate is the worker's.

**`NEXT_PUBLIC_*` is inlined into the client bundle at build time.** Changing it
without a redeploy changes nothing the browser sees.

---

## 4. Not gated, but production does not work without them

### Railway worker

| Variable | Value source | What breaks if absent |
|---|---|---|
| `REDIS_CACHE_URL` | Phase A.3 | Every LLM call fails at the cost reservation. The client is lazy, so this fails at first use, not at boot. |
| `OPENAI_API_KEY` | live key | Primary LLM. **No code reads this** — `new OpenAI(LLM_CLIENT_OPTIONS)` lets the SDK read the environment itself. It is therefore invisible to every audit. |
| `ANTHROPIC_API_KEY` | live key | Fallback LLM. Same implicit SDK read. |
| `RESEND_API_KEY` | prod key | No approval emails. That is the core product loop. |
| `RESEND_FROM_EMAIL` | **root domain**, `Name <addr@repworth.net>` | Same. **Not** `send.repworth.net` — see §12.2. |
| `RESEND_WEBHOOK_SECRET` | Phase E.1, provider-issued `whsec_…` | No delivery or bounce tracking. Do not generate your own. |
| `CSRF_SECRET` | MINT | The weekly-report feedback link cannot be signed. **Must match Vercel** — see §6. |
| `WORKER_INTERNAL_SECRET` | MINT | The admin queue-health panel degrades to unavailable. **Must match Vercel.** |
| `POSTHOG_API_KEY` | prod key | The analytics dispatch loop is a silent no-op. |
| `POSTHOG_HOST` | optional | Defaults inside `posthog.ts`. |
| `GLOBAL_DAILY_COST_LIMIT_CENTS` | real ceiling | No platform-wide spend bound. |
| `SERPAPI_API_KEY` | live key | Ranking tracking and place resolution fail. **Not boot-gated** — see §7. |
| `LIST_UNSUBSCRIBE_EMAIL` | real mailbox | Boot **warning** only. Bulk-sender compliance risk. |
| `LIST_UNSUBSCRIBE_URL` | real URL | Same header, no warning. |
| `DB_POOL_MAX` | `20` — already set | Drill-blessed. Never raise blind. **Stays native, not in Infisical — §9.1.** |
| `ZERNIO_API_KEY` | live key | Conditional gate above; also every publish. |
| `ZERNIO_WEBHOOK_SECRET` | MINT, then paste into Zernio | Conditional gate above. |
| `WORKER_PUBLIC_URL` | Phase A.4 | Conditional gate above. |

### Vercel

| Variable | Value source | What breaks if absent |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | FIXED `https://repworth.net` | **Finding F2.** `assertSameOrigin` fails on 21 routes; the trailing slash double-slashes every generated link. |
| `REDIS_CACHE_URL` | Phase A.3, same value as Railway | Cost guard, connect-flow CAS, rate limits. |
| `WORKER_PUBLIC_URL` | Phase A.4 | UI → worker calls. |
| `WORKER_INTERNAL_SECRET` | MINT, **matches Railway** | Admin queue-health panel. |
| `CSRF_SECRET` | MINT, **matches Railway** | `POST /api/feedback` rejects every weekly-report click. |
| `SESSION_COOKIE_SECRET` | MINT, **matches Railway** | Approval device cookies, Zernio connect cookies, offboarding tokens. |
| `IMPERSONATION_COOKIE_SECRET` | MINT | Admin view-as. **Vercel only** — see §7. |
| `SENTRY_DSN` | Phase A.1 | Server errors untracked. |
| `NEXT_PUBLIC_SENTRY_DSN` | Phase A.1 | Browser errors untracked. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | referrer-locked key | PlaceAutocomplete in onboarding. Essentials fields only: `id`, `formattedAddress`, `location`. |
| `ZERNIO_API_KEY` | live key | **Every onboarding connect call 401s.** See §7 — this is missing from both existing runbooks. |
| `RESEND_API_KEY` | prod key | Contact, lead-intake and demo-request routes send nothing. |
| `RESEND_FROM_EMAIL` | verified sender | Same. |
| `CONTACT_NOTIFY_TO` | real mailbox | Contact-form notifications go nowhere. |
| `SERPAPI_API_KEY` | live key | `POST /api/signup/place-prefill` degrades. |
| `SERPAPI_TIMEOUT_MS` | optional | Defaults to 2000 ms. |
| `GLOBAL_DAILY_COST_LIMIT_CENTS` | real ceiling | `/admin/costs` reads it. |
| `DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT` | CARRY | `/admin/costs` throws without them. Already set. |
| `DB_POOL_MAX` | `3` | Vercel is many short-lived functions against one PgBouncer. Not `20`. **This value differs per platform — see §9.1.** |
| `FOUNDING_DEADLINE` | already set | Missing or malformed fails closed to list pricing. |
| `BETA_COMP_COUPON_ID` | Phase F.4, live-mode ID | The beta comp. Vercel only — no worker path reaches `applyTierSnapshot`. |
| `SENTRY_AUTH_TOKEN` | Sentry token | Source-map upload. Build-time only; uploads stay silent when unset. |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Sentry slugs | Same. |
| `TELEGRAM_BOT_USERNAME` | only if channels on | The channel deep-link builder falls back to `RepWorthBot`. |
| `SOLICITATION_UNSUBSCRIBE_MAILTO` | only if solicitation on | The `/u/[token]` page omits the mailto line. |
| `ZERNIO_PROFILE_ID_PREFIX` | optional | Defaults to `repworth-prod-`. |

---

## 5. Flag posture — beta

Every flag below reads the literal string `true`. Anything else is off. Set the
same value on both platforms; the "reads on" column says where it takes effect.

| Flag | Value | Reads on | Note |
|---|---|---|---|
| `AUTO_APPROVAL_ENABLED` | `false` | both | Invariant #3. Owner approval is the content-safety control. |
| `AUTOPILOT_PURCHASABLE` | `false` | both | Beta lands on Copilot. Already set. |
| `TRIAGE_ENABLED` | unset | Railway | ADR 0005 ordered go-live, later. |
| `ESCALATION_ENABLED` | unset | Railway | Same. |
| `JUDGE_ENABLED` | unset | Railway | Same. |
| `GOVERNOR_ENABLED` | unset | Railway | Same. |
| `AUTO_APPROVAL_PROVIDER_MODERATION_READY` | unset | both | The later auto-approval gate marker. Not the same thing as `OPENAI_MODERATION_ENABLED`. |
| `TRIAL_ENABLED` | `false` | both | The comp is a coupon, not a trial. |
| `SELF_SERVE_SIGNUP_ENABLED` | `false` | both | Already set on both. No flip needed. |
| `ONBOARDING_DEMO_ENABLED` | `true` | Vercel | Off means invited owners get the legacy wizard and no AI demo. It degrades silently. |
| `ZERNIO_PUBLISHING_ENABLED` | `true` | both | Turns on the conditional gate in §2. |
| `ZERNIO_RECENT_REVIEW_POLL_DISABLED` | **unset** | Railway | Set to `true` today. It is the other half of the §2 producer denial. WS8 §7 restores it. |
| `OPENAI_MODERATION_ENABLED` | `false` for now | both | Flip in Phase G.4, after corpus validation. |
| `MULTI_LOCATION_ENABLED` | unset | Vercel | Beta is single-location. |
| `EDIT_REPLIES_ENABLED` | unset | both | Owner decision. |
| `EXTERNAL_REPLY_IMPORT_ENABLED` | carry the current value | both | Present on Railway today. Do not drop it in the sync. |
| `ACCOUNT_OFFBOARDING_ENABLED` | unset | both | Owner decision. `true` adds two gates — see §2. |
| `CHANNELS_TELEGRAM_ENABLED` | unset | both | Channels stay off for beta. |
| `CHANNELS_WHATSAPP_ENABLED` | unset | both | Same. |
| `SOLICITATION_SEND_ENABLED` | unset | both | Adds four gates when on. |
| `SOLICITATION_WATCH_ENABLED` | unset | both | |
| `SOLICITATION_AUTO_APPROVAL_ENABLED` | unset | both | |
| `STRIPE_TAX_ENABLED` | unset | both | Exact-boolean gate applies if set. |
| `STRIPE_LOCATIONS_RECONCILE_DISABLED` | unset | both | Reconciliation stays on. |
| `NOTIFICATION_FAILOVER_DISABLED` | unset | Railway | Failover stays on. |
| `EMAIL_CHANNEL_RECONCILE_DISABLED` | unset | both | Reconciliation stays on. |
| `RANKING_TRACKING_ENABLED` | owner decision | Railway | Paid SerpAPI work. `active`-only by design. |
| `MFA_ENFORCEMENT_ENABLED` | owner decision | **Vercel only** | Read only by `src/proxy.ts`. Enrol admin MFA before enabling, or you lock yourself out. |

### Default-ON kill switches — leave unset

`BOOT_STAGGER_ENABLED`, `LLM_CIRCUIT_BREAKER_ENABLED` and `DB_ADMISSION_ENABLED`
are on unless the value is literally `false`. Do not create these entries.
Creating one with any other value is a no-op; creating one with `false` disables
a resilience control.

---

## 6. Values that must match across platforms

A mismatch here is a silent failure, not a crash.

| Variable | Why |
|---|---|
| `SESSION_COOKIE_SECRET` | HMAC keys. The worker mints an unsubscribe token; Vercel's `/u/[token]` page and the worker ingress both verify it. |
| `CSRF_SECRET` | `WeeklySummaryWorker` signs the feedback link on Railway. `POST /api/feedback` verifies it on Vercel. |
| `WORKER_INTERNAL_SECRET` | Vercel's admin route sends it as a bearer token to the worker's `/internal/queue-health`. |
| `REDIS_CACHE_URL` | Both platforms must address the one production Upstash instance. |
| `NEXT_PUBLIC_APP_URL` | Origin checks and generated links. |
| `WORKER_PUBLIC_URL` | The webhook signature base derives from it. |
| six `STRIPE_PRICE_*` | Checkout on Vercel, reconciliation on Railway. |
| `DAILY_COST_LIMIT_CENTS_*` | The worker enforces; `/admin/costs` reports. |

---

## 7. Corrections this derivation forces

Each of the following contradicts a runbook. The code is the evidence.

1. **`SERPAPI_API_KEY` is not boot-gated.** `beta-production-standup.md` Phase B
   lists it as gated "eager import". `src/lib/config/worker.ts:50` types it
   `rawOptionalVar`, and the only asserting accessor,
   `assertWorkerSerpapiConfig`, carries a `fallow-ignore-next-line
   unused-export` — it has **no production caller at all**.
2. **`DATABASE_URL` is not boot-gated, and no production code reads it.** The
   same Phase B list names it. `CORE_INFRA_REQUIRED_ENV` is four names and this
   is not one of them. The only reader in the repo is `scripts/wedge-repro.ts`.
   It is present on both platforms today; it is ops-and-migrations config, not
   app config.
3. **`REDIS_CACHE_URL` is not boot-gated either.** The same Phase B list names
   it. `getCacheRedisOptions()` is a function and `_redis` is lazy, so a missing
   value throws at first use. It is required in practice, not at boot.
4. **The list omits `SESSION_COOKIE_SECRET` and `NEXT_PUBLIC_APP_URL`**, which
   are unconditional gates via `assertUnsubscribeIngressConfigured`
   (`worker/index.ts:596`).
5. **`IMPERSONATION_COOKIE_SECRET` is Vercel-only.** The stand-up's Phase B tells
   you to mint it on Railway. The one reader,
   `src/lib/admin/impersonation/cookie.ts`, is reached only from `src/app/**`.
6. **`POSTHOG_API_KEY` is Railway-only.** The cutover plan's Phase C lists it as
   a missing Vercel variable. `posthog-node` is imported by exactly one file,
   `src/lib/analytics/posthog.ts`, whose only importers are `worker/index.ts`,
   `AnalyticsDispatchPoller` and `worker/jobs/publisher/activation.ts`. Next
   writes analytics rows to Postgres; the worker ships them.
7. **`ZERNIO_API_KEY` is required on Vercel and appears in no Phase C list.**
   The Next connect routes call `zernioClient.createProfile`, `deleteAccount`
   and `selectLocation` under the ADR 0001 exception. The transport reads
   `getServerConfig().ZERNIO_API_KEY ?? ''` and sends `Bearer ` when absent.
   Onboarding connect would 401 with nothing in the boot log.
8. **`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are read by no RepWorth code.**
   `new OpenAI(LLM_CLIENT_OPTIONS)` and `new Anthropic(LLM_CLIENT_OPTIONS)` pass
   no `apiKey`, so each SDK reads the environment itself. No audit and no gate
   can see them. They are still mandatory.
9. **`DB_READ_POOL_MAX` has no effect.** `readReadPoolMax()` clamps it to
   `[WEDGE_SAFE_READ_MIN, READ_POOL_MAX_CEILING]`, and both constants are `8`.
   Do not set it.
10. **`PAST_REPLIES_VIEW_ENABLED` is read nowhere.** It is absent from all 174
    declared variables. It is still set on Vercel production. Delete it there.

---

## 8. Deliberately out of Infisical

| Variable | Owner | Reason |
|---|---|---|
| `REDIS_QUEUE_URL` | Railway, native | A Railway reference expression. **In production the service is named `Redis`, so the expression is `${{Redis.…}}`, NOT `${{redis.…}}`** — see §13. Keeping it native means a Redis re-provision repairs it. `?family=0` is mandatory — Railway's private network is IPv6-only. |
| `RAILWAY_*` (8 names) | Railway, injected | `RAILWAY_ENVIRONMENT_NAME` is how `deploymentLane()` resolves the lane (ADR 0013). Sentry tags derive from it. |
| `VERCEL_*` incl. `VERCEL_GIT_COMMIT_SHA` | Vercel, injected | Same. `/api/health` reports the SHA. |
| `PORT` | Railway, injected | |
| `NODE_ENV` | leave unset | ADR 0013 records production Railway as `NODE_ENV` unset with `RAILWAY_ENVIRONMENT_NAME=production`. `requiresProductionConfig()` is already true from the Railway signal, so setting it changes nothing our code reads. |
| `MOCK_EXTERNAL_APIS` | leave unset | A value gate. Absence is correct; `true` is a boot failure. |
| `MOCK_ZERNIO_LOCATION_COUNT` | never | A mock fixture, read only in mock mode. |
| `DATABASE_URL` | ops only | Not read by app runtime (§7.2). Keep it wherever migrations run. |
| seven legacy `STRIPE_PRICE_*` | Railway + Vercel, native | See the warning below. |
| `DB_READ_POOL_MAX` | never | Clamped to a constant (§7.9). |
| `DB_POOL_MAX` | each platform, native | The correct value differs by platform: `20` on Railway, `3` on Vercel. One Infisical key cannot hold both (§9.1). Already correct on both today. |

### The legacy Stripe price variables are a rollback trap

Both platforms carry seven names the current binary never reads:
`STRIPE_PRICE_BASIC`, `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_STANDARD_OVERAGE`,
`STRIPE_PRICE_PREMIUM`, `STRIPE_PRICE_PREMIUM_OVERAGE`, `STRIPE_PRICE_FOUNDING`,
`STRIPE_PRICE_FOUNDERS_OVERAGE`.

`RETAINED_STRIPE_PRICE_HISTORY` in `src/lib/payments/price-tier-map.ts` is an
**empty array**, so nothing in code preserves those IDs. The stand-up keeps the
env vars through the WS8 rollback window because a rolled-back binary reads them.

**Consequence for Phase I.** Switching either Secret Sync from Import to
Overwrite deletes every destination variable that Infisical does not manage —
which would remove all seven and close the rollback door with no error. Either
keep both syncs on Import until the rollback window closes, or enable **Disable
Secret Deletion** on both syncs, not only the Railway one.

---

## 9. Sync configuration

| Sync | Target | First strategy | After the name lists verify |
|---|---|---|---|
| `prod` → Vercel | project `rep-worth`, environment **Production** | Import (Infisical priority) | Auto-sync ON. **Redeploy manually** — Vercel does not restart on an env change, and `NEXT_PUBLIC_*` is inlined at build time. |
| `prod` → Railway | project `repworth`, environment **production**, service **repworth-worker** | Import (Infisical priority) | Auto-sync ON, **Disable Secret Deletion** ON. |

Three rules that decide whether this goes well.

0. **Target the `prod` slug, not `production`.** `--env production` errors; the
   environment does not exist under that name (§12.3). A sync aimed at a
   non-existent slug writes nothing.
1. **Name the Railway service.** A sync with no service selected writes
   environment-level shared variables instead of service variables.
2. **Do not sync until Infisical is complete.** Railway restarts the service on a
   variable change, so a partial sync is a boot-gate crash loop.
3. **Do not import from Vercel.** Infisical imports variables marked sensitive as
   **empty**. Every production variable there shows as Encrypted. Type them in.

### 9.1 One environment, two destinations

The plan uses one Infisical environment, `production`, and two Secret Syncs. A
sync pushes the environment, not a subset. Two consequences follow, and the
second is a blocker.

**`DB_POOL_MAX` cannot live in Infisical.** Its correct production value is `20`
on the Railway worker and `3` on Vercel. One key in one environment cannot hold
both.

It is correct on Railway (`20`) and **empty on Vercel**, verified 2026-08-30
(§11). An empty value is not "unset and harmless": `readPoolMax()`
(`src/lib/db/server.ts:15`) falls back to **10**, so Vercel production runs at 10
connections per serverless instance against one PgBouncer today. Set it to `3`
natively during Phase C.

> **Decision: keep `DB_POOL_MAX` native on each platform**, exactly like
> `REDIS_QUEUE_URL`. Add it to the §8 exclusion list. Enable **Disable Secret
> Deletion** on both syncs so neither can remove it.

The alternatives are worse. Per-sync key filters add a second place where the
production variable set is defined. A second environment doubles every shared
secret and reintroduces the drift Infisical is meant to end.

**Single-platform values will land on both platforms.** `ADMIN_NOTIFICATION_EMAIL`,
`STRIPE_WEBHOOK_SECRET`, `ZERNIO_WEBHOOK_SECRET` and `POSTHOG_API_KEY` are read
only by the worker. `IMPERSONATION_COOKIE_SECRET`, `NEXT_PUBLIC_SENTRY_DSN`,
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
`SENTRY_PROJECT` and `CONTACT_NOTIFY_TO` are read only by Vercel. A union sync
places each on the platform that ignores it.

Nothing breaks. The cost is blast radius: a Vercel environment leak would then
also expose the Stripe and Zernio webhook signing secrets, which today it does
not. **This is an owner decision, not a technical blocker.** Record it either way.
Accepting the union is the simpler operation and is what the plan assumes.

---

## 10. Entry count

Distinct Infisical keys, counted once each.

| Group | New keys | Running total |
|---|---|---|
| Unconditional worker gates, minus `REDIS_QUEUE_URL` and `STRIPE_WEBHOOK_SECRET` | 16 | 16 |
| Vercel core-app gates (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) | 2 | 18 |
| Zernio conditional gate (`ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `WORKER_PUBLIC_URL`) | 3 | 21 |
| Required in practice, worker side | 14 | 35 |
| Required in practice, Vercel side | 11 | 46 |
| Flags carrying an explicit value | 8 | 54 |
| **Enter now** | | **54** |
| Held until a later phase: `STRIPE_WEBHOOK_SECRET` (D.3), `BETA_COMP_COUPON_ID` (F.4) | 2 | 56 |

The 14 worker-side entries are `REDIS_CACHE_URL`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
`RESEND_WEBHOOK_SECRET`, `CSRF_SECRET`, `WORKER_INTERNAL_SECRET`,
`POSTHOG_API_KEY`, `POSTHOG_HOST`, `GLOBAL_DAILY_COST_LIMIT_CENTS`,
`SERPAPI_API_KEY`, `LIST_UNSUBSCRIBE_EMAIL` and `LIST_UNSUBSCRIBE_URL`.

The 11 Vercel-side entries are `IMPERSONATION_COOKIE_SECRET`,
`NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `CONTACT_NOTIFY_TO`,
`SERPAPI_TIMEOUT_MS`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
`ZERNIO_PROFILE_ID_PREFIX`, `TELEGRAM_BOT_USERNAME` and `FOUNDING_DEADLINE`.

The 8 flags are `AUTO_APPROVAL_ENABLED=false`, `AUTOPILOT_PURCHASABLE=false`,
`TRIAL_ENABLED=false`, `SELF_SERVE_SIGNUP_ENABLED=false`,
`ONBOARDING_DEMO_ENABLED=true`, `ZERNIO_PUBLISHING_ENABLED=true`,
`OPENAI_MODERATION_ENABLED=false`, and `EXTERNAL_REPLY_IMPORT_ENABLED` at its
current Railway value.

Freshly minted in this pass: `SESSION_COOKIE_SECRET`, `CSRF_SECRET`,
`IMPERSONATION_COOKIE_SECRET`, `WORKER_INTERNAL_SECRET`, `ZERNIO_WEBHOOK_SECRET`.
Rotated at their provider: `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`, and the
Supabase database password inside `DATABASE_POOL_URL`. That set is exactly the
rotation owed for the 2026-08-30 transcript exposure.

---

## 11. Live state, verified 2026-08-30

A name-and-hash comparison of the two platforms, taken after the manifest
merged. No value was printed. Secrets were compared by SHA-256 prefix; only
non-secret values are quoted.

Counts match the record: **27 application variables on the Railway production
worker** (plus 8 `RAILWAY_*`), **34 on the Vercel production project** (the "56
names" figure in earlier notes counts the `VERCEL_*`, `TURBO_*` and `NX_DAEMON`
values a `vercel env pull` adds).

### Shared values agree, with three exceptions

Every value present on both platforms hashes identically — `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `DATABASE_POOL_URL`, `DATABASE_URL`, all six current
`STRIPE_PRICE_*`, all seven legacy `STRIPE_PRICE_*`, both
`DAILY_COST_LIMIT_CENTS_*`, `FOUNDING_DEADLINE`, `AUTOPILOT_PURCHASABLE`,
`SELF_SERVE_SIGNUP_ENABLED`. The exceptions are `DB_POOL_MAX`,
`STRIPE_SECRET_KEY` and `WORKER_INTERNAL_SECRET`, all three because the Vercel
side is empty.

### Nine Vercel production variables are SENSITIVE, not empty — F8 REFUTED

> **Corrected 2026-08-31.** The paragraphs this section used to carry concluded
> the nine were genuinely empty, and that production Checkout had therefore been
> broken since `STRIPE_SECRET_KEY` was set. **That conclusion is wrong and is
> withdrawn.** The reasoning was sound; the evidence was corrupted by a stale
> tool.

`vercel env pull` returns nine production variables as zero-length:
`STRIPE_SECRET_KEY`, `WORKER_INTERNAL_SECRET`, `SESSION_COOKIE_SECRET`,
`DB_POOL_MAX`, `ONBOARDING_DEMO_ENABLED`, `GOOGLE_SHEETS_CLIENT_EMAIL`,
`GOOGLE_SHEETS_PRIVATE_KEY`, `OWNER_LEADS_GOOGLE_SHEET_ID`,
`OWNER_LEADS_GOOGLE_SHEET_RANGE`.

**All nine are Vercel *Sensitive* variables.** That type is write-only: a pull
returns it empty by design. Settled two ways on 2026-08-31:

1. The owner opened `STRIPE_SECRET_KEY` in the dashboard. It reports the value
   exists and **cannot be viewed** — the Sensitive signature, not the empty one.
2. `vercel@latest env ls production` adds a **`type` column** the installed
   54.14.5 does not have. It reports **9 `Secret` and 26 `Config`** across 35
   production variables, and the nine `Secret` names are **exactly** the nine
   above. A perfect 1:1 match with the "empty" list.

**Why the earlier evidence pointed the wrong way.** Both arguments against the
Sensitive hypothesis were artifacts:

| Earlier argument | What was actually true |
|---|---|
| "`vercel env ls` reports every one of the 34 as `Encrypted`, not `Sensitive`" | CLI **54.14.5 has no `type` column at all**. `Encrypted` was a fixed label on every row, so it could not have distinguished the two types. |
| "`SUPABASE_SERVICE_KEY` — at least as sensitive — pulled a 219-character value" | It is type **`Config`**, not `Secret`. It pulls because it is not Sensitive. It was never a counterexample. |

**Two consequences, both good, and one that overturns a second finding.**

1. **Production Checkout is not broken.** `getStripe()` receives a real key. The
   defect this section warned about does not exist.
2. **Finding F10's operational claim is also wrong.** `DB_POOL_MAX` is
   `Secret`, not empty, so "Vercel production runs at 10 connections per
   serverless instance today" is unfounded — `readPoolMax()` never saw a blank.
   **The Phase C action is unchanged: set it to `3`.** Only the justification
   changes, from "repair a live defect" to "pin a value we cannot read back".
3. `ONBOARDING_DEMO_ENABLED` likewise holds a real value. It is set explicitly
   in Phase C regardless.

**This raises the weight of §9 rule 3.** "Do not import from Vercel — Infisical
imports variables marked sensitive as empty" is no longer a precaution against a
hypothetical. **Nine real variables would arrive blank**, three of them
credentials. The plan types them in, so nothing is at risk — but the rule now has
a named cost.

**Open question for the first sync.** These nine carry the Sensitive flag today.
Whether an Infisical Secret Sync preserves that flag or writes them as ordinary
encrypted variables is unknown. Losing it on `STRIPE_SECRET_KEY`,
`SESSION_COOKIE_SECRET` and `WORKER_INTERNAL_SECRET` is a small but real posture
regression. **Re-run `vercel@latest env ls production` after the first sync and
compare the `type` column.**

**Tooling note.** The installed Vercel CLI is 54.14.5; current is 59.10.0. It
cannot express variable types and produced a month of wrong conclusions from one
missing column. Use `npx vercel@latest` for any type-sensitive read until it is
upgraded.

### Three findings confirmed against the live platforms

| Finding | Verified value |
|---|---|
| `NEXT_PUBLIC_APP_URL` is wrong on Vercel | `https://rep-worth.vercel.app/` — wrong host and a trailing slash, exactly as recorded |
| `PAST_REPLIES_VIEW_ENABLED` is still set | `true` on Vercel production, read by no code (§7.10) |
| `ZERNIO_RECENT_REVIEW_POLL_DISABLED` is still set | `true` on Railway — the §2 producer denial, removed at WS8 §7 |

`EXTERNAL_REPLY_IMPORT_ENABLED` is `true` on Railway. Carry that value; do not
drop it in the sync.

### Rotate during the freeze — the window is open now

The WAF rule denies every production `/api/*`, so no request reaches Postgres,
Supabase Auth or Stripe from the Vercel deployment. Rotating
`SUPABASE_SERVICE_KEY`, the Supabase database password and `STRIPE_SECRET_KEY`
therefore breaks nothing that is currently reachable. **This is the safest
moment in the whole cutover to rotate**, and it closes the moment the deny rule
is lifted at WS8 §7.

One dependency to watch: if the Supabase key rotation rolls the project JWT
secret, `NEXT_PUBLIC_SUPABASE_ANON_KEY` changes with it. Re-read both keys after
rotating rather than assuming the anon key survives.

---

## 12. Phase I pass 1 — executed 2026-08-30

### 12.1 Result

The Infisical `prod` environment holds **43 keys**. Every value was compared
against its source file after the write: no key missing, no value mismatched,
**no empty secret**, nothing stray. Pre-write validation passed **43/43** on
format.

| Group | Keys |
|---|---|
| Carried from the Railway production worker | 11 |
| Carried from the Vercel production project | 2 |
| Fixed literals from this manifest | 9 |
| **Freshly minted, 32 bytes hex** | 5 |
| **Rotated at the provider** | 3 |
| Owner-supplied provider values | 13 |

**Minted:** `SESSION_COOKIE_SECRET`, `CSRF_SECRET`, `IMPERSONATION_COOKIE_SECRET`,
`WORKER_INTERNAL_SECRET`, `ZERNIO_WEBHOOK_SECRET`.
**Rotated:** `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`, and the Supabase
database password inside `DATABASE_POOL_URL`.

That set is exactly the rotation owed for the 2026-08-30 transcript exposure.
**Finding F4 is closed.**

No secret value passed through a transcript. Carried values were pulled straight
into a mode-600 gitignored file, minted values were generated into it, and the
write used `infisical secrets set --file`, whose output table masks values.

Format checks that passed: `sk_live_` prefix; `sb_secret_` prefix; the pooler URL's
`:6543` plus project-ref username plus `?pgbouncer=true`; `https://repworth.net`
with no trailing slash; every secret ≥32 bytes; every boolean exactly `true` or
`false`; `SENTRY_ORG=repworth-nv`.

### 12.2 Supabase now uses a new-format secret key

`SUPABASE_SERVICE_KEY` holds an `sb_secret_…` value, not a legacy `service_role`
JWT. The variable **name is unchanged** deliberately — renaming would touch both
config schemas, the registry, `.env.example` and four docs for a cosmetic gain
mid-cutover. Rename after launch.

Why the new format was chosen over rotating the legacy key: rotating a legacy
`service_role` key means rolling the project JWT secret, which invalidates the
`anon` key at the same instant. A new secret key is additive and independent.

Blast radius was checked against the three documented limitations and is **zero**:
no `pg_net` or Database Webhooks, no Edge Functions, no Realtime usage. The key
reaches exactly nine call sites, all `auth.admin` — no PostgREST reads, no
Storage. `@supabase/supabase-js` 2.106.2 supports the format; its own README uses
it.

> **Still owed:** exercise one `auth.admin` call on staging under a staging secret
> key before the production worker deploys. The admin invite at
> `/admin/businesses/new` does it. This is the project's own staging-first rule.

### 12.3 `RESEND_FROM_EMAIL` is on the root domain — correction

Earlier records, including this file's own §4 row, said it must stay on
`send.repworth.net` because the root SPF has no `amazonses.com` include. That
conflates the `From:` header with the envelope sender. Live DNS, 2026-08-30:

| Record | Value | Meaning |
|---|---|---|
| `MX send.repworth.net` | `feedback-smtp.us-east-1.amazonses.com` | Resend's custom **Return-Path** subdomain |
| `TXT send.repworth.net` | `v=spf1 include:amazonses.com ~all` | SPF authorises the **envelope** |
| `TXT resend._domainkey.repworth.net` | present | **DKIM signs the root domain** |
| `TXT resend._domainkey.send.repworth.net` | **absent** | No DKIM key on the subdomain |
| `TXT _dmarc` | `p=quarantine; adkim=r; aspf=r` | Relaxed alignment |

The verified sending domain is `repworth.net`. A From address on
`send.repworth.net` would carry no DKIM key at all. Staging has been sending from
the root all along. Value in use: `RepWorth <notifications@repworth.net>`, a Zoho
group with external senders allowed.

### 12.4 The environment slug is `prod`

`--env prod` succeeds; `--env production` errors. `staging` and `dev` work;
`stg` and `development` do not. Point both Secret Syncs at **`prod`**.

### 12.5 Planned keys deliberately not entered

| Key | Why |
|---|---|
| `POSTHOG_API_KEY` | Owner deferred. `AnalyticsDispatchPoller` ships nothing until it lands — rows accumulate unsent, nothing breaks. |
| `LIST_UNSUBSCRIBE_URL` | By design (§12.6). |
| `POSTHOG_HOST`, `SERPAPI_TIMEOUT_MS`, `ZERNIO_PROFILE_ID_PREFIX` | Optional with working defaults. |
| `TELEGRAM_BOT_USERNAME`, `SOLICITATION_UNSUBSCRIBE_MAILTO` | Their features are off for beta. |
| `GOOGLE_SHEETS_*`, `OWNER_LEADS_*` (4) | Empty on Vercel today (§11), so nothing to carry. The owner-lead mirror is inert either way and is not a launch gate. |
| `DB_POOL_MAX` | Stays native per §9.1 — the value differs per platform. |

### 12.6 Why `LIST_UNSUBSCRIBE_URL` stays unset

It is a **single shared** URL used on every marketing email. The only unsubscribe
endpoints that exist — `worker/ingress/unsubscribe.ts` and
`src/app/api/u/[token]/route.ts` — are **per-recipient token** routes on the
solicitation lane. There is no valid token for a shared URL.

Set it, and `headers.ts` emits `List-Unsubscribe-Post: One-Click`. A mail client
POSTs on the recipient's behalf, hits an unknown token, and receives a **503**
from `replyUnknownToken`. The opt-out silently fails.

Unset is the tested path: `headers.ts` falls back to mailto-only and omits the
Post header, which its own comment records as accepted by Gmail and Outlook for
low-volume senders.

`LIST_UNSUBSCRIBE_EMAIL` is `unsubscribe@repworth.net`, a monitored Zoho group.
**There is no automation behind it.** A human must stop sending to that owner
within ten business days, per CAN-SPAM.

### 12.7 The Infisical CLI cannot delete a secret

`infisical secrets delete` at **v0.43.128** sends
`DELETE /api/v3/secrets/raw/<name>` without the environment or workspace, and the
API returns `404 Secret not found` for a secret the read plainly returns. Tried
with `--env` before and after the positional argument, with `--path /`, and with a
`.infisical.json` link file. **Delete through the web UI.** Do not script a
secret removal against this CLI version.

### 12.8 Still owed before the syncs run

1. Add the four Phase A outputs. **Two are in as of 2026-08-30**, so the
   environment now holds **45 keys**:

   | Key | State |
   |---|---|
   | `SENTRY_DSN` | ✅ written, verified `ee14c7a4175df209` |
   | `NEXT_PUBLIC_SENTRY_DSN` | ✅ written, same value, same hash |
   | `WORKER_PUBLIC_URL` | ✅ `https://worker.repworth.net`, format gate checked |
   | `REDIS_CACHE_URL` | ✅ `sincere-primate-143545.upstash.io:6379`, `PING`→`PONG` before the write, verified `55a91f680d1b55ad` |

   **Count: 47 keys. All four Phase A outputs are in.** Two keys remain held by
   design: `STRIPE_WEBHOOK_SECRET` (D.3) and `BETA_COMP_COUPON_ID` (F.4).

   `REDIS_CACHE_URL` is confirmed **not** staging's instance — staging's cache is
   `saving-mongoose-139950.upstash.io`. Compared by host, so no value was read.

   The Sentry project `repworth-production` **already existed** under org
   `repworth-nv` — the earlier record saying it did not is stale. Its DSN is
   distinct from staging's in both key and project ID, so §A.1's "never reuse
   the staging DSN" is satisfied by construction, not by care.
2. Check `STRIPE_SECRET_KEY` in the Vercel dashboard — empty, or Sensitive? (§11)
3. Prove the Supabase secret key on staging (§12.2).
4. Then configure both syncs against `prod`, **Import only**, deletion disabled on
   both.


---

## 13. Finding F14 — the production Redis service is named `Redis`, not `redis`

**Railway reference variables resolve by service name, and the name differs
between environments.**

`docs/runbooks/deployment-guide.md:1296` records the staging service name as
lowercase and says why: *"service named `redis` (lowercase, so the
`${{redis.…}}` reference resolves)"*. That was a deliberate choice.

The Railway dashboard's `+ New → Database → Add Redis` names the service
**`Redis`**. So the production service created on 2026-08-30 is `Redis`, and
every copy of the documented expression in this repo spells it lowercase.

| Environment | Service name | Service ID | Image | Correct expression |
|---|---|---|---|---|
| staging | `redis` | `2dbd085e-…` | `redis:8.2.1` | `${{redis.…}}` |
| production | **`Redis`** | `f9573767-…` | `redis:8.2` (`haTemplateCode: redis-ha`) | **`${{Redis.…}}`** |

**Verified, not assumed.** The value set on the production worker was read back
through a transform that prints structure only, never the value:

```
REDIS_QUEUE_URL present, length 87
  still contains an unresolved ${{...}} : False
  user      : default
  password  : non-empty, 32 chars
  host      : redis.railway.internal
  port/db   : 6379 / 1
  ?family=0 : present
```

An unresolved reference would have left the literal `${{...}}` in the string, or
an empty password segment. Neither is present.

**Why it would have failed silently.** `assertCoreInfraEnv` checks that
`REDIS_QUEUE_URL` is **present**, not that it is well-formed. A lowercase
reference resolving to an empty password yields
`redis://default:@redis.railway.internal:6379/1?family=0` — a syntactically
valid URL that passes the boot gate and then fails `NOAUTH` on every BullMQ
operation. The worker reports healthy while no job ever runs. That is the same
failure shape as the missing `?family=0`.

**The private network endpoint is lowercase either way.** The service's
`privateNetworkEndpoint` is `redis`, so `RAILWAY_PRIVATE_DOMAIN` resolves to
`redis.railway.internal` in both environments. Only the **reference prefix**
differs, because that is the service name.

### The name cannot be made to match — this is permanent

An earlier draft of this section recommended renaming the production service to
`redis` for parity. **That is impossible, and the recommendation is withdrawn.**

**Railway service names are unique per PROJECT, not per environment.** Both
environments live in project `repworth`, and the staging service already holds
`redis`. Railway rejects the rename with "already taken in the project"
(observed 2026-08-31).

The capital `Redis` is therefore **forced**, not chosen. This section is a
permanent part of the production configuration, not a temporary exception.

**Consequence for anyone editing the queue URL.** The lower-case
`${{redis.…}}` form printed in `deployment-guide.md` (lines 269, 560, 1279,
1296) is correct **for staging only**. Production must use `${{Redis.…}}`.
Copying the documented line into production produces a URL with an empty
password that passes the boot gate and then fails `NOAUTH` on every queue
operation — see the failure analysis above.

`RAILWAY_PRIVATE_DOMAIN` still resolves to `redis.railway.internal` in both
environments, because the private network endpoint is derived separately from
the service name. Only the reference prefix differs.
