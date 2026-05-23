---
name: lab-notes
description: Chronological engineering discoveries, bug postmortems, and non-obvious API behaviors discovered during RepWorth development. Read this before touching any of the named libraries, APIs, or subsystems — these are real bugs that already burned time. Organized by date discovered.
---

# RepWorth — Lab Notes

Hard-won discoveries from production debugging and integration work.
Check the relevant section before implementing anything in these areas.

> **Worker file paths (as of 2026-05-05):** Class names referenced in
> these notes are stable — only file paths changed during the worker
> reorg. PR #18 additionally moved the BullMQ `'failed'` exhaustion
> handlers out of `worker/index.ts` into dedicated `failed-hook.ts`
> modules colocated with their workers. For the current location of
> any class, look at how it's imported in `worker/index.ts` (the
> runtime registry) or read `docs/directory.md`. Quick map for things
> mentioned below:
> - `OutboxPoller` → `worker/background/pollers/OutboxPoller.ts`
> - `CleanupAbandonedSignupsPoller` → `worker/background/pollers/CleanupAbandonedSignupsPoller.ts`
> - Ingest failed-hook: `worker/jobs/zernio/ingest-failed-hook.ts` (`handleIngestFailed`)
> - Publisher failed-hook: `worker/jobs/publisher/failed-hook.ts` (`handlePublisherFailed`)

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

### `gitignore /docs/*` means runbook updates ship but docs don't
`/docs/*` in `.gitignore` (per commit `b1d66f7`) means changes to
`docs/currents.md`, `docs/progresstracking.md`, `docs/directory.md` etc.
persist on disk but aren't committed. Only `docs/runbooks/*.md` are
tracked because they were added before the `/docs/*` rule landed and
ignore rules don't retroactively un-track tracked files.

When you edit one of the gitignored doc files, mention the limitation in
the commit message of any related commit so future readers know the
on-disk content may have drifted from any committed snapshot.

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
