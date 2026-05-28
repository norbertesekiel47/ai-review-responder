# RepWorth — Lab Notes

Hard-won discoveries from production debugging and integration work.
Check the relevant section before implementing anything in these areas.

## Topic index

Jump to the dated entries by subsystem (search the anchors below):

- **Postgres.js / JSONB / PgBouncer** — JSONB string-wrapping, v3 double-encoding, statement_timeout, FOR UPDATE under PgBouncer
- **Indexes / migrations** — STABLE-in-predicate, ON CONFLICT byte-for-byte, column-level REVOKE, pg_constraint relation scoping
- **Zernio** — nested `account.id`, MOCK_EXTERNAL_APIS real-path tests, reviewReply normalization
- **Stripe** — inbound_events payload shape, overage idempotency, billing reconciliation from stored quota
- **Supabase auth** — implicit-flow OTP, identities:[] for existing emails, auth_id vs users.id, SMTP rate limit
- **Billing / multi-location** — stored-quota vs TIER_CONFIG, base price not grandfathered, channel account-scope desync
- **Analytics / PostHog** — unconfigured no-op retry budget, durable vs intent events, RLS on new tables
- **Moderation / logging** — fail-open moderation, logger-never-throws (incl. AsyncLocalStorage binding for correlation IDs)
- **CI / tooling** — nested-worktree poisoning, MOCK_EXTERNAL_APIS=false in CI, tenant-scope allowlist drift, comment-backtick extractor false-positive, allowlist file-move orphaning
- **Testing** — vi.hoisted for shared mocks, NextRequest vs Request, relative imports under tsx

---

## 2026-04-09

### Postgres.js + PgBouncer JSONB string wrapping
Postgres.js + PgBouncer returns JSONB columns as plain strings, not parsed
objects. Guard every JSONB read:
```typescript
typeof x === 'string' ? JSON.parse(x) : x
```

---

## 2026-04-11

### SerpAPI Maps Reviews ignores `num` on page 1
SerpAPI always returns 8 results on page 1 regardless of the `num` parameter.
Removed `num` from the request; slice client-side instead.

### Claude Haiku model string deprecated
`claude-3-5-haiku-latest` → 404. Use `claude-haiku-4-5-20251001` explicitly.
Update the fallback LLM config if you ever see 404 on the Haiku calls.

### Vercel serverless can't reach local Docker Redis
Rate limiter must gracefully skip (not throw) when `REDIS_CACHE_URL` is
missing or unreachable. Already handled — don't add hard failures here.

### BullMQ rejects `:` in job IDs
OutboxPoller uses `_` as the separator in constructed job IDs. Never use `:`
in any dynamically-constructed BullMQ job ID.

### Supabase PgBouncer statement_timeout
PgBouncer enforces ~8s `statement_timeout`. The OutboxPoller watchdog CTE
can exceed this. Set `connection: { statement_timeout: 30_000 }` on the
Postgres.js client used by OutboxPoller. Already configured — don't remove it.

---

## 2026-04-13

### Google Maps URL hex CIDs vs Place IDs
Google Maps URLs use hex CIDs (`0x...:0x...`), NOT canonical Place IDs.
Resolve via PlaceAutocomplete or SerpAPI `engine=google_maps` search.
Never use `data_id` from the URL directly.

### Place ID format is NOT `ChIJ`-only
Place IDs use base64url charset + 20+ chars. Also valid: `GhIJ`, `Eic`,
`Iho`, and others. Match on charset + length, never on `ChIJ` prefix.

### PlaceAutocompleteElement shadow DOM styling
`PlaceAutocompleteElement` has a closed shadow DOM — can't style via
`::part()`. Fix: `color-scheme: light only !important` on the element.
Never set `overflow: hidden` on the container (clips the dropdown).

### Google Maps Essentials vs Pro tier fields
`displayName` is Pro tier (paid). On the free Essentials tier, only use:
`id`, `formattedAddress`, `location`. Already enforced in onboarding wizard —
don't add `displayName` calls.

### `@googlemaps/js-api-loader` v2 SSR guard
`setOptions()` in v2 accesses `window` at import time. Guard all usages:
```typescript
if (typeof window !== 'undefined') { ... }
```
Also: `Autocomplete` class is blocked for new customers — use
`PlaceAutocompleteElement` instead.

---

## 2026-04-14

### Stripe `inbound_events.payload` structure
The full Stripe event object is stored in `payload`. To get the session ID:
```sql
payload->'data'->'object'->>'id'   -- ✅ correct (session ID)
payload->>'id'                      -- ❌ wrong (this is the evt_... event ID)
```

---

## 2026-04-18

### Postgres.js v3 JSONB double-encoding
`${JSON.stringify(x)}::jsonb` in Postgres.js v3 double-encodes the value,
producing a JSONB scalar string instead of a parsed object. Always use the
`jsonb()` helper:
```typescript
import { jsonb } from '@/lib/db/server'
// Uses sql.json(value) with OID 3802 internally
sql`INSERT INTO foo (data) VALUES (${jsonb(myObject)})`
```
Never use the `::jsonb` cast with a JS-interpolated string.

---

## 2026-04-24

### Supabase server-side signUp implicit flow
Server-side `supabase.auth.signUp()` uses implicit flow → confirmation emails
return `#access_token=...` fragment to homepage (JavaScript can't read it
server-side). Fix: use 6-digit OTP (`{{ .Token }}` template + `/signup/check-email`
entry point). This also sidesteps email-scanner link prefetch attacks.

### `channel_enrollments` row insertion timing
Must only insert AFTER email is verified (post-OTP or post-Google-OAuth).
Admin `createBusinessTx` keeps inline INSERT (pre-verified by definition).
Forgetting the Google OAuth path silently drops all notifications for
Google-signed-up businesses. Already fixed — don't regress this.

### Admin-onboarded owners with `auth_id=NULL`
Pre-fix: admin-onboarded owners had `auth_id=NULL` → couldn't log in.
Admin route now calls `inviteUserByEmail` + patches `auth_id`. Compensating
delete fires on invite failure to prevent email collision on retry.

### Supabase built-in SMTP rate limit
Built-in SMTP: 2 emails/hour. Fix: custom SMTP via Resend.
`smtp.resend.com:465`, username `resend`, password = `RESEND_API_KEY`.
In `/api/auth/signup`, disambiguate `over_email_send_rate_limit` → 429,
NOT 409 `account_exists`.

---

## 2026-04-26

### `CleanupAbandonedSignupsPoller` TOCTOU vulnerability
Must re-validate ALL predicates inside the transaction with `SELECT FOR UPDATE`
after taking advisory locks. `deleteUser()` is irreversible AND non-transactional
— getting this wrong nukes paying accounts. Already hardened — treat this as
a red line.

### Supabase obfuscated signUp response for existing emails
`supabase.auth.signUp()` returns `identities: []` for already-confirmed emails
(anti-enumeration protection). Detect this BEFORE calling `createBusinessTx`
and return `account_exists` (409) to the client.

### `googleMapsUrlSchema` contract with worker
`googleMapsUrlSchema` must call `parseGoogleMapsUrl()` and enforce the same
parseability contract as the worker's `validate_place_id`. If the wizard
accepts a URL that the worker can't parse, the business onboards successfully
but `PlaceIdValidationWorker` permanently fails.

---

## 2026-04-27

### Postgres STABLE expressions rejected in partial index predicates
Postgres rejects `STABLE` expressions in partial-index keys/predicates
(ERROR 42P17). `timestamptz::date` is `STABLE` (depends on session timezone).

**Wrong:**
```sql
CREATE UNIQUE INDEX ... WHERE (created_at::date) = ...  -- ❌ fails
```

**Correct:**
```sql
CREATE UNIQUE INDEX ... WHERE ((created_at AT TIME ZONE 'UTC')::date) = ...  -- ✅
```

The `ON CONFLICT` clause on any INSERT into that index must use the EXACT
same expression byte-for-byte or Postgres won't recognize the constraint match.

---

## 2026-04-28

### Zernio `account.disconnected` nested payload
Zernio's `account.disconnected` webhook payload uses NESTED `account.id`,
NOT flat `accountId`:
```typescript
// ✅ correct
const accountId = body.account?.id

// ❌ wrong — body.accountId is undefined
const accountId = body.accountId
```
A flat-`accountId` payload returns `200 received:true` but silently skips
processing (logs `missing account.id — skipping`). Test helpers MUST build
the nested shape.

---

## 2026-04-29

### Postgres `ON CONFLICT` must reference partial-index expressions verbatim
The `ON CONFLICT` clause must reference partial-unique-index expressions
BYTE-FOR-BYTE. Migration 005's `idx_review_exceptions_collision_dedup`
predicate uses `(payload->>'provider_review_id')`, NOT `provider_review_id`.

```sql
-- ✅ correct — matches the index expression exactly
ON CONFLICT (aggregate_id, (payload->>'provider_review_id'))
  WHERE topic = 'ingest_zernio_review' ...

-- ❌ wrong — "no matching unique constraint" at runtime
ON CONFLICT (aggregate_id, provider_review_id) ...
```

This applies to any index using JSONB operators or expression casts in the
conflict target.


---

## 2026-05-02

### Split decision: ship view-only, park Zernio-shaped edit machinery
`feat/edit-existing-replies` was code-complete (31 commits, 6 review rounds,
~3,500 LOC) and would have shipped the full edit / regenerate / publish /
retry / restore-original flow. We split it instead:

- **Shipped on `feat/past-replies-view`:** read-only Past Replies tab + the
  flag-gated ingestion that fixes the Tanicia silently-dropped-replies bug.
- **Parked on tag `wip/edit-existing-replies-zernio-v1`:** the entire DELETE+
  POST orphan-marker recovery state machine, the 7 API routes, the
  EditReplyDrawer, the recovery routes, the publisher edit branch.

**Why parked, not shipped:** Zernio's API requires DELETE-then-POST to edit a
reply. Direct GBP API uses single-PUT replacement. ~25% of the parked code
(orphan-marker convention, `runEditPublisherIfApplicable`, `publisher-on-failed.ts`,
`verify409InTx`, recovery routes) becomes vestigial when GBP arrives. Per
CLAUDE.md, "GBP API: Not applied for" — 6-18 month timeline at best. The
75% that survives a GBP swap (route shapes, drawer state machine minus
recovery, helpers) is reusable as a spec-as-code reference, but rebuilding
against GBP's simpler model is cleaner than carrying Zernio-shaped
machinery in production for 6-18 months.

**Resurrect the parked tag only if:** GBP timeline blows up beyond ~12
months AND premium-tier monetization needs the differentiator urgently.
Otherwise wait for GBP and rebuild against the simpler model.

### Two-flag rollout pattern for ingest-vs-UI features
The original single-flag design (`EDIT_EXISTING_REPLIES_ENABLED` gates
everything) entangled the data-write decision with the UI-expose decision.
Imported `posted` rows count toward `dashboard/service.ts` HANDLED_STATUSES,
so flipping ingestion on changed customer-visible numbers BEFORE the UI
explained them.

The view-only branch splits this into two independent flags:

- `EXTERNAL_REPLY_IMPORT_ENABLED` — gates writes (ingestion path).
- `PAST_REPLIES_VIEW_ENABLED` — gates UI (page + nav link).

Operator turns import on first → silent ingestion soaks → metric shift
visible in product analytics → operator turns view on once they're
comfortable. Each flag is independently revocable.

Pattern generalizes: any feature that writes data AND surfaces it
asymmetrically should use a dual flag. Cost: one extra env-var line in
the runbook. Benefit: independent revocation + soak windows decoupled
from UI launch timing.

### `cherry-pick eb4d183 c2360cd 891e975` worked clean; `ca53663` and `9e0ca93` had to be redone manually
When cherry-picking a fix-pass branch onto a stripped-down replacement
branch, fix commits that touched code added in earlier-dropped commits
will need redoing. Specifically: Round-1 Medium 1 (`ca53663`, reviewReply
normalization) included a hunk modifying `verify409InTx` — but
`verify409InTx` doesn't exist on the read-only branch (it's part of the
parked publisher edit machinery). Round-1 Medium 5 (`9e0ca93`) needed
`redactSensitiveError` to be exported, which depended on the round-1 fix
commit `a8836fd` we weren't bringing.

Resolution: redo both as fresh commits scoped to only the parts that apply
to the new branch. ~30 LOC of manual edits versus the alternative of
cherry-picking the full chain and then trying to revert the dependencies.

Lesson for future splits: when cherry-picking a partial chain, audit each
commit for cross-references to commits not in the cherry-pick set. Either
include the dep, or plan to redo the fix manually.

### `EditReplyDrawer` close-during-async-op = hidden draft class of bug
Round-2 M3 → Round-3 M → Round-4 M all caught variants of the same bug:
the drawer state has an outstanding worker / outbox / fetch in flight, but
tryClose lets close happen, and the worker later commits an invisible row.

Three states needed close-blocking on the parked branch:
- `creating_draft` (POST /draft in flight, ~500ms)
- `regenerating` (worker generating LLM response, 5-30s)
- `regenerate_poll_error` (transient polling failure but outbox still alive)

Discovery sequence: Round-2 M3 caught only `creating_draft`. Round-3 M
extended to `regenerating`. Round-4 M added `regenerate_poll_error` and
distinguished it from terminal `error` (only the latter is closable
because the worker reported it's done — no row will materialize).

Generalizable rule: any UI state that holds an outstanding server-side
async operation must either (a) refuse close until the operation
terminates, or (b) provide a server-side cancel endpoint. (b) is harder
because the operation may have already committed by cancel time.

### `vi.mock` factory hoisting — use `vi.hoisted` for shared mock state
When a test file mocks a module and wants to share the mock function with
the test body (to seed return values per-test), the naive pattern fails:

```ts
// ❌ ReferenceError: Cannot access 'sqlMock' before initialization
const sqlMock = vi.fn();
vi.mock('@/lib/db/server', () => ({ sql: sqlMock }));
```

Vitest hoists `vi.mock` factories to the top of the file, above any
top-level `const`. Use `vi.hoisted()` to share state with the factory:

```ts
// ✅ Works — vi.hoisted runs alongside vi.mock
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ sql: sqlMock }));
```

### [SUPERSEDED 2026-05-27] `/docs/*` is no longer gitignored
The earlier rule ignored all of `docs/`. Current `.gitignore` tracks `docs/` by
default and ignores only generated/binary noise (`docs/graphify-out/`,
`docs/superpowers/landingPageScreenshots/`, `docs/**/*.docx`, `docs/**/*.zip`).
New docs/specs/plans now commit normally.

### Zod v4 — `z.never()` options use `error:`, not `invalid_type_error:`
[2026-05-03] WROTE `z.never({ invalid_type_error: '...' })` per zod v3
idiom → 3 TS2353 errors at compile-time, plus the custom message would
silently never surface even if it had compiled. zod v4 renamed the
option key to `error:` (and accepts a function form for dynamic
messages). Correct:

```ts
// ✅ zod v4
googlePlaceId: z.never({ error: 'unexpected_field: ...' }).optional(),

// ❌ zod v3 — won't compile in v4
googlePlaceId: z.never({ invalid_type_error: '...' }).optional(),
```

The runtime guarantee (the schema rejects values that violate `never`)
holds either way; only the custom error message is affected.

### Postgres FK to `users(id)` — never store Supabase `auth_id` directly
[2026-05-04] PR #2 `/api/onboarding/start` initially inserted
`user_id = ${user.id}` where `user` came from `supabase.auth.getUser()`.
That returns the **Supabase auth identity UUID**, not the row id of
the app `users` table. Migration 032's FK on `onboarding_demos.user_id`
points at `users(id)`, so every happy-path INSERT would have FK-failed
in production.

Anywhere we want a `users.id` value from a Supabase session, we have to
join through:

```sql
SELECT u.id AS user_id, ...
FROM users u
JOIN businesses b ON b.id = u.business_id
WHERE u.auth_id = ${supabaseUser.id}
  AND u.role = 'owner'
LIMIT 1
```

The same gotcha applies to any future table that FKs to `users(id)`.
The `auth_id` column is the bridge between Supabase Auth and the app's
own `users` row — they are NOT the same UUID.

### Cost-guard reservation must be released on tx idempotency-loser path
[2026-05-04] PR #2 `/api/onboarding/start` reserved 20¢ in Redis BEFORE
the FOR UPDATE re-read inside the tx. When two concurrent submissions
hit the route and one won the FOR UPDATE race, the loser's tx callback
returned early (no demo INSERT) but the reservation stayed locked. Net
effect: 20¢ leaked per loser AND the response said `demoQueued: true`
even though no demo was queued.

Fix pattern: track a `demoInserted` boolean closed over by the tx
callback, set it true on the happy path INSERT, and after the tx commits
release the reservation if the flag is still false. Mirror this in any
future route that reserves Redis budget before a tx that may no-op.

### Worker post-completion best-effort blocks must be self-contained try/catch
[2026-05-04] PR #2 `OnboardingDemoWorker` had `checkCostThreshold` +
`Sentry.captureMessage` inside the same outer try as `completeDemo`.
A Redis or Sentry hiccup AFTER the demo completed cleanly would fall
into the outer catch and call `failDemo`, flipping a successful demo
to `failed` for the user.

Rule: any work that runs after a successful primary side effect (DB
write, external publish, etc.) needs its own narrow try/catch with
log-and-swallow semantics. Never let observability/telemetry failures
poison the success path.

### Page-level reads must filter `archived` when the table has 23505 race-loser archives
[2026-05-04] PR #2 `lifecycle.completeDemo` recovers from a Postgres
23505 (concurrent completes for the same user, blocked by the partial
unique index) by archiving THIS row and closing its outbox. The losing
demo can therefore have a NEWER `created_at` than the winning completed
demo.

Any UI/API read that does `ORDER BY created_at DESC LIMIT 1` against
`onboarding_demos` MUST filter `AND generation_status <> 'archived'` or
it will surface the loser's archived row and the page will render with
no matching status branch (header only, no CTA, no review cards). The
two affected reads in PR #2: `/onboarding/demo/page.tsx` and
`/api/onboarding/demo/status/route.ts`.

Generalizes: any state-machine table with an `archived` terminal value
where the archive can be created later than other terminal rows for the
same logical entity.

### Column-level Postgres `REVOKE` does nothing without a table-level revoke first
[2026-05-09] Migration 040 originally tried to lock down owner-edit
surface on `businesses` by issuing `REVOKE UPDATE (col1, col2, …) ON
businesses FROM authenticated`. Postgres still allowed UPDATEs on those
columns: the broader table-level `GRANT UPDATE` was authoritative, and
column-level revokes don't shrink an existing table grant.

Correct pattern:

```sql
-- 1. Drop the broad grant first
REVOKE UPDATE ON TABLE businesses FROM authenticated;
-- 2. Re-grant only the safe columns
GRANT UPDATE (tone, products_services, staff_names, …) ON businesses TO authenticated;
```

Migration 040 fixed this for the obvious columns; migration 041 caught
the columns missed in the first sweep (`subscription_activated_at`,
`place_id_verified`, `google_maps_url` on `businesses`,
`archived_at` / `archive_reason` on `channel_enrollments`). Always
verify with `\dp businesses` after running these — the privileges
column should show only the GRANTed columns, not `arwdDxt`.

### `SELECT … FOR UPDATE` outside `sql.begin()` is a no-op under PgBouncer
[2026-05-09] `UpdateStripeOverageWorker` originally read the account
row with `FOR UPDATE` to "serialize" concurrent overage updates. With
PgBouncer in transaction-pooling mode (Supabase default), the lock is
released the moment the SELECT statement completes — there is no
surrounding transaction to hold it across the subsequent Stripe
network call.

Two valid patterns:

1. **Wrap the whole flow in `sql.begin()`** so the lock survives
   across the Stripe call. Holds a Postgres row lock through a network
   I/O — fine if you trust Stripe to respond quickly, but a slow
   Stripe response now blocks any concurrent worker on the same
   account.
2. **Drop `FOR UPDATE` and rely on Stripe-side idempotency.** Pass an
   `idempotencyKey` on the `subscriptionItems.update` /
   `subscriptionItems.create` call that includes the target quantity
   (e.g. `stripe-overage-update:${accountId}:${itemId}:${qty}`). Two
   concurrent jobs computing the same quantity dedup at Stripe; two
   computing different quantities (because one saw a state the other
   didn't) execute independently — exactly what you want.

We picked (2). The misleading `FOR UPDATE` was removed and a comment
added explaining why. Do not re-add it without also wrapping the
worker body in a transaction.

### `archived_at` is a separate skip from the subscription guard
[2026-05-09] `ResponsePublisherWorker` had a JOIN to `accounts` for
the subscription guard but never selected `businesses.archived_at`.
A response approved before archive, with the publisher job already
queued, would still post to Google after the location was archived.
The subscription guard reads from the *account*, not the location, so
it doesn't catch a per-location archive.

Add `b.archived_at` to the load query and short-circuit with
`markOutboxCompleted` (graceful skip — not a failure). The
NotificationWorker's `loadNotificationContext` already does this for
the dispatch path; the publisher needed the same gate. Always check
both subscription_status (account-level) AND archived_at
(location-level) for any worker that operates on a single
business_id.

### Channel cache invalidation must log on Redis failure, not silently swallow
[2026-05-09] Every `channel_enrollments` write path was using
`invalidateChannelCache(...).catch(() => {})` — silently dropping
Redis errors. If Redis was down, channel writes (including TCPA STOP
unsubscribes) would not propagate to the in-memory resolver cache for
up to 5 minutes, and you would not even know it failed.

Fix pattern: `safeInvalidateChannelCache(accountId, context, logger?)`
exported from `resolve-channels.ts`. Wraps `invalidateChannelCache`
with a try/catch that logs `'channel-cache-invalidate-failed'` with
`{accountId, context, error}` as structured fields. The context
string (`'admin.sms.delete'`, `'settings.channels.override.upsert'`,
…) is what you'll grep for when an alert fires.

The wrapper must NEVER throw — channel writes are the source of
truth, the cache is best-effort. But silent failure for a
TCPA-compliance-critical path is not acceptable.

### Migration `034` dropped `users.business_id` outright — no dual-read window
[2026-05-09] The original multi-location design spec proposed keeping
`users.business_id` as a deprecated pointer for one release before
dropping. The implementation took the simpler path: migration 034
drops the column outright. Anywhere reading `users.business_id` will
fail to compile.

Auth code now reads `users.account_id` and resolves the user's
"primary location" by joining to `businesses` with `is_primary = TRUE
AND archived_at IS NULL`. See `src/lib/db/auth.ts:readSelf` and
`src/lib/auth/require-owner-access.ts`. The middleware's
`users_self_select` RLS policy works unchanged because it gates on
`auth_id = auth.uid()`, not on the column being selected.

### CSV bulk-import: enqueue ONE aggregate Stripe overage job, not one-per-row
[2026-05-09] The first cut of admin CSV import called
`addLocationTransaction` for each row, which inserts a
`update_stripe_overage_quantity` outbox row each time. A 100-row
import produced 100 separate worker invocations that each retrieved
the subscription and updated the quantity — 99 of them redundant.

The fix: `addLocationTransaction` accepts
`enqueueStripeOverageUpdate?: boolean` (default `true`). The CSV
import passes `false` per row, then calls
`enqueueCsvImportStripeOverageUpdate(accountId)` exactly once after
the loop if any rows succeeded. Pattern generalizes: any batch
caller of an outbox-enqueueing transaction should be able to
suppress the per-call enqueue and emit one aggregate job.

### Don't bifurcate the post-pay wizard guard with the same "duplicate-submit" check
[2026-05-04] PR #2 wired the existing `/api/onboarding/business`
"already-onboarded" guard (`if (place_id_verified || google_maps_url)
return 409`) to also fire for the new post-pay flow. But in the post-pay
flow, `place_id_verified` is the REQUIRED PRECONDITION (set at
`/onboarding/start` BEFORE Stripe). The guard fired on every legitimate
post-pay submission, returning 200 with no DB write — silently swallowing
every Profile/Voice submit.

Pattern: when bifurcating a route by a flag and the legacy semantic
"X means already done" inverts to "X means ready to proceed", the guard
needs an explicit branch on the flag. Don't let the legacy interpretation
leak into the new path.

---

## 2026-05-22

### Billing snapshot: read STORED quota, not `TIER_CONFIG` — but base price has no stored column
[2026-05-22] PR #51 moved location-quota math off the live `TIER_CONFIG` and onto
the account's stored columns. `currentBillingSnapshot`, `assertCanAddLocation`,
`createCheckoutSession`, `UpdateStripeOverageWorker`, and
`StripeLocationsReconcilePoller` all read `accounts.locations_included` now; PR #52
(review follow-up) extended `currentBillingSnapshot` to also read
`accounts.locations_overage_price_cents`.

Why stored, not config: Stripe grandfathers the original Price IDs on existing
subscriptions, so a future `TIER_CONFIG` price/quota edit must NOT retroactively
change what an existing account is told it pays. Stored = point-in-time snapshot
written at signup / select-plan / tier change.

The trap that bit us in review: the first cut grandfathered `included` (stored)
but still read overage PRICE from `config.overageCents`. Asymmetric — a config
overage-price change would have drifted the displayed/preview overage while the
included count stayed pinned. Fix: read both from the stored columns.

Remaining gap (deliberate, documented): **base price is still
`TIER_CONFIG[tier].baseCents`** — there is no `accounts.base_price_cents` column.
So the base is NOT grandfathered. Most consequential for the `founders` tier,
whose copy promises "Rate locked for life." If you ever change a base price,
existing accounts' displayed base will drift from their actual Stripe charge.
True base grandfathering needs a schema migration (add `accounts.base_price_cents`,
snapshot it at signup/select-plan/tier-change, read it in `currentBillingSnapshot`).
See the TODO in `src/lib/accounts/quota.ts` and runbook §6.

### Don't gate three different questions with one location-count boolean
[2026-05-22] The pre-PR-#51 code used `shouldUseMultiLocationSettings(flag, count)`
(`flag && count > 1`) to answer three unrelated questions at once: "show the
Locations tab?", "switch the dashboard into multi-location mode?", and "can this
account add a location?". Result: a multi-location-eligible account with exactly
one location was locked out of adding its second — the feature it paid for.

Split into three helpers in `src/lib/locations/multi-location-mode.ts`:
`shouldShowLocationsSettings` (flag only — visibility),
`shouldUseMultiLocationSettings` (`count > 1` — content mode),
`canAddLocationForAccount` (flag + active + `multiLocAllowed` — eligibility).
Pattern: when one boolean is doing visibility + mode + permission at once, that's
a smell — they have different inputs and diverge the moment a new account exists.

### Owner channel enrollment: display reads by `account_id`, runtime keys by `business_id` → multi-location desync
[2026-05-22] (WhatsApp go-live PR #53) The `/settings/channels` page hydrates
org-default enrollments by `account_id` (with `location_id IS NULL`), but every
runtime path — the `/api/dashboard/channels` status GET and the owner
start/cancel/disable routes for SMS/Telegram/WhatsApp — keys by
`business_id = user.locationId` (`user.primary_location_id`). An org-default
`channel_enrollments` row carries the `business_id` of whoever created it. On a
multi-location account with ≥2 owners on different primary locations, owner B sees
the channel "connected" on the page (matched by `account_id`) but the status API
returns nothing → Disconnect 404s, Connect trips
`channel_enrollments_account_channel_scope_uniq` (migration 034 keys uniqueness on
`(account_id, channel, COALESCE(location_id, sentinel))`, NOT `business_id`) →
classified as `EnrollmentDatabaseError` → 500.

Root cause: org-level owner enrollment is an **account-scoped** resource
(`location_id IS NULL`), but the read/write paths address it by the legacy
per-location FK. Single-location accounts are immune (`business_id` always ==
`primary_location_id`). Pre-existing; affects SMS + Telegram identically — the
WhatsApp work just mirrored the pattern and surfaced it. Interim guard:
WhatsApp owner self-service gated to single-location accounts. Correct fix
(separate task): key the org-default paths by `(account_id, channel, location_id
IS NULL)`. See `docs/known-issues.md` +
`docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`.

### Catching only AuthError but returning 401 for everything masks server errors
[2026-05-22] The owner WhatsApp routes wrapped `requireRole(req, 'owner')` in a
try/catch that returned `AuthError` → its `statusCode`, else a blanket
`401 unauthorized`. But `requireRole` can throw non-`AuthError` (e.g. a DB/Supabase
failure during the auth lookup) — those were being reported to the client as 401,
hiding real 5xx incidents behind a "not authenticated" response. Fix: in the
fallback, `throw err` so unexpected failures surface as a 5xx. Pattern: a catch
that maps a specific typed error should re-throw everything else, not collapse all
errors into the typed error's status. (Same anti-pattern still lives in the
Telegram/SMS owner routes — pre-existing, tracked for a follow-up.)

### Account-scoping a shared helper requires updating ALL call sites — TS + mocked tests won't catch a miss
[2026-05-22] When `cancelTelegramEnrollment` / `disableTelegramEnrollment` /
`cancelWhatsAppEnrollment` changed signature from `(sql, businessId)` to
`(sql, accountId)`, both parameters were `string`. TypeScript did not flag the 3
admin call sites (`admin/channels/telegram/{cancel,disable}`,
`admin/channels/whatsapp/cancel`) that still passed `businessId`. Mocked route tests
didn't catch it either: the queue-based `sql` mock ignores the WHERE predicate and
returns queued rows regardless of the argument value.

The bug would have silently no-op'd admin cancel/disable in production:
`WHERE account_id = <businessId>` → no matching row → 0 rows updated → the route
returned 200 as if it succeeded.

Lesson: when changing a shared helper's parameter semantics while keeping the same
type, grep ALL callers (`grep -rn 'helperName('`) before considering the change
complete, and fix every one. Consider using a branded type (e.g. `type AccountId =
string & { __brand: 'AccountId' }`) so the compiler catches mismatches at the next
type change.

---

## 2026-05-24

Discovered while standing up GitHub Actions CI (Spec 24 task 0, branch `ci-keystone`).

### `MOCK_EXTERNAL_APIS=true` in CI breaks the Zernio real-path tests
The first CI run failed 16 tests in `src/lib/zernio/__tests__/client.test.ts`,
`worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts`, and the zernio
e2e/correlation tests — all green locally. Cause: the CI env block set
`MOCK_EXTERNAL_APIS=true`, and `src/lib/zernio/client/transport.ts` returns a
**mock transport** when that var is `'true'`. So tests that inject their own
`fetch` and assert real timeout/error-classification never ran the real path
(symptoms: `vi.fn() called 0 times`, `promise resolved {reviews:[]} instead of
rejecting`). The suite is designed to run with the flag **off** — individual
tests flip it to `'true'` themselves only where they exercise the mock path
(`client.test.ts:406,488`). `.env.local` has `MOCK_EXTERNAL_APIS=false`, which
is why it was green locally.
**Correct approach:** CI must set `MOCK_EXTERNAL_APIS=false` (mirror `.env.local`).
Tests never hit the network anyway (injected mocks / `vi.mock`), so `false` is safe.

### `new Request()` has no `.cookies` — use `NextRequest` in route tests
After fixing the above, CI still failed with unhandled rejections from
`src/app/api/account/settings/__tests__/route.test.ts`:
`TypeError: Cannot read properties of undefined (reading 'getAll')` at
`src/lib/db/auth.ts:37` (`request.cookies.getAll()`), thrown from inside
GoTrueClient's async `_emitInitialSession`. The test built `new Request(url)` (a
Web `Request`, which has **no `.cookies`**) and cast it to `any`; the Supabase
SSR cookie adapter then blew up in a background promise, so assertions passed but
vitest failed the run on the unhandled error. Latent locally because real
`.env.local` Supabase creds took a different `getUser()` path.
**Correct approach:** route tests must use `NextRequest` (from `next/server`),
which carries a real cookies store (`getAll()` → `[]`), matching how routes are
actually invoked.

### Never validate CI from a git worktree nested inside the parent repo
Running `pnpm lint`/`pnpm test` inside `.worktrees/<x>/` (a worktree physically
nested under the main repo) gives false failures: ESLint walks up and finds the
parent's `.eslintrc.json` (plugin conflict), and Node/vitest resolve up into the
parent's `node_modules`, creating duplicate module instances
(`useLocationScope must be used within a LocationProvider`, mocks not
intercepting). These do NOT reproduce on a standalone CI checkout.
**Correct approach:** validate CI by pushing and reading the GitHub run, or clone
to a clean dir outside the repo. Don't trust local lint/test from a nested worktree.

### Branch protection on a private repo needs a paid plan → use a ruleset under an org
Both classic branch protection (`PUT .../branches/main/protection`) and
repository rulesets (`POST .../rulesets`) return `403: Upgrade to GitHub Pro or
make this repository public` on a **private repo on the Free plan**. An org
"Pro" purchase on a *different* account doesn't help — the plan must be on the
**repo owner**.
**Correct approach:** transfer the repo to an org on a paid plan (Team), then
apply a **repository ruleset** (not classic protection) with
`required_status_checks` + `deletion` + `non_fast_forward`. After transfer,
re-point Vercel/Railway GitHub App access to the new org and update the git
remote (GitHub redirects the old URL, but update it anyway).

### Dependabot groups must split majors from minor/patch
Grouping by `dependency-type` alone (all prod together, all dev together) bundles
breaking majors with safe patch/minor bumps, so the grouped PR is permanently red
whenever any dep ships a major (here: Next 16 removed `next lint`; a TypeScript
major broke CSS side-effect imports with `TS2882`).
**Correct approach:** add `update-types: [minor, patch]` to each group so majors
are excluded and arrive as individual, reviewable PRs.

---

## 2026-05-25

Discovered building the Step 1 keystones (`codex/step-1-keystones`, PR #81):
`accounts.past_due_at`, the generalized account audit helper, and worker-side
PostHog activation capture.

### A "posted" response has FOUR transition sites — an activation hook on one misses the rest
`responses.status = 'posted'` is set in four places, not one: the main publish
success path (`ResponsePublisherWorker.ts`), the edit-then-publish success path
AND the `409_matches` path (`edit-publish.ts`), and the idempotent 409
reconciliation path (`publisher-error-handlers.ts`). An "emit on first posted
response" event attached only to the main path silently under-counts activation
for accounts whose first post lands via edit-publish or reconciliation.
**Correct approach:** funnel every posted transition through ONE shared
chokepoint (`worker/jobs/publisher/activation.ts`,
`maybeCaptureActivationCompleted`) and test that all four paths reach it. Before
adding any "on publish" side effect, grep for every `status = 'posted'` UPDATE.

### Best-effort telemetry runs AFTER tx commit — return a candidate, don't capture inside the tx
The publish status flip happens inside a transaction; the PostHog call is
network I/O that must not run before/inside the commit. The edit-publish path
returns an *activation candidate* from the tx outcome (`{ outcome: 'completed',
postedResponse }`) and the caller captures it only after the tx commits. Pattern:
decide-inside-tx, fire-after-commit for any external side effect gated on a
just-committed row.

### `shutdownAnalytics()` must be flushed on worker shutdown — and guarded so it can't skip DB teardown
`posthog-node` batches events and flushes on a timer; events captured shortly
before a Railway redeploy are lost unless flushed on SIGTERM. Wire
`shutdownAnalytics()` into `worker/index.ts`'s `shutdown()` after the workers
close (so no new events enqueue mid-flush) and **wrap it in try/catch** — a flush
network failure must never skip the `sql.end()` that follows. Generalizes the
existing "post-completion best-effort blocks need their own try/catch" note to
the process-lifecycle teardown.

### A best-effort helper should own its never-throws contract; callers shouldn't double-wrap
`maybeCaptureActivationCompleted` swallows + logs all errors internally and
never throws. Once that contract is documented on the function, the outer
try/catch at each call site is dead code — remove it and let the one internal
catch enforce "analytics never blocks outbox completion." Tests that mock the
helper to *throw* then contradict the contract; cover the never-throws guarantee
once where it lives, not at every caller.

### A dynamically-built `new RegExp(...)` trips external ReDoS scanners even with hardcoded inputs
A migration-structure test built `new RegExp(\`...${name} ${type}\`)` from a
hardcoded `it.each` array. No project analyzer flags it (eslint is just
`next/core-web-vitals`), but external security scanners flag any interpolated
`new RegExp` as ReDoS. Don't add a disable directive for a rule the project
doesn't run — **remove the root cause**: assert with a whitespace-normalized
`.toContain(...)` substring check instead of a dynamic regex.

### `noUncheckedIndexedAccess` makes array-index reads `T | undefined`
`mockFn.mock.invocationCallOrder[0]` is typed `number | undefined` under this
tsconfig flag, so passing it to `.toBeLessThan()` fails `tsc`. After asserting
the mock was called, a non-null assertion (`...[0]!`) is correct and idiomatic
in this repo (cf. `mock.calls[0]![0]`). `pnpm test` passing does NOT imply
`pnpm typecheck` passing — run both.

---

Discovered building Wave 1 — foundation / launch-risk
(`codex/wave-1-foundation-launch-risk`, PR #85): tenant-isolation proofs,
billing reconciliation, security/PHI, legal accuracy, approval snapshot.

### `postgres.TransactionSql` has no `.begin` in its types — make the outbox helper caller-owned
Tried to make `openPhiReviewException` atomic by wrapping its two INSERTs in
`db.begin(...)`, where `db: typeof sql | TransactionSql`. `tsc` failed:
`Property 'begin' does not exist on type 'TxClient'`. Postgres.js exposes
`.begin` on the base `Sql` but NOT on `TransactionSql` (savepoints work at
runtime, the type omits them).
**Correct approach:** the *caller* owns the transaction — each call site wraps
`await sql.begin((tx) => helper(tx, ...))` and the helper takes the handle and
uses it only as a tagged template. Matches the entry-point invariant
(orchestration owns the tx boundary). The reconcile path already passed a `tx`,
so only the 3 top-level-`sql` callers (webhook worker, backfill worker,
recent-review poller) needed wrapping.

### PHI scanning must gate EVERY ingest path — `processReview` is the real chokepoint, not just `insertImportedReview`
The spec anchored "scan before `insertImportedReview`," but new (unanswered)
reviews persist through `processReview`, and the recent-review poller's
unanswered branch called it with no PHI gate — a live steady-state path
(`ZERNIO_PUBLISHING_ENABLED=true`) shipped unguarded in the first cut.
**Correct approach:** gate before persistence on all four paths (webhook,
backfill, recent-poller, reconcile). Conversely, do NOT double-gate:
`reconcileExternallyAnsweredReview` already runs `detectLikelyPhi` before each
import branch, so a "move the check above reconcile" review suggestion was
*rejected* — it would skip reconcile entirely for PHI-flagged replied reviews
and break the supersede-stale-responses logic.

### A conservative PHI regex must use co-occurrence, not bare medical keywords
First-cut patterns matched bare `patient|treatment|therapy|surgery|medication`,
which quarantined ~8/9 normal reviews for RepWorth's own target verticals
(dentists, vets, spas, PTs) — "Dr. Smith was *patient*", "great massage
*therapy*". Because PHI blocks persistence, that silently breaks ingestion for
those customers.
**Correct approach:** require co-occurrence — a self-reference
(`i|me|my|we|our`) AND a medical-context term — plus the well-scoped MRN /
insurance-identifier patterns (identifier + digits). Quarantine for operator
review, never silent-delete.

### Billing reconciliation must compute expected invoice from STORED quota, not live `TIER_CONFIG`
A reconciler that derives "expected" overage from live `TIER_CONFIG` false-alarms
on every grandfathered account (Stripe reflects the price the sub was created
at).
**Correct approach:** expected overage uses stored `accounts.locations_included`
+ `accounts.locations_overage_price_cents` (point-in-time); base is the lone
exception (`TIER_CONFIG.baseCents`, no stored column). Prefer
`currentBillingSnapshot()` over rebuilding the math.

### `ON CONFLICT DO NOTHING` + an unconditional alert = alert spam on every re-ingest
`openPhiReviewException` fired `Sentry.captureMessage` before checking whether
the `INSERT ... ON CONFLICT DO NOTHING` actually created a row, so a review
re-seen each poll cycle re-alerted forever.
**Correct approach:** gate the alert AND the follow-up outbox enqueue behind a
non-empty `RETURNING` — only a newly created exception notifies.

---

## 2026-05-26

Discovered building + reviewing Wave 2 — Activation (`codex-wave-2-activation`,
PR #87): analytics queue, past-due recovery, MFA, support + impersonation.

### Unconfigured PostHog must not burn an analytics row's retry budget
The dispatch poller treated `captureAnalyticsEvent() === false` (the documented
no-op when `POSTHOG_API_KEY` is unset) as a retryable failure. Each poll
incremented `attempts`; within `max_attempts` every queued row walked to
`status = 'failed'` — and the pending index excludes `failed`, so once a key was
finally added the **entire activation funnel was permanently lost**. A test had
even codified the bug.
**Correct approach:** if analytics isn't configured the poller **early-returns
and claims nothing** (rows stay `pending`, fully recoverable). Config/transient
failures *defer* (revert the claim's `attempts++`); only genuine per-event errors
exhaust the budget. `flush`-before-mark-`completed` so a `completed` row was
actually delivered, not just buffered; drain the in-flight batch on shutdown.

### One past-due recovery clock, read DOWN, and clamp future timestamps
`checkSubscription` measured the 7-day grace from `businesses.updated_at`, so any
unrelated write to the business row silently shifted the grace window.
**Correct approach:** `computePastDueRecoveryState(account)` is the **single**
source consumed by both the UI and the worker guard, anchored on
`accounts.past_due_at`. `daysRemaining` must `Math.floor` (not `ceil`) or the
banner over-promises by up to a day; a **future-dated** `past_due_at` (clock skew)
must be **clamped to now** (full grace), not treated as instant read-only.

### Grant-extension `expires_at` must be `max(graceDeadline, now) + days`
`parseExtension` discards any extension with `expires_at <= now`. `now + days`
is a no-op *inside* the window; `past_due_at + grace + days` is a no-op for an
**already-locked-out** account (lands in the past → discarded → stays read-only
while the route returns 200 + writes a "granted" audit row). The customer who
contacts support is the locked-out one.
**Correct approach:** `max(past_due_at + grace, now) + days*DAY` — future in both
cases.

### Impersonation: reap expired sessions, re-check AAL2 on the view, no session swap
"One active session per actor" was a partial UNIQUE index on `(actor_user_id)
WHERE ended_at IS NULL` — but nothing sets `ended_at` on TTL expiry (the `/end`
route needs the now-evicted cookie), so a lapsed session **permanently 409'd**
new starts. AAL2 was also only checked at start, not on the view loader that
renders customer PII.
**Correct approach:** `startImpersonationSession` reaps expired-but-unended rows
before the active-session pre-check; the view loader re-checks current AAL2;
view-as is admin-owned (no Supabase session swap — server-only service-role reads
scoped by `account_id`, never the service key at the `src/proxy.ts` edge).

### Every public table needs RLS — a new table without it is anon-readable
Migration 046 created `analytics_events` without `ENABLE ROW LEVEL SECURITY` — the
only table-creating migration that skipped it. In Supabase a public-schema table
without RLS is reachable via the anon PostgREST API, exposing
`account_id`/`user_id`/`business_id` + event properties.
**Correct approach:** enable RLS (deny-all, no policy) on every new table; server
reaches it via the RLS-bypassing `postgres` role. Fixed in migration 049.

### Durable analytics facts are server-emitted; only intent events are client-postable
`/api/analytics/enqueue` validated against the full allowlist, so anyone could
POST `activation_completed`/`first_response_drafted` and forge the funnel. And a
client-fired `gbp_connect_started` got an anonymous `distinct_id` while
`gbp_connected` is account-keyed, so the per-account funnel couldn't join.
**Correct approach:** gate the client route to `CLIENT_ENQUEUEABLE_EVENT_NAMES`
(intent only); capture `gbp_connect_started` server-side in the connect start
route (account-scoped, like `gbp_connected`); the client only reports failures.

### The `lint` CI job is eslint **and** the tenant-scope audit (two steps)
A green ESLint does not mean the `lint` job passes — `pnpm ci:tenant-scope` runs
as a second step. Editing a tenant-table query's SQL (adding a column/JOIN)
silently **breaks its allowlist `sqlSnippet` match**, surfacing as a paired
"unused allowlist entry" + "missing scope" finding; the first CI run of a
long-lived branch surfaces accumulated drift at once.
**Correct approach:** when a tenant-table query changes, update its allowlist
snippet to the new normalized SQL (or drop the entry if the query is now
inline-scoped), after verifying each flagged query is genuinely safe. Run
`pnpm ci:tenant-scope` locally, not just `pnpm lint`.

---

## 2026-05-26 — Wave 3 (Visibility & AI Safety, PRs #93–#96)

### A logger must never throw
The JSON logger (`src/lib/shared/logger.ts`) serializes object args and
`JSON.stringify`s the record. A cyclic/unserializable arg would throw — from a
**log call**, potentially inside an error path, masking the original error or
crashing a worker.
**Correct approach:** fail open. Wrap the arg sanitize and the final
`JSON.stringify` in try/catch; on failure emit a safe placeholder
(`{ unserializable: true }`). A log call must be incapable of throwing.

### Bind log context at the registration boundary, not per handler
Threading request/job IDs into every `logger.*` call by editing each handler is
huge churn and easily drifts.
**Correct approach:** an `AsyncLocalStorage` context (`log-context.ts`) + a
`withJobLogContext` wrapper applied at the BullMQ `new Worker(queue, handler)`
registration (`worker/job-log-context.ts`). Handlers are untouched; every log
line they emit inside the run automatically carries the job's IDs. Pollers
(non-job loops) are out of scope for that wrapper — bind them separately if
needed.

### Moderation must fail open, never silently approve
The optional OpenAI Moderation provider call can error or time out. If a
moderation failure threw (or returned "clean" on error), unsafe text could pass.
**Correct approach:** local regex rules always run first and stand alone; the
provider is additive and gated behind `OPENAI_MODERATION_ENABLED`. On a provider
error, fall back to the local decision and record `openai_moderation: 'error'` —
never throw, never downgrade a local flag. (`src/lib/moderation/moderate.ts`.)

### Holding an unsafe draft must stay atomic with the response write
A high-severity flagged draft must NOT send the owner notification, but the
response still persists as `pending_approval`. Doing the notification-skip
outside the response transaction would risk a partial state where a flagged
draft still got notified.
**Correct approach:** in the SAME `persistResponseAndNotify` transaction, write
moderation fields to `api_costs`, insert the `flagged_responses` row, and skip
the `send_notification` outbox enqueue — all or nothing. The no-auto-posting
invariant stays intact: flagging only removes the notification, never posts.

### A long-lived audit FK can block a prune (`ON DELETE SET NULL`)
`flagged_responses` is an audit record that outlives the `api_costs` row it
points at; `api_costs` is pruned at 90 days by the ArchivalPoller. A default
(RESTRICT) FK on `flagged_responses.api_cost_id` would make that prune fail with
a FK violation once a referenced cost row aged out.
**Correct approach:** `api_cost_id UUID REFERENCES api_costs(id) ON DELETE SET
NULL` (column nullable). The flag survives, the cost-row pointer nulls out, the
prune proceeds.

### Untrusted values inside a delimited prompt block must be escaped
Wrapping review text in a `<review>…</review>` data block is good, but
interpolating `reviewerName`/`reviewText` raw lets a malicious `</review>` close
the block early and smuggle instructions.
**Correct approach:** escape `&`/`<`/`>` on the untrusted string fields before
interpolation (`escapeForReviewBlock` in `prompt-builder.ts`) so an embedded
`</review>` renders inert as `&lt;/review&gt;`. (Numeric/controlled fields like
`starRating`/`date` can't carry markup, so they don't need it.)

### A stale `.next/` breaks `pnpm typecheck` after a branch switch
`.next/types/validator.ts` is generated by `next build`/`dev` and is **not**
switched by git. After moving from a branch that has a route (e.g. PR 1's
`/api/health`) to one that doesn't, the stale validator references a missing
module and `tsc` (which includes `.next/types/**`) errors on a file you didn't
touch.
**Correct approach:** `rm -rf .next` and re-run `typecheck`. A fresh `pnpm
build` regenerates it for the current branch.

---

## 2026-05-27 — Wave 3 (PRs 4–6: eval harness, sentiment, KPIs, finance + review fixes)

### `tests/llm-eval/*` must use relative imports, not the `@/` alias
The eval harness runs under `tsx` (`pnpm eval:llm`), and **tsx does not resolve
tsconfig `paths`** — `@/lib/...` fails at runtime. Existing CI scripts
(`scripts/ci/*.ts`) already import relatively for the same reason.
**Correct approach:** inside `tests/llm-eval/`, import via relative paths
(`../../src/lib/moderation/output-filter`). Relative paths resolve under both
`tsx` and Vitest; the `@/` alias is src-only convenience.

### A `vi.mock` path is relative to the TEST file, not the module under test
The eval live-runner test mocked the generator at `../../src/...` (copied from
the runner's own import), but from `tests/llm-eval/__tests__/` that resolves to
`tests/llm-eval/src/...` — wrong, so the mock didn't intercept.
**Correct approach:** count hops from the test file. From a `__tests__/` dir one
level deeper than the module, the mock path needs one extra `../`
(`../../../src/...`). Verify the mock actually intercepts (assert the mocked fn
was called) — a non-intercepting mock makes the test pass against the real impl.

### A dynamic `await import('./x')` is still type-checked — it can't forward-reference a missing module
`run.ts` referenced `./live-runner` (built in a later task) via dynamic import,
assuming TS wouldn't resolve it. `tsc` DOES resolve dynamic-import specifiers, so
it errored. Bridging with `@ts-expect-error` is worse: once the module exists the
directive becomes an "unused" error, and an unrelated `as` cast left behind masks
real type drift.
**Correct approach:** build modules in dependency order, or accept the type error
until the dep lands — don't paper over it. Heavy deps are still isolated behind
the dynamic import (offline stays keyless) without any suppression.

### A deterministic backfill must use the SAME formula as the runtime classifier
Migration 052 backfills `reviews.sentiment_*` in SQL while the ingest path
classifies in TS. If the two diverge, backfilled and newly-ingested rows
disagree.
**Correct approach:** keep one mapping (star→label/score). Making the v1
classifier **star-only** (no text heuristics) let the SQL `CASE` and the TS
`classifySentiment` be provably identical; `sentiment_source` is the seam for a
later text/LLM classifier. The migration-structure test + a classifier unit test
each assert the shared table.

### Sentiment must be set at EVERY review-content write site, not just `processReview`
Review content is written at three sites: the NEW insert and the content-changed
UPDATE in `process-review.ts`, **and `insertImportedReview` in
`zernio-ingest-shared.ts` which bypasses `processReview` entirely** (external-reply
path). A classifier hooked only into `processReview` silently leaves imported
reviews unclassified.
**Correct approach:** grep every `INSERT INTO reviews` / content `UPDATE reviews`
(there are exactly 5; 3 write content, 2 are status-only) and wire the classifier
at all content-write sites. Same lesson as the "four `posted` transition sites"
note — a value set at one of several write sites misses the rest.

### A typed-error catch must re-throw others; service calls need their own boundary
`/api/dashboard/kpis`'s `requireRole` catch mapped **all** non-`AuthError`
failures to 401, masking infra faults as auth errors; and the KPI service calls
had no try/catch, so a DB error escaped uncaught.
**Correct approach:** in a catch that maps a specific typed error, re-throw/500
everything else (a DB failure during auth is 5xx, not 401); wrap the
data-fetch section in its own try/catch returning a clean logged 500. (Repeats
the 2026-05-22 "catching only AuthError" note — it recurs on every new route.)

### A new owner data endpoint must replicate the subscription read-entitlement gate
`/api/dashboard/kpis` enforced auth + IDOR but not subscription status, so a
cancelled/unpaid owner could still read KPIs. Auth ≠ entitlement.
**Correct approach:** gate owner data reads on `subscriptionAllowsDashboardRead`
(`active` or `past_due` grace) **before** computing anything, mirroring
`/api/dashboard`. Extracted as a shared predicate in
`src/lib/shared/subscription-status.ts` so the rule has one home.

### Validate a client-supplied UUID before the `::uuid` DB cast (400, not 500)
`?scope=not-a-uuid` flowed into a `WHERE id = ${x}::uuid` query → Postgres
invalid-UUID error → 500. (Same latent bug still in `/api/dashboard` — tracked as
issue #103.)
**Correct approach:** `isValidUuid()` (`src/lib/shared/ids.ts`) the
client-controlled id before the DB read and return a controlled 400.

### A rate metric's numerator and denominator must share one population
`flaggedRatePct = flagged_count / generation_count`, but `flagged_count` counted
flags across **all** providers while `generation_count` was openai/anthropic-only
— a population mismatch (equal today only because non-LLM rows are never flagged).
**Correct approach:** scope both to the same set (`FILTER (WHERE provider IN
('openai','anthropic') AND flagged)`). Audit every rate's two halves for the same
WHERE.

### A `pg_constraint` existence guard must be scoped to its relation
`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...')` is unsafe —
`conname` is unique only per-table, so a same-named constraint on another table
false-matches and skips the `ADD`.
**Correct approach:** join `pg_class`/`pg_namespace` and filter
`relname = 'reviews' AND nspname = 'public'`.

### The queue-Proxy `sql` mock needs its call index reset on re-seed within a test
A test that seeds rows, calls the service, then re-seeds and calls again read
**past the cursor** (the counter wasn't reset) — the second call got empty rows,
so assertions passed vacuously.
**Correct approach:** reset `sqlCallCounter.value = 0` (and the results array)
inside the `seed()` helper so every seed is a fresh queue. Watch for tests whose
second assertion happens to equal the "empty" result — they hide this.

### A new endpoint must not couple a pre-existing one's success to its own query
`/api/admin/costs` ran `getCostReport` and the new `getMarginReport` in one
`Promise.all` with a single 500 catch — a fault in the new finance query would
take down the long-standing cost report.
**Correct approach:** make the new/secondary data **best-effort** —
`getMarginReport(...).catch(() => null)`, return `margin: null`, keep the
required data's failure as the 500. The consumer already guards a missing margin.

### tenant-scope allowlist `sqlSnippet`s break on ANY query-text change — and recur
Every time a tenant-table query's SQL changed in PRs 5–6 (adding sentiment
columns, the `flagged` provider filter, the TTR `status <> 'deleted'` clause) the
allowlist `sqlSnippet` stopped matching → the paired "unused entry" + "missing
scope" finding. Admin cross-account aggregates (margin, flagged queue) are
**intentionally** unscoped and allowlisted with a `requireRole('admin')`
rationale.
**Correct approach:** after editing any allowlisted query, re-run
`pnpm ci:tenant-scope` and sync the snippet to the new normalized SQL (verify the
query is still genuinely scoped/admin-gated first). Expect this on nearly every
SQL edit to a tenant table.

### A branch off `main` can sweep PR4's untracked report artifacts via `git add -A`
PR4 gitignores `tests/llm-eval/reports/`. The sentiment branch (off `main`, which
lacks that rule) had untracked report JSONs in the shared working tree; a
`git add -A` during an amend swept three into a commit.
**Correct approach:** `git rm` them + add the gitignore guard on the branch; a
file added-then-removed across a branch nets to absent in the PR diff. Prefer
explicit `git add <paths>` over `-A` when sibling branches' artifacts may be
loose in the tree.

## 2026-05-28

### Backtick-wrapped `tx`/`sql`/`db` in a comment silently breaks the tenant-scope audit
`scripts/ci/tenant-scope-audit.ts` extracts SQL by regex-scanning raw source text
for tag-template literals (tags `sql`/`tx`/`db` + any `sql` alias imported from
`db/server`); it does NOT strip JS/TS comments first. A backtick-quoted tag word
in a comment (e.g. `(`tx`)` in a doc-comment) is read as the OPENING of a template
literal, and the parser consumes up to the next real backtick — SWALLOWING the SQL
template that follows. The swallowed query is then never audited (a silent
tenant-scope COVERAGE GAP), and any allowlist entry for it reports "unused entry".
Bit PR #124: a new `edit-publish-tx.ts` header comment — "runs on an already-open
transaction (`tx`)" — swallowed `supersedeSibling`'s
`UPDATE responses ... WHERE id = ${siblingId}` → unused-entry → CI `lint` job
(`pnpm ci:tenant-scope`) failed; the file's `zernio_connections` UPDATE was
dropped from the audit too. Benign on `main` only because its lone backtick-`tx`
sat AFTER the query.
**Correct approach:** never put a backtick-wrapped `tx`/`sql`/`db` in a comment in
a `src/` or `worker/` file — write "the tx handle" / "via sql" instead. Extractor
hardening (strip comments before tag-scanning) tracked in issue #125. (Safe to use
such backticks in `.claude/`, `docs/`, etc. — only `src/` + `worker/` are scanned.)

### Moving an allowlisted query to a new file orphans its allowlist entry
Allowlist entries are keyed by FILE + table + normalized snippet, so relocating a
tenant-table query (extraction/refactor) leaves the old entry "unused" and the new
file uncovered. `pnpm lint` is `eslint src` — it does NOT run this audit and does
NOT cover `worker/`, so a moved-query break passes local `lint` but fails the CI
`lint` job (which also runs `pnpm ci:tenant-scope`).
**Correct approach:** when SQL moves between files, repoint the entry's `file` and
run `pnpm ci:tenant-scope` (+ `ci:rls-audit`) — not just `lint`/`typecheck`/`test`.
