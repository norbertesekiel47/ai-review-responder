# RepWorth — Lab Notes

Hard-won discoveries from production debugging and integration work.
Check the relevant section before implementing anything in these areas.

## Topic index

Jump to the dated entries by subsystem (search the anchors below):

- **Postgres.js / JSONB / PgBouncer** — JSONB string-wrapping, v3 double-encoding, statement_timeout, FOR UPDATE under PgBouncer; the AUTHORITATIVE production JSONB parse-site allowlist (2026-08-03); every error class reachable from a query carries a STRING `code` (`PostgresError`, `57014`, `CONNECTION_*`, Node `ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`) — narrow a swallow-catch on that shape, NEVER on `instanceof PostgresError`, which rethrows transient blips into the caller (#679, 2026-08-08)
- **Indexes / migrations** — STABLE-in-predicate, ON CONFLICT byte-for-byte, column-level REVOKE, pg_constraint relation scoping, CHECK passes NULL (pair NOT NULL + NULL-safe preflights), hung ALTER TABLE = lock queue behind a long-lived Supavisor session (cancel stalled backend, verify clean, retry); a hash column's invariant asserted only in a COMMENT is unenforced — pair it with a format CHECK (`token_hash ~ '^[a-f0-9]{64}$'`, migration 056's pattern) and mutation-verify it; `migration-immutability-guard.sh` keys on the migrations-log HEAD rather than "applied", so amending a local-only migration after the log bump is a guaranteed false positive (escape hatch `MIGRATION_GUARD_DISABLE=1` is launch-time only); a `CROSS JOIN LATERAL (SELECT EXISTS (…))` consumed by two `COUNT(*) FILTER`s does NOT share one evaluation — Postgres pulls the single-row LATERAL up and plans one correlated SubPlan per reference (~81–261× planner cost, ~137× buffers vs `LEFT JOIN … AND status='posted'` + `FILTER (WHERE p.review_id IS NULL / IS NOT NULL)`, which is the shape that ships), and never justify a SQL shape with an unverified planner claim in a comment (#731, 2026-08-09)
- **Zernio** — nested `account.id`, MOCK_EXTERNAL_APIS real-path tests, reviewReply normalization; the sandbox feed is non-descending in practice — the consented import's dirty-ordering WARN + page-to-feed-end is the NORM on staging, not an incident (#675, 2026-08-06)
- **Stripe** — inbound_events payload shape, overage idempotency, billing reconciliation from stored quota; `maxNetworkRetries: 0` still retries ONCE on ECONNRESET/EPIPE (stripe-node 22.2.0 `_shouldRetry` — under-lock worst case ≈ 2× the per-call timeout, #514)
- **Supabase auth** — implicit-flow OTP, identities:[] for existing emails, auth_id vs users.id, SMTP rate limit, a client-wide fetch timeout also bounds identity MUTATIONS → split bounded/unbounded clients (#508)
- **Billing / multi-location** — stored-quota vs TIER_CONFIG, base price not grandfathered, channel account-scope desync
- **Analytics / PostHog** — unconfigured no-op retry budget, durable vs intent events, RLS on new tables
- **Moderation / logging** — fail-open moderation, logger-never-throws (incl. AsyncLocalStorage binding for correlation IDs); `createWorkerLogger` OBJECT args pass through the analytics blocked-key sanitizer, which silently drops any key containing `token` — a deliberately-safe derived value (hash prefix, masked suffix, key id) must be NAMED to survive it (`hash_prefix`, not `token_hash_prefix`), and string args bypass the sanitizer entirely (#644)
- **Ingress / rate limiting** — the limiter's ingress-scope test needs BOTH arms: `request.routeOptions.url` (post-routing, resolved) and `decodeIngressPath(request.url)` (raw, decoded). Percent-encoded paths (`/%69ngress/resend`) defeat a raw check and absolute-form request targets (RFC 9112 §3.2.2) defeat the decoded one — either alone bypassed the limiter for Stripe, Resend, Telegram, Twilio and Zernio alike. A statutory opt-out route is exempt by design (§9.2), and the exemption must be read from the RESOLVED route config so an unmatched path under the prefix cannot inherit it (#644)
- **CI / tooling** — nested-worktree poisoning, MOCK_EXTERNAL_APIS=false in CI, tenant-scope allowlist drift, comment-backtick extractor false-positive, allowlist file-move orphaning, worktree test-failure vs real regression (verify on the same ref), nested-worktree Edit/Write path leak + concurrent branch/stash churn (explicit `git add`, /tmp patch, re-verify HEAD before commit), Railway RAILPACK build has no `.git` so git-touching `prepare`/`postinstall` scripts must be `|| true`, Fallow `fallow-ignore-next-line` is single-line (directive + reason on ONE line or it suppresses the next *comment*, not the code) + `--gate new-only` resolution conventions (delete genuine dead code, `usedClassMembers` for interface dispatch, inline `complexity`, `duplicates.ignore` for divergent clones); `ci:db-imports` AST guard — STRICT composition-root allowlist with registration-derived worker roots (flipped from a checked-in baseline in A+ campaign PR 3; shipped as PR 1a); fallow CRAP is inflated repo-wide because the coverage input excludes integration suites → integration-only-covered code reads as ~0% covered and accrues PHANTOM complexity debt that decomposition cannot clear (#581); a `verify-gate.sh` run whose row COUNT shrank is DISARMED (missing `.feature/intake.json`), not faster — it still prints GREEN; a gate row must be a CHECK never a MUTATION — `pnpm test:db:setup` DROPs schema `public`, so declaring it in `verification_commands` races the parallel fan-out and produces a spurious RED; never author a fallow suppression from a PREDICTION (an export whose only consumer is a live-DB suite is not dead code, so the marker itself fails as `stale suppression`); `estimated_diff_size` must budget production and TEST lines separately or `reclassify` fires on exactly the DB-contract features whose 4:1 test ratio is designed; the post-merge promotion sweep does NOT need the main checkout — park `.feature/intake.json` and `git checkout -b <docs-branch> origin/main` in the shipping worktree itself (same checkout satisfies containment, no intake satisfies arming), and branch off `origin/main` never local `main`, which lags after every squash merge; `feature-cleanup.sh` derives `MAIN_ROOT` from its cwd, so run from inside a feature worktree it skips that worktree and silently cleans nothing (#644); a verify-gate GREEN branch can still fail CI's fallow job — `ci:fallow*` is deliberately outside the local gate, so run `npx fallow audit --gate new-only --base origin/main` before opening a PR whose diff added mirrored/parallel blocks, and remediate on merit not suppression (#675, 2026-08-06); `git merge --ff-only main` CANNOT fast-forward `staging` after a squash merge and `git cherry` is the wrong check (patch-ids do not survive squashing) — use `git diff --stat staging origin/main`, then reset + `--force-with-lease` (#679, 2026-08-08); staging is behind Vercel team-SSO AND app auth, so any smoke crossing a Next.js route needs the owner's browser — worker/Railway ingress stays scriptable, so split the smoke list by surface before estimating it (#679, 2026-08-08); a gate row's NAME is also its status slot, its `.feature/logs/<name>.log` and its coverage dir, so the old 40-char truncation could report PASS for a FAILED suite — `row_slug` (`scripts/gate-rows.sh`) truncates for readability and identifies by an appended hash, and `launch()` asserts uniqueness at registration (#696, 2026-08-08); a "is it wired?" test asserting SOURCE TEXT is the same defect class as the bug it guards — extract to a sourced library, or `eval "$(sed -n '/^fn() {/,/^}/p' script.sh)"` to run the REAL body; keep text assertions for genuinely textual properties and write them as patterns not literals (#696, 2026-08-08); `exit` in a SOURCED bash file kills the caller — a library signals, the entry point decides, and the entry point's abort path is defined BEFORE the `source` line; follow every `source` with a `command -v <symbol>` guard or a failed load resurfaces as exit 127 misread by the call site (#696, 2026-08-08); under `set -u` on **bash 3.2** (what `/usr/bin/env bash` is on macOS) `"${ARR[@]}"` on an EMPTY array is fatal — use `${ARR[@]+"${ARR[@]}"}` (#696, 2026-08-08); in a guard module whose PROSE is its spec, an absolute written about a narrow text-presence check ("`unlocked-ddl` can never fire") is itself a false claim — say what the code literally does and mutation-prove each claim BEFORE writing it, and expect the documentation to be its own cost centre, since `reclassify` fires on prose volume no heavier lane control can address (#706, 2026-08-08); `verify-gate.sh` resolves `TEST_DATABASE_POOL_URL` but NOT `DATABASE_POOL_URL`, so a changed integration suite that transitively imports the `src/lib/db/server` singleton dials vitest.setup's dummy `localhost:5432` — export BOTH vars to the test DB when invoking the gate (fallow.yml CI already exports both); permanent fix is #744 (#728, 2026-08-09); NEVER measure a feature's diff — or a collision check against an open PR — against `origin/main`: use `git merge-base origin/main HEAD`, because `main` moves mid-run and the inflation is indistinguishable from genuine scope creep at exactly the moment `reclassify` asks you to judge it (bit the same run twice: a fake revert on a stale branch, then a fake 15× overshoot); a grep gate that forbids an identifier forbids it in PROSE too (scope it to code with `rg … | rg -v '^\S+:[0-9]+:\s*//'`); `ci:tenant-scope` cannot tell you the snippet it wants (`TenantScopeFinding` has no SQL field — derive it by reusing the audit's own `extractSqlTemplates` + normaliser; five regenerations 420→418→414→412→409→408 have hit this); under concurrent subagent dispatch commit with a pathspec (`git commit -m … -- <files>`), never bare `git add` + `git commit` (#731, 2026-08-09)
- **Solicitation / CSV ingest** — the `csv_ingest` advisory-lock contract covers status transitions only: the offboarding purge hard-DELETEs `contact_csv_uploads` unlocked, so `writeTerminalUploadState` deliberately TOLERATES a 0-row terminal write rather than asserting (#582); the batch builder pools every contact of the business, so a staging smoke's funnel never equals its own CSV; `useReviewedPing` is `visibilityState`-gated so background automation never writes `reviewed_at`; the Suppression ledger's §1.2 lookup has ONE owner (`suppressionMatchSql`) and its `channel` is a PARAMETER on both reader and writer — a hardcoded literal on one side fails OPEN the day the channel enum grows (#643); the offboarding token scrub matches on `account_id` alone so its account-leading index is usable, with the `business_id` arm kept only in the purge VERIFIER as a cross-account tripwire
- **Worker startup / Sentry** — the production startup asserts (`assertAlertSinkEnv` / `assertAdminNotificationEmail` / Stripe) early-return unless `NODE_ENV==='production'`, so a prod env that omits `NODE_ENV` silently disables the whole boot-safety layer (set `NODE_ENV=production` AND `SENTRY_DSN` together); Fallow reason-placement refinement (2026-06-20); unlistened EventEmitter `'error'` on any Queue/Worker/ioredis client = fatal uncaughtException → `attachEmitterErrorLogger` + per-source suppress window (#508)
- **Live-DB test suites** — a live-DB **suite** must be named `*.integration.test.ts` (that glob is what puts it in vitest's serialized `integration` project), and no live-DB **file** — suite or `__tests__/` helper — may execute DDL at run time: DDL's ACCESS EXCLUSIVE locks deadlock sibling suites whenever `verify-gate.sh` runs vitest in CONCURRENT PROCESSES, where in-process serialization does not reach (#573); provision with `pnpm test:db:setup`, assert with `assertSchemaReady`. Detection is AST extraction of EXECUTED SQL, not a text marker (#694, 2026-08-08 entry), over every `.ts`/`.tsx` under `__tests__/` rather than the suites alone — a helper can BUILD a DDL fragment a suite splices in, and reaches the DB by importing `postgres` (#706, 2026-08-08 entry). Two lock-enforced allowlists — migration-**shape** files and **DDL-probe** suites — must hold `acquireLiveDbLock` AND roll back any unconditional re-apply (a committed re-apply of an old migration reverts a later one on the shared DB); statically-invisible safety takes `-- live-db-ddl-ignore: <reason>`; force a transaction abort with `helpers/abort-injection.ts`, never a temporary constraint. Unsetting `TEST_DATABASE_POOL_URL` does NOT sleep the suites — `.env.local` disk fallback (#563, 2026-08-03 entry) — but `pnpm vitest run <file>` does NOT hydrate it, so a suite gated on it SKIPS silently (#694)
- **False coverage / mutation** — a test that passes whether or not the bug exists is the dominant defect mode on guard-shaped work; a fix for an "X is untested" finding must ITSELF be mutation-pinned or it reproduces the defect (happened twice in consecutive rounds at #679, and ~10 instances there were caught by mutation, none by reading); a JS `throw` does not poison a Postgres transaction, so savepoint-recovery tests need Postgres-side abort injection (#679, 2026-08-08)
- **Testing** — vi.hoisted for shared mocks, NextRequest vs Request, relative imports under tsx, compat re-export must shield all consumers (mock-contract), memoized `getServerConfig()` ignores late `process.env` mutation (set env before first access or mock the accessor; `flags.ts` reads live on purpose), `AbortSignal.timeout` runs on Node's internal timers — vitest fake timers can't advance it (real timers + injectable small timeout, #508), module-scope `llmCircuitBreaker` singleton leaks state across suites that mock the SDKs but drive the real `runLlmTask` → `reset()` in `beforeEach` (#515), `app.inject()` NORMALISES the request target so an inject-only suite is structurally blind to anything about the raw request line (absolute-form targets, malformed targets) — a surviving mutant there means dead logic OR a harness blind spot, so reach for a real-socket `net.connect` test before deleting a security-adjacent branch (#644); before merging or reshaping a query, enumerate THREE categories of dependent assertion — tests that (i) count queries, (ii) dispatch on query text, and (iii) IDENTIFY a query by text then constrain its contents; (iii) is the one that bites, and never verify a type-level guarantee by grepping for the enclosing function name (TS anchors structural-assignability errors at the offending literal and names the TYPES — `TS2741` one missing property, `TS2739` several) (#731, 2026-08-09)
- **Frontend / CSS / brand** — iOS Safari rounded-island clip is `overflow:hidden`+`border-radius`+retained `transform` (not a sibling clip), reproduce an audit's CSS cause before trusting it; flag-driven copy swaps on dead-end features mislead; an admin "act on stuck items" panel needs a real outbox-backed route (2026-05-29 launch readiness)
- **Owner offboarding** — `railway up` from a worktree ships stale worker code (`OutboxPoller: Unknown topic`); Stripe Basil/Dahlia moved `current_period_end` onto the subscription item; `approval_audit_log` has no `approval_link_id`/`user_agent` (mock-asserted SQL *text* hid the drift); keep-my-data must be exempt from the blanket `/api/account/*` owner-API proxy gate; the `purge_after` token-expiry trigger blocks shrinking the purge window while a keep-my-data token is live
- **Worker crash-net / cost-guard** — crash-net rejection classification (strict recoverable-DB allowlist vs billing's broad transient check, transient-rejection governor); cost-guard fail-open limiters + pre-LLM reservation retry matrix (transport retryable, budget terminal, finalize never job-retried), Upstash SPOF; a cache whose KEY a replacement job can legitimately share must bind its PAYLOAD to content provenance — the `(reviewId, version)` idempotent-generation cache served a stale draft to live-ingest's same-version replacement job and deterministically defeated the #728 persist gate (#728, 2026-08-09)
- **Vercel BotID / WAF** — client/server `checkLevel` must match or it fail-blocks legit traffic (single source of truth); only protect a route that has an in-app token-bearing caller (dead/external callers get 403'd, invisible to preview/mocked tests); Deep Analysis is billed → gate it behind auth, not just the forgeable same-origin header; WAF custom rules have no committable config (the runbook is source of truth); the staging custom env is preview-TYPE so a production-only WAF condition excludes it

---

## 2026-04-09

### Postgres.js NUMERIC/DATE decoding (not the JSONB carve-out)
- [2026-07-25] Competitor Delta digest compared `snapshot_date === currentDate`
  and every location degraded to the teaser branch → Postgres.js decodes DATE
  columns to JS `Date` objects, so `===` against a string is always false; unit
  tests with string fixtures cannot catch it → select `snapshot_date::text` and
  keep DATE values strings end-to-end, plus pin the query shape in the suite
  (`expect(query.text).toContain('snapshot_date::text')`). Caught in PR #570
  review; same family as the timestamptz-µs lab note.
- [2026-07-25] Postgres.js returns **NUMERIC as a JS string** (precision
  preservation) — `competitor_snapshots.rating NUMERIC(2,1)` reads back as
  `"4.8"`, not `4.8`. Any consumer must `Number(...)` at the read boundary.
  This is NOT the PgBouncer JSONB carve-out (different decoder, applies
  everywhere) — do not add such sites to CLAUDE.md's JSONB allowlist.

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

- [2026-08-08] **The UI half of this pair is RETIRED — do not resurrect it for
  this feature.** #678 deleted `PAST_REPLIES_VIEW_ENABLED` (spec
  `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.3a
  S4). WHAT WOULD HAVE FAILED → once the **Reviews list** became the consented
  **Review import**'s only destination, a `false` view flag would have let
  `import_decision='accepted'` coexist with the imported reviews landing on a
  `notFound()` — the owner consents to an import they can then never see. WHY →
  a *destination* surface cannot be independently revocable from the write that
  targets it; the two flags stopped being orthogonal the moment consent pointed
  at the page. CORRECT APPROACH → the Reviews list renders unconditionally and
  `EXTERNAL_REPLY_IMPORT_ENABLED` alone governs the import (no silent-soak
  window any more — turning it on shifts "total responded" and surfaces the rows
  in one step). The surviving flag, `EDIT_REPLIES_ENABLED`, gates the
  live-Google *mutation*, which is a genuinely separable and larger risk;
  `editRepliesEnabled()` in `src/lib/past-replies/flags.ts` is its only reader.
  The dual-flag pattern above still holds for write-vs-expose pairs that stay
  orthogonal — it does not hold when one flag can 404 the other's output.

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

### Postgres.js does NOT parameterise every tagged-template substitution — a nested `Query` is spliced as raw SQL
Widely assumed the opposite, and #694 shipped a code comment asserting it before
review round 2 disproved it live:

```ts
await sql`${sql.unsafe('select 42 as n')}`   // → [{ n: 42 }]
```

A bind parameter can never be a statement, so that result is proof. Postgres.js
inspects each substitution: a plain value becomes `$n`, but a nested `Query`
(anything built by `sql`…`` or `sql.unsafe(...)`) is spliced into the SQL TEXT via
`fragment()`. That is what makes composable fragment builders work
(`primaryTrackedKeywordSql`, `publisherSubscriptionEligibleSql`), and it is the
same mechanism an injection would ride.

**Two consequences.** (1) "It's a tagged template, so it's parameterised" is not a
safety argument — check whether the substitution is a value or a `Query`. (2) Any
static analysis over SQL text must treat a fragment as SQL that executes
SOMEWHERE ELSE than where it is written; `ci:live-db-suites` gets this right only
because its AST walk visits the *producing* node — which is why #706 had to widen
its file set to every `.ts`/`.tsx` under `__tests__/`, since a producing node in
an unscanned file is a node it never visits. It remains blind to a fragment built
outside `__tests__/` altogether.

### An exact count written into a comment is a maintenance trap
#694's audit header cited "770 of 1201 templates" to justify not using a
tag-name allowlist. The figure went stale THREE times inside a single feature:
wrong when written, corrected to 1469 by review round 1, invalidated again by the
*other* round-1 fix commit (which added one `sql()` template), and a fourth
recount split 80-vs-78 on whether `NOT_LIVE_DB` exclusions count. Each correction
was itself reviewed and still landed wrong.
**Correct approach:** state the load-bearing CLAIM, which drift cannot falsify
("`sql()` is the plurality of tagged templates, ~770 of ~1470"), mark it a
point-in-time census, and record the method so a reader can recount instead of
trusting the number. Reserve exact figures for things a test asserts — if no test
pins it, it will rot, and a precise wrong number is worse than an honest
approximate one.

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
- [2026-07-02] Same trap, line-pinned flavor: local `pnpm lint` is ESLint-only — CI's lint JOB also runs the audit scripts; when a file with `file:line` allowlist pins shifts (e.g. `static-policy-audit`'s `src/lib/dashboard/types.ts` pins after an edit above them), run the audits explicitly (`pnpm ci:static-policy` etc.) and re-pin.

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

### Backtick-wrapped `tx`/`sql`/`db` in a comment broke the tenant-scope audit (RESOLVED #125, PR #149)
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
**RESOLVED (#125, PR #149, commit `51dc796f`):** `extractSqlTemplates` now strips
JS/TS comments before the tag-scan, via a char state machine that leaves `//` and
`/*` inside string/template literals intact. A backtick-wrapped `tx`/`sql`/`db` in a
comment no longer opens a phantom template, so the "never write a backtick tag in a
comment" workaround is no longer required.
**Residual limitation (noted during PR #149 review):** the stripper does NOT model
JS regex literals or nested template interpolation. A `'` or `` ` `` inside a regex
literal placed before a tagged SQL template could still mis-track state and drop the
query — both are rare in scanned `src/`/`worker/` files, but if the audit ever
reports a baffling "unused entry", check for a regex literal upstream.

### Moving an allowlisted query to a new file orphans its allowlist entry
Allowlist entries are keyed by FILE + table + normalized snippet, so relocating a
tenant-table query (extraction/refactor) leaves the old entry "unused" and the new
file uncovered. `pnpm lint` is `eslint src` — it does NOT run this audit and does
NOT cover `worker/`, so a moved-query break passes local `lint` but fails the CI
`lint` job (which also runs `pnpm ci:tenant-scope`).
**Correct approach:** when SQL moves between files, repoint the entry's `file` and
run `pnpm ci:tenant-scope` (+ `ci:rls-audit`) — not just `lint`/`typecheck`/`test`.

### A worktree test failure can be a real regression, not the nested-worktree leak
The nested-worktree `node_modules` leak (CLAUDE.md "CI & repo") is real, which makes
it a tempting catch-all whenever tests fail inside a `.claude/worktrees/` checkout
but "pass in a clean checkout." During PR #130 I dismissed 11 `generator.test.ts`
failures as the leak — they were a genuine regression. The trap: I compared the
worktree (MY branch) against a clean checkout sitting on `main` (WITHOUT my change),
so "passes clean, fails in worktree" looked environmental when it was really "passes
on `main`, fails on my branch." CI on a clean clone of the BRANCH failed identically
— the decisive signal I should have trusted first.
**Correct approach:** to separate an environmental artifact from a real bug, run the
SAME ref in both places (or just read the branch's CI on a clean clone). "Passes on
the base branch" proves nothing about your change. Never reach for a known gotcha as
the explanation without reproducing it with one variable changed at a time.

### A compat re-export must shield ALL consumers, not just the externally-owned one
When you extract a module and leave a re-export shim on the OLD module for
back-compat, repointing even ONE in-house consumer at the NEW module breaks every
test that mocks the OLD module to neutralize that consumer's side effects. PR #130
extracted `concurrency-guard.ts` from `costs/tracker.ts` (shim left on `tracker`) and
repointed `cost-guard.ts` at the new module. `withCostGuard`'s consumers
(`generator.ts`, `review-summary.ts`) have tests that `vi.mock('@/lib/costs/tracker')`
to stub the guard — once `cost-guard` sourced the slot fns from `concurrency-guard`
(unmocked), those tests hit the real `getCacheRedis()` ("Connection is closed.").
Reverted; `cost-guard` stays on the shim like every other consumer.
**Correct approach:** while the shim exists, keep ALL consumers on it; migrate them
together — and update their test mocks to the new module — in one follow-up once the
shim is removed. A consumer's import path is part of the test-mock contract of
everything that exercises it.

### Nested-worktree work: tool path-resolution leak + concurrent branch/stash churn
Two failure modes hit the parallel-agent channel-scope fixes (PRs #132/#133/#135),
both rooted in `.claude/worktrees/<x>` living UNDER the main repo. (1) A subagent
spawned with its own worktree had Edit/Write resolve file paths against the PARENT
repo working tree, not its worktree — it "wrote" files into the main checkout, then
detected the drift, captured diffs as patches, reverted main, and re-applied onto its
worktree branch. (2) Across a long session the MAIN checkout's branch + `git stash`
stack were mutated by concurrent work: HEAD moved off the fix branch onto an unrelated
branch and the in-progress edits were auto-stashed ("WIP (preserve)"); the stash stack
also reordered between two `git stash show` calls. Net effect: an "Edit succeeded"
result followed by a "file modified since read" / reverted-content reminder is NOT
proof your change landed on the branch you think you're on.
**Correct approach:** for multi-step edits in a worktree/contended tree —
(a) CI on the pushed branch is the only authoritative lint/test signal (never trust
local runs from a nested worktree; CLAUDE.md "CI & repo");
(b) re-verify `git rev-parse --abbrev-ref HEAD` immediately before EVERY commit;
(c) `git add` files by EXPLICIT path, never `-A`/`.`, so a stray concurrent change
(e.g. unrelated legal edits) can't ride along;
(d) snapshot risky WIP to a `/tmp` patch (`git diff -- <files> > /tmp/x.patch`) so a
branch switch or stash reorder can't lose it;
(e) commit small and often rather than holding a large uncommitted WIP.

## 2026-05-29 — Launch readiness (Parts 1 & 2)

### iOS Safari clips the rounded island — `overflow:hidden` + `border-radius` + retained `transform`, NOT the sibling clip the audit assumed
The 2026-05 launch audit (part 2, doc since retired) reported that `.rw-island { overflow:hidden }` was
clipping the **fixed dot-nav + parallax** on iOS. That diagnosis was wrong: the
dot-nav and parallax are *siblings* of `.rw-island`, not descendants, so they were
never inside its clip box. The real bug (PR #161) is the well-known **iOS Safari
repaint glitch**: a box that has `overflow:hidden` **and** a `border-radius` **and**
a retained `transform` (the marketing island holds `scale(1)` via a `both`-fill
animation; the auth island animates `transform` on intro) intermittently fails to
re-clip its own rounded corners on repaint, so content bleeds past the radius.
**Correct approach:** fix the *property*, not the assumed sibling. Remove
`overflow:hidden` from the island root; where a child genuinely needs to clip a
full-bleed pane (the auth `.rw-showcase` gradient), give *that* child its own
`border-radius` + `overflow:hidden` so it self-clips. A Vitest contract test
(`src/__tests__/island-overflow.test.ts`) now asserts no `.rw-island` block — root
or `@media` — re-declares `overflow:hidden`. Lesson: when an audit hands you a
plausible CSS cause, reproduce the clip with one variable changed at a time before
trusting the stated mechanism.

### An admin "act on stuck items" panel needs a real backend route + outbox transitions, not a frontend-only button
`ZernioConnectionPanel` carried a `TODO(zernio)` for force-drain/dismiss buttons on
the awaiting-reconnect queue. There was **no backend** to wire them to —
`awaiting_owner_connect` is only ever *set* by `zernio-publisher.ts`; nothing drained
or dismissed it on demand. Adding buttons first would have been a dead end. The real
fix (PR #185, blocker #23b) is an admin-only `POST
/api/admin/businesses/[id]/zernio-queue` that **force-drain** re-fires the existing
`drain_pending_owner_connect` → `DrainOwnerConnectWorker` (gated on
`ZERNIO_PUBLISHING_ENABLED` + active connection) and per-response **dismiss** →
`superseded` (`posting_error='admin_dismissed_awaiting_connect'`), each writing
`account_audit_log` in the **same transaction**, mirroring `grant-extension`/`flagged`.
**Correct approach:** before adding a control to a panel, confirm the state machine
has a real, audited transition to drive it — and reuse the existing outbox worker
rather than inventing a second drain path. Invariant #3 stays intact because these
are post-approval drafts and the publisher's subscription guard still applies.

### A flag-driven "reason swap" on a feature with no owner-facing path either way is misleading — show one honest, flag-independent message
The owner SMS row swapped its "coming soon" copy based on `CHANNELS_SMS_ENABLED`, but
there is **no owner self-service SMS path either state** (SMS enrollment is
admin-only). So flipping the flag changed the *words* without changing what the owner
could actually do. PR #176 de-scoped owner SMS to post-launch: the row now shows one
honest, flag-independent "SMS notifications are coming soon", and the dead owner-UI
plumbing (`smsAvailable()` + `initialAvailability.sms`) was removed. The flag's real
consumers (worker dispatch, admin enrollment, factory, boot assertion) were left
untouched. **Correct approach:** a feature flag should gate real behavior; if both
branches dead-end at the same place, delete the branch and the plumbing rather than
dressing it up.

## 2026-06-04

### Railway RAILPACK builds have no `.git` → a git-touching `prepare` script breaks the deploy
A `prepare: "lefthook install"` script (added to install git hooks on `pnpm
install`) passed local installs, GitHub CI, and Vercel — but **failed the
Railway worker build**. Railway's RAILPACK builder runs `pnpm install
--frozen-lockfile --prefer-offline` in a build context with **no `.git`
directory**, so `lefthook install` aborts with `fatal: not a git repository`
(exit 128) → `prepare` Failed → `[ELIFECYCLE] Command failed with exit code 1`
→ `Build Failed`. The previous image keeps running (no live outage), but every
subsequent Railway deploy is blocked until it's fixed. GitHub CI (`actions/checkout`)
and Vercel both build from a git checkout, so neither reproduces it — **CI green
does NOT prove a Railway-safe install.** **Correct approach:** any
`prepare`/`postinstall` that shells out to git must be deploy-safe —
`prepare: "lefthook install || true"`. Hook installation is a local-dev
convenience; never let it abort a production install. To reproduce the failure
locally, run the installer from a dir with no `.git` (`cd $(mktemp -d) &&
node_modules/.bin/lefthook install; echo $?` → 1).

## 2026-06-06

### The auto-approval kill switch is read at worker *boot*, so you can't test the §6 downgrade with a "flip mid-flight" race
`autoApprovalRuntimeEnabled()` reads `process.env.AUTO_APPROVAL_ENABLED`, and Railway
injects env at **process start** — so a running worker keeps its boot-time value until
it **restarts**. Trying to test the publisher kill-switch downgrade by auto-approving a
review and then flipping the flag mid-flight just **posts**: the old process publishes
within seconds, long before a redeploy boots a flag-off process. On a real connected GBP
that is a real reply you didn't want. **Correct approach (post-safe):** set
`AUTO_APPROVAL_ENABLED=false` on the worker *first*, then make the publisher process an
already-`approved` `auto_policy` row while the flag is off — seed a *test* review's
response to `approved`/`auto_policy` + insert its `publish_response` `job_outbox` row in
one tx; the running (flag-off) publisher hits the kill-switch and **downgrades instead of
posting** (`status='pending_approval'`, `posting_error='auto_policy_revoked_by_kill_switch'`,
re-notify). Documented in the runbook appendix (`completed_runbooks/auto-approval-staging-test.md`).

### `psql` can't open the staging `DATABASE_POOL_URL` — it carries a Postgres.js-only `?pgbouncer=true` param
The Railway worker's `DATABASE_POOL_URL` ends in `?pgbouncer=true` (a Postgres.js
connection hint). `psql`/libpq rejects it: `invalid URI query parameter: "pgbouncer"`.
**Correct approach:** strip the query string and re-add only `sslmode=require`
(`"${url%%\?*}?sslmode=require"`), or use the direct `DATABASE_URL`. Pull the value
**unprinted** (`railway variables --kv | grep '^DATABASE_POOL_URL=' | cut -d= -f2-`) so the
credential never lands in the terminal.

### Vercel staging is behind Deployment Protection (SSO) — automation/CDP browsers can't log in
`staging.repworth.net` returns `401` and redirects to `vercel.com/login`; the Google SSO
step then refuses an automation-controlled (DevTools-protocol) browser ("this browser may
not be secure"). **Correct approach:** use a **Protection Bypass for Automation** token —
navigate once to `…?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true` to
set the bypass cookie, then the app's own **email/password** login works in the automated
browser. Don't try to complete Vercel/Google SSO inside the controlled browser.

---

## 2026-06-08 — Owner offboarding (staging dry-run + live E2E)

### `railway up` from a nested git worktree ships STALE worker code → `OutboxPoller: Unknown topic`
Deploying the staging worker with `railway up` from `.claude/worktrees/<name>/` produced a running
worker **missing the offboarding queue wiring** — the boot banner had none of the five offboarding
pollers, and the billing job failed in the outbox with
`Unknown topic: account_offboarding_billing_schedule`, stalling every offboarding job. The
fix-branch source was correct (`worker/queues.ts` registers all five offboarding topics in
`topicToQueue` unconditionally), so this is a deploy artifact, not a code bug. **Correct approach:**
deploy the worker from a **clean clone** outside the worktree —
`git clone -b <branch> file://<repo> /tmp/deploy && cd /tmp/deploy && railway up -p <proj> -s repworth-worker -e staging --ci -y`. Same worktree footgun that aborts the Vercel CLI upload
(CLAUDE.md "Worktrees are footguns here"). Also: `railway logs` non-interactively returns a
stale/truncated snapshot — don't trust it to prove pollers booted; verify by driving a real job.

### Stripe Basil/Dahlia: `current_period_end` is on the subscription ITEM, not the top level
With the pinned `apiVersion: '2026-05-27.dahlia'` (Basil-era), `subscription.current_period_end`
(top-level) is **undefined**; the value lives at `subscription.items.data[0].current_period_end`.
Reading the top-level field threw and stranded `cancel_only` at `failed/billing` (dry-run D1).
**Correct approach:** `items.data[0].current_period_end ?? subscription.current_period_end` (item
first, legacy top-level fallback). A unit mock that returned the field top-level hid this; the
regression test feeds the real item shape.

### `approval_audit_log` has NO `approval_link_id` / `user_agent` columns
The purge scrub + verification referenced two phantom columns; Postgres rejects them at **plan
time** (`column "approval_link_id" … does not exist`) regardless of row count, so every
`delete_data` purge failed and data was never deleted (dry-run D3). The real PII columns are
`response_id, token_hash, device_cookie_hash, ip_address, metadata, actor_user_id,
response_text_at_approval`. NB: `account_audit_log` (a different table) legitimately HAS
`ip`/`user_agent`/`request_id` — scrub those there. **Lesson:** the unit tests asserted the scrub
**SQL text** (and even asserted the phantom columns present), so the drift sailed through CI — add a
real-DB integration test that runs the production scrub/verification against the live schema.

### keep-my-data must be EXEMPT from the blanket `/api/account/*` owner-API proxy gate
`isProtectedOwnerApiRoute` matched `/api/account/*` and trapped the public, token-authenticated
`/api/account/offboarding/keep-my-data`, so a logged-out owner clicking the rescue link in their
email got `401` (dry-run D2). **Correct approach:** a `PUBLIC_OWNER_ACCOUNT_API_PATHS` exemption
checked **before** the `/api/account/` prefix (the route validates its own raw token), mirroring the
`/admin/login` exemption. Sibling `confirm`/`reactivate`/`status` stay owner-gated.

### Shrinking `purge_after` for a test is blocked while a keep-my-data token is live
`enforce_account_offboarding_purge_after_token_expiry` rejects setting
`account_offboardings.purge_after` earlier than an **active** keep-my-data token's `expires_at` (a
good safety invariant). To exercise purge end-to-end on staging, **revoke/expire the token first**
(`UPDATE account_offboarding_tokens SET revoked_at=NOW() …`), then `UPDATE … SET purge_after=NOW()`.

## 2026-06-09 — Billing compliance hardening

### A pinned Stripe `apiVersion` does NOT pin webhook payload shapes
`new Stripe(key, { apiVersion })` only fixes the version for **outbound** API calls this client makes.
Inbound **webhook** event payloads are shaped by the version set on the Stripe Dashboard **endpoint**,
which is independent. **Correct approach:** keep `STRIPE_CLIENT_CONFIG.apiVersion`
(`src/lib/payments/stripe-client.ts`) and the Dashboard endpoint version in lockstep, and treat the
endpoint version as a launch-gate item with staging evidence — not something the code pin guarantees.

### Stripe `tax_behavior` is immutable once set; `tax_code` lives on the Product, not the Price
You cannot "update tax_behavior" on a Price that already has it set to inclusive/exclusive — only a
Price whose `tax_behavior` is still `'unspecified'` is updatable; otherwise you must **create a new
Price**. And the SaaS tax code (`txcd_10103001`) is a **Product** field, not a Price field. **Correct
approach (launch gate):** set `Product.tax_code`, then per Price update-if-unspecified-else-recreate;
pre-revenue, recreate-from-scratch is the zero-ambiguity option.

### Changing a tier price = new Stripe Price ID + env lockstep; existing customers are grandfathered
A Stripe Price `unit_amount` is immutable, so a price change means a **new Price object**. RepWorth
grandfathers via the stored snapshot on `accounts` (`base_price_cents` / `locations_included` /
`locations_overage_price_cents`, migration 054, invariant #9a) — billing reads those, not live
`TIER_CONFIG`. **Correct approach:** the documented procedure in `env-vars.md` — new Price → point
`STRIPE_PRICE_*` at it in dev+staging+prod lockstep → match `TIER_CONFIG` → `pnpm verify:stripe-prices`.
New signups/tier-changers get the new price; existing subs keep theirs. Repricing *existing* customers
is a separate cohort migration + ARL §17602(g) notice (out of scope). `TIER_CONFIG` and the Stripe
`unit_amount` are two copies of one fact with no runtime assertion — `verify:stripe-prices` is the guard.

### Dahlia preview-invoice lines expose `pricing.unit_amount_decimal`, not `price.unit_amount`
The reconciliation drift sum (`undiscountedLineAmountCents` in `billing-reconciliation/drift.ts`) reads,
in order, `price.unit_amount` → `pricing.unit_amount_decimal` → `subtotal` → `line.amount`. On the pinned
`2026-05-27.dahlia` version, real lines populate `pricing.unit_amount_decimal` (the legacy `price` shape
is absent), and tax surfaces on `subtotal`/`amount`. **Correct approach:** the tax-safety regression test
must model the Dahlia shape AND carry tax-inflated `subtotal`+`amount` the function must ignore (returns
pre-tax 7900, not 8612) — testing only the legacy `price.unit_amount` path wouldn't guard the real path.

### `pnpm lint` only covers `src/` — `worker/` TS is not ESLint-linted
The `lint` script is `eslint src`, so unused imports / lint issues in `worker/**` are caught only by
`pnpm typecheck` (tsc), not by lint. **Correct approach:** after migrating worker code, rely on typecheck
for worker files (and eyeball them); don't assume a green `pnpm lint` vetted the worker tree.

### Mocking Postgres.js `sql` in a Vitest unit: `vi.mocked(sql)` keeps the typed tagged-template signature
`vi.mocked(sql).mockResolvedValueOnce([{…}])` is rejected by TS because the typed tagged-template return
(`RowList`/result-meta) doesn't accept a plain row array. **Correct approach:** `const sqlMock = sql as
unknown as Mock` (runtime is the `vi.fn()` from `vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }))`),
then `mockResolvedValueOnce`/`mockReset` per case. Used in `quota.grandfathering.test.ts`.

## 2026-06-09 — Vercel BotID + WAF (Slice 2 rate-limit hardening, PR #257)

### BotID client/server `checkLevel` must match, or it fail-blocks real users
Vercel BotID verification fails if the client `initBotId` and the server `checkBotId` advertise a DIFFERENT `checkLevel` for the same path — and a failed verification can block legitimate traffic. FAIL → real users 403'd by config drift. WHY → the client challenge and server check must agree on the level. CORRECT → derive BOTH sides from ONE isomorphic list (`src/lib/security/botid-routes.ts`); never hand-write the level in a route. A test pins the exact path→level contract.

### Only BotID-protect a route that has an in-app, token-bearing caller
BotID's client SDK only attaches its challenge token to fetches made FROM the instrumented app. A route reached by a native `<form>` POST, a server-to-server call, or an external/separate frontend carries NO token → `checkBotId` returns `isBot:true` → 403. FAIL → we nearly shipped enforce-now BotID on `/api/contact` + `/api/demo-request`, which are dead "public-lead remnants" with no in-app caller (`book-a-demo` posts to `/api/lead-intake`; `help/contact` has no form) — it would have 403'd any surviving external caller, and preview + unit tests (which MOCK `checkBotId`) cannot catch it. CORRECT → before protecting a route, grep for its in-app `fetch` caller; if none, don't protect it, and add a test asserting unprotected paths are NOT registered.

### BotID Deep Analysis is billed → gate it behind cheap guards AND auth
`checkLevel:'deepAnalysis'` runs ML scoring at ~$1/1000 calls; Basic is free. Calling it before a route's cheap rejections wastes money on traffic that would be rejected anyway. `assertSameOrigin` is NOT sufficient gating — the Origin header is forgeable by a script. FAIL → `onboarding/start` ran the Deep call before its auth 401, so session-less scripted noise burned Deep $. CORRECT → put `botIdBlockResponse` AFTER the feature-flag/same-origin guards AND (on an auth-gated route) after the 401, so Deep fires only for a confirmed session.

### `botIdBlockResponse` fails OPEN on infra error, throws on unregistered path
Mirrors the app-wide rate-limit posture: if the BotID platform check itself ERRORS (API blip, missing OIDC token) we log + return `null` (allow), so a BotID outage doesn't 500 signup/login for everyone — the route's own rate limits + the WAF still apply. But an UNREGISTERED path THROWS (programmer error surfaced loudly, not swallowed as fail-open). Resolve the per-path options OUTSIDE the `try` so the throw isn't caught.

### Vercel WAF custom rules have NO committable config file
There is no `vercel.json` field for WAF custom rules — they are Vercel platform state (staged drafts → `vercel firewall publish`). FAIL → expecting to commit them as code. CORRECT → the runbook (`docs/runbooks/vercel-waf-rate-limiting.md`) is the authoritative, version-controlled representation; its `vercel firewall rules add` commands reproduce the rule set, and "if a live rule changes, change it here too."

### Staging custom env is preview-TYPE → don't add a production-only WAF condition
RepWorth is one Vercel project; the staging Custom Environment is **type `preview`** (branch `staging`). A WAF rule with `{"type":"environment","op":"eq","value":"production"}` therefore EXCLUDES staging. FAIL → a "target production" condition silently leaves staging unprotected. CORRECT → omit the environment condition so the rule covers prod + staging + previews alike (the only place an env condition belongs is the optional "test the flip in preview first" step).

## 2026-06-11 — Multi-location two-location full-loop sign-off run

Notes from driving the launch-gating full loop (Zernio webhook → ingest → real-LLM draft → owner approve → publish) for two locations against a local stack. Runbook: `docs/runbooks/multi-location-e2e-full-loop.md`.

### Zernio fixture's `publish_reply` MUST attach the reply to the stored review
The publisher does a post-publish verification (`worker/jobs/publisher/verify-posted.ts` → `verifyOwnReplyAttached`, added after the 2026-05-31 phantom-id false-positive): after `postReply` returns 2xx it re-reads the review via `listAllReviews` and requires OUR reply text to be `reviewReply.comment`. FAIL → the E2E fixture (`e2e/fixtures/zernio-fixture-server.ts`) recorded the `publish_reply` call but left the seeded review's `reviewReply: null`, so the re-read threw `ZernioReplyVerificationIndeterminateError(review_found_but_reply_null)` and EVERY full-loop response was marked `status='failed'` — the loop could never reach `posted`. CORRECT → `publish_reply` now attaches `reviewReply = { comment, updateTime }` to the matching stored review (mirrors real Zernio). Fixed + regression-tested in #273. Lesson: any fake provider that records a write must also REFLECT it on the next read if the worker verifies its own writes.

### A committed `tsx` launcher can't use top-level await (repo is CJS)
`package.json` has no `"type":"module"`, so `tsx`/esbuild transforms `.ts` to CJS, and top-level `await` throws `TransformError: Top-level await is currently not supported with the "cjs" output format`. FAIL → `e2e/fixtures/serve.ts` used a top-level `await startZernioFixtureServer(...)` + `await new Promise(...)`, so the documented `pnpm exec tsx e2e/fixtures/serve.ts` wouldn't start. CORRECT → wrap the body in `void (async () => { ... })()`; a listening HTTP server keeps the process alive without the trailing `await new Promise`.

### Running the real worker locally against isolated infra (mocks OFF) without touching shared services
To exercise `MOCK_EXTERNAL_APIS=false` safely, OVERRIDE every infra pointer to local before `pnpm worker` (the worker loads `.env.local` via `worker/env.ts` with dotenv `override:false`, so a prior `export` wins): `DATABASE_POOL_URL`/`DATABASE_URL` → local Postgres; `REDIS_QUEUE_URL=redis://localhost:6379/14` + `REDIS_CACHE_URL=redis://localhost:6379/15` (both ioredis-compatible; use HIGH db numbers to isolate from the dev worker's db0); empty `REDIS_QUEUE_TOKEN`/`REDIS_CACHE_TOKEN`; `ZERNIO_API_BASE=<fixture url>`; `GLOBAL_DAILY_COST_LIMIT_CENTS` low; empty `RESEND_API_KEY`/`SENTRY_DSN`/`POSTHOG_API_KEY` to silence real outbound. WHY isolate the CACHE specifically: the cost-guard writes the platform-wide `cost:global:{date}` key — hitting the real Upstash would skew the live circuit breaker. Also: a dev worker already holds **PORT 3001**, so run the test worker on a different `PORT` and point `WORKER_URL` at it.

### Get a webhook-signing secret from dotenv, not `grep`/`cut` — and sign in-process
`scripts/zernio-fire-webhook.sh` signs the body HMAC-SHA256 with `ZERNIO_WEBHOOK_SECRET`; the worker verifies with the dotenv-parsed value. FAIL → extracting the secret with `grep '^ZERNIO_WEBHOOK_SECRET=' .env.local | cut -d= -f2-` gave a mangled 118-char string (vs the real 32) → `401 invalid_signature`; capturing `pnpm exec tsx -e "...console.log(secret)"` into a shell var ALSO contaminated it with pnpm's banner. CORRECT → sign the webhook entirely in-process (a `tsx -e` that runs `dotenv.config({path:'.env.local'})` then `crypto.createHmac('sha256', process.env.ZERNIO_WEBHOOK_SECRET)` and POSTs) so the secret never round-trips through a bash variable.

### Approving a draft headlessly (no browser/CSRF) → `approveBySession`
The token-mode approval route is device-bound + CSRF-protected (awkward to drive without a browser). For a scripted/owner approval that faithfully runs the SAME core path (lock via `lockPendingResponse` → mark `approved`/`approval_method='owner'` → `enqueuePublishResponse` → audit), call `approveBySession(tx, responseId, businessId, { actorUserId, ipAddress }, correlationId)` from `src/lib/approval/session-mode.ts` inside `sql.begin`. (A tsx script that imports `@/lib/...` must run `dotenv.config({path:'.env.local'})` FIRST, or a transitively-imported Supabase client constructor throws `supabaseUrl is required`.)

---

## 2026-06-14 — Fallow CI (channels-rollout PRs #320 / #321)

Notes from making the `fallow` quality gate (`fallow audit --gate new-only --fail-on-issues --base origin/main`) pass for the auto-post FYI + channel work. Config: `.fallowrc.jsonc`. Related runbooks: `docs/runbooks/channels-rollout.md` (prod rollout), `docs/runbooks/channels-staging-smoke-test.md` (staging test).

### `fallow-ignore-next-line` is SINGLE-LINE — directive + justification on ONE comment line
The directive suppresses the source line IMMEDIATELY below it — and another `//` line counts as that "next line." FAIL → I wrote a multi-line block (directive on line 1, four more `//` justification lines, then the `export async function`), so the directive attached to the next *comment* line, not the function; the three `complexity` findings persisted and `fallow audit` stayed exit 1 even though the comment "looked" attached. CORRECT → put the directive AND its reason on one line: `// fallow-ignore-next-line complexity — <reason all inline>` directly above the target (matches the existing `approval-client.tsx` / `zernio/client/transport.ts` suppressions). Bonus gotcha: verify with the REAL exit code — `fallow … 2>&1 | tail; echo $?` prints `tail`'s exit (always 0), not fallow's; use `fallow … > log 2>&1; echo $?`.

### Resolving `--gate new-only` findings: fix the genuine, configure dispatch + divergent
Only `introduced:true` findings gate (inherited/pre-existing ones in a touched file — e.g. `postReplyAndHandleTerminalOutcomes` complexity — are excluded, so they need NO suppression). Conventions, all in `.fallowrc.jsonc`: (1) a genuinely-unused export → DELETE it (`buildAutoPostNoticeEmailHtml` was only used in-file); (2) interface-dispatched class methods reported "unused" because the `getChannel(id).sendX()` factory hides the concrete call → `usedClassMembers` scoped rule `{ "implements": "NotificationChannel", "members": [...] }` (one entry beats N inline comments); (3) inherent entry-point / one-pass-loop complexity → inline `complexity` suppression with a real justification; (4) deliberately-parallel-but-behaviourally-divergent clones → `duplicates.ignore` by file — ignoring ONE side of a 2-instance group drops it below `minOccurrences:2`. The envelope key is `.duplication` (not `.dupes`); per-finding `introduced` flags tell you which actually gate.

---

## 2026-06-20 — Beta-launch alerting gate (PR #354)

### Production startup asserts are gated on `NODE_ENV` — an env without it silently disables them
`worker/config/startup-assert.ts` guards `assertAlertSinkEnv` (the new `SENTRY_DSN` requirement), `assertAdminNotificationEmail`, and the prod branch of `assertStripeWorkerEnv` with `if (process.env.NODE_ENV !== 'production') return;`. FAIL → checking the Railway `production` worker env (still pre-launch) showed only 9 vars: no `SENTRY_DSN`, **and no `NODE_ENV`** — so if prod were deployed as-is, the entire boot-safety layer would no-op and the worker would boot happily without an alert sink (the exact silent-inert failure the gate exists to prevent). Staging was fine (74 vars, `NODE_ENV=production` + `SENTRY_DSN` set → gate active and passing, worker boots). CORRECT → when provisioning prod, set `NODE_ENV=production` **and** `SENTRY_DSN` together; treat "the prod safety asserts only fire when `NODE_ENV=production`" as a provisioning invariant, not an assumption. Verify presence without printing secrets: `railway variables -s repworth-worker -e <env> --kv | grep -c '^SENTRY_DSN='`.

### Fallow `fallow-ignore-next-line` reason: prefer the line ABOVE, not trailing the directive (refines 2026-06-14)
The 2026-06-14 note prescribes `// fallow-ignore-next-line <kind> — reason` all on ONE line. That passes the gate, BUT local fallow 2.86.0 tokenizes every word after `<kind>` as its own issue-kind and reports each as a **stale-suppression** WARNING (118 of them, from 4 prose-laden directives here) — noisy even though stale-suppressions are warn-level (exit stays 0). CORRECT (clean on any version) → put the rationale on the comment line(s) ABOVE and leave the directive bare: `// <rationale>` then `// fallow-ignore-next-line complexity` directly above the target. The directive itself is still single-line (the 2026-06-14 rule holds); just don't trail free text after the kind.

---

## 2026-06-22 — Card-up-front trial: bugs only a live staging E2E catches (PR #362)

Three real launch-blockers in the 30-day trial, ALL invisible to a 6-round plan grill + two Codex passes + a thermo-nuclear pass + a 5-agent heavy review — caught only by driving the real flow on staging (real Stripe test-mode Checkout, real onboarding). Meta-lesson: for **Stripe/billing and onboarding flows, code review reasons from *assumed* external behavior**; a live staging E2E is what verifies the assumption. Run it before flipping the flag.

### A $0 card-up-front trial Checkout reports `payment_status='paid'`, NOT `'no_payment_required'`
FAIL → the trial-start branch in `worker/ingress/stripe/checkout-completed.ts` gated on `session.payment_status === 'no_payment_required'` (Codex round 1 *assumed* trials arrive that way). On staging EVERY trial fell through to the inline paid-activation block and was misfiled `subscription_status='active'` with `trial_ends_at=NULL` and no `trial_started` event — owner saw no trial. The real `checkout.session.completed` (verified in `inbound_events`): `payment_status='paid'`, `amount_total=0`, `mode='subscription'`, while the Stripe subscription was genuinely `trialing`. WHY → with `payment_method_collection:'always'` (card up front), Stripe auto-finalizes the $0 `subscription_create` invoice as **paid**, so `payment_status` is `paid` not `no_payment_required`. CORRECT → detect a trial by the **$0 subscription-mode signal** (`session.amount_total === 0 || payment_status === 'no_payment_required'`), then confirm via the *retrieved subscription's* `status==='trialing'`; normal paid signups (`amount_total>0`) skip the extra Stripe retrieve. Every unit test passed because the fixture hard-coded `payment_status:'no_payment_required'` — fixture-vs-reality gap. Now the fixture mirrors the real `paid`/`amount_total:0` shape.
**Second bite (2026-07-22, #518):** a DIFFERENT check had the same whitelist — `trialContractMatchesLease` (same file) accepted only `'no_payment_required'`, flagged the real `paid` session `invalid_trial`, and `cancelUnexpectedSubscription` auto-cancelled the perfectly valid trialing sub → every card-up-front trial stranded `pending_payment`. Found live in the staging E2E (Phase A onboarding). Lesson upgraded: when touching trial contracts, `rg no_payment_required` and fix EVERY site — the guarantee is `subscription.status==='trialing'` + 30-day window + $0 invoice, never the session's `payment_status` alone.

### A trial can't onboard when `ONBOARDING_DEMO_ENABLED=true` (infinite redirect loop)
FAIL → dashboard "Set up business" ping-ponged `/onboarding/business → /onboarding/start → /dashboard`; the trial could never reach the wizard. WHY → `src/app/onboarding/business/page.tsx` set `demoFlowEnabled = (process.env.ONBOARDING_DEMO_ENABLED === 'true')` *unconditionally*. But the demo-mode wizard (Profile/Voice/Connect) assumes the location was captured at `/onboarding/start` during the **pre-pay demo**; a card-up-front trial skips that and arrives subscribed with **no location**, so the guard redirected it to `/onboarding/start`, which redirects subscribed (`subscriptionGrantsFullAccess`) accounts back to `/dashboard`. CORRECT → gate the flag on the location actually being present: `shouldUseDemoWizard(envEnabled, row)` in `guard.ts` (true only when `place_id_verified || google_maps_url`). A subscribed account with no location now gets the **non-demo wizard** (Location/Profile/Voice), which captures the location itself. The guard's `demoFlowEnabled` branch had **zero unit coverage** — that's why it slipped; added it.
**Second bite (2026-07-22, #519):** the page was fixed but `POST /api/onboarding/business` still read the RAW `onboardingDemoEnabled()` → the route took the post-pay branch, rejected the wizard's `googlePlaceId` with 409 `onboarding_not_started`, and the trial looped `/business → /start → /dashboard` again. The route now calls the same `shouldUseDemoWizard(flag,row)` helper as the page. Lesson upgraded: a flag-semantics fix is done only when EVERY reader of the flag goes through the one helper — grep the raw accessor after extracting it.

### Trial start must mirror `businesses.subscription_activated_at` or onboarding drips die for trials
FAIL → `apply-subscription-state.ts` `writeBusinessesMirror` wrote only `businesses.subscription_status`; the drip scheduler gates on `businesses.subscription_activated_at IS NOT NULL` and the drip worker hard-fails day_7/day_30 if null → no drips for any trial, even post-conversion. WHY → the trial path reaches the applier via `maybeStartTrial` and bypasses the legacy inline paid path (the only other writer of that column). CORRECT → the applier's businesses UPDATE sets `subscription_activated_at = COALESCE(subscription_activated_at, NOW())` on entering `trialing`/`active`, scoped to the primary business. (`accounts.subscription_activated_at` is the *service-start* anchor — set at trial start, drives the Zernio backfill gap/historical window; see `review-ingestion.md`.)

### Staging Stripe webhook was missing `invoice.payment_action_required` (the SCA event)
The staging endpoint subscribed to 5 of the 6 events the worker handles; `invoice.payment_action_required` (SCA-at-conversion → `past_due`) was absent, so that path would never fire. Audit the endpoint's `enabled_events` against the handler set (`worker/ingress/stripe.ts`) when standing up an env — and add the same event to the **prod** webhook before the flag flip.

### Stripe converts a trial (`trialing→active`) BEFORE the renewal charge fails → `trial_payment_failed` is effectively unreachable for a card decline
Verified live on staging with a `pm_card_chargeCustomerFail` test-clock sub. At trial end Stripe fires `customer.subscription.updated` (**`trialing→active`**) *first*, THEN creates the first real invoice, attempts the charge, and on failure emits `invoice.payment_failed` (→ `past_due`). The worker processes events in arrival order, so by the time `invoice.payment_failed` lands the account is already `active`. `invoice-payment-failed.ts` only emits `trial_payment_failed` on a **direct `trialing→past_due`** transition (its source-status guard), so a normal card-decline-at-renewal fires `trial_converted` (on the `→active` step) then a silent `active→past_due` — NOT `trial_payment_failed`. Net: the DB/entitlement state is correct (`past_due` + 7-day grace), but **conversion analytics are overstated** (`trial_converted` fires even when the conversion charge immediately fails) and `trial_payment_failed` only fires for the rarer direct paths (e.g. SCA `payment_action_required`). **FIXED (2026-06-22):** `invoice-payment-failed.ts` now also emits `trial_payment_failed` on an `active→past_due` failure when the account has a `trial_converted` analytics row from the **last 3 days** (= the conversion charge + its dunning retries, NOT a normal renewal months later). Keyed by `(accountId, stripeSubscriptionId)` so it's idempotent with — and dedupes against — the direct `trialing→past_due` path. So `trial_converted` still fires on the status transition, but **net conversions = `trial_converted` − `trial_payment_failed`** is now accurate. The `:status_change` advisory lock serializes the convert vs fail webhooks, so the `trial_converted` row is committed and visible when the failure arrives second. Lesson: Stripe's trial→active status change is NOT proof of payment — don't treat a `trialing→active` webhook as "successfully converted/paid."

### [2026-06-26] A transient Postgres statement-timeout took down the ENTIRE worker (postgres.js connection-layer unhandledRejection)
FAIL → on a staging boot the worker logged `OnboardingDripScheduler` "Scheduler cycle failed" (a caught error) and **then**, 3 ms later, a process-level `[worker] Fatal process-level error - exiting` with `crash_kind: unhandledRejection` carrying the SAME `PostgresError: canceling statement due to statement timeout` — exiting the whole worker (all 24 queues + 20 background loops). WHY → two non-obvious facts compounded: (1) at boot ~20 pollers/schedulers fire their first cycle simultaneously and hammer a cold Supabase PgBouncer, which enforces its server-side `statement_timeout` (~8s) regardless of the client's `connection.statement_timeout: 30_000` (a session `SET` doesn't stick in transaction-pooling mode); a heavy query (`OnboardingDripScheduler`'s 3×`NOT EXISTS` cross-join) times out → SQLSTATE `57014`. (2) The scheduler's own `try/catch` caught its awaited query — but postgres.js *also* surfaced a **connection-layer rejection** for the same timeout as a separate, un-awaited promise that escaped the scheduler's catch entirely. `worker/index.ts`'s last-resort `process.on('unhandledRejection', fatalExit)` then crashed the whole process over one recoverable blip. The scheduler was NOT the bug (it already caught its errors) — the crash-net's blast radius was. CORRECT → the `unhandledRejection` handler now classifies the reason: `isCrashNetRecoverableDbError(reason)` (an explicit allowlist in `src/lib/db/transient-error.ts`: `57014` / `57P0x` / postgres.js `CONNECTION_*` / specific 08-class connection failures — deliberately EXCLUDING ambiguous `08007 transaction_resolution_unknown`, `08P01`, and the open-ended `08xxx` prefix) → **recover** (Sentry `warning` + log, no exit), the loop reconciles next cycle. `uncaughtException` stays always-fatal (the stack unwound → state unknown). A duration-based governor (`worker/transient-rejection-governor.ts`) still escalates a *sustained* storm (rejections persisting >10 min, no >5 min idle gap) back to a crash+restart so a permanently-broken path doesn't run alive-but-broken behind the `SELECT 1` `/ready` probe. Lessons: a poller catching its own awaited query is NOT enough — postgres.js can emit a *separate* connection-layer unhandledRejection on the same timeout; and a process-level crash-net must distinguish recoverable infra blips from real bugs (Release It! "fail inside boundaries that prevent wider collapse"), not blanket-crash on any rejection.

### [2026-06-26] pnpm supply-chain hardening (`minimumReleaseAge` + `trustPolicy`) intentionally blocks some Dependabot bumps — that's a feature, not a failure
FAIL → `pnpm update @babel/core …` aborted with `ERR_PNPM_TRUST_DOWNGRADE` ("High-risk trust downgrade for semver@6.3.1 — possible package takeover"); and a `pnpm.overrides` entry to force `vite@8.0.16` silently no-op'd (the lockfile stayed at 8.0.5). WHY → `pnpm-workspace.yaml` (not `package.json`) carries the repo's hardening: `minimumReleaseAge: 10080` (a **7-day quarantine** on freshly published versions — `vite@8.0.16` was published 2 days ago, so it is intentionally un-installable yet) and `trustPolicy: no-downgrade` (rejects a package whose provenance weakens — bumping `@babel/core` re-resolved its subtree to a non-provenanced `semver@6.3.1`). Two more gotchas: (a) in pnpm 10+/11 with a `pnpm-workspace.yaml`, `overrides` (and config) live **in that file**, NOT `package.json.pnpm.overrides` (which is silently ignored); (b) forcing one package of a tightly-pinned set creates a split — bumping `@opentelemetry/core` alone (while `@sentry/node` pins the rest of the OTEL set) produced a `2.7.1 + 2.8.0` split that can break OTEL/Sentry instrumentation. CORRECT → patch only what bumps cleanly in-range (`pnpm update <names> -r`, lockfile-only, single-version) — here form-data 4.0.6, undici 7.28.0, esbuild 0.28.1 — and **respect the hardening** for the rest: a fresh release waits out the 7-day quarantine (self-resolves), a trust-downgrade bump waits for an upstream provenance fix, and a version-locked set (OTEL) waits for a coordinated `@sentry/node` SDK bump. Do NOT lower `minimumReleaseAge` / disable `trustPolicy` to force a low-severity fix — that trades a documented advisory for a worse supply-chain exposure. Lesson: a blocked dep bump in this repo is usually the hardening working as designed; verify publish-age (`npm view <pkg>@<v> time`) and provenance before assuming the tooling is broken.

---

## 2026-07-02 — DB-imports ratchet guard: composition-root convention (A+ campaign PR 1a)

### Domain modules take `sql`/`supabaseServer` as a parameter — only composition roots import `src/lib/db/server`
Spec: `docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md` §2.1 (Modularity A+ campaign, closing the June-accepted "ambient DB singleton" residual). `src/lib/db/server.ts` stays the single owner/constructor of the Postgres.js `sql` client and the `supabase-js` service client — pooling, `statement_timeout: 30_000`, and the two-client split are unchanged. What changes is WHO may import it: **composition roots** (Next.js route handlers `src/app/**/route.ts`, server-component pages `src/app/**/page.tsx`, and layouts `src/app/**/layout.tsx` — Next.js invokes all three, so no caller exists that could inject a client; `src/instrumentation.ts`; the worker job handlers, pollers, and schedulers REGISTERED in `worker/index.ts` (root status is EARNED by registration, not file position — see the PR-3 update below); `worker/index.ts`/`worker/queues.ts`; and everything under `worker/ingress/` — kept blanket on purpose, since per-event ingress handlers legitimately live in provider subfolders and path shape can't separate handler from helper there) may import the singleton and pass the client down. Everything else — **domain modules** (`src/lib/**` business logic, job-subfolder helpers like `worker/jobs/publisher/*.ts`, unregistered top-level helpers that sit beside the handlers like `worker/jobs/summary-report-helpers.ts`, and background-loop subfolder helpers like `worker/background/pollers/health-alert/checks.ts`) — must receive `sql`/`supabaseServer` (or `tx: TransactionSql` inside a transaction, already the `job-outbox-helpers` convention) as an explicit leading parameter instead of importing the module.

New AST-based `ci:db-imports` guard (`scripts/ci/db-imports-audit.ts`, mirrors `process-env-audit.ts`'s shape: `ts.createSourceFile` walk for `ImportDeclaration`/`ExportDeclaration` nodes so a `"@/lib/db/server"` string literal or comment can't false-fire, and `import type`/`export type` is correctly excluded — a type-only import carries no runtime dependency on the singleton). As SHIPPED in PR 1a it ran in baseline mode: CI failed on either a NEW non-composition-root importer or a stale baseline entry that no longer imported `db/server`, with every non-root importer as of 2026-07-02 checked into `scripts/ci/db-imports-baseline.ts` (105 files then, regenerated via a `--emit-baseline` flag) — a **ratchet** that only shrank as the Stage-2 domain sweeps (spec §3) injected the client instead of importing it. **PR 3 (Stage 3) completed the flip to STRICT** — see the PR-3 update below: the Stage-2 sweeps drove the baseline to 0, then PR 3 DELETED `scripts/ci/db-imports-baseline.ts` and the `--emit-baseline` machinery, so the audit now fails on ANY non-composition-root file that imports `db/server` — no baseline, no exceptions. Wired into `.github/workflows/ci.yml` (`lint` job, right after the process-env step) and `lefthook.yml` pre-push (`db-imports`, appended at the end of the commands block to avoid textual conflicts with other in-flight lefthook edits).

### [2026-07-04] PR 3 (Stage 3) — flipped STRICT + F15 registration-derived worker roots; process-env widened; fallow gained real `--coverage`

Three guard changes landed together in PR 3 (`aplus/3-ratchet-strict`):

**`ci:db-imports` → strict + registration-derived worker roots (F15).** The Stage-2 sweeps emptied the baseline, so PR 3 deleted `scripts/ci/db-imports-baseline.ts` + the `--emit-baseline` code path and the guard now fails on ANY non-composition-root importer of `@/lib/db/server` (no baseline, no exceptions). The old **positional** worker-root rule is GONE — do not reintroduce it. It used to say a `^worker\/jobs\/[^/]+\.ts$` file was a root by position, with a hand-maintained `NON_ROOT_EXCEPTIONS` set carving out top-level helpers (e.g. `worker/jobs/summary-report-helpers.ts`). Both are DELETED. Worker roots are now **DERIVED from `worker/index.ts` registration**: `readRegisteredWorkerRoots(indexText)` parses the entry point with the TypeScript compiler (never a raw-text regex — same reason as `fileImportsDbServer`) and credits a top-level `worker/jobs/<X>.ts`, `worker/background/pollers/<X>.ts`, or `worker/background/schedulers/<X>.ts` as a root ONLY if `worker/index.ts` imports it (a single-path-segment tail; a subfolder handler like `./jobs/publisher/ResponsePublisherWorker` is already excluded, and only a direct top-level `import` counts — not a barrel re-export or dynamic `import()`). Root status is thus EARNED by registration, not granted by file position, and the bias is deliberately fail-safe: an un-credited real handler produces a LOUD CI failure (fix by importing it directly in `worker/index.ts`), never a silent root grant to an unregistered helper. (`src/lib/db/auth.ts` remains a named owner-classified root from sweep 2i — a db-layer auth gate, not a domain module.)

**`ci:process-env` widened + `NEXT_PUBLIC_*` exempted.** The scan surface grew from `src/lib` + `worker` to also cover `src/app` + `src/components`, and `NEXT_PUBLIC_*` is now an exempt env INDICATOR (build-time-inlined PUBLIC client config that can never route through the server-only config accessor — exempt everywhere, alongside `NODE_ENV` / `MOCK_EXTERNAL_APIS` / `VERCEL_*`). That combination moved the baseline 14 → 10: it surfaced 2 genuine admin env-readiness reads (added) and declassified 6 former `src/lib` entries whose only counted read was a `NEXT_PUBLIC_*` var (removed as stale). Still **baseline-mode** (shrinks toward 0 in Stage 4), NOT strict.

**`ci:fallow` gained real `--coverage` in CI.** `.github/workflows/fallow.yml` now runs `pnpm test:coverage` then `ci:fallow:coverage` so cold-path / CRAP signals use real runtime coverage. The coverage input is self-healing: `scripts/ci/normalize-v8-coverage.ts` runs first and clamps vitest-4's v8 out-of-range `-1` branch-count sentinel to `0` (spec-valid istanbul) so fallow's u32 coverage parser accepts the report. The static `ci:fallow` (fast, no coverage generation) is retained for LOCAL/MANUAL runs and is wired into NO hook or workflow.

---

### [2026-07-05] The crash-net/transient-rejection governor is BLIND to a "zombie-pool" all-poller-timeout storm — every poll cycle times out but each is *caught*, so no `unhandledRejection` ever escapes

FAIL → a staging worker sat in a **10-hour storm** where essentially every poller/scheduler cycle logged `[ERRO] Poll cycle failed … timed out` (statement-timeout / connection-drop) and never recovered — yet the process was never restarted, so a wedged Postgres pool persisted until a **manual redeploy**. WHY → this is the *complement* of the [2026-06-26] crash-net note, and exposes its blind spot. That fix made `worker/index.ts`'s `process.on('unhandledRejection')` classify transient-DB rejections and let a duration-based governor (`worker/transient-rejection-governor.ts`) escalate a *sustained* storm back to a crash+restart. But the governor is fed ONLY by rejections that reach the crash-net — i.e. **un-awaited/connection-layer rejections that escape a loop's own `try/catch`**. In a zombie-pool storm, each poller's awaited query times out and is **caught by that poller's own `try/catch`** (logged as a handled `Poll cycle failed`), so postgres.js does not surface a separate escaping rejection → the crash-net never fires → the governor's counter stays at zero → no restart, forever. The `/ready` probe (`SELECT 1`) can even pass intermittently, so the load balancer keeps the alive-but-useless instance in rotation. Diagnosed environmental (not a code regression): the storm began ~10h AFTER a verified-clean deploy boot, hit 2c-era pollers a later sweep never touched, with the event-driven paths idle; a fresh redeploy (the post-merge `staging` realign) booted clean with normal INFO cycles (`StripeLocationsReconcile` "no drift", etc.) — a healthy fresh boot is the confirmation that the wedge was in the pool/DB session state, not the code. CORRECT (proposal — NOT yet implemented; flagged for a Stage-3-adjacent change, out of scope for the behavior-preserving A+ campaign) → add a liveness escalation that does NOT depend on the crash-net seeing an *unhandled* rejection: e.g. an in-memory counter incremented in the shared poll-wrapper's `catch` and reset on any poll success — when N consecutive cycles across the poller fleet fail with zero interleaved success, escalate to a **deliberate `process.exit`** so Railway restarts the process and resets the pool. The escalator must not itself require a healthy query (the health-alert poller *also* times out in the storm — see its known-noise 30s timeout), so key it on the failure counter, not on a probe query. Lessons: catching a poller's own awaited error is correct for a *single* transient blip but hides a *fleet-wide* wedge from the crash-net; "recover-don't-crash" (the 2026-06-26 fix) and "crash-so-you-restart" (this gap) are two failure modes that need *different* detectors — the governor watches unhandled rejections; a wedged-pool detector must watch *handled* poll-failure density. (Release It!: a health check that can't distinguish "briefly degraded" from "permanently wedged" keeps a dead instance in rotation.)

---

## 2026-07-16 — WS8 tier-cutover promotions (claude-mem sweep)

### [2026-07-14] A CHECK constraint on a nullable column silently passes NULL — pair NOT NULL with CHECK, and write NULL-safe preflights
FAIL → planning the WS8 tier migrations (077/078), the strict two-tier CHECK on `subscription_tier` looked sufficient on its own — but a NULL row would have sailed through it and then crashed the strict code's `isSubscriptionTier()` reads. WHY → SQL three-valued logic: a CHECK evaluates to UNKNOWN for NULL, and UNKNOWN *passes* the constraint. A CHECK alone therefore validates nothing about NULL-ability; the same trap applies to preflight queries, where `col NOT IN (...)` also drops NULL rows from the blocker count. CORRECT → any "column must be one of X" contract needs BOTH `NOT NULL` and the CHECK (078 does exactly this on the businesses mirror), and preflights must be NULL-safe — count `col IS NULL OR col NOT IN (...)`, never bare `NOT IN`. Migration 078's abort-before-DDL preflights are the reference implementation.

### [2026-07-14] A hung migration is a lock queue behind a long-lived pooled (Supavisor) session — cancel the stalled backend, verify clean state, then retry staging-first
FAIL → migration 076 hung indefinitely on staging: the migration backend (pid 3460156) sat waiting for a lock on `notification_deliveries` and never progressed. WHY → `ALTER TABLE` needs ACCESS EXCLUSIVE, and an active long-lived Supavisor query on the table held a conflicting lock; the queued migration then itself blocked everything arriving behind it, so the damage compounds the longer it waits. Under pooled connections a "stuck migration" is almost never the DDL being slow — it's lock acquisition. CORRECT → diagnose via `pg_stat_activity` (look for the migration backend `wait_event_type='Lock'` and the pid it waits on), cancel the stalled migration backend, verify no partial schema change landed (our migrations are single-transaction, so a cancelled one leaves a clean state — confirm the expected columns/objects are absent), let the lock-holding query finish or clear it, then re-run staging first before touching production.

### [2026-07-16] `getServerConfig()` memoizes on first access — mutating `process.env` afterward is a silent no-op
FAIL → the WS8 smoke harness's original `withOpenAutopilotGate()` helper flipped `AUTOPILOT_PURCHASABLE=true` via `process.env` mid-run; every Autopilot scenario still saw the gate closed, with no error anywhere. WHY → all three config accessors (`src/lib/config/{server,worker,client}.ts`) are lazy + memoized by design — the first `getServerConfig()` call parses the env once and every later call returns that snapshot, so a subsequent env mutation is invisible. Only `src/lib/config/flags.ts` reads `process.env` live (deliberately un-memoized so tests skip the reset-the-memo dance). CORRECT → set the env var BEFORE anything touches the config accessor (the rewritten smoke script sets it at boot, `scripts/ws8-staging-smoke.ts:79`), or mock/override the accessor itself in tests — never flip memoized config through the environment mid-run. When adding a new toggle, decide up front whether it belongs in the memoized schema (boot-time contract) or `flags.ts` (runtime-flippable) based on whether anything needs to change it mid-process.

---

## 2026-07-18 — #500 pool-wedge self-heal

### [2026-07-18] An `active+ClientRead` postgres.js connection is a socket wedge no server-side timeout heals — reclaim it client-side (end+rebuild); a server-side backstop needs a genuinely-reachable direct route (tracked #477, not live)
FAIL → a `HealthAlertPoller` health-check connection stalled server-side in `state=active, wait_event=ClientRead` and never came back to the shared postgres.js pool; one leaked slot per cycle silently starved the pool the whole worker shares, and neither `statement_timeout` nor the app-level `withTimeout` guard reclaimed it. WHY → `ClientRead` means the *server* is blocked waiting for client bytes that never arrive (a socket-level stall), so a server-side `statement_timeout` never fires — the statement isn't executing, it's mid-read; and `withTimeout` only *races* the promise, it does not cancel the underlying query or close the socket (`src/lib/shared/with-timeout.ts`), so the wedged connection is orphaned, still checked out, never returned. You also cannot identify the culprit backend by `application_name`: the Supavisor transaction pooler flattens every client's `application_name` to `'Supavisor'` server-side (verified on staging 2026-07-18 — see ADR 0007), so `pg_stat_activity` can't tell your backend from a Vercel dashboard read. CORRECT → reclaim at the client-side layer, which is the layer that actually runs. Client-side (fast, ~≤30s, KEPT — #500/#502): bulkhead the health checks onto a *dedicated* postgres.js client (`health-alert/health-db.ts`, `max:2`) and on `withTimeout` expiry `end()`+rebuild it (`recycleHealthSql`, rebuild UNCONDITIONALLY in `finally` even if `end()` hangs) — the client-side FIN gives the wedged backend's ClientRead an EOF so it dies. Server-side backstop (REMOVED #505): #500/#502 shipped an out-of-band `PoolWedgeReaperPoller` meant to run on a *runtime-verified-direct* `:5432` route (connect with `application_name='rw-wedge-reaper'`, trust the route only if `current_setting('application_name')` echoes it back exactly) and `pg_terminate_backend` any backend matching the full wedge signature whose query began with a cooperative `/* rw-reapable */` marker. It was deleted under #505: Railway's outbound network is IPv4-only while Supabase's direct `:5432` host is IPv6-only, so the verified-direct precondition is architecturally unreachable from Railway and the reaper never fired live — dead code kept alive only by its own tests. The genuine-direct-route concept and its two postgres.js 3.4.9 terminate-query traps are preserved for a future re-arm on a reachable route (ticket #477): (1) a row-value `IN ${tuples}` list mis-renders (the `in` builder drops the outer wrap, or the leading `(` hits the `\(`→`select` path and crashes) — join `(pid, backend_start)` pairs via `unnest(${pids}::int[], ${backendStarts}::timestamptz[])` instead; (2) `timestamptz` decodes to a millisecond JS `Date`, truncating Postgres microseconds — project both timestamps as `::text` and cast back with `::timestamptz[]` to keep `backend_start` equality microsecond-exact across the round-trip.

### [2026-07-18] Concurrent `Promise.all` queries on a shared postgres.js client over the Supavisor TRANSACTION pooler pipeline onto shared connections and wedge PERMANENTLY in `ClientRead` — #505 proved the #500 wedge's actual trigger
FAIL → the above self-heal note (same day) contained the wedge but left its *cause* an open, unproven "boot-burst" candidate (ADR 0008 originally shipped as "root cause still unproven"). #505 then proved it: `runHealthChecks` (`worker/background/pollers/health-alert/checks.ts`) fired its 6 health-bundle queries **concurrently via `Promise.all`** on the dedicated bulkhead client (`max:2`), and this — not the boot burst — was the trigger, recurring on **every 5-minute health cycle**, not just at boot. WHY → over the Supavisor **transaction** pooler, postgres.js pipelines the queries that exceed the pool's actual open-connection count onto the connections that ARE open; a pipelined query's response then parks server-side in `state=active, wait_event=ClientRead` and is never read, because the issuing client has already moved past that logical slot — a permanent wedge, once per cycle. Proven by a deterministic differential repro against the staging pooler: the real 6-query `Promise.all` bundle on `max:2` wedged **6/6** iterations; the same 6 queries run **sequentially** wedged **0/6**; the same 6 queries concurrent with **`max:6`** (one connection per query) wedged **0/6**; the actual fixed (sequential) `runHealthChecks` on `max:2` validated **0/6** against staging post-fix. Honest nuance — do NOT overclaim: concurrency-exceeding-pool-size is *necessary* but not *sufficient* alone — an earlier isolation repro with *uniform* queries at concurrency > `max` came back clean 21/21, so the trigger also depends on the query mix, not count alone. CORRECT → the fix idiom for any concurrent-query group sharing one postgres.js client over a transaction pooler: either run the queries **sequentially** (one in flight at a time — what `runHealthChecks` now does, commit a10f5eb), or give each concurrent query **its own connection** (`max ≥ concurrency`, e.g. bump the client's pool size to match the fan-out). `checks.ts`'s `runHealthChecks` is the confirmed instance; a companion audit (`docs/superpowers/plans/fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md`) catalogs ~15 other candidate sites with the same shape, each requiring its own differential-repro verification before being treated as confirmed — don't fix-by-analogy. See ADR 0008 for the full decision record (retitled to reflect the proven root cause) and the investigation doc for the falsified/refined hypothesis history. The one-off differential above is now checked in and re-runnable as `scripts/health-bundle-differential.ts` (ephemeral-branch, 3-arm) — see `docs/runbooks/pool-wedge-burst-drill.md` Part A.

---

## 2026-07-20 — #511 scalability verification remainders

### [2026-07-20] A boot-time summed-concurrency assert is only as strong as its hand-maintained queue inventory — a `runLlmTask`-calling worker omitted from the list is silently uncapped
FAIL → the summed LLM worker-slot cap (ADR 0005 addendum) was first inventoried in #490, but that list missed the `generate_demo` worker — so the "global LLM concurrency ≤ N" guarantee was quietly wrong: a real LLM-calling queue sat outside the sum and the boot assert would have happily passed a genuinely over-budget configuration. WHY → `assertSummedLlmWorkerSlots` (`worker/config/startup-assert.ts`) sums only the entries it is *handed* in `worker/index.ts`; there is no mechanism forcing that hand-written list to equal the true set of queues whose handlers call `runLlmTask`. The assert reads EFFECTIVE `worker.opts` so it catches a *concurrency-value* drift on a listed queue, but it is blind to a *missing* queue — the failure mode is omission, not misconfiguration, and omission leaves no error to observe. CORRECT → two layers. (1) Immediate: grep `runLlmTask` importers before editing the inventory (the code comment at the assert call site now says exactly this), and keep the cap literals module-private so the list — not a magic number — is the thing under review. (2) Durable (filed as a follow-up `ci:` candidate): a contract audit that maps every `runLlmTask` importer to a queue and fails CI if any such queue is absent from the `assertSummedLlmWorkerSlots` inventory — the only thing that turns "someone remembered to add it" into an invariant. Until that audit exists, treat the inventory as a manually-verified list, not a guarantee. Cap value itself is 9 (`generate_response`=5 + four ×1); `judge_verdict` is flag-gated and capped separately at 1 so booting with the judge flag ON never trips the sum.

---

## 2026-07-20 — #508 production reliability guards

### [2026-07-20] Bounding the shared supabase-js client's global fetch also bounded Auth identity MUTATIONS → an ambiguous timeout can orphan a committed signUp/invite → split the client
FAIL → the P2 hardening installed a 10s `AbortSignal.timeout` fetch as the GLOBAL fetch of the shared `supabaseServer` client, to stop worker-side admin/storage calls from hanging BullMQ slots. But supabase-js `global.fetch` applies to EVERY call on that client — including Auth identity mutations (signup provisioning, invites). WHY → a mutation that commits remotely but responds >10s surfaces client-side as a TimeoutError with no reconciliation path: the Auth identity exists, the app never learns it, and the user later hits `account_exists` lockouts. A timeout on a READ is safe (retry); a timeout on a NON-IDEMPOTENT identity mutation is an ambiguous-outcome hazard. CORRECT → split by call class, not one global bound: `supabaseServer` stays UNBOUNDED for identity-mutating flows (all Next.js signup/invite paths), and the separate `supabaseServerBounded` (`boundedSupabaseFetch`, `SUPABASE_FETCH_TIMEOUT_MS=10_000`, `src/lib/db/server.ts`) serves worker-side admin/storage calls where hanging is worse than ambiguity (offboarding purge, `CleanupAbandonedSignupsPoller` — whose `Promise.race` belt stays, since it also covers non-fetch hangs). Tests pin which client gets the injected fetch. General rule: a client-wide timeout is a per-endpoint-semantics decision in disguise — never bound idempotent reads and ambiguous mutations with one knob.

### [2026-07-20] An unlistened EventEmitter `'error'` on any BullMQ Queue/Worker/raw ioredis client is a FATAL uncaughtException — every emitter needs a listener, and the listener needs a per-source suppress window
FAIL → none of the BullMQ Workers, Queues, or the probe Redis client had an `.on('error')` listener, so a transient Railway Redis blip could restart the entire worker — inconsistent with the deliberately-recoverable Postgres crash-net. WHY → Node escalates an `'error'` event with no listener to `uncaughtException`, which the worker treats as ALWAYS fatal (correctly — for real programmer errors). And the naive fix (capture every event to Sentry) is its own outage amplifier: ioredis reconnect loops emit one error per failed attempt across ~46 emitters, so an unthrottled listener turns a Redis outage into a log flood + Sentry alert storm. CORRECT → one helper applied at the registration sites so new registrations inherit it: `attachEmitterErrorLogger(emitter, source)` (`worker/emitter-errors.ts`, wired in `worker/index.ts` + `worker/queues.ts`) — structured log + Sentry `warning` for the FIRST error per source per 60s window, count-and-suppress the rest, surface the suppressed count when the next window opens. The listener body itself never throws (a throwing `'error'` listener IS an uncaughtException). Caveat for tests: any suite that mocks BullMQ `Queue` as a bare class must give the mock a no-op `on()` or module-scope attachment loops crash at import.

### [2026-07-20] `AbortSignal.timeout` runs on Node's internal timer list — vitest fake timers cannot advance it → test with real timers + an injectable small timeout
FAIL → the P2 bounded-fetch test used vitest fake timers to fast-forward past the 10s bound; the test hung forever (Node 24). WHY → `AbortSignal.timeout()` schedules on Node's internal timers, not the JS-land `setTimeout` that vitest's fake-timer shim patches — faking time never fires the abort. CORRECT → real-timer test with a small injected timeout: `boundedSupabaseFetch` takes an optional trailing `timeoutMs` param defaulting to the production constant (test-only; production callers never pass it), plus a separate test pinning the constant at 10_000 so the injectability can't mask a drifted default.

### [2026-07-20] `markOutboxFailed` is a CAS returning boolean — coupled terminal writes must branch on ownership INSIDE the same tx, or a stale attempt commits rows it doesn't own
FAIL → the zernio ingest failed-hook wrote its terminal bookkeeping (`review_exceptions` INSERT + `markOutboxFailed`) as loose sequential statements; a retried/stale exhaustion attempt could insert exception rows for a transition it did not win, and any error in the sequence left half the bookkeeping committed. WHY → `markOutboxFailed` is a compare-and-swap (it returns whether THIS caller performed the terminal transition), but a CAS only confers ownership over writes that are atomic with it — outside a transaction, the "loser" has already executed its coupled INSERTs by the time it learns it lost, and a mid-sequence crash splits the pair. CORRECT → CAS-FIRST inside `sql.begin`: run `markOutboxFailed` as the first statement of the tx, execute the coupled writes only if it returns ownership, and roll everything back together on failure (atomic watchdog recovery re-drives the whole unit). Post-commit observability (e.g. the pagination trend Sentry signal) also gates on the captured ownership boolean. `withOwnedTerminalTransition` (`worker/jobs/zernio/ingest-failed-hook.ts`) owns this contract in one place, including the `coupledTerminalTxStarted` flag that stops the hook's last-resort crash guard from splitting a rolled-back coupled tx with a best-effort single-statement `markOutboxFailed`.

---

## 2026-07-21 — reliability follow-ups #514–#516

### [2026-07-21] `maxNetworkRetries: 0` is NOT a single-attempt guarantee — stripe-node retries ONCE on a first-attempt ECONNRESET/EPIPE before the maxRetries guard
FAIL → the P8 under-lock bound (`{ timeout: 8_000, maxNetworkRetries: 0 }` on every tier-change Stripe call made while the pg advisory locks + `FOR UPDATE` are held) was documented as "exactly one 8s attempt"; codex adversarial review verified the claim against stripe 22.2.0 source and found it wrong. WHY → `RequestSender._shouldRetry` retries a FIRST-attempt `ECONNRESET`/`EPIPE` unconditionally, BEFORE it consults the `maxNetworkRetries` limit — a socket reset always gets one extra attempt regardless of the setting. `ETIMEDOUT` (the hung-provider case the bound actually targets) does NOT take that path: one capped attempt, fail fast. Each attempt is individually bounded by `timeout`, so the realistic worst-case lock hold is ~2×8s + overhead ≈ 26s (down from ~60s+), not a hard 8s — and the reset path is near-instant in practice, not a full extra timeout. CORRECT → read `maxNetworkRetries: 0` as "no retry on timeout; at most one reset retry"; state lock-hold worst cases as ~2× the per-call timeout; keep the bound in its ONE owner constant (`STRIPE_UNDER_LOCK_REQUEST_OPTIONS`, `src/lib/accounts/tier-change.ts`) with this caveat documented at the constant, and recover ambiguous timeouts via the webhook/reconciler path + idempotency keys, never by retrying under the lock. (Also: `subscriptions.retrieve` takes RequestOptions as the THIRD argument — pass `{}` params second, or TS2559.)

### [2026-07-21] A module-scope breaker singleton accumulates state across vitest cases that mock the SDKs but drive the real seam — reset it in `beforeEach`
FAIL → `generator.test.ts` and `review-summary.test.ts` mock the raw OpenAI/Anthropic SDKs but exercise the REAL `runLlmTask`, which consults the live `llmCircuitBreaker` module singleton — each transient-failure test case silently pushed the shared breaker toward its 5-failure trip, so a late (or reordered) test could find the breaker OPEN and fail for a reason unrelated to its assertion: an order-dependent flake. WHY → `vi.mock` replaces the SDK modules, not `src/lib/llm/circuit-breaker.ts`; module state persists across cases within a vitest worker, and nothing on the real seam path resets it between tests. CORRECT → any suite that drives the real `runLlmTask` (rather than mocking the seam itself) calls `llmCircuitBreaker.reset()` in `beforeEach` (`reset()` exists for exactly this — it clears state only and is test-only). General rule: mocking a dependency's LEAVES does not isolate stateful MIDDLE layers — enumerate the singletons on the real code path and reset each one per test.

### [2026-07-23] Governor never re-suspended any account after its first unsuspension — postgres.js `timestamptz`→JS `Date` truncates microseconds, so the window's own source row compared as "newer" (SECOND subsystem bitten by this trap)
FAIL → in the Phase D staging drill, a clearly breaching candidate (5/5 `flag` judge verdicts, signal rate 1.0 ≥ 0.4, sample ≥ 5) ran >10 minutes at 20s governor cadence with zero suspensions and zero log lines. WHY → `listGovernorCandidates` computes `window_start = GREATEST(now()-7d, MAX(autonomy_unsuspended.created_at))` — microsecond precision in Postgres; postgres.js decodes `timestamptz` into a JS `Date` (millisecond precision); `revalidateGovernorCandidate`'s staleness check ran `created_at > ${observedWindowStart}` against the truncated value, so the very audit row that DEFINED the window matched as "newer" whenever its timestamp carried non-zero sub-ms digits (~999/1000 of real `NOW()`-written rows) → silent skip, every cycle, forever — permanent immunity for exactly the repeat-offender case the governor exists for. All 31 prior tests passed because JS-Date-seeded audit fixtures carry ZERO microseconds — the one timestamp shape that hides the bug. CORRECT (#520) → truncate the DB side to the precision the JS value actually has (`date_trunc('milliseconds', created_at) > ${window}`), make the scheduler's revalidation-skip path LOG (the silence is why it took a live drill to find), and regression-test with an audit row seeded `+ interval '419 microseconds'`. This is the same trap the wedge-reaper hit on `backend_start` equality (see that note's postgres.js trap (2)) — twice bitten, so promoted to a CLAUDE.md non-obvious gotcha: any SQL comparison of a µs-precision column against a JS-round-tripped value from the SAME row must truncate the DB side or keep the value `::text` end-to-end.

## 2026-07-22 — full text of two CLAUDE.md gotchas (moved here in the token trim; CLAUDE.md keeps the summaries + directives)

### Worker crash-net: recoverable transient-DB rejections vs fail-fast (full mechanics)
`worker/index.ts`'s `process.on('unhandledRejection')` classifies the reason via `isCrashNetRecoverableDbError` (`src/lib/db/transient-error.ts`): a transient Postgres statement-timeout / connection drop — which postgres.js can surface as a *connection-layer* rejection that escapes a poller's own `try/catch` — is captured (Sentry `warning`) and survived (the loop recovers next cycle). A *sustained* storm escalates back to a crash via `worker/transient-rejection-governor.ts` (duration-based); ambiguous-state DB codes (`08007`/`08P01`) + every non-DB rejection still fail fast; `uncaughtException` is ALWAYS fatal. Do NOT reintroduce a blanket crash-on-any-rejection (a single boot-time DB blip would otherwise kill all 24 queues + 20 loops). `isTransientPostgresError` (broad) is for billing's idempotent retry; the crash-net's `isCrashNetRecoverableDbError` is the stricter allowlist — keep them distinct.

### Cost-guard fail-open/retry matrix: limiters fail OPEN, reservation precedes spend (full mechanics)
API rate limits fail OPEN; the worker cost RESERVATION precedes every LLM call → spend is always safe even when the limiter is bypassed (`enforceDashboardRegenRateLimit` is the shared per-owner regenerate limiter; both authed regenerate entrypoints call it). On the worker, a raw Redis (Upstash) **transport** error at all four PRE-LLM touchpoints is **RETRYABLE**, not terminal: `checkRegenBudget` re-throws directly; `checkIdempotentCache` (`src/lib/costs/tracker.ts:138`), `reserveCost` (`tracker.ts:204`), and `acquireConcurrencySlot` (`src/lib/costs/concurrency-guard.ts:57`) throw `CostInfraUnavailableError` (`src/lib/costs/errors.ts`), which `generate-draft.ts:88` re-throws like `TransientLLMError` → BullMQ (5× + backoff on the LLM-bound `generate_response` queue; 3× elsewhere) + outbox watchdog re-dispatch (`OUTBOX_WATCHDOG_STALE_MS`, 15min default). (Changed in #255 — those three were previously terminal via the generic `{kind:'failed'}` catch; do not re-introduce that.) **Budget-exceeded** decisions (`CostLimitExceeded`/`GlobalCostLimitExceeded`/`RegenBudgetExceeded`) stay **TERMINAL** — only transport/infra failures retry; never reclassify a budget decision as infra. Post-LLM `tryWriteCache`/`finalizeCost` are out of scope: a finalize failure is governed by `withCostGuard`'s `onFinalizeError`, NOT a job-level retry (a retry would re-spend + burn a regen slot). Net: a transient Redis blip at any pre-LLM touchpoint (incl. first-draft, `version==1`) now RETRIES instead of losing the draft — **spend-safe AND resilient to transient blips**; only an outage outlasting the retry+watchdog budget still fails. (The avoid-facts guardrail RETRY re-throws all three transient classes — `TransientLLMError`, `ConcurrencyLimitExceededError`, `CostInfraUnavailableError` — for BullMQ retry; on retry the primary hits the idempotent cache so only the regen re-runs. Owner-accepted trade-off 2026-07-16: a Redis outage during the guardrail can re-spend, bounded by the queue's BullMQ attempts budget.) Do NOT "fix" the API limiters to strict (fail-open is intentional; the reservation already guarantees spend). The single Upstash instance is still a **SPOF** (cache + rate-limit + cost-reserve + regen-budget + idempotent-generation).

## 2026-07-26 — Solicitation watch-mode owner UI smoke (#528)

### [2026-07-26] Claude-in-Chrome `read_network_requests` reports a **204 No Content** as **503** — trust the server log, never the extension's status code
FAIL → the owner UI smoke's `reviewed_at` idempotency check saw `POST /api/dashboard/solicitation/batch/reviewed → 503` on every second-visit ping, reproducibly, and it was briefly reported as a real defect. WHY → the browser extension's network capture mis-surfaces a bodyless `204` as `503`; the Vercel runtime log for the SAME three requests (03:19:43 / 03:20:40 / 03:22:02, 1:1 count match) shows `POST … 204` with the route's own `batch_reviewed_ping` line each time. Code reading corroborates independently: that handler can only emit 204/400/402/403/404/500, `withSameOrigin` adds only 403, and the single 503 site in `src/` (`withRateLimit`'s strict-mode `rate_limit_unavailable`, `src/lib/auth/route-helpers.ts`) is **not** applied to the route. CORRECT → when a browser-driven runbook sees an unexplained 5xx, confirm it server-side (`get_runtime_logs` for Vercel, `railway logs` for the worker) BEFORE filing; and when the observed status cannot be produced by any layer in the handler chain, treat the observation tool as the prime suspect. Routes that return `204` are the ones exposed to this — `/api/dashboard/solicitation/batch/reviewed` is the known instance.

### [2026-07-26] `useReviewedPing` is gated on `document.visibilityState === 'visible'`, so a minimized/background automation window never writes `reviewed_at` — this is the feature, not a bug
FAIL → during the smoke, opening `/dashboard/requests` left `solicitation_batches.reviewed_at` NULL and looked like a broken write path. WHY → `RequestsClient.useReviewedPing` deliberately refuses to ping from a hidden tab ("the signal has to mean somebody looked"), and Chrome reports `visibilityState: 'hidden'` for a minimized window even when `document.hasFocus()` is `true` — so headless/background drivers silently exercise only the suppression branch. `window.focus()` cannot fix it (browsers block programmatic focus). CORRECT → for any runbook step asserting `reviewed_at`, bring the Chrome window genuinely to the foreground and confirm `document.visibilityState === 'visible'` in-page first; the `visibilitychange` listener then fires the ping. Bonus: doing it in this order observes BOTH halves of the gate (withheld while hidden, written on visible), which a plain foreground open cannot show.

### [2026-07-26] The Solicitation batch builder pools EVERY contact of the business, so a staging smoke's funnel never equals its own CSV — predict the arithmetic instead of expecting a clean env
FAIL → the smoke CSV added 6 contacts but the batch screen read 46 evaluated / 35 held / 11 sendable, which reads as wrong until the pool is understood. WHY → `batch-builder.ts`'s candidate window is `WHERE c.business_id = …` over the whole location (bounded by `MAX_DATA_ROWS`), not the uploading file's rows; `contact_csv_uploads` only *triggers* the batch. Staging accumulates contacts across runs, and every prior `send` ask makes its contact `over_contacted` for `MIN_GAP_DAYS` (30) afterwards. CORRECT → before uploading, snapshot the existing pool (`solicitation_contacts` count + prior asks by status/reason) and state the expected per-gate arithmetic in the evidence file BEFORE the build; then diff the `solicitation batch build finished` log's `withheld_by_reason` against it. Do NOT delete another run's fixture to get clean numbers on shared staging — the accumulated pool is what makes `over_contacted` observable at all.

## 2026-07-26 — #565 complexity-bundle promotions

### [2026-07-26] The `csv_ingest` advisory-lock contract is a STATUS-TRANSITION contract, not a table contract — the offboarding purge deletes unlocked, so a 0-row terminal write is tolerated on purpose (#582)
FAIL → an early draft of #565's plan read `src/lib/solicitation/ingest.ts`'s documented per-business concurrency contract ("every transaction that writes `contact_csv_uploads` takes `pg_advisory_xact_lock(hashtext('csv_ingest_' || businessId))` as its FIRST statement") as universal, concluded that the terminal `status='pending'`-guarded UPDATE matching 0 rows was an impossible state, and specified an assertion + throw. Adversarial review caught it before implementation. WHY → there is a **fourth writer** outside the protocol: `worker/jobs/account-offboarding/purge-stages.ts:256` hard-DELETEs `contact_csv_uploads` by `account_id` with no advisory lock. Only three writers honour it (the ingest transaction, `terminalizeUploadForInactiveSubscription`, and the csv-ingest failed-hook — all now routed through the single owners `acquireCsvIngestLock` / `writeTerminalUploadState`). So the purge can commit between the ingest transaction's `status='pending'` read and its terminal write: the row vanishes mid-ingest, the terminal UPDATE matches 0 rows, and the job completes normally reporting success for an upload whose row no longer exists. That outcome is **benign** — the account was legitimately being purged. The assertion would have converted it into throw → BullMQ retry → retry exhaustion → failed-hook terminalisation → Sentry noise, i.e. an alert storm manufactured out of a correct-by-intent deletion. CORRECT → `writeTerminalUploadState` (`ingest.ts:410`) returns `void`, no caller inspects a row count, and its doc comment names `purge-stages.ts` and forbids adding the assert. Read the lock contract as scoped to **status transitions**, with the purge an explicit permanent exception — the two are not the same claim, and the narrower one is what actually holds. Enforcement today is a comment, which is the weakest possible mechanism for a contract that reads as universal from inside `ingest.ts`; #582 tracks closing it properly (take the lock in the purge stage, per-business under the account). General rule: before asserting "this state is impossible", enumerate every writer of the table, not every writer that follows the protocol.

### [2026-07-26] fallow CRAP is inflated repo-wide — integration-only-covered code reads as ~0% covered and accrues PHANTOM complexity debt that decomposition cannot clear (#581)
FAIL → #565 was scoped from a fallow report as "decompose 5 complexity hotspots in the contacts ingest lane". Measuring first (`npx fallow health --complexity --format json` with the four `fallow-ignore-next-line complexity` suppressions in `src/lib/solicitation/ingest.ts` stripped) returned **zero** findings for that file: those functions clear both the cyclomatic and cognitive thresholds comfortably and were only ever flagged on CRAP. Four of the five "hotspots" were not hotspots, and that scope was dropped from the branch on the evidence. WHY → the CI gate is `ci:fallow:coverage`, which scores CRAP = `CC² · (1 − cov)³ + CC` from a `vitest run --coverage` report that **does not include the integration suites**. Every integration-tested module therefore reads as ~0% covered and its CRAP is inflated by up to the full complexity value. This is not lane-local: it applies to every module whose real coverage lives in a `*.integration.test.ts`. And decomposition cannot fix it — splitting an 89-line function with ~0% apparent coverage yields several functions with ~0% apparent coverage, so the suppressions are still required afterwards. CORRECT → when a fallow complexity finding drives a ticket, read the finding's `exceeded` field before scoping any work: `exceeded: "crap"` with `coverage_tier: "partial"` / `coverage_source: "estimated"` means the number is coverage-sensitive, so check whether the covering suite is an integration suite (→ phantom, file it against #581, do not decompose) or whether raw CC is genuinely over threshold (→ real, decompose). #565's two lanes are the worked example: `batch-builder.ts` had CC=14, so cutting decision points dropped CRAP below threshold and decomposition genuinely fixed it; `ingest.ts` was already under threshold and no restructuring could have moved its score. The one-line justification "CRAP vs complexity" is wrong; the real distinction is "CC above vs below threshold". Corollary: measure before accepting a debt ticket's premise — a fallow-derived scope can be majority phantom, and each phantom item costs a full review cycle to discover.

### [2026-07-26] A `verify-gate.sh` run with FEWER rows than the last one is DISARMED, not faster — a missing `.feature/intake.json` silently drops build/promised-tests/extras/reclassify and still prints GREEN
FAIL → during #565's review fix round, an agent told to clean up its scratch `.feature/fallow-health.json` deleted `.feature/intake.json` and `.feature/state.json` along with it. The next `scripts/verify-gate.sh --review` reported GREEN — while silently skipping every intake-driven row. Caught only by noticing the row count had dropped versus the previous run. WHY → every intake read in the script is failure-tolerant by design, and with the file gone each one degrades to "nothing to check" rather than to an error: `SURFACE` falls back to `backend` (`jq … 2>/dev/null || echo "backend"`, :37) so the `build` row is never launched (:62 launches it only for `ui`/`mixed`); the `verification_commands` loop reads an empty stream (:71) so all declared extras vanish; the `promised-tests` row is appended only inside `jq -e '.tests_to_add | length > 0'` (:126), which fails, so the row is absent entirely rather than FAIL; and `reclassify` needs `estimated_diff_size` (:133), so it too disappears. `PASSED` is computed as "no row said FAIL" (:156) — zero rows to fail is indistinguishable from all rows passing. CORRECT → read the row COUNT, not just the verdict: a gate table shorter than the previous run on the same branch is a disarm signal. Recovery is to restore the intake from its committed copy, re-arm the branch, re-confirm the fix round's changed files are in-surface after the fact, and re-run the full table (24 rows for #565). Do not let a cleanup step touch `.feature/` beyond the exact scratch file it created. The same shape applies to the `integration-suites` SKIP row and the `WARNING:` block: the gate is deliberately loud about *known* gaps and silent about a *missing* configuration, so absence of a row is never evidence of absence of a problem.

## 2026-07-26 — #573 live-DB suite deadlock under gate load

### [2026-07-26] Run-time migration DDL in a test suite deadlocks sibling suites across vitest PROCESSES — vitest serialization is per-process, only a session advisory lock spans processes
FAIL → `scripts/verify-gate.sh --review` failed intermittently (≈50%) with `PostgresError: deadlock detected` (40P01), always in a live-DB suite, never on an assertion; the victim varied between runs (`batch-builder.integration.test.ts`, `account-offboarding/integration-lifecycle.test.ts`) and even between tests within one suite, and the whole thing was invisible in CI (no `.env.local` → the suites skip) and unreproducible in isolation. WHY → the Postgres server log names both sides: one backend waiting for `RowShareLock` on `agent_runs` (`appendRunStep`'s `SELECT … FOR UPDATE`), the other waiting for `AccessExclusiveLock` on `solicitation_asks` while running **`088_solicitation_batch_executor.sql`** — a *test suite re-applying a migration in `beforeAll`*. DDL vs row locks on the same relations in opposite orders. Eight suites re-applied migration SQL to ensure their schema; `vitest.config.ts` already serializes `*.integration.test.ts` into its own project (`fileParallelism: false` + `groupOrder`), which makes this safe **within one vitest process** — but nothing in vitest spans processes, and `verify-gate.sh:70` launches every intake `verification_commands` entry in parallel with the main `test` row. #565's intake declared two of them (`pnpm test …ingest.integration.test.ts`, `…batch-builder.integration.test.ts`), so a `--review` run put three vitest processes on one database. Two more compounding facts: (1) `integration-lifecycle.test.ts` self-hydrated `.env.local`, so it ran even in a "no-export" gate run — which is why the issue's "every self-hydrating suite holds the shared lock, so this is ruled out" reasoning was wrong; and (2) its filename does not match `**/__tests__/**/*.integration.test.ts`, so it sat in the *parallel* project with ~740 other files. Differential proof: same two suites in ONE process 0/4 deadlocks, in TWO processes 3/6; the gate-shaped three-process arm 5/6 → 0/8 after the fix. CORRECT → remove the ingredient a test controls: the schema is provisioned once by `pnpm test:db:setup` and suites **assert** it (`assertSchemaReady`, which also owns the single migration→objects map) instead of applying it. A live-DB suite must also be named `*.integration.test.ts` so the serialized project actually claims it. Migration-**shape** suites legitimately apply DDL and are allowlisted, but must hold `acquireLiveDbLock` — a Postgres SESSION advisory lock is the only mechanism that serializes across processes (renamed from `feature-543-database-lock`, which had quietly become the shared protocol). Both rules are CI-enforced by `ci:live-db-suites`. General rule: "vitest runs these serially" is a claim about one process; the moment a script invokes vitest twice concurrently, every in-process guarantee is void — reach for a DB-side lock, or delete the contended operation.

### [2026-07-26] A migration-shape suite that COMMITS a re-apply of an old migration silently reverts a later migration on the shared test DB
FAIL → with the run-time DDL removed, `batch-builder.integration.test.ts` began failing on `agent_outcomes_outcome_kind_check` rejecting `solicitation_batch_built` — a value migration 088 explicitly added. The database had been freshly provisioned to head minutes earlier. WHY → `migration-074-…integration.test.ts`'s "applying the migration a second time is a clean no-op" test re-applied 074 **unconditionally and committed it**. 074 defines `agent_outcomes_outcome_kind_check` with its own, narrower value list; 088 later `DROP`s and re-`ADD`s that same constraint with `solicitation_batch_built` included. So a committed 074 re-apply drops the 088 version and restores the 074 one — leaving the shared DB permanently below head for every suite that runs afterwards. It had been invisible for as long as it existed because `batch-builder` re-applied 088 in its own `beforeAll` on every run and healed it; removing that DDL is what exposed it. Proven by differential: provision → constraint at head; run the 074 shape suite alone → constraint reverted, nothing else touched. CORRECT → a shape suite's unconditional re-apply runs inside `BEGIN` … `ROLLBACK` with its end-state assertions **inside** the transaction (they still observe the twice-applied schema, and nothing is left behind) — the pattern migrations 077/078's suites already used. General rule: on a SHARED database, any test that applies DDL owns the obligation to leave the schema exactly as it found it; re-applying migration N is not idempotent with respect to migration N+k when both write the same named object, and "the suite passes" says nothing about what it did to the next suite.

## 2026-08-01 — #625 consent-ledger ship promotions

### [2026-08-01] Registering an analytics event name only in `ANALYTICS_EVENT_NAMES` rolls back every transaction that emits it — the DB CHECK is a second, unpaired owner
FAIL → #625's Task 3 registered `solicitation_consent_recorded`/`_upgraded` in the TS allowlist; every consent-recording `csv_ingest` transaction then rolled back on `analytics_events_event_name_check` (live suite: `violates check constraint`). WHY → `analytics_events.event_name` is ALSO a DB-level CHECK allowlist (046 → 058 → 069 → 089 → 094), and `ci:analytics-events` compares the TS list only against `docs/analytics/events.md`, never the database; 089's own header warns about exactly this and it happened anyway because the plan treated the event as wiring-only. CORRECT → any new `ANALYTICS_EVENT_NAMES` entry ships with a paired event_name-CHECK migration in the same change; the live CHECK⟺allowlist drift guard lives in the newest such migration's shape suite (currently `migration-094-consent-analytics-events.integration.test.ts`, handed off 089 → 094).

### [2026-08-01] A vitest hook OR test-body timeout on a live-DB suite poisons the FOLLOWING tests — abandoned, not cancelled; and a budget near the observed worst case is a flake
FAIL → `batch-builder.integration.test.ts` failed 2/16 only under `verify-gate.sh --review` (16/16 standalone); the visible failure was an FK violation in the NEXT test. WHY → a timed-out vitest hook is abandoned, not cancelled: postgres.js kept executing the queued cascade DELETEs and removed the row the next test had just seeded. The cleanup was slow because FK fan-out did tens of thousands of row-ops (~7s standalone, >30s under the gate's concurrent coverage load). At ship the SAME contention class recurred in the test BODY: the 5000-contact window test ran 98s against a 90s `timeout` under gate load (93s even standalone on a loaded machine). CORRECT → live-DB cleanup hooks do child-first, business-scoped, set-based DELETEs; both hook and body budgets carry generous explicit headroom (120s/180s here) — never a budget near the observed worst case. Extends the 2026-07-26 #573 notes.

### [2026-08-01] A new table or a new analytics event is never wiring-only — budget the registry ripples at planning time
FAIL → #625's intake estimated ~1200 diff lines; actual ~2500, with three mid-run surface amendments. WHY → the plan priced the schema + writer but not the registry ripples a new table/event drags in: `scripts/ci/tenant-tables.ts` (`ci:rls-audit`/`ci:tenant-scope`), `docs/security/rls-inventory.md`, `TABLE_DISPOSITIONS` + purge sweep (+ the spec §7.2 cascade assumption being wrong), the event_name-CHECK migration (note above) + `docs/analytics/events.md`, migrations-log retention row, `schema-ready.ts`. CORRECT → when an intake adds a table or event, enumerate the registries up front and put every one in `allowed_edit_surface`; also expect one fallow finding class only at PR time — `verify-gate.sh` excludes `ci:fallow*` BY DESIGN (own workflow/baseline), so changed-code complexity trips surface at CI, and the house fix is extracting the new logic into a small decision helper, never a `.fallowrc` waiver (waivers are for pre-existing complexity swept in mechanically).

## 2026-08-03 — #643 suppression-ledger ship promotions

### [2026-08-03] `pnpm test:db:setup` DROPs schema `public`, so declaring it as a `verification_command` makes the gate race itself — provision serially BEFORE the fan-out
FAIL → #643's first `scripts/verify-gate.sh` run came back RED with 27 admin-route test timeouts and a live-DB suite failing "behind head". Nothing was actually broken: the intake had listed `pnpm test:db:setup` in `verification_commands`, and `verify-gate.sh:70` launches every declared extra **in parallel with the main `test` row**. WHY → `test:db:setup` is destructive by design — it drops schema `public` and re-applies bootstrap + every migration. Running it concurrently with suites that are mid-query yanks the schema out from under them, which surfaces as timeouts and phantom "behind head" assertions rather than as an obvious DDL error. The gate does not own its DB precondition, so nothing stops an intake from declaring a destructive command as a parallel row. Compounding: the gate also does not export `TEST_DATABASE_POOL_URL` (it lives in `.env.local`), so without a manual `export` the `integration-suites` row SKIPs — which the gate itself declares not-review-ready for DB-touching work. CORRECT → never put a destructive provisioning command in `verification_commands`. Run it **serially, before** the gate: `export $(grep -E '^TEST_DATABASE_POOL_URL=' .env.local) && pnpm test:db:setup && bash scripts/verify-gate.sh`. General rule: a gate row is a *check*, never a *mutation* — anything that changes the world the other rows are observing has to happen before the fan-out, not inside it. Extends the #573 notes: same root cause (concurrent vitest processes on one database), different trigger.

### [2026-08-03] Never write a fallow suppression from a PREDICTION — if the export has any real consumer, the marker itself becomes the failure (`stale suppression`)
FAIL → #643's plan mandated a `fallow-ignore-next-line unused-export` marker on `recordSuppression`, reasoning that it ships with zero production callers (G6: the writer lands ahead of #644/#645/#627 so its byte-for-byte `ON CONFLICT` predicates are proven against the real partial indexes the moment those indexes exist). Writing the marker **created** a CI failure: `pnpm ci:fallow` reported `stale suppression … (no unused-export issue found on the next line)`. WHY → the same G6 decision that made the export callerless in *production* also gave it a live-DB integration suite as a real consumer, and fallow counts a test import as a use. The predicted finding could never fire, so the suppression was stale from the moment it was written. CORRECT → the marker was removed and its rationale kept as a plain comment. Never author a suppression for a finding you have not *observed*: run the audit, read the actual finding, then suppress the specific thing it reported. A suppression written from a prediction is a defect class, not a one-off — #643's step-7 reviewers were briefed to sweep the branch for others and found zero. Corollary for the "ship the writer early" pattern: an export whose only consumer is a test is NOT dead code to fallow, so it needs no waiver at all.

### [2026-08-03] `estimated_diff_size` must budget production and TEST volume separately — a 4:1 test-to-code ratio is a designed property of a DB-contract feature, and a 1:1 estimate fires the abort criteria on exactly the work whose rigour is most worth having
FAIL → #643's `reclassify` gate row fired at 2.77× (later 2.94×): 5,299 changed lines against an `estimated_diff_size` of `+1800`. The trigger reads as "re-run step 0 and re-classify the lane". WHY → the estimate was made as one number. The breakdown shows nothing was out of control: production code landed at **435 lines across exactly the files the plan's file-structure table named**, 37/37 files in-surface, zero scope creep. The overrun was test volume the plan itself mandated (a 14-row `SUPPRESSION_SCOPES × SUPPRESSION_SOURCES` Cartesian matrix, 8-row token nullability permutations, six live-DB suites, mutation-verified retention proofs) plus 1,537 lines of workflow artifacts — the plan document, deviations file, intake and handoff. Excluding workflow artifacts the diff is 3,452 (1.9×, under the trigger). CORRECT → estimate production and test lines as two numbers, and when a plan mandates exhaustive data-driven matrices give it a test-line estimate of its own. Re-classifying #643 with the real numbers landed on the same lane (RISK was already `high`, 6 tracer tasks under the ~8 epic threshold), so the correct call was "continue, do not re-run step 0" — but that had to be adjudicated by hand. Candidate gate improvement: exclude `docs/superpowers/plans/**` from the reclassify computation — counting a plan document against the implementation it describes is not a meaningful ratio.

### [2026-08-03] `migration-immutability-guard.sh` keys on the migrations-log HEAD, not on "applied to staging/prod" — so amending a LOCAL-ONLY migration after the log bump is a guaranteed false positive
FAIL → #643's adversarial review found `solicitation_unsubscribe_tokens.token_hash` was `TEXT NOT NULL UNIQUE` with a comment asserting invariant #5 and nothing enforcing it. Fixing it meant editing `096_solicitation_suppressions.sql`, which the PreToolUse hook blocked: the same branch's T6 task had already bumped `Current head: **097**` in `.claude/reference/migrations-log.md`. WHY → the hook refuses any edit to a `supabase/migrations/*.sql` whose number is `<=` the recorded head, using the log head as a **proxy** for "already applied and therefore immutable". On a feature branch that writes its migrations-log entry before promotion, that proxy is wrong by construction — 096 existed only in a rebuildable local container. CORRECT → the escape hatch is the process env var `MIGRATION_GUARD_DISABLE=1`, and because it is read at process start it **cannot be set from inside a running session** — `.claude/settings*.json` sits outside `allowed_edit_surface`, and the edit-surface guard correctly refuses to write it. Relaunch as `MIGRATION_GUARD_DISABLE=1 claude`, then resume. Amending in place was also the *correct* call rather than merely the convenient one: the intake's `allowed_edit_surface` listed `096_*.sql`/`097_*.sql` and no `098` glob, so shipping the CHECK as a new migration would have required a second surface amendment and tripped the abort criteria. Candidate guard improvement: a per-entry applied marker in the log rather than the head number alone. Same class: `edit-surface-guard.sh` blocks worktree→main-checkout edits with `WORKTREE_EDIT_GUARD_DISABLE=1` as its only escape — also launch-time — so the post-merge promotion sweep must run from the main checkout AFTER `feature-cleanup.sh` removes the worktree, never from the shipping session.

### [2026-08-03] A comment asserting an invariant is not enforcement — and removing a defensive `OR` can HAND BACK tenant-scope allowlist entries
FAIL → two #643 review findings with the same shape. (1) `token_hash TEXT NOT NULL UNIQUE` carried the comment *"SHA-256, node:crypto (invariant #10); raw token NEVER stored (invariant #5)"* while accepting a raw token as readily as a digest — a single call site that forgot to hash would have stored plaintext and every reader downstream would still have worked. (2) `suppressionMatchSql` hardcoded `channel = 'email'` while `recordSuppression` took `channel` as a parameter — two owners for one dimension, failing **open**: the day `SUPPRESSION_CHANNELS` gains a member the writer mints rows the reader can never see, and an opt-out the ledger holds but the gate cannot find means the recipient gets contacted. CORRECT → (1) a named format CHECK mirroring migration 056's `account_offboarding_tokens`, `CHECK (token_hash ~ '^[a-f0-9]{64}$')`, lowercase-only because that is what `node:crypto`'s `digest('hex')` emits and admitting uppercase would let two spellings of one digest past the UNIQUE index; verified by **mutation** (remove the CHECK, re-provision, confirm 6 of 7 new assertions fail, restore). (2) `channel` became a required parameter on both sides. Bonus finding from the same review: the offboarding token scrub's `OR business_id IN (SELECT … FROM businesses …)` made `idx_solicitation_unsubscribe_tokens_account` unusable (seq scan) on the one statement that index was added for, **and** was redundant under the G12 CHECK (`business_id NOT NULL ⟹ account_id NOT NULL`). Dropping it from the scrub while KEEPING it in the purge verifier restored index usability on the hot path and preserved the cross-account tripwire on the cold one — and because the remaining predicate is natively account-scoped, it also deleted two `tenant-scope-allowlist` entries (`ALLOWLIST_BASELINE` 413 → 411). General rule: an allowlist entry that exists only because the scanner rejects `OR` is a signal worth re-reading — the `OR` may not be earning its keep.

### [2026-08-03] PgBouncer JSONB parse-site allowlist — AUTHORITATIVE (moved from CLAUDE.md, context diet)
CLAUDE.md keeps the guard rule (`typeof x === 'string' ? JSON.parse(x) : x`, then narrow; never paper over with `: any`); this entry owns the site enumeration. **Exactly 19 production JSONB field-to-parser sites today:**
- `job_outbox.payload` (2): `worker/background/pollers/OutboxPoller.ts`; `src/app/api/dashboard/past-replies/draft-status/route.ts`.
- `businesses.tracked_keywords` (1): `src/lib/admin/business-detail/mappers.ts` (the `trackedKeywords` call through `parseDbArray`; its sibling calls parse `TEXT[]`, not JSONB). `RankingTrackingWorker` no longer parses this column — it reads the primary keyword via `primaryTrackedKeywordSql` (#572), which resolves it in SQL.
- `accounts.flags` (2 shared parser sites): `src/lib/shared/past-due-recovery.ts`; `worker/background/pollers/billing-reconciliation/account-flags.ts`.
- Demo snapshots (4): `prospect_demos.reviews_snapshot` + `.generated_responses` in `src/app/(public)/demo/[slug]/page.tsx`; the same two `onboarding_demos` fields, server-projected into `src/app/onboarding/demo/PaywallWithDemoClient.tsx`.
- Run spine (2): `agent_runs.error` + `agent_run_steps.detail` in `src/lib/agents/read.ts`.
- `solicitation_outreach` (3): `.lint_detail` + `.moderation_detail` + `.interpolation_inputs` through the shared parsers `parseOutreachLintDetail`/`parseOutreachModerationDetail`/`parseOutreachInterpolationInputs` in `src/lib/solicitation/outreach.ts` (consumed by the Requests read model in `src/lib/solicitation/batch-view.ts`; each narrows and throws on a shape the writers cannot have produced — the `parseEvidence` posture).
- One each (5): `analytics_events.properties` in `worker/background/pollers/AnalyticsDispatchPoller.ts`; `review_exceptions.payload` in `worker/jobs/AdminExceptionWorker.ts`; `account_offboardings.provider_dispositions` through the shared parser in `src/lib/account-offboarding/provider-disposition.ts`; `contact_csv_uploads.report` through the shared parser `parseIngestReportValue` in `src/lib/solicitation/ingest.ts` (consumed by `getUploadStatus` in `uploads.ts` and the worker's terminal-status re-read); `solicitation_asks.evidence` through `parseEvidence` in `src/lib/solicitation/batch-view.ts` (the Requests read model — a non-object or discriminant-less value throws rather than rendering a blank spoilage row).

Any new production JSONB field-to-parser site must be added HERE. Do **not** add HTTP/request bodies, provider responses, LLM output, Redis/cache/connect-state values, local storage, JSON structured clones, or `TEXT[]` reads — those are different parsing boundaries, not this PgBouncer JSONB carve-out.

### [2026-08-03] Single-replica worker — detection mechanics (moved from CLAUDE.md, context diet)
The worker is single-replica by invariant, and that is DETECTED, not enforced. Four boot guards (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1) plus the in-process LLM circuit breaker are only correct with one replica, and the P2 pollers in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md` become duplicate-processing bugs with two. `ci:static-policy` blocks `numReplicas`/`multiRegionConfig` in `railway.toml` (config-as-code overrides the dashboard, so that is the one path a static check can block), and every boot logs + Sentry-tags `replica_id`/`deployment_id` via `worker/config/replica-identity.ts`. Railway injects a per-replica id but **no replica count**, so no process can assert it is alone — scaling up starts a new replica without redeploying the existing one, so **two `replica_id`s under one `deployment_id` is the signal**. A dashboard-set replica is not prevented; clear the P2 list first. **The signal is acted on (#587):** each replica registers in Redis under a TTL every `HealthAlertPoller` cycle, and the poller pages when >1 is live — immediately for replicas sharing a `deployment_id` (scale-out), or after a 2-cycle grace for a cross-deployment overlap (so a normal zero-downtime deploy does not page). `worker/background/pollers/health-alert/replica-cardinality.ts`. Deliberately a registry, NOT a boot-gating lease: a Redis outage must degrade to "no replica alerting", never to a worker that will not start — the check carries its own log-and-swallow `try/catch` for exactly that reason.

### [2026-08-03] Worktrees — sibling vs nested: full mechanics + cleanup (moved from CLAUDE.md, context diet)
`pnpm worktree:new <branch>` (→ `scripts/new-worktree.sh`) creates the worktree *outside* the repo at `../RepWorth-worktrees/<branch>/` with its own `node_modules` + copied `.env*.local`, so local lint/test/typecheck and the pre-push hook give a trustworthy signal. A *nested* worktree (`.claude/worktrees/`, `.worktrees/`) poisons local CI: Node's upward `node_modules` resolution and ESLint's upward config cascade leak the parent's deps/config in — if you're stuck in one, push and read the runner instead. The harness `EnterWorktree` tool and Agent `isolation:'worktree'` both create *nested* worktrees, so they inherit that caveat (fine for edit+typecheck agents, not for trustworthy full CI). Either way, every Write/Edit path must point at the worktree root (`…-worktrees/<branch>/…` or `.claude/worktrees/<name>/…`), never the parent checkout, or the edit silently lands in `main`'s tree (hook-enforced in the worktree→elsewhere direction by `edit-surface-guard.sh`). **Cleanup:** first confirm the branch's PR is merged (`gh pr list --head <branch> --state merged` — squash merges make `git branch --merged` useless) and the tree is clean, then remove each worktree individually: `git worktree remove <path>`, then `git branch -D <branch>`. One at a time, no `--force` — each removal stays reviewable.

- [2026-08-09] Pushing a staging merge from a dep-less throwaway worktree failed lefthook's test-changed (vitest cannot run without node_modules; lefthook runs in the pushing worktree) → the hook adds no signal there → push with --no-verify AFTER the real worktree's gate is green, or push from a checkout with deps.

### [2026-08-03] TEST_DATABASE_POOL_URL fallback — unsetting it does NOT sleep live-DB suites (moved from CLAUDE.md, context diet)
`resolveTestDatabaseUrl()` (`live-db-lock.ts`) falls back to reading `.env.local` off disk, so the six suites gating on it (ingest, batch-builder, run-spine, live-db-lock, migrations 088/090) run even under `env -u`. That matters because a whole-repo `pnpm test` with the DB awake breaks the suites that set the `src/lib/db/server` singleton at import time — whichever file initializes it first wins and the rest get `ECONNREFUSED :5432` (the #520 class). CI never sees it because CI's DB *is* on :5432, so the singleton default happens to be right. Kill switch: `REPWORTH_DISABLE_LIVE_DB_SUITES=1`, honoured by both gates; `scripts/verify-gate.sh`'s full-suite row sets it alongside `env -u` (#563).

### [2026-08-03] fallow coverage input is DB-complete as of #581 (moved from CLAUDE.md, context diet)
`fallow.yml` stands up its own `postgres:16` service container — per-job, on its own runner, NOT shared with `ci.yml` (which stands up its own, as does `e2e.yml`). Before that, ~37 integration suites self-skipped in the fallow run, so a module covered *only* by an integration suite read 0% and its CRAP (complexity × uncovered²) was inflated by up to its full complexity. Corollary the original report got wrong: a module with BOTH a unit and an integration suite was never affected — `ingest.ts` measured 91.9% statements / 89.1% branches in the DB-less input, and its four `fallow-ignore-next-line complexity` suppressions were phantom (removed; the gate passes without them under either input).

## 2026-08-03 — #644 unsubscribe opt-out ship promotions

### [2026-08-03] `createWorkerLogger` object args pass through the analytics blocked-key sanitizer, which silently DROPS any key containing `token`
FAIL → #644's §9.5 structured line was going to carry `token_hash_prefix`, the one field that makes a redemption correlatable across a provider's retries. It would have been removed from **every** log line — no error, no warning, the field simply absent, discoverable only while debugging a production incident, which is exactly when it is needed. WHY → object arguments to `createWorkerLogger` are sanitized by the analytics blocked-key filter, which strips any key whose *name* contains `token`. The sanitizer is doing its job: a key called `*token*` overwhelmingly holds a secret. The collision is that a **hash prefix of** a token is safe by construction and reads as a token by name. Invariant #5 says never log the raw token; it does not say never log a name containing the word. CORRECT → renamed to `hash_prefix`. General rule: **any deliberately-safe derived value — a hash prefix, a masked suffix, a key id — must be NAMED so it does not collide with the blocked-key sanitizer**, or the logger drops it without a sound. String args do not pass through the sanitizer, so the trap only bites the structured (object) lane, which is the lane you want for correlation.

### [2026-08-03] `app.inject()` normalises the request target, so it cannot falsify a claim about the raw request line — and absolute-form targets bypassed the ingress limiter for ALL FIVE providers
FAIL → the ingress limiter's scope test has two arms: `request.routeOptions.url?.startsWith('/ingress/')` (arm 1) and `decodeIngressPath(request.url).startsWith('/ingress/')` (arm 2). Arm 1 looked like dead logic — deleting it failed **zero** tests, and the plan had justified it by comparing against a *raw* URL check rather than the *decoded* one it actually specified. Both observations were true; the conclusion was wrong. WHY → an **absolute-form request target** (RFC 9112 §3.2.2), `POST http://<host>/ingress/resend HTTP/1.1`, is legal HTTP/1.1 any client may send. `find-my-way@9.6.0` strips scheme and authority (`index.js:571-572`) so the route resolves normally, while `request.url` retains the full absolute string — making arm 2 false. Verified over a **raw socket** against `fastify@5.8.5`: arm1 `true` / arm2 `false`. Deleting arm 1 makes every ingress provider's limiter — Stripe, Resend, Telegram, Twilio, Zernio — bypassable by a one-token change to the request line. No test caught it because **`app.inject()` normalises the target before Fastify sees it**, so the absolute-form case is unreachable through the entire existing suite; every rate-limit test on this branch and every earlier one goes through `inject`. CORRECT → keep both arms, and cover the case with a **real-socket** test (`net.connect` writing the request line by hand). General rule: a surviving mutant means dead logic **or** a structural blind spot in the harness — and `inject`-only suites are blind to anything about the raw request line (absolute-form, duplicate headers, malformed targets). When a mutation "proves" a security-adjacent branch is dead, ask what the harness cannot express before deleting it.

### [2026-08-03] The post-merge promotion sweep does NOT require the main checkout — park `.feature/intake.json` and branch the shipping worktree off `origin/main`
FAIL → #643's note concluded the sweep "must run from the main checkout AFTER `feature-cleanup.sh` removes the worktree, never from the shipping session", because `edit-surface-guard.sh`'s only escape (`WORKTREE_EDIT_GUARD_DISABLE=1`) is read at process start. In #644 that route was unavailable: the main checkout was on an unrelated branch, and `feature-cleanup.sh` computes `MAIN_ROOT` from its own cwd — run from inside the feature worktree it **skips that worktree as `MAIN_ROOT`** and cleans nothing. WHY → the guard has two independent rules. Always-on worktree containment blocks cross-*checkout* edits (session cwd in a worktree, target elsewhere); the `/feature` arming blocks edits outside `allowed_edit_surface` and is file-anchored on `.feature/intake.json`. Both are satisfied by staying in ONE checkout and disarming: `mv .feature/intake.json .feature/intake.parked.json` (the documented park operation), confirm `scripts/arm-check.sh` reports DISARMED, then `git checkout -b <docs-branch> origin/main` in the same worktree. Same checkout → containment passes; no intake → arming passes. CORRECT → park, branch off `origin/main` **not** local `main` (which lags after every squash merge — a worktree created from local `main` lands pre-merge and silently omits the code being documented), do the sweep, PR it, then run `feature-cleanup.sh` from the main checkout last. Corollary: `feature-cleanup.sh` must be run from the main repo root or it silently under-reports.

## 2026-08-05 — #645 manual suppression paths ship promotions

### [2026-08-05] A legal refactor can blind a file-level `ci:*` security audit — typecheck and every route test stay green
FAIL → the three admin suppressions routes opened with the same ~14-line preamble (AAL2 gate, `request.json()` in a try, `safeParse`, two 400s). Extracting it into a `withAal2JsonBody(schema, handler)` wrapper compiled, passed all route tests, and turned **`ci:admin-aal2` RED on all three routes**. WHY → `scripts/ci/admin-aal2-audit.ts` is a **file-level TEXT scan**: a file under `src/app/api/admin/**` exporting a mutation verb must literally contain the string `requireAdminWithAal2`. Moving the call behind a wrapper made three genuinely-gated routes indistinguishable from ungated ones. The audit is right to be strict — "is this admin mutation MFA-gated?" should be answerable by grepping the route, not by following an import. CORRECT → keep the gate spelled out in every route; share only the parts that carry no authorization meaning (here, body parsing → `parseJsonBody`). The audit *does* expose a `GATED_SHARED_HELPERS` allowlist for thin delegators, and adding to it was the wrong instinct twice over: it is outside a feature branch's surface, and it trades a greppable gate for a shorter file. **General rule: before extracting a shared helper out of a route, check whether a `ci:*` audit string-matches the thing you are about to move.** The audits that scan source text — `admin-aal2`, `static-policy`, `tenant-scope`, `outbox-seam` — all have this property, and a passing typecheck proves nothing about them. Same principle migration 098 applied when it refused `original_*` column names to stay visible to `accountLinkedTablesFromMigrations()`: never reshape code so a governance check stops seeing it.

### [2026-08-05] `fallow` is a CI-only gate — a fully green `verify-gate.sh` does not predict it, and the LOCAL fallow invents findings CI does not have
FAIL → #645 passed all 28 `verify-gate.sh` checks and two full review rounds, then failed `fallow` the first time a PR existed (4 duplication clone groups + a 19-cyclomatic component). WHY → `verify-gate.sh` does not run fallow at all. CLAUDE.md says `ci:fallow` "gates nothing", which is true of *that script* but not of `fallow.yml`'s **`ci:fallow:coverage`**, which is a real PR check. The two facts read as one and hide the gap. CORRECT → expect a fallow round on every PR; do not treat local green as ship-ready. **Second trap, worse:** running `fallow audit` locally without `--coverage` estimates CRAP **from export references**, which reported `ContactRow` as HIGH at 63.6 CRAP while the coverage-informed CI run did not flag it at all. Read both outputs side by side before refactoring — a local HIGH carrying the "CRAP scores are estimated" banner is not a finding, and chasing it means restructuring code against a number CI never computes.

### [2026-08-05] #674 — a hazard described too narrowly is worse than one described not at all
FAIL → #674 deferred a known lost-draft hazard to #675 and documented it as *"if `importReview` wins the identity **race** against a concurrent live-ingest `processReview`…"*. The adversarial review agent showed **no concurrency is required**: the live lane enqueues `generate_response` only when it INSERTs a review or when the content hash CHANGES, so a later `processReview` for an already-imported row takes the existing-row path, matches the hash, and returns `'unchanged'` without enqueueing (`processExistingReview`, the `existingHash === contentHash` branch). All three Zernio lanes converge on that same `processReview`, so none is a rescue. WHY → the race was the case that got *noticed* (it is the interesting one), and writing it down felt like documenting the hazard. It is actually the **rare** instance of a general property whose common instance — import first, live lane polls later — is the ordinary path. CORRECT → when deferring a hazard, state the **general property**, then note the interesting case as an instance of it. The test: *what is the simplest sequence that triggers this?* If the written hazard requires concurrency, interleaving, or a crash window, check whether the plain sequential ordering already does it. A too-narrow description is worse than silence: the next implementer reads "race", adds a narrow concurrency guard, closes the ticket, and ships the systemic bug — where no description at all would have made them look. Corollary that cost a second round: **a correction must reach every copy.** The fix updated the JSDoc, the deviations entry and the plan's Hazards section — and missed that the plan *embeds the implementation code*, so the superseded paragraph survived verbatim 435 lines lower, in the same file the successor ticket is pointed at.

### [2026-08-05] #674 — `describeWithDb` does NOT assert schema, and asserting what the suite READS is not enough
FAIL → a new live-DB suite shipped with no `assertSchemaReady` call, on the plan's stated belief that "`describeWithDb` handles the schema assertion". It does not — `src/__tests__/helpers/describe-with-db.ts` only gates on `TEST_DATABASE_POOL_URL` (plus the `REPWORTH_DISABLE_LIVE_DB_SUITES` kill switch) and registers `describe` or `describe.skip`. Nothing in it touches the schema. The cited precedent (`read.integration.test.ts`) also omits the assertion, so copying the nearest neighbour propagated the gap; 32 other suites do call it. WHY → CLAUDE.md says live-DB suites "**assert** their schema … so a behind-head DB fails loudly", which is a statement about the *convention*, not about the helper. Then the first fix was **still wrong**: it asserted `MIGRATION_071_RUN_SPINE` — the run-spine tables the suite READS — and missed that the code under test WRITES `agent_runs.parent_run_id`, a column added by migration **088** and declared by `MIGRATION_088_SOLICITATION_BATCH_EXECUTOR`. `MIGRATION_071_RUN_SPINE` lists only `tables`, no `columns`. A DB at head 071–087 would pass the assertion and then fail at the first `it` with the raw `column "parent_run_id" does not exist` — precisely the failure mode the assertion exists to prevent. CORRECT → call `assertSchemaReady` explicitly in every live-DB suite, and build the requirement list from **everything the transaction under test touches**, not from the tables the assertions read. Trace the writers (`startOrGetActiveRun` → `recordStep` → `completeRun`), not just the `SELECT`s. `run-spine.integration.test.ts` gets this right and asserts 071 + 088 + 091 together.

### [2026-08-05] #674 — plan-embedded code is unlinted, untypechecked and unexecuted until a subagent runs it
FAIL → across three plan-review rounds, the implementation plan's embedded code accumulated defects no tool would catch: `agent_run_steps.run_id` (the real column is `agent_run_id`; `run_id` is the local *variable* name the run-spine writers use), a missing `sentiment_score` assertion, an unnecessary `as MonitoredReview` cast, and a `git ls-files`-based audit invoked before the file was staged (so it inspected nothing). Round 3 caught the column name — in the very suite added to catch that class of error, which would have failed to run at all and thrown in `afterAll` before deleting a row. WHY → a plan is prose to every tool in the repo. Its TypeScript is not typechecked, its SQL is not parsed, its shell is not run. Yet it is treated with the confidence of code because it *looks* like code. CORRECT → schema identifiers, helper signatures and column names inside a plan need the same "look it up, don't guess" discipline as production code — every one of those four was verifiable with one `rg` against the migration. Related trap from the same ticket: a verification step that says *"expect the output to mention X"* is only a non-vacuousness proof **if the tool prints X on success**. `scripts/ci/live-db-suites-audit.ts` prints filenames only in its failure branch, so the prescribed receipt was unobtainable and a passing run could never satisfy it. When specifying a check, confirm the tool actually emits the evidence you are asking for.

### [2026-08-05] Resolving a `docs/directory.md` merge conflict is where a design fact quietly reverts — grep the FACT, not the rows you remember editing
FAIL → `docs/directory.md`'s `supabase/migrations/` prose paragraph still claimed migration 098 carries "deliberately **no `account_id`**, so it is correctly absent from the offboarding inventory". Both halves were false as shipped: 098 declares `account_id UUID`, and the table is `table-disposition.ts` entry `retain_compliance_limited_pii` with a `purge-verification.ts` branch. WHY → deviation D-A11 reversed that design mid-branch, and the resync commit swept "`CONTEXT.md`'s Correction path entry and two `docs/directory.md` rows" — the rows the author remembered editing. The stale claim lived ~1000 lines away in a section about migration *numbering*, which is not where anyone looks for a statement about column design. It survived two review rounds and only surfaced while hand-resolving a merge conflict in that same file. CORRECT → when a deviation reverses a design decision, `rg` the **fact** (`account_id`, "offboarding inventory") across `docs/` and `.claude/`, not the file sections you touched. A doc that describes a design the code no longer has is worse than no doc, because the next session trusts it.

### [2026-08-05] #673 — an intake is a snapshot; ticket amendments posted after intake lock are invisible to every downstream review
FAIL → migration 100 shipped `import_decision` with a FOUR-valued CHECK (`…|expired`) to staging and prod. #670's resolution — enum is **three-valued**, expiry is derived on read, "a CHECK value nothing writes would misrepresent the state machine" — had been posted as an amendment comment on ticket #673 roughly **17 minutes after** the /feature intake was locked. Three codex plan-review rounds and two branch-review rounds all validated against the intake and plan (that is their job — a fixed target), so the amendment was never seen; the drift surfaced only at promotion, when the epic map was read to answer "what's the next ticket". Corrective migration 101 landed the same day (PR #686). WHY → the /feature workflow makes the signed intake the scope contract precisely so reviews have a stable target, and nothing in the workflow re-reads the source ticket after intake sign-off. An amendment posted to the ticket between intake lock and ship therefore has no path into the run — the resolution notes WERE posted downstream (#673 got the comment); posting is not receiving. CORRECT → two checkpoints, both cheap: at **plan sign-off**, and again in the **step-8 ship preflight**, re-read the source ticket's comments and the epic map entry for anything posted after the intake's lock timestamp. An amendment that contradicts a locked intake term must either amend BOTH intake copies through the amendment protocol before execution, or be explicitly deferred with a comment back on the ticket saying the running feature will NOT honour it. Silence is how both sides ship believing they won.

### [2026-08-05] #673 — environment-state premises decay in hours; re-verify them at apply time, and date them in immutable headers
FAIL → spec §8a R3 and migration 100's header state both environments hold **zero `businesses` rows** — true when the staging reset ran that morning, false by the staging apply a few hours later (2 smoke rows had appeared; deviation D8). The claim is baked into an immutable migration header. Harmless here only because DEFAULT `'pending'` is the truthful state for a never-answered location — the premise was sufficient-but-not-necessary for the no-backfill decision. WHY → environment-state premises ("prod is empty", "no rows predate X") are snapshots that anything with write access — smoke tests, beta pokes, another session — invalidates silently; specs and headers quote them as standing facts. CORRECT → every data-state premise a migration relies on gets re-verified **by query in the apply-time preflight** (and the result recorded in the migrations-log entry, which stays editable); migration headers should phrase such premises as dated observations ("zero rows at spec lock, 2026-08-05"), not standing claims. The migrations-log entry — not the immutable header — is where apply-time reality belongs.

## 2026-08-06 — #675 consented import ship

### [2026-08-06] #675 — a verify-gate GREEN branch can still go red in CI: the fallow job is deliberately outside the local gate
FAIL → PR #689 opened with the branch fully gate-GREEN (all 21 rows) and every prior review round closed — and CI's `fallow` job failed with three findings (an unconsumed `export`, a 19-line clone, arrow complexity), forcing a post-open fix commit, a gate re-run, a staging re-ride and a re-smoke. WHY → `verify-gate.sh` derives its audit set from package.json's `ci:*` scripts but **excludes `ci:fallow*` by design** (its own CI workflow, own baseline, own coverage env) — so fallow findings are structurally invisible until the PR exists. The clone in question was even review-approved code: the D3 fix deliberately mirrored branch 2 verbatim, which is exactly what a suffix-array clone detector flags. CORRECT → treat fallow as a ship-time gate, not a review-time gate: before opening a PR on a branch whose diff added parallel/mirrored blocks, run `npx fallow audit --gate new-only --base origin/main` locally (static mode approximates CI; CRAP differs — coverage-fed CI is the arbiter) and remediate on merit (de-export, extract with per-call-site messages) rather than suppress. Post-open fixes on a RISK=high branch don't get a self-run review round past the cap — surface them as a PR comment for the owner (the D14 pattern).

### [2026-08-06] #675 — the Zernio sandbox feed is non-descending in practice: the import's dirty-ordering lane is the norm there, not the exception
FAIL (expectation, not code) → both staging smokes of the consented import logged `Zernio page order non-descending at review … (page 1) — early stops disabled` and paged to feed end (4 pages). Anyone watching staging logs will see this WARN on every import and may read it as a regression. WHY → the import trusts its two early stops (target met / floor passed) only while pages arrive newest-first; Zernio's ordering is verified-but-undocumented (spec §9), and the **sandbox** feed genuinely interleaves. Dirty mode is the designed response: page to feed end or `ZERNIO_IMPORT_MAX_PAGES`, then select in-memory — results are identical, just more pages fetched. CORRECT → on staging, the ordering WARN + `pages=N > 1` with a clean `Import complete` line is healthy behavior, not an incident; it only becomes a signal when paired with `ZernioImportPaginationCapExhaustedError` (cap-out with <100 in-window — bump the cap and re-enqueue) or when it starts appearing in **prod** logs, which would mean Google/Zernio ordering changed for real feeds too (the early-stop optimization stops applying; cost is extra pages, correctness unaffected).

## 2026-08-07 — #677 import offer ship

### [2026-08-07] #677 — `ci:tenant-scope` strips subqueries before analysing predicates, so a tenant key bound inside `EXISTS (…)` reads as UNSCOPED
FAIL → three new queries bound `business_id`/`account_id` correctly but did so inside `EXISTS (…)` subqueries; `ci:tenant-scope` reported the tables as unscoped and demanded allowlist entries for code that was already tenant-safe. WHY → the audit strips subqueries before it analyses predicates, so anything bound below the top level is invisible to it. The failure mode is insidious in both directions: the honest fix looks like "add a suppression", which permanently blinds the audit to that call site. CORRECT → restructure so every tenant key is bound in a **top-level** predicate rather than suppressing. `createImportOffer` JOINs the two junction halves instead of testing them with `EXISTS` (safe: `accounts.id` is the PK and `zernio_connections_one_active_per_business` makes an active row unique per business); `finalize-tx`'s completed-run guard became its own statement ahead of the INSERT; `import-offer-view` uses a `LEFT JOIN` plus a second conditional query. Net effect on the tree was a **shrink** — allowlist baseline 420 → 418.

### [2026-08-07] #677 — a shared SQL fragment must not require identifier interpolation: `db(alias)` dies on the repo's hand-rolled `sql` mocks
FAIL → `importConsentStateSql` took an `alias` parameter and injected it via postgres.js's identifier form `db(alias)`. Correct against real Postgres, and it passed the live-DB suites — but the four producers' unit suites use hand-rolled `sql` mocks implementing only the tagged-template call form, so `db('b')` arrived as a bare string and died on `strings.join is not a function` across several directories at once. WHY → a fragment consumed by N producers is consumed by N test harnesses too, and the repo's mocks model the tagged-template API, not the full postgres.js surface. Making the fragment more flexible taxed every mock in the repo. CORRECT → fix the contract instead of generalising the fragment: it now takes **no interpolation at all** and callers must alias `businesses` as `b`. Note this trades a compiler-checked parameter for a naming convention nothing enforces — a caller aliasing differently compiles clean and derives consent from the wrong row; the guard is the source tripwire `import-consent-lock-order-source.test.ts`.

### [2026-08-07] #677 — `ci:outbox-seam` derives helper coverage ONLY from `job-outbox-helpers.ts`, so a shared function elsewhere is NOT a helper to the audit
FAIL (a recorded blocker that was FALSE) → the handoff carried, and a review round re-asserted, that extracting the triplicated `ZERNIO_INITIAL_BACKFILL` enqueue into a shared function would turn every raw producer red under `ci:outbox-seam` and force migrating them all in one PR. Acting on that belief is why three copies were allowed to diverge in the first place — and they had already diverged (the A4 bug). WHY → `scripts/ci/outbox-seam-audit.ts` pins `HELPER_MODULE` to `src/lib/shared/job-outbox-helpers.ts` and derives coverage **only from that file**. Minting a helper *there* does turn every raw producer for that topic red; a shared function *anywhere else* is invisible to the audit. CORRECT → the two are not the same act. Consolidating duplicated enqueue logic into a domain module (`src/lib/reviews/import-consent.ts`) is always available and costs nothing at the audit; only `job-outbox-helpers.ts` carries the all-or-nothing migration. Verify a claimed CI blocker against the audit **source** before letting it shape a design — this one survived a handoff and a review round unchecked.

### [2026-08-07] #677 — a live UNIQUE partial index found a design bug three plan-review rounds missed
FAIL → a fixture seeding two `initial` runs was rejected by `zernio_backfill_runs_one_initial_per_business`, a UNIQUE partial index on `(business_id) WHERE run_reason='initial'` that exists in the DB and appears in no plan. Chasing the rejection exposed that **reactivation runs recur by design**, so the planned "newest run wins" read model would have flipped the banner back to "Importing your reviews…" every time an archived location was reactivated — months after the one-time import finished. WHY → the plan reasoned about run rows as a flat set; the schema already encoded a distinction (`initial` is unique, everything else recurs) that no reviewer reconstructed from prose. CORRECT → `readImportOfferView` and `enqueueInitialImport` both scope to `run_reason='initial'`, spelled identically. The general lesson is the argument for the four live-DB rows being non-negotiable at the step-5 gate: **a constraint the plan never mentions is still a reviewer**, and only a suite that actually touches Postgres consults it.

### [2026-08-07] #677 — `GREATEST(NULL, x)` returns `x`, so a junction predicate over two nullable timestamps admits HALF a junction
FAIL (caught in review, never shipped) → the Import offer's junction is "subscription activated AND an active Zernio connection". A predicate that merely combined the two timestamps with `GREATEST` would have handed an offer to a location holding only one half, because Postgres's `GREATEST` ignores NULLs rather than propagating them. WHY → `GREATEST`/`LEAST` are NULL-skipping in Postgres, unlike arithmetic — so they silently succeed on incomplete data exactly where a conjunction was intended. CORRECT → `createImportOffer` proves **both halves explicitly** in its own SQL (`a.subscription_activated_at IS NOT NULL AND zc.status='active'`) rather than deriving them from a combined timestamp, and does so inside the helper because "the callers do not check, so the helper must." Confirmed on staging against two same-named businesses: only the one with an active connection was given a deadline.

### [2026-08-07] #677 — `verify-gate.sh` writes `phase=gate_green` itself, which silently rewinds a reviewed branch to step 7
FAIL → running the gate after review completion overwrote `.feature/state.json`'s `phase` from `reviewed` back to `gate_green`. A resumed session reading that file would re-enter step 7 and open review round 2 on already-reviewed code — burning a round against feature.md's cap for nothing. Hit twice in one session (once after the staging-ride commit, once after the fallow fix). WHY → the gate script and the workflow both own the same field, and the gate's write is unconditional; it has no way to know whether the run is a mid-execution consistency check or a post-review re-verification. This is the mirror of the opposite trap recorded at #675, where the phase had to be *held* at `executing` to stop a resumed session skipping ahead. CORRECT → after any `verify-gate.sh` run past step 7, immediately `bash scripts/feature-state.sh set-phase reviewed` and confirm the file. Sequence a docs commit as **commit → re-run gate → set-phase**, so `lastGreenGateSha` and `headSha` both land on the new SHA; setting the phase first leaves the gate SHA stale and a resume will flag it.

### [2026-08-07] #677 — the fallow-outside-the-local-gate trap recurred on the very next ticket
FAIL → PR #691 opened fully gate-GREEN (26/26, full mode, four live-DB rows running) and CI's `fallow` job failed again — an unused type export (`ImportDecisionRejection`) and a 9-line clone. Third consecutive occurrence of the class (#659, #689, #691). WHY → unchanged and by design: `verify-gate.sh` excludes `ci:fallow*`. The #675 note already prescribed the remedy and it was not run. CORRECT → the remedy is now non-optional on any branch adding a new module or a route handler: run `pnpm ci:fallow` **before** opening the PR. Also worth knowing for the clone half — fallow matches clones **across the whole repo**, not just the diff, so a new file can be flagged against an untouched one. That is a trap for surface-budgeted work: the reported partner may be out of surface, and "fix it there" can cost an amendment. Look for a duplicate of the same block **inside** the new file first — in #677 both handlers of the new route carried the same preamble, so a module-private helper was justified on its own merits and the cross-file clone dissolved as a side effect, with zero out-of-surface edits.

## 2026-08-08 — #679 import consent worker guard ship

### [2026-08-08] #679 — a fix for an untested-guard finding reproduces the defect unless the fix is itself mutation-pinned
FAIL → twice, in consecutive review rounds. Round 2's decisive finding was that the SAVEPOINT — the fix for the branch's worst defect — shipped unpinned: deleting it left all 37 live-DB and 42 unit tests green. Round 3's decisive finding was that the **catch narrowing**, round 2's own fix for that finding, shipped unpinned too: both failure tests injected SQLSTATE `23514`, which carries a string `code` and is swallowed either way, so deleting the guard also left every suite green. WHY → a finding of the form "X is untested" gets answered by adding a test that exercises the *happy path through* X, which passes with or without X. The fix and its test are written in the same breath from the same mental model, so the model's blind spot is inherited. Review reading does not catch this: across three rounds, roughly ten instances of false coverage on this branch were caught by mutation and **zero** by reading. CORRECT → when a finding says a guard is untested, the acceptance criterion is not "a test now exists" but "deleting the guard turns the suite RED, demonstrated". Delete it, run the suite, record the failure count, restore. Budget the mutation run as part of the fix, not as optional verification after it.

### [2026-08-08] #679 — narrowing an over-wide `catch` is a repo-wide change, and postgres.js's error taxonomy is why `instanceof PostgresError` is the wrong narrowing
FAIL → two connected traps. (a) Narrowing a `catch (e) { /* swallow */ }` converts every latent swallow into a live failure, so the blast radius is "every mock standing in for the narrowed type" — discoverable only by running the FULL suite, not the changed-file subset. Several unrelated suites (including a Stripe resume test) went red because their `sql` mocks lacked a `savepoint` method. (b) A review axis then recommended tightening the narrowing to `instanceof postgres.PostgresError`. WHY (b) is wrong → every error class actually reachable there carries a **string** `code`: `PostgresError`, statement-timeout `57014`, postgres.js's own `CONNECTION_*` errors, and Node's `ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`. Narrowing to `PostgresError` would rethrow a transient connection blip straight into `finalizeConnectionTx` and reintroduce the connect outage the savepoint exists to prevent. (`DOMException` has a numeric code, but postgres.js 3.4.9 does not produce them for query timeouts — its cancellation path is `57014`.) CORRECT → narrow on the string-`code` shape, not the class. And treat a catch-narrowing as a type-level change with a full-suite blast radius: run the whole suite before assuming it is local, or scope it as its own change with a budget for the incomplete mocks it will expose.

### [2026-08-08] #679 — a JS `throw` does not poison a Postgres transaction, so JS-thrown abort injections cannot test savepoint recovery
FAIL → tests meant to prove "the enclosing transaction survives a failed emission" injected a JS error and passed trivially, because the transaction was never actually aborted. WHY → Postgres marks a transaction aborted only when *the server* raises; a JS exception thrown between statements leaves the connection's transaction perfectly usable, so the savepoint's ROLLBACK TO has nothing to recover from and the assertion proves nothing. CORRECT → abort injections must be **Postgres-side** (a real constraint violation, e.g. a bogus `event_name` raising `23514`). One deliberate exception is legitimate and should stay documented at its injection site: a test asserting that a *code-less* error **propagates** may throw a JS `TypeError`, because its claim is about the rethrow, not about the caller surviving.

### [2026-08-08] #679 — `git merge --ff-only main` cannot fast-forward `staging` after a squash merge; verify with the tree diff, never `git cherry`
FAIL → CLAUDE.md's post-promotion ritual is `git merge --ff-only main` on `staging`, which aborted with "Not possible to fast-forward" — `staging` held the branch's 24 un-squashed commits while `main` had the single squash commit. WHY → a squash rewrites history, so the branches genuinely diverge even though their content is identical; ff is only possible when `staging` is an ancestor. `git cherry main staging` is NOT the check to reach for here: it compares patch-ids, and squashing changes every one, so it reported all 24 commits as missing from `main` when in fact every line was present. CORRECT → the authoritative check is `git diff --stat staging origin/main`. If it is empty (or shows only paths `main` has a newer version of), nothing is lost and the resolution is `git reset --hard origin/main` + `git push --force-with-lease origin staging`. That is also the observed steady state: prior rides left `staging` sitting on `main`'s exact SHA, not on a merge commit.

### [2026-08-08] #679 — staging sits behind Vercel team-SSO *and* app auth, so any smoke that must cross a Next.js route has no headless path
FAIL → the last smoke assertion (both Import-offer analytics events landing through their real writers) could not be driven from the shell: an anonymous request to `staging.repworth.net` 302s to `vercel.com/sso-api`. WHY → `ssoProtection: "all_except_custom_domains"` exempts only the **production** domain, and both emission writers (`createImportOffer`'s GET self-heal and `recordImportDecisionAndEnqueue`'s POST) are Next.js routes rather than worker ingress. Protection-Bypass-for-Automation would clear the SSO gate but not the app session, so it is not sufficient on its own. CORRECT → plan any staging assertion that crosses a Vercel route as a **browser** step from the start (the owner's logged-in Chrome). Worker-side assertions stay fully scriptable — Railway ingress is unaffected — so split the smoke list by which surface it lands on before estimating it. Setup for this one: reset the target business to `pending` / NULL deadline; the banner then mints a fresh offer on render.

---

## 2026-08-08 — #696 verify-gate row identity ship

### [2026-08-08] #696 — a gate row's NAME is its status slot, its log file and its coverage dir, so a truncated identifier can report PASS for a suite that FAILED
FAIL → `verify-gate.sh` derived both dynamic row names by truncating to 40 characters (`tr -c 'a-zA-Z0-9' '-' | cut -c1-40`). `src/lib/reviews/__tests__/import-consent.integration.test.ts` is **exactly** 40 slug characters, so every `import-consent-*.integration.test.ts` sibling collapsed onto the same row. The visible symptom was a spurious `GATE: RED` (two vitest processes racing one coverage directory to an `ENOENT`, while both suites passed 30/30 alone) and #679 worked around it by renaming its suite. WHY the workaround was the wrong read → the collision is not a coverage-directory problem, it is an **identity** problem: the same name is also the row's entry in the `NAMES`/`RESULTS` arrays and its `.feature/logs/<name>.log`, so the other direction of the same race records PASS for a failed suite — a silent green in the check that is the mechanical backstop for a whole `/feature` run. CORRECT → truncate for *readability*, never *identify* by the truncation: `row_slug` (`scripts/gate-rows.sh`) keeps the 40-char prefix and appends a 6-char hash of the full input. Pair it with an assertion at registration (`assert_unique_row_name` in `launch()`) so a name derived some other way in future cannot resolve silently. Generalisation worth carrying: whenever a derived string is used as a *key* — a log filename, a cache key, a lock name, a job id — a lossy transform on the way in is a correctness bug, not a cosmetic one.

### [2026-08-08] #696 — a "is it wired?" test written against SOURCE TEXT is the same defect class as the bug it guards
FAIL → the first fix added a test asserting that `verify-gate.sh`'s `launch()` body *contains the strings* `assert_unique_row_name` and `gate_abort`. The spec review then built a mutant whose `launch()` asserted uniqueness over `${PIDS[@]}` instead of `${NAMES[@]}` — every duplicate silently accepted, the entire fix disarmed — and the suite passed 7/7. WHY → a text assertion proves the source *mentions* the guard, never that it is reachable, correctly parameterised, or has any effect. That is precisely the failure the ticket existed to remove ("a check that structurally cannot see what it claims to enforce"), reproduced inside its own fix. The trap is easy to fall into in bash, because a monolithic script offers no obvious call seam. CORRECT → there is almost always a seam. Two that worked here: (a) extract the function into a **sourced library** the suite can `.` and call directly; (b) for functions that must stay in the entry-point script, `eval "$(sed -n '/^launch() {/,/^}/p' scripts/verify-gate.sh)"` in the harness runs the REAL body and fails loudly if the function is renamed. Reserve text assertions for properties that genuinely ARE textual — "this token appears nowhere in this file" — and write them as patterns, not literals (`/cut\s+-c\s*1-\d+/`, not `'cut -c1-40'`), so the next spelling of the same mistake still trips them.

### [2026-08-08] #696 — `exit` in a SOURCED bash file kills the caller, and doing it before the caller's abort handler exists leaves a stale-GREEN gate-status.json
FAIL → `scripts/gate-rows.sh` resolved its hash tool at source time and ran `exit 1` when neither `shasum` nor `sha1sum` was on PATH. Because the file is sourced, that exit terminated `verify-gate.sh` itself — and it fired *above* the line where `gate_abort` was defined, so the gate died without writing `.feature/gate-status.json`. The previous run's `{"passed":true}` stayed on disk, which is exactly what `.claude/hooks/stop-gate.sh` reads. A fatal misconfiguration presenting as the last run's success. WHY → sourcing is not calling: there is no frame to unwind to, so `exit` in a library is a caller-level control-flow decision the library has no standing to make. The ordering compounded it — a failure handler defined *after* the code that can fail is not a handler. CORRECT → a sourced library never calls `exit`; it signals (leave a variable unset, `return` non-zero) and lets the entry point decide. Define the entry point's abort path **before** anything that can fail, the `source` line included. Pin it with a text assertion: the library must contain no `exit` at any depth. Corollary from the same round → if the source fails outright (missing file, `CDPATH` redirection, syntax error), the undefined function's exit 127 is read as whatever the call site takes non-zero to mean — here, a bogus "duplicate row name" naming an innocent row. Follow every `source` with a `command -v <known_symbol>` guard that names the real cause, and use `CDPATH= cd` wherever a script resolves its own directory.

### [2026-08-08] #696 — under `set -u` on bash 3.2, `"${ARR[@]}"` on an EMPTY array is a fatal unbound-variable error
FAIL → the uniqueness assert in `launch()` expands the accumulated row list, and the very first call (`launch lint`) happens with `NAMES=()` still empty. Spelled `"${NAMES[@]}"` it kills the gate before a single row starts — and before any `gate-status.json` is written. WHY → bash 4.4 fixed this; `/usr/bin/env bash` on macOS is **3.2.57**, where an empty array under `set -u` counts as unset. Every gate script in this repo runs `set -uo pipefail`, so the whole class applies. CORRECT → `${ARR[@]+"${ARR[@]}"}` is the 3.2-safe spelling, and the case is worth its own test — mutating the guard away is invisible to review and to any test that starts with a non-empty array. Same family as the existing `wait -n` note: assume bash 3.2 semantics for anything under `scripts/`.

## 2026-08-08 — #694 live-DB DDL detector ship

### [2026-08-08] #694 — an audit that keys on an INCIDENTAL marker reports `passed` on a tree that violates its own rule
FAIL → `ci:live-db-suites` implemented R2 ("no run-time DDL in a live-DB suite") as `text.includes('supabase/migrations') && text.includes('.unsafe(')`. Three suites executed DDL without naming a migration path and passed clean for months; one of them forced a transaction abort by adding a temporary CHECK constraint to `job_outbox` and dropping it in a `finally`. A vitest TIMEOUT skips the `finally`, so the constraint stranded on the shared test container and blocked every sibling suite that enqueues `zernio_initial_backfill` — 14 spurious failures across three suites, none of them code defects. WHY → the marker was a proxy for the thing, chosen because it was easy to grep. A proxy holds only as long as the correlation does, and nothing tested the correlation. Same shape as #592 (SQL audits keyed on a tag-name list the codebase had outgrown) one layer down. CORRECT → detect the thing itself: AST-extract every tagged template and every `.unsafe()` call, match DDL verbs over the extracted text only. **A CI audit needs tests for its PRECISION and its REACH separately** — reach fixtures assert a finding IS produced (they are what catch the detector going blind), precision fixtures assert real clean suites stay clean. A repo-wide "everything is clean" assertion catches neither: under a reach regression the offender list is empty and it PASSES. That trap is easy to write and reads as the strongest test in the file.

### [2026-08-08] #694 — a tag-NAME allowlist cannot see this repo's test-file SQL: `sql()` is a CallExpression
FAIL → the obvious implementation was to reuse `SQL_TAG_NAMES` / `isSqlTaggedTemplate` from `scripts/ci/lib/sql-tag-scan.ts`. A census of all 80 marker-passing live-DB suites: of 1469 tagged templates, `sql()` accounts for **770** — and its tag is a `CallExpression`, which that helper does not match (it handles a bare identifier or a property access rooted in one). `db!` (`NonNullExpression`, 73) is likewise invisible, plus one-offs `sqlA()`, `observerSql()`, `tierSql()`, `boundedSql`, `recorder!`, `handle`, `seed`, `client`. The name list would have seen ~530 of 1469 and missed the plurality. WHY → production code passes an executor as a typed parameter with a conventional name, which is what `SQL_TAG_NAMES` models; test files hold theirs behind a lazy getter (`sql()`) or a non-null-asserted `let`. Different idiom, same helper assumed to fit. CORRECT → in a file already proven to reach the live DB, PRESUME every tagged template is SQL — no name list to rot. Verified there is no competing tagged-template DSL in those files (no `it.each`, `css`, `gql`, `String.raw`); all 21 distinct tag forms are DB handles. `scripts/ci/lib/sql-tag-scan.ts` is therefore imported for `lineHasPragma` ONLY and left byte-identical: widening `SQL_TAG_NAMES` to cover test idioms would have silently changed the scope of four other audits. If you ever edit `SQL_TAG_NAMES`, know that `live-db-suites-audit.ts` deliberately does not consume it.

### [2026-08-08] #694 — fail-closed on unreadable SQL has a middle case: the PARTIALLY readable template
FAIL → the extractor treated a `ts.TemplateExpression` argument to `.unsafe()` as "statically readable" and matched DDL verbs against `arg.getText()`. For `sql.unsafe(\`${ddl}\`)` that text is the literal `` `${ddl}` `` — no verb, reported clean, straight through a stated fail-closed invariant. WHY → readable/unreadable was modelled as a binary. A template with substitutions is neither: its static spans are visible and its substitutions are not. Blanket fail-closed on the type would have flagged every legitimate mid-statement interpolation (`UPDATE … SET x = '${v}'`, the common fixture shape). CORRECT → a DDL verb can only BEGIN a statement, so fail closed exactly when a substitution stands at a statement-start position (prior static text, comments blanked, is empty or ends with `;`) and stay readable otherwise. Tagged templates need no such rule — Postgres.js parameterises their substitutions, so one cannot carry a statement. Companion lesson: when matching SQL text, blank comment bodies to EQUAL-LENGTH whitespace rather than deleting them, so every offset (and every reported line number) survives; a DDL verb in a `--` comment inside an executed template is not executed DDL.

### [2026-08-08] #694 — a `get`-only Proxy over a Postgres.js client must forward `begin`'s LEADING arguments
FAIL → `abortingExecutor` (the non-DDL replacement for the temporary-constraint abort) wrapped `.begin` by taking the callback off the end of `args` and calling `target.begin(wrapped)` with one argument. Postgres.js also supports `begin(options, cb)`, which this repo uses — `src/lib/escalations/list.ts:43` passes `'isolation level repeatable read read only'`. Any future caller whose writer used that form would silently lose its isolation level and the test would still pass. WHY → reading the callback as "the last argument" is correct and feels complete; it says nothing about the arguments before it. CORRECT → `args.slice(0, -1)` and spread them back: `target.begin(...leading, wrapped)`. Confirm empirically rather than by inspection — wrap a real client, `.begin('read only', write)`, and assert SQLSTATE **25006**, with a negative control (`.begin(write)` must NOT raise it) proving the option arrived rather than something else failing. Related: prefer `rejects.toMatchObject({ code })` over a `try/catch` plus `(err as { code?: string })` cast — the cast yields a bare `TypeError` when nothing throws, which is the case you most want a readable message for.

### [2026-08-08] #694 — `pnpm vitest run <file>` does not hydrate `.env.local`, so a live-DB suite SKIPS instead of failing
FAIL → running a touched integration suite directly reported success with zero tests executed. The suites gate on `process.env.TEST_DATABASE_POOL_URL`, and vitest does not load `.env.local` for them; `pnpm test:integration` works only because its npm script shells out to `dotenv` first. WHY → a skip and a pass look identical in a tail-truncated reporter, and this is the #520 class (an existing-but-not-run suite). CORRECT → `export $(grep -E '^TEST_DATABASE_POOL_URL=' .env.local | xargs)` before any direct `vitest run` of a live-DB suite, and read the TEST COUNT, not just the colour. Second-order trap from the same feature: `it.fails` on a repo-wide audit assertion is INVERTED at the eval commit — while the detector is still loose it finds nothing, the assertion passes, and `.fails` therefore goes red. `.fails` only becomes correct once the tightened detector surfaces real offenders.

## 2026-08-08 — #697 import consent analytics sink ship

### [2026-08-08] #697 — a `warn` is not a sink: swallowing an error into stdout is indistinguishable from having no error handling at all
FAIL → #679 correctly savepointed the two **Import offer** analytics emissions so a failed emission costs a metric instead of a Google Business Profile connect outage, and logged the failure with `createWorkerLogger(...).warn`. The comment said "a human should look." No human could: `warn` writes structured JSON to **stdout**, and this project's documented paging route is Sentry (`docs/runbooks/beta-launch-alerting.md` §1). Persistent migration-102 drift could have undercounted both one-shot events indefinitely with nothing alerting. WHY → "log it and continue" feels like handling. It is handling only if something *reads* the log; otherwise the swallow and a bare `catch {}` differ by a string nobody sees. The savepoint fix was reviewed three times and this gap survived all three, because every reviewer was checking that the failure didn't propagate — not that it arrived anywhere. CORRECT → when a catch block deliberately swallows, ask **"which configured alert would fire?"** and name it. If the answer is "someone greps Railway", the sink does not exist. The repo shape is `Sentry.captureMessage(msg, { level, tags: { subsystem, … }, extra })` **plus** the log line, the pair wrapped in its own `try`/`catch` — three sites now: `src/lib/llm/circuit-breaker.ts:185-205`, `src/lib/notifications/contact-notify.ts:46`, `src/lib/reviews/import-consent.ts`. `tags.subsystem` is not decoration: every Sentry alert rule here routes on it, so an untagged capture is durable but unroutable.

### [2026-08-08] #697 — an alert on a CONSTANT title groups into one Sentry issue, so a "new issue" rule fires exactly once, ever
FAIL → the first routing instruction written for the new tag mirrored the existing `subsystem:health_alert` rule ("issues tagged X at level warning → Discord"). But the capture title is a fixed string, so every occurrence — both event names, every business, both deployment lanes — groups into ONE Sentry issue. A rule triggered on *"a new issue is created"* would fire on the first drift event and then stay silent through the repetition that is the actual signal. WHY → Sentry alert conditions and Sentry grouping are designed independently, and the trigger most people reach for reads as "tell me about this problem." It means "tell me the first time." CORRECT → match the trigger to the message's cardinality. A constant-title `captureMessage` for a P2 wants an **event-frequency** condition (e.g. seen >3 times in an hour); a `captureException` with varying stack frames groups per-cause and a new-issue rule is fine. Both routing inventories (`docs/runbooks/beta-launch-alerting.md` §1 and `docs/launch-checklist.md`) now say so explicitly — and note there ARE two inventories, so a new tag must be added to both or they drift.

### [2026-08-08] #697 — `toMatchObject` cannot guard a "these fields and no others" invariant
FAIL → the tests asserted the Sentry `extra` payload with `expect(options.extra).toMatchObject({ business_id, event_name })`. The locked invariant was "only business_id, event_name and the error text leave the process — never the event `properties`, review text, tokens or handles". `toMatchObject` is a SUBSET matcher, so adding `properties: input.properties` to the payload shipped green through all 15 tests. Caught by the review axis, then confirmed by mutation. WHY → for a PII/redaction invariant the assertion target is the **key set**, not the values; a subset matcher is structurally blind to the only mutation that matters. CORRECT → `toEqual` with the exact keys, using `expect.stringContaining(...)` / `expect.any(String)` for values you cannot pin. Same rule for `tags`. Generalisation: whenever a test exists to prove something is ABSENT, a subset matcher is the wrong tool — and verify it by adding the forbidden field and watching it go red.

### [2026-08-08] #697 — mutation-test the ORDER of two statements, not just their presence
FAIL → two orderings in the new catch block were load-bearing and neither was pinned by the first implementation's tests: the code-less rethrow must precede the capture (or a mis-wired handle masquerades as schema drift in the alert channel), and the `warn` must sit OUTSIDE the capture's guard (or the only sink left on the transport-failure path is deleted). Both survived a green suite. Worse, moving the `warn` inside the guard is what "make it match the named precedent" looks like, so a future tidy-up would do it. WHY → tests naturally assert that things happened; asserting they happened in a particular relationship to each other requires deliberately constructing the failure of the *other* branch. CORRECT → for each ordering, write the mutation first and check it goes red before keeping the test. Here: a `console.warn` spy inside the throwing-capture test (with `mockRestore` in a `finally`, or the stub leaks into every later suite in the serialized `integration` project), and a "reports nothing to Sentry before it rethrows" title. Five mutations total, each verified to turn only its intended title red — that table belongs in the PR body.

### [2026-08-08] #697 — proving an observability change on staging without touching the schema
FAIL → the change only manifests when an analytics emission FAILS, but staging has migration 102 applied so it never does. The obvious staging proof — drop `analytics_events_event_name_check`, exercise the path, restore it — is destructive DDL on a shared database with a restore step that a timeout or a crash can skip (exactly the #694 stranded-constraint failure, one environment up). WHY → reproducing a constraint violation is instinctively read as "remove the constraint," when the violation is equally reachable from the other side. CORRECT → offer the constraint a value it already rejects. Same table, same constraint, same SQLSTATE, zero schema change. Wrap the whole thing in `sql.begin` and throw a sentinel at the end so nothing persists — including any state you set up to reach the emitting branch (no staging business satisfied `createImportOffer`'s four-way predicate, so the proof reset one INSIDE the aborted transaction). Assert the branch actually ran (`offer_outcome === 'created'`), because an absence-shaped proof looks identical to an injection that silently stopped firing. Resolve the resulting Sentry issue immediately with an activity-feed comment marking it synthetic, and tag the event (`proof: <issue>`) so it is self-identifying later.

## 2026-08-08 — #695 import consent enforcement locus + block reason ship

### [2026-08-08] #695 — a shared mock recorder makes its optional field unassertable, so the eval passes while the feature is unbuilt
FAIL → three of the four new `guardImportConsent` titles went GREEN at the eval commit, which is the one thing a failing eval may not do. Two causes compounded, both invisible from the plan text: the recorder array was shared by the plain writer AND the new reason writer, so `reason` had to be declared optional; and the vocabulary member did not exist yet, so `expect(calls[0]!.reason).toBe(OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED)` compared `undefined` to `undefined` and passed. Three rounds of adversarial plan review, briefed explicitly with "can this eval pass while the feature is still wrong?", all missed it — the hole is not in the prose, it is in the type. WHY → an assertion against a not-yet-existing constant is an assertion against `undefined`, and `toBe(undefined)` is satisfied by any recorder that did not record. CORRECT → assert the *writer* was called (`expect(mockWriter).toHaveBeenCalledTimes(1)`), not just the recorded shape; and give each writer its OWN recorder so the discriminating field can be **required** rather than optional. Once the field is required, a regression to the other writer leaves the array empty and the assertion throws instead of silently passing. A negative pin that holds before AND after the change (here: "stamps no reason when consent is accepted") is a regression guard, not an eval — do not force it red, it would mean asserting something false.

### [2026-08-08] #695 — when a call site swaps writers, grep the suites that MOCK the module, not the importers of the deleted symbol
FAIL → T1/T2/T3 each ran only the five test files the plan enumerated and each reported green; the whole-repo `pnpm test` gate row then went RED on a SIXTH file with `No "markOutboxCompletedWithReason" export is defined on the … mock`. WHY → the round-1 review had already caught one extra reference site and the lesson was recorded as "count the references" — but that was applied to the *deleted symbol* and not to the *changed call site*. They are different searches: `rg markOutboxOwnerUnreachable` finds files importing the removed export; only `rg 'vi\.mock\(.*shared/outbox'` finds files that stub the module and assert on the writer the call site no longer uses. A module mock that omits the new export fails at CALL time, so typecheck cannot see it either. CORRECT → after changing which function a call site invokes, enumerate every suite that mocks that module and check each one's factory and assertions; and never treat targeted per-suite runs as coverage for a module-level rename — only the whole-repo run is authoritative. Corollary for triage: the 29 assertions in that file that legitimately still name the plain writer must be left alone; retargeting one to make the suite pass would mask a real regression.

### [2026-08-08] #695 — `job_outbox.completion_reason` is a 7-DAY operational signal, not an audit record
FAIL → the ticket promised refusals would be "durably queryable" via `completion_reason`. `ArchivalPoller.ts:60` deletes completed `job_outbox` rows 7 days after `completed_at`, and a policy refusal is *completed* (skip-as-success), never failed — so it takes the 7-day arm, not the 90-day dead-letter one. The adversarial review axis found it; three plan rounds and two implementation agents did not. WHY → the whole `OUTBOX_COMPLETION_REASON` vocabulary inherits the archival life of the table it lives on. `owner_unreachable` (ADR 0010) has always had the same 7-day life, so nobody had ever had cause to state the limit. CORRECT → before promising durability from a `job_outbox` column, read the archival arm for that row's terminal status. If the question being answered outlives 7 days ("did we import without consent?"), the answer belongs on the domain row (`businesses.import_decision`), not the dispatch row. When the implementation is right and only the CLAIM is wrong, fix the claim — do not expand scope into a second sink; here that would have contradicted a locked non-goal and coupled the shared archival arm to one domain, the exact coupling the same ticket's ADR rejects. Confirmed live on staging: the 10 pre-existing `zernio_initial_backfill` completed rows all carry NULL, so NULL genuinely does not mean "genuine import".

---

## 2026-08-08 — #680 legacy backfill-counter DROP (migration 103)

### [2026-08-08] #680 — `SET LOCAL` in a migration is a no-op that only WARNS, because this repo applies migrations one autocommitting statement at a time
FAIL → migration 103 pinned `search_path` with `SET LOCAL search_path = public, pg_temp` to stop a same-name temp table capturing the whole migration. It would have done nothing at all. WHY → `SET LOCAL` takes effect only inside a transaction block; outside one it emits `WARNING: SET LOCAL can only be used in transaction blocks` and is discarded. `scripts/test-db-setup.sh:53` applies each file with plain `psql -v ON_ERROR_STOP=1 -q -f "$migration"` — no `--single-transaction` — and no migration in this repo carries its own `BEGIN`/`COMMIT`, so every statement autocommits separately and the setting never reaches the later `DO` and `ALTER`. This is the dangerous shape, not a loud one: the migration applies cleanly, the shape suite stays green, and the hole the statement was written to close stays wide open behind a statement that reads exactly like its remedy. Only an adversarial review round caught it, on the third pass. CORRECT → use session-level `SET`, which is correct under BOTH autocommit and a transaction-wrapped apply, and is already the house precedent (099/100/101/102 all use bare `SET lock_timeout = '5s'`). Generalisation: before trusting any migration statement whose whole job is to affect LATER statements, confirm the apply path actually shares a session/transaction with them — `SET LOCAL`, `SET CONSTRAINTS … DEFERRED` and advisory locks all evaporate the same way. State the resulting scope explicitly: a session-level `SET` persists for the rest of that psql session, so a future migration sharing a session inherits it.

### [2026-08-08] #680 — `String.match()` without the `/g` flag cannot count matches, so an "exactly one" assertion written with it is inert
FAIL → a shape-suite test asserted the migration contains exactly one `DO $$ … $$` block via `executableSql.match(/DO \$\$[\s\S]*?\$\$\s*;/).length === 1`. It would have passed with two blocks, or twenty. WHY → without `/g`, `.match()` returns a *single-match* array whose shape is `[full, ...captureGroups]`, so `.length` is 1 for any successful match regardless of how many exist in the string; only `/g` returns the array-of-all-matches whose length means what the assertion assumed. The test read as a real constraint and enforced nothing. CORRECT → count with `[...s.matchAll(re)].length` or a `/g` regex, and treat any `.length` on a non-global `.match()` result as a bug. Better still, avoid the whole class: for an immutable artefact like a landed migration, pin the entire normalised text against a canonical constant rather than trying to count and allowlist its parts — one assertion that cannot be partially satisfied beats several that can.

### [2026-08-08] #680 — a `table_schema = 'public'` literal cannot follow a `pg_temp` shadow, which makes the suite that depends on it self-contradictory
FAIL → migration 103's preflight guard checked for its own columns via `information_schema.columns WHERE table_schema = 'public'`, while the tests that prove the guard's failing branch shadow the real table with a `pg_temp` replica under `SET LOCAL search_path = pg_temp, public`. The two cannot coexist: temp tables report their own `pg_temp_N` schema and never `public`. WHY → it made one suite demand two incompatible database states — the final-state test needs `public` to be POST-103 (columns absent) while the guard test needs the existence check to find them PRESENT — and the guard test is the *only* one that can prove the guard fires at all, since on clean data a working guard and a broken one both report zero abort rows. CORRECT → resolve through `to_regclass` + `pg_attribute` (with `AND NOT attisdropped`, since `pg_attribute` retains dropped columns as tombstones) so the check follows `search_path`: it resolves to `public` in a real apply and to the replica under the shadow, letting the test execute the migration's own verbatim text. Pair it with an explicit session-level `SET search_path` in the migration so the real apply is deterministic rather than merely probable.

### [2026-08-08] #680 — `ci:live-db-suites` counts an unreadable `.unsafe()` argument as DDL, so a dynamically-executed guard needs its OWN pragma
FAIL → a shape suite executed a migration's `DO` block read from disk via `tx.unsafe(guardSql)` and would have failed `ci:live-db-suites`, even though that block runs no DDL and the transaction always rolls back. WHY → by design: `scripts/ci/live-db-suites-audit.ts:264-276` records an `.unsafe()` call whose argument it cannot statically read with `text: null`, and `unpragmaedDdlLines` treats `sql.text === null` as DDL — its header states the rule outright, "an unreadable `.unsafe()` argument counts as DDL: unresolvable SQL must never pass as safe". A runtime variable is by definition unreadable. CORRECT → budget TWO `-- live-db-ddl-ignore: <reason>` pragmas for a suite that both builds a `pg_temp` fixture and dynamically executes migration text, each carrying its own distinct reason. Do not try to make the argument statically readable to dodge the rule — executing the migration's real text is the whole point of the test.

### [2026-08-08] #680 — a preflight that never fires is indistinguishable from a working one, so prove the FAILING branch or the gate is theatre
FAIL → the plan's first draft documented the reconciliation query in the migration header for an operator to run by hand, and the shape suite text-searched that comment for two substrings. Both environments were already clean, so a guard with an inverted predicate, a typo, or no effect at all would have produced identical evidence: zero abort rows, migration applies, everyone satisfied. WHY → clean data carries no information about a gate. Apply-time evidence can only ever confirm "nothing aborted", which is equally consistent with "nothing needed to abort" and "the gate is broken". CORRECT → make the gate an executable statement inside the migration (it cannot then be forgotten), and prove its RAISING branch in a test by executing the migration's own guard text against a seeded replica. Mutation-test the predicate afterwards: swapping #680's two-branch disjunction for the naive `collapsed = legacy sums` form turned the passing-branch test red, which is what demonstrates the test discriminates. The live payoff was concrete — staging's apply-window preflight returned `unreconciled_two_branch=0` alongside `unreconciled_naive=2`, i.e. the naive predicate would have aborted the migration on two perfectly healthy rows.

### [2026-08-08] #680 — a plain `psql` migration cannot be proven by boot readiness; probe the worker's own statement shapes inside a `DO` block that RAISEs
FAIL → after dropping four columns, `/ready` returning `postgres: ok` proves only that the worker connects — it says nothing about whether the worker's INSERT/UPDATE still resolve, and no natural import run had occurred since the drop. WHY → the failure mode a column DROP introduces is `42703 undefined_column` at statement-execution time on a specific write path, which a health probe never exercises. CORRECT → execute the worker's OWN statement shapes against the live post-migration schema inside `DO $$ … RAISE EXCEPTION 'PROBE OK …' … $$`, which reports success through the error channel and guarantees rollback, so it is safe on a real environment. Incidental but useful: the first attempt failed `23505` on `zernio_backfill_runs_one_initial_per_business` rather than `42703` — a statement only reaches a uniqueness check AFTER column resolution, so even that failure was evidence the column set was valid. Re-run with a lane the partial index does not cover.
---

## 2026-08-08 — #706 live-DB helper scan ship

### [2026-08-08] #706 — an AST walk that visits the PRODUCING node is only as wide as its file set, and a Postgres.js fragment moves the producer into another file
FAIL → `ci:live-db-suites` audited only files matching `*.test.ts`/`*.test.tsx`, so DDL built inside a `__tests__/` helper was invisible: a helper exporting `` sql`ALTER TABLE …` `` and a suite executing it as `` sql`${addCheck}` `` both audited clean, and `live-db-suites-audit: passed` printed over a tree taking ACCESS EXCLUSIVE on `job_outbox`. WHY → Postgres.js routes a nested `Query` substitution through `fragment()` and splices it in as raw SQL **text**, not as a bind value, so the suite really executes the helper's statement while carrying no DDL text of its own. #694's defence — "the walk visits the producing node, so a smuggled fragment is caught where it is built" — is true, but only within a file the walk actually reads. CORRECT → scan every `.ts`/`.tsx` under `__tests__/` (904 → 917 files), and split the enforcement unit rather than applying both rules to both kinds: R1 **naming** is a claim about which vitest project a file lands in, so it can only be asked of a SUITE (a helper renamed `*.integration.test.ts` would run as an empty suite); R2 **DDL** and the lock check ask whether a statement takes ACCESS EXCLUSIVE, which is true wherever it was written, so they apply to every live-DB FILE. Helpers need their own reachability marker — they are HANDED their handle and so name none of the suite-shaped `LIVE_DB_MARKERS`, but they cannot avoid TYPING it, so an import of `postgres` (value or `import type`; five of the six use `import type`) is the gate, in either spelling — the `from 'postgres'` clause and the inline `import('postgres').Sql` type, which carries no `from` clause and is already this tree's idiom for handing a fake handle to something. Deliberately not offered to suites, and the reason is what R1 MEANS, not noise volume: naming is a claim about which vitest project a file lands in, and a mock-shaping type import is not evidence that a suite reaches a database. The volume is real too — many suites match the marker while reaching no database, and many of those are neither already visible through `LIVE_DB_MARKERS` nor named `*.integration.test.ts` — so admitting it would fire R1 across the tree on files that touch no DB. (The census and its recount method sit in the module's `HELPER_DB_MARKER` JSDoc and are deliberately not copied here: they move whenever a test file is added or renamed.) `src/lib/shared/__tests__/helpers/apply-migration-074.ts` was the one real occurrence — it runs `db.unsafe(readMigration074Sql())`, had never been audited, and is now allowlisted **and** lock-enforced against its own `withMigration074ApplyLock`; mutation-proved by stripping the lock marker and watching `unlocked-ddl` appear. Two bounds remain, both stated in the module: a fragment built outside `__tests__/` entirely (a `src/` module a suite imports) and the `e2e/` Playwright lane, which owns its own database lifecycle. General rule: a static analysis whose correctness argument is "it sees the producer" owes a statement of which files it reads — the argument and the file set are one claim, not two.

### [2026-08-08] #706 — an absolute written about a narrow text-presence check is a false claim; state what the code literally does
FAIL → two independent review rounds found the same defect class in one module, and **every instance was a comment, not code**. Three from this ticket: (1) `OWN_APPLY_LOCK`'s `BOUND:` said `unlocked-ddl` "can never fire" for `apply-migration-074.ts` — it does fire; rename or delete `withMigration074ApplyLock` and the finding appears, which is the mutation three shipped docs cite as proof of enforcement. (2) The module header defined a SUITE as "a file vitest runs", hundreds of lines above an `isSuite` JSDoc that had just been corrected to deny that equivalence — the predicate is a filename **suffix** test, and `src/lib/shared/index.test.ts` is matched by no vitest include glob yet classifies as a suite. (3) A `BOUND:` paragraph listed a handle typed `unknown` and cast as invisible to `HELPER_DB_MARKER`, in the same commit that widened the regex to match exactly that form and shipped a test asserting it is matched. WHY → each absolute was written *about* a mechanically narrow check and quietly generalised it. The 074 check is `text.includes(OWN_LOCK_MARKER)`: it reads the identifier's **presence, not its position**, so what it genuinely cannot do is distinguish DDL inside the wrapper from DDL hoisted out of it — a true and useful bound. "Can never fire" is a different, larger, false claim, and it is the dangerous direction: a maintainer who believes it concludes the allowlist entry is inert, removes it, and CI goes red with the finding the comment promised was impossible. The failure is not sloppiness — an absolute reads as the stronger, more helpful sentence, which is exactly why it gets written. CORRECT → in a guard module whose prose IS its spec, every claim must describe what the code literally does and be checkable beside it. Prefer the shape "the check is X, so it cannot distinguish Y from Z" over "Z can never happen": a bound stated as a mechanism survives a refactor, a bound stated as an absolute is falsified by one. Verify each claim by **mutation before writing it**, not after — all three above were settled in seconds by editing the real file text and re-running the audit. And when one fact has two owners (a module header and the mechanism's own JSDoc), correcting one and leaving the other is how a module ends up defining its central term two incompatible ways.

### [2026-08-08] #706 — a guard module whose prose is its spec carries a documentation multiplier; budget it as its own cost centre
FAIL → the `/feature` step-5 `reclassify` trigger fired at **2.15×** — 280 production changed lines against `estimated_prod_lines: 130`. Step 0 was re-run as the workflow requires, and the lane came back **CONFIRMED, not changed**: the executable change was **32 lines**. The whole overrun was prose — 144 comment lines inside the audit module plus 52 across four repo docs (`CLAUDE.md`, `lab-notes.md`, `currents.md`, `progresstracking.md`), and the deviations record puts the full prose cost near 250 lines once the review rounds' own corrections are counted, roughly **8:1** against the code. WHY → this module's convention requires every mechanism to declare its blast radius in a `BOUND:` paragraph, and the change retired claims that four durable documents asserted as still open. Neither cost tracks lines of code, so estimating from the code was not a small arithmetic miss — it omitted a whole cost centre. The trigger's stated premise fails here too: "the heavier lane's controls exist for exactly this feature" does not hold when the overrun is documentation, because no heavier control (a staging ride, a merge pause) addresses prose volume. Second-order effect this ticket demonstrated: **each review round's corrections are themselves fresh claims**, so prose grows superlinearly with review depth — round 2 produced five findings and **every one was a defect introduced by a round-1 fix** (four on the standards axis, one on spec), all of them prose. CORRECT → when estimating a ticket against a module of this shape — every mechanism owes a `BOUND:`, and the change retires claims in `currents.md`/`progresstracking.md`/`lab-notes.md`/`CLAUDE.md` — budget the documentation separately from the code, the same way `estimated_diff_size` already has to budget production and test lines separately (#643). Do **not** amend `estimated_prod_lines` afterwards to clear the WARN: the intake is the record of what was predicted, and editing it defeats the trigger for the next feature. Leave the WARN standing and record why.

## 2026-08-09 — #729 generate-tx extraction ship

### [2026-08-09] #729 — the /feature edit-surface hook and feature-surface-audit DISAGREE on Next.js dynamic-segment paths; declare BOTH spellings

An `allowed_edit_surface` entry containing `[reviewId]` can never satisfy both
enforcement layers with one spelling. The bash hook (`edit-surface-guard.sh`)
matches with `[[ == ]]` globs, so `[reviewId]` is a character class — the
entry silently matches nothing and every in-scope edit is blocked; it needs
`\[reviewId\]`. `scripts/ci/feature-surface-audit.ts` `globToRegExp` escapes
every literal char (only `*`/`?` are wild), so it needs the UNESCAPED form and
reads `\[` as a literal backslash — its header's claim that its semantics
match the hook's is false for character-class characters. CORRECT APPROACH:
declare both spellings side by side (each matcher is satisfied by one entry;
the other is inert under `.some()`), and treat the dual entry as one surface
item. Root fix (aligning the two matchers) is unowned as of #729.
#726 refinement: when the two intake copies stay separate, each can carry
ONLY its consumer's spelling — the committed docs copy (read by
`ci:feature-surface`) unescaped, the gitignored `.feature/intake.json`
arming copy (read by the bash hook) escaped. Both-spellings-in-one-list is
required only where a single copy feeds both matchers; #726 shipped green
with the split spelling (deviations D4).

### [2026-08-09] #729 — postgres.js `TransactionSql` is NOT assignable to `Sql`; fragment helpers must take the union

`statusArraySql(tx, …)` failed TS2345: postgres.js types `Sql` and
`TransactionSql` as SIBLING interfaces (both extend `ISql`; `TransactionSql`
lacks `CLOSE`/`END`/`PostgresError`/`options` + more), so a helper typed
`(sql: Sql, …)` rejects a transaction handle even though the runtime tag call
is identical. Passing the singleton from inside a domain module instead would
violate invariant #15. CORRECT APPROACH: shared SQL-fragment helpers accept
the caller's client as a union — `SubscriptionSql` in
`src/lib/shared/writable-subscription.ts` is the named precedent;
`statusArraySql` (`src/lib/shared/response-status-sql.ts`) joined it at #729.

## 2026-08-09 — #728 content-freshness gate ship

### [2026-08-09] #728 — verify-gate ran a changed publisher integration suite against vitest.setup's dummy localhost:5432

- [2026-08-09] The `/feature` step-5 gate ran
  `autopilot-entitlement-concurrency.integration.test.ts` (changed by a
  mechanical unwrap of persist's new discriminated-union return) and the
  suite burned its 30s timeout plus an unhandled ECONNREFUSED against
  `localhost:5432` → `scripts/verify-gate.sh` resolves
  `TEST_DATABASE_POOL_URL` but not `DATABASE_POOL_URL`, and that suite
  transitively imports the `src/lib/db/server` singleton (stripe
  `subscription-updated` ingress → `resolveAccountReference`), whose path
  needs `DATABASE_POOL_URL` — so it got vitest.setup's dummy value while the
  suite's own live-DB reads resolved fine (`fallow.yml` CI is immune because
  it already exports BOTH) → export BOTH vars to the test DB when invoking
  the gate; a pre-existing suite requirement, surfaced only because the
  suite became "changed". Permanent fix (the gate script owning the second
  var) filed as **#744** — `verify-gate.sh` was outside #728's surface.

### [2026-08-09] #728 — the (reviewId, version) idempotent-generation cache served a stale draft to live-ingest's same-version replacement job

- [2026-08-09] The persist-boundary content-freshness gate (ADR 0017) was
  deterministically defeated in the exact race it exists to close — found by
  the adversarial branch review as a NO-SHIP: live-ingest's replacement job
  legitimately shares the in-flight job's `(reviewId, version)` cache key,
  so it was served the stale H1-cached draft, and its own gate compared
  H2==H2 and persisted the stale text as fresh → the cache's identity
  carried no content provenance while its key is designed to be shared by a
  colliding job — key equality is not content equality, and ADR 0017's
  convergence argument implicitly assumed the replacement job REGENERATES →
  any cache whose key can be shared by a replacement job must bind its
  PAYLOAD to content provenance: `CachedGeneration.reviewContentHash`,
  cache-read accepts ONLY strict equality with the current attempt's loaded
  hash, `null===null` passes for legacy entries, provenance-less or
  mismatched entries are rejected + cleared best-effort (corrupt-payload
  precedent). Direct cache writers must stamp provenance too — the
  avoid-facts guardrail's `setCachedGeneration` overwrite, left
  provenance-less, would turn the documented retry-hits-cache economy into
  a fresh re-spend. Deliberately NO clear-on-skip in the gate: the
  provenance check is the one owner of cache validity (a second guard is
  two-owner drift).

## 2026-08-09 — #730 open-flag predicate consolidation ship

### [2026-08-09] #730 — the /feature surface globs have TWO matchers with disjoint escape semantics

- [2026-08-09] The intake's `src/app/api/dashboard/reviews/[reviewId]/…`
  surface entries never matched their own paths, blocking the T1/T4 edits →
  `edit-surface-guard.sh` matches with bash `[[ == ]]` (unquoted pattern), so
  `[reviewId]` parses as a character class; meanwhile the merge-time mirror
  `scripts/ci/feature-surface-audit.ts` (`globToRegExp`) escapes EVERY
  non-wildcard char, so the same entry matches literally there — and the
  escape fix (`\[reviewId\]`) inverts the failure: bash matches, the TS
  audit demands a literal backslash in the path → the ONLY spelling both
  engines accept is the `*` wildcard
  (`src/app/api/dashboard/reviews/*/draft-status/…`). Verify any
  non-alphanumeric surface entry against BOTH engines before locking an
  intake; the audit's own header ("character classes are NOT supported (no
  intake uses them)") is the contract — bracketed Next.js route dirs go in
  as `*`.

### [2026-08-09] #730 — a composable SQL fragment's BUILD calls break every ordered-mock double downstream of it

- [2026-08-09] Re-expressing `hasOpenFlag` on `openFlagExistsSql` (and
  composing the fragment at 8 call sites) broke 21 tests across 5 suites in
  two waves — 9 failures in 3 suites surfaced at T4, 12 more in 2 suites
  only at the gate's whole-repo run — none of them in the suites the
  per-task run commands covered → a Postgres.js fragment is BUILT with
  tagged-template calls (`tx`${id}::uuid``, the `EXISTS (…)` body) that a
  queue/positional test double counts as executed statements, shifting or
  consuming every later ledger position (409s from a mis-read held probe;
  empty dashboard payloads) → when a shared helper gains fragment
  composition, EVERY suite whose double flows through it needs the
  fragment-aware branch BEFORE its first post-change run:
  `isExecutedStatement = /^\s*(select|insert|update|delete|with)\b/i` on the
  joined template strings; build calls return `{ fragmentText, values }` and
  never touch the queue; positional assertions re-point to an executed-only
  capture (`txExecutedCalls`), never renumber. 7 suites now carry the
  pattern verbatim (extract a shared helper at the next consumer —
  rule-of-three is at its boundary); `worker/__tests__/helpers/mock-sql.ts`
  needs nothing — it already flattens fragments without consuming, so
  flattening-harness suites assert the fragment SQL inside the parent text
  instead of as captured build calls.

### [2026-08-09] #730 — two live-DB integration suites fail on LOCAL env shape, not code (forced --no-verify staging pushes)

- [2026-08-09] The lefthook pre-push `test-changed` blocked both staging
  pushes on 3 failures in suites #730 never touched →
  `migration-056-account-offboarding.integration.test.ts` (RLS behavioral:
  expects `permission denied` as the `authenticated` role, gets
  `relation … does not exist` — the local `postgres:16` container's
  `authenticated` role lacks the schema USAGE grant real Supabase has) and
  `autopilot-entitlement-concurrency.integration.test.ts` (WS8 publisher
  linearization) fail IDENTICALLY at base on a green-gate tree — they are
  in the "run only when invoked directly" class (the #520 gap), so no gate
  or CI lane had ever run them against the local container → pushed
  `--no-verify` twice with the evidence recorded; UNRESOLVED: either
  provision the local container's `authenticated` role to Supabase shape in
  `test:db:setup`, or move both suites onto an env-shape allowlist that
  skips-loudly locally — ticket-worthy, not yet filed. (Also: the
  `staging-ride` worktree has no `.env.local`, so #719's drip-eval
  precondition test fails there unless `TEST_DATABASE_POOL_URL` is exported
  on the push command.)

## 2026-08-09 — #731 deferred maintainability bundle ship

### [2026-08-09] #731 — never measure a feature's diff against `origin/main`; measure against `git merge-base origin/main HEAD`

- [2026-08-09] Twice in one run a moved baseline was misread as real code
  movement: first a sibling PR (#747) whose `git diff origin/main --
  src/lib/past-replies/load-replies.ts` showed a 15-line change that
  *inverted* #730's just-merged `openFlagExistsSql` composition — reading as
  a revert of merged work on a file this bundle edits — and then, after #747
  actually landed on `main` mid-run, `git diff origin/main --numstat`
  reported **3,075 changed production lines against a 200-line estimate**
  (15×), which fires `/feature`'s reclassify trigger and under the abort
  criteria argues for tearing the branch down → diffing a branch against a
  moved `main` renders every commit the branch has not merged yet as an
  *outgoing* change, so a stale branch's diff shows the newer commit
  backwards and a long-running branch's diff shows the whole of `main`'s
  progress as its own; the true figures were 290 prod / 430 test, both under
  the 2× threshold, and `comm -12` over the two changed-file lists was empty
  → always measure a feature's own diff, and any collision check against an
  open PR, from `git merge-base origin/main HEAD` (or the PR's own merge
  base), never from `origin/main`. `scripts/verify-gate.sh`'s `reclassify`
  row already does this correctly; the hand-run measurement is what needs the
  discipline, and knowing the trap in the abstract did **not** prevent
  walking into it a second time two hours later — the symptom (a huge
  unexplained diff) does not resemble the cause (a moved baseline), and it
  surfaces at exactly the moment the workflow asks you to judge scope creep.

### [2026-08-09] #731 — a `CROSS JOIN LATERAL (SELECT EXISTS (…))` read by two `COUNT(*) FILTER`s is NOT one shared evaluation

- [2026-08-09] Merging the Reviews list's two group-denominator `COUNT`s into
  one snapshot via `CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM
  responses p WHERE p.review_id = r.id AND p.status = 'posted') AS has)` +
  `COUNT(*) FILTER (WHERE NOT posted.has)` / `FILTER (WHERE posted.has)`
  shipped a large read regression that both round-1 review axes found
  independently → Postgres pulls the single-row LATERAL up and plans **one
  correlated SubPlan per reference** (SubPlan 1 *and* SubPlan 3, each
  `loops=20000`), so the "the EXISTS is evaluated ONCE" premise is false and
  the shape forfeits the hash semi/anti-join the two deleted `EXISTS` /
  `NOT EXISTS` counts each got. Measured on Postgres 16 with the
  production-shaped partial index at 20k reviews for one location:
  **~81–261× planner cost**, **~137× buffer accesses** (586 vs 80,206) and
  2.5–13× execution, direction reproducing across three runs on two
  independently-built fixtures → for a two-way partition count, `LEFT JOIN
  responses p ON p.review_id = r.id AND p.status = 'posted'` +
  `COUNT(*) FILTER (WHERE p.review_id IS NULL)` /
  `FILTER (WHERE p.review_id IS NOT NULL)` — a Hash Right Join, and the
  partition is closed *arithmetically* because a LEFT JOIN preserves every
  review and `IS NULL` / `IS NOT NULL` is a total split. The join cannot
  multiply rows because `responses_one_posted_per_review` (migration 031) is
  `UNIQUE (review_id) WHERE status = 'posted'`; that index guarantee is what
  makes the shape safe, and it is the same join, on the same index, the
  file's main row source 160 lines above already treats as load-bearing —
  declining a second dependency on it bought nothing and cost an order of
  magnitude.

### [2026-08-09] #731 — never justify a SQL shape with an unverified planner claim in a comment

- [2026-08-09] The regression above shipped *because* its rationale comment
  asserted a planner behaviour ("the EXISTS is evaluated ONCE in the
  LATERAL") that nobody had run `EXPLAIN` against; the sentence then read as
  the reason not to question the shape, and a second comment in the same
  change compounded it ("the FILTER predicate is an EXISTS, not a join", used
  to explain why a review with multiple posted responses counts once) →
  a plausible planner story is indistinguishable from a measured one once it
  is written in the imperative voice next to the code it defends, and common
  subexpression elimination across `FILTER` references is exactly the kind of
  optimisation a reader will assume rather than check → state only
  independently checkable facts in the comment (an index's uniqueness
  guarantee, a join's totality, a predicate's exhaustiveness) and put
  measurements in the commit message, where they carry their date and their
  fixture. The replacement comment re-makes **no** planner assertion.

### [2026-08-09] #731 — landmine enumeration before a query merge needs a THIRD category of dependent assertion

- [2026-08-09] Merging two queries into one broke a pre-existing #678 title
  the plan's recon never named — `'loadPastRepliesPageView averages star
  rating over all reviews, not only replied ones'` locates the AVG query with
  `/AVG\(/i` and then asserts `expect(avgQuery.text).not.toContain("'posted'")`,
  which the merge falsifies by putting the partitioning predicate in the same
  template → the recon enumerated assertions that (i) **count** queries and
  (ii) **dispatch** on query text, but not assertions that (iii) **identify**
  a query by text and then constrain its *contents*; a merge changes what a
  text-matched query contains, not only how many queries exist, so category
  (iii) is the one that bites → before merging or reshaping a query,
  enumerate all three categories. The title's *claim* survived intact (the
  AVG's row set is still `FROM reviews r WHERE r.business_id = …`, one
  conjunct); only its mechanism was an artefact of the AVG having had a
  template to itself, so both original assertions were re-applied to the
  strip remainder plus two positive `FROM`/`WHERE` pins — no assertion
  deleted, no title text changed. Related but distinct from #730's
  fragment-blast-radius note above, which is about *build calls* consuming an
  ordered mock's queue positions; this one is about the *text* a surviving
  assertion matches on.

### [2026-08-09] #731 — `ci:tenant-scope` cannot tell you the snippet it wants, and every allowlist regeneration hits that wall

- [2026-08-09] The plan's step said to take the expected `sqlSnippet` "from
  the failure output", and warned correctly that a guessed snippet is the #1
  way the step burns a round — but the audit prints only `file: table:
  reason` triples → `TenantScopeFinding`
  (`scripts/ci/tenant-scope-audit.ts`) carries **no SQL field**, so there is
  nothing to paste, which makes the step a dead end rather than a nuisance
  → derive the snippet by reusing the audit's own machinery, which is what
  the match keys on (`getAllowlistEntry` compares
  `normalizeSql(stripSqlComments(x))` on both sides): import
  `extractSqlTemplates` from the audit module in a throwaway script, apply
  the same comment-strip + whitespace-collapse, and print the template you
  are re-pinning. Landed 408 (baseline 408) first try, no burned round. Five
  regenerations have now hit this wall (420→418→414→412→409→408); the durable
  fix is to put the normalised SQL on the finding (preferred) or export
  `normalizeSql`/`stripSqlComments`, which are module-private — worth its own
  ticket.

### [2026-08-09] #731 — a grep gate that forbids an identifier forbids it in prose too

- [2026-08-09] Two plan steps demanded an identifier appear nowhere
  (`rg -n "peekRegenBudget\b"` → no hits; `rg -n
  "PAST_REPLIES_VIEW_ENABLED" worker/` → no hits) while sibling steps
  supplied verbatim replacement **comments** that legitimately named it, so
  following the plan literally guaranteed the gate reported a hit whose
  stated triage was "STOP and report" → `rg` cannot tell a call site from
  prose, and a retirement comment's whole job is often to name the thing it
  warns you off re-adding → scope such a gate to code
  (`rg … | rg -v '^\S+:[0-9]+:\s*//'`) and decide per comment whether the
  identifier earns its place: #731 **dropped** it where the comment merely
  records a completed consolidation (the fact survives without the name, and
  `git log -S` still finds it via the commit subject) and **kept** it where
  the comment exists to stop a retired flag being reintroduced — the same
  reason CONTEXT.md names it.

### [2026-08-09] #731 — never verify a type-level guarantee by grepping for the enclosing function name

- [2026-08-09] The plan proved its `Required<Pick<…>>` slice by deleting a
  field and running `pnpm typecheck 2>&1 | grep -A2 'orphanReplyFacts'`,
  whose stop condition ("if it does not appear this refactor is unsafe")
  fires a **false STOP on a correct refactor** — the grep emits zero lines →
  TypeScript anchors a structural-assignability error at the offending
  object literal's position and describes the two structural types; it never
  names the enclosing function → grep the file and the error code:
  `pnpm typecheck 2>&1 | grep -E 'replies-view\.ts.*TS27(39|41)'`. Note the
  code: **TS2741** is the single-missing-property form (what one deleted
  field actually reports, observed at `replies-view.ts(257,3)` naming
  `failed_response_id`), **TS2739** the ≥2-properties sibling — a proof
  command pinned to the wrong one of the pair also emits nothing.

### [2026-08-09] #731 — under concurrent subagent dispatch, commit with a pathspec

- [2026-08-09] Two parallel task agents independently reached for
  `git commit -m … -- <files>` instead of the plan's `git add` + `git commit`
  → `git commit` with no pathspec commits the whole **index**, so a sibling
  agent staging a file between one agent's `add` and its `commit` is swept
  into the wrong commit (both agents were editing the same worktree; one
  confirmed via `git status --porcelain` between the two calls that a
  sibling's two dirty files happened to be unstaged at that instant — luck,
  not a guarantee) → the pathspec form is the default for any parallel-task
  bundle; it cannot capture another agent's work no matter the timing. Worth
  carrying in the plan template's concurrency note.

### [2026-08-09] #731 — estimate the test-line bucket bottom-up from pinned titles × suites, never as a ratio of the production estimate

- [2026-08-09] The gate's `reclassify` row went WARN on the **test** bucket
  after the review-fix round (490 actual vs a 230 estimate, 2.13×), forcing a
  full step-0 re-derivation that came back **lane unchanged** on all three
  axes → the estimate had been anchored to the production figure at ~1.15:1,
  which is verbatim the #643 mistake the intake guidance warns about; the
  actual ratio (490/323 ≈ 1.52:1) is unremarkable for a feature whose
  deliverable is 14 pinned titles across five suites plus a live-Postgres
  partition guard, and the largest single contributor was tests added
  *because* the review found a coverage hole — a trigger that pushes toward a
  heavier lane for having fixed a review finding is reading its own signal
  backwards → count the test bucket bottom-up (14 titles × ~25 lines of
  body/fixture + harness reshaping in 5 suites ≈ 450, which trips nothing).
  Correct the estimate in the retrospective, never the intake — and record
  the reasoning, because a WARN reasoned past without a written record is
  indistinguishable from a WARN that was ignored.

---

## 2026-08-09 — #719 onboarding drip: dropped column, invisible failure, unbounded churn

### The 034 dropped-column class
- [2026-08-09] `onboarding_drip` never once completed on staging (93 failed rows, 0 completed) → `handleOnboardingDrip` read `users.business_id`, dropped by migration 034 on 2026-05-10, throwing `42703` after claiming the drip-log row and before sending; three sites shared it (`OnboardingDripWorker` ×2, `ownerHasDashboardAuth`, the latter latent in `WeeklySummaryWorker`/`MonthlyImpactWorker`) → post-034 the location→owner path is `businesses.account_id → users.account_id`. **A dropped column is invisible to these unit tests**: worker suites mock `sql` as a positional queue returning canned rows for any SQL, so only a `*.integration.test.ts` catches it — and `describeWithDb` SKIPS rather than fails without `TEST_DATABASE_POOL_URL`, so the suite needs an execution sentinel or the guard silently does not run.
- [2026-08-09] The failure was undiagnosable → `worker/index.ts` added a Sentry *breadcrumb* on job failure and never `captureException`, so a deterministic crash raised no issue → the **Job-failure sink** now captures on the terminal attempt. It writes nothing to `job_outbox`: the watchdog's terminalizer at `OutboxPoller.ts:140-143` sets `last_error` **unconditionally**, so anything written there is destroyed by the generic text it was meant to replace.
- [2026-08-09] The pile was *growing*, not stale → `OnboardingDripScheduler`'s in-flight `NOT EXISTS` excludes only `status <> 'failed'`, so every failed row was re-minted next cycle: each burns 5 watchdog attempts over ~75 min, then a fresh one appears → any scheduler re-queuing on a predicate that excludes `failed` needs a failure bound. Rolling (3/24h) over lifetime, so a transient outage self-heals.
- [2026-08-09] Counting recent `job_outbox` failures by `completed_at` alone under-counts, and `COALESCE(completed_at, created_at)` still gets it wrong → the watchdog's terminate path stamps `completed_at`, the poller's dispatch-error path (`OutboxPoller.ts:293-299`) does not, and a long-lived row can fail recently → use `COALESCE(completed_at, dispatched_at, created_at)`: the claim UPDATE refreshes `dispatched_at` on every attempt.

### Reuse and contracts before adding worker plumbing
- [2026-08-09] Before adding an outbox write helper, grep `src/lib/shared/outbox.ts` → `recordOutboxTransientError` (:183) and `isTerminalAttempt` (:211) already exist; a plan round-1 review caught both about to be reinvented. **But "it already exists" is not "it fits here"** — that same review directed the Job-failure sink to reuse `isTerminalAttempt`, and the branch review then found that WRONG for the call site. Grep first, then check the call context; the second half is the part the reuse advice skipped.
- [2026-08-09] A BullMQ final-attempt check has TWO correct forms and picking the wrong one fails silently → `isTerminalAttempt` (`outbox.ts:211`) is `attemptsMade >= max || attemptsMade + 1 >= max`, written for the **catch block**, where `attemptsMade` is not yet incremented. The `'failed'` **event** has already incremented it, so that form fires one attempt EARLY *and* again on the real last one — a duplicate Sentry issue plus a false "exhausted its retries" for a job BullMQ then retries successfully → in a `'failed'` listener use `attemptsMade >= max`. `worker/jobs/judge/failed-hook.ts:44-57` already documented the split and ends "do not unify them": the trap was written down and got walked into anyway. Note a case at `attemptsMade: 1 / attempts: 5` does NOT discriminate the two forms — only the second-to-last attempt does, which is why the original eval passed either way.
- [2026-08-09] A generic worker-level `'failed'` listener must not persist or string-log `err.message` → `worker/jobs/csv-ingest/failed-hook.ts:34` states the contract (only the bounded error CLASS, because Postgres messages may embed contact handles) and string logger args bypass the object sanitizer → log `err.name`.
- [2026-08-09] "Sentry has its own scrubber" was FALSE for the one field that mattered → `scrubSentryEvent` covered `extra`, `request`, `transaction` and `breadcrumbs`, never `event.exception.values` — which is exactly where `captureException` puts `err.message`. Promoting worker job failures from breadcrumbs (scrubbed) to real issues (not) was therefore a net PII regression on the louder channel → `sentry-scrub.ts` now redacts `exception.values` and the top-level `message`. Before routing any new text to Sentry, check which event FIELD it lands in: that scrubber is per-field, not per-event.

### Harness traps found during execution
- [2026-08-09] `pnpm vitest run worker/jobs/` showed one red (`publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`, `ECONNREFUSED :5432` after a 30s hang) that was NOT a regression → exporting `TEST_DATABASE_POOL_URL` alone is not enough for suites that reach Postgres through the `@/lib/db/server` singleton rather than their own client; that path reads `DATABASE_POOL_URL` and silently falls back to the postgres.js default → export BOTH to the local test DB when running a directory sweep locally. CI already sets it, which is why the gap only ever shows up on a developer machine.
- [2026-08-09] A test that mocks `sql` as a positional queue is structurally blind to schema drift → the mock returns canned rows for ANY SQL, so `OnboardingDripWorker.test.ts` passed against the dropped-column query both before and after the #719 fix, and a query being *deleted* can still leave cases green by positional luck (the removed query was first in a two-step chain, so each fixture value slid onto the survivor) → when a change removes a query, a unit case that passes UNCHANGED is evidence of nothing; re-derive what the mock now feeds, and let a live-schema suite own the assertion.
- [2026-08-09] A guard can produce a FALSE NEGATIVE and read as a real failure → #719's execution sentinel exists to prove the live-DB cases ran, and it asserted `process.env.TEST_DATABASE_POOL_URL` directly. `resolveTestDatabaseUrl()` falls back to reading `.env.local` off disk, so in the documented local setup the ten live cases ran and PASSED while the sentinel alone failed → any check that gates on "is the live DB reachable" must resolve the URL the same way `describeWithDb` does. A guard that cries wolf where the thing it guards is working gets ignored, which is worse than not having it.
- [2026-08-09] A unit fixture pinned to a hard-coded calendar date rots into a silent pass → `OnboardingDripWorker.test.ts` seeded `subscription_activated_at: new Date('2026-04-01')`, and the moment #719 added the handler-side **Drip staleness cap** every case began refusing its drip while the suite still read green on the assertions it did make → seed time-sensitive fixtures RELATIVE to now (`Date.now() - 12h`) and let the cases that want the boundary override it explicitly.

### Shipping traps found merging #719 (2026-08-10)
- [2026-08-10] A `git merge` that reports NO conflict can still corrupt a shared enum → syncing `main` into `staging` after #719's squash, git cleanly auto-merged `src/lib/shared/outbox-completion-reason.ts` and produced **`DRIP_TOO_STALE` twice** — the ride's copy plus main's squashed copy — a duplicate key in an `as const` object, with no marker and no warning. Two other files DID conflict and were caught; this one did not → after any merge that touches a file BOTH branches append members to, diff the result against the authoritative branch (`git diff origin/main -- <file>`) rather than trusting "merge succeeded". The conflicting files are the safe ones; the silently-merged ones are where the corruption lives.
- [2026-08-10] Copying the OBSERVED staging-resync habit instead of reading the runbook enshrines the drift → after #719's squash, `git merge --ff-only main` aborted (staging held the un-squashed ride, main the squash), and staging's recent history showed four `Merge origin/main into staging — #NNN squash sync` commits, so a sync merge looked like the house convention and was repeated. It is not: `deployment-guide.md` §"Re-sync staging" prescribes `git reset --hard origin/main` + `--force-with-lease`, safe because staging is a **disposable integration anchor** — nothing of value lives only there. A sync merge "works" and leaves staging permanently ahead; four of them is how staging reached **101 commits ahead of main**, which is precisely the drift the rule forbids → follow the runbook branch, and treat repeated commits in a branch's history as evidence of what people DID, never of what they SHOULD do. Supersedes the #679 note above only in emphasis: that one already had the right answer (`git diff --stat staging origin/main`, then reset) and was not consulted.
- [2026-08-10] A PR can go stale faster than its own CI → `main` took ~10 commits during #719's PR while one full run costs ~12 minutes (`fallow` alone ~11m), so every green was invalidated before it could merge and the branch needed four rebases → arm `gh pr merge --auto` instead of hand-watching. It closes the window between "green" and "merged". It does not remove genuine conflicts: `.claude/reference/lab-notes.md` collides with EVERY docs sweep that lands first, because both sides append a dated section to the same file tail.
- [2026-08-10] Verifying a CI gate with the wrong command wastes a full cycle → #719's fallow failure was "fixed" and re-pushed after checking `pnpm ci:fallow`, but the gate is `pnpm ci:fallow:coverage`; `package.json` documents that split in an explicit comment ("The CI fallow gate is ci:fallow:coverage … The static ci:fallow … is wired into NO hook or workflow") which had already been read → when a CI job fails, read the workflow to find the EXACT command it runs and run that one, coverage generation included.

## 2026-08-10 — #688 KPI Review-time anchor ship

- [2026-08-10] Integration-test expectation for `SentimentTrendPoint.weekStart` spelled as `::date::text` never matched any trend point → postgres.js decodes a `date` (OID 1082) column into a JS `Date`, and the KPI mapper's `String(r.week_start)` emits the long local form ("Mon Aug 10 2026 00:00:00 GMT-0700 …"), not ISO — `src/lib/kpi/types.ts`'s "ISO date" doc comment is wrong about the runtime value → compute expected values in SQL selected as `::date` (no `::text`) and round-trip them through the SAME postgres.js-decode + `String()` path the production mapper uses. Wire-format cleanup deliberately deferred to #757's adjudication of the KPI surface (the route has zero consumers today, so nothing depends on either spelling).
- [2026-08-10] Seeding seven businesses under one account in a live-DB suite blew up on `businesses_account_primary_uniq` → `seedLocation` (`src/lib/shared/__tests__/live-db-tenant.ts`) defaults `isPrimary: true` and the partial unique allows exactly ONE primary per account → pass `isPrimary: false` (or `bizId === FIRST`) for every location after the first. Applies to any future multi-location live-DB suite built on `seedLocation`.
- [2026-08-10] Editing a query pinned by `scripts/ci/tenant-scope-allowlist.ts` fails `ci:tenant-scope` with PAIRED findings — "unused tenant scope allowlist entry" + "missing account_id or business_id scope" → the audit strips SELECT subqueries before predicate analysis, so a query whose tenant scope lives inside a subquery (both KPI sentiment-trend templates) is allowlisted by EXACT raw template text, and ANY edit to that template invalidates the pin → re-pin the affected `sqlSnippet` strings to the new text in the same PR, entry count at baseline (no growth). #757 will hit the same wall if the `src/lib/dashboard/aggregate-queries.ts` windows it must re-anchor are similarly pinned — check the allowlist before planning that edit surface.
- [2026-08-10] The whole staging admin portal "loaded nothing" while every request showed **200** in the Network tab and Vercel logged zero errors → the #505 Connection wedge had reached the **Vercel admin surface**: `getAdminOverview` fired a **7-query** `Promise.all` on the SHARED `sql` client whose pool is `DB_POOL_MAX=3` on Vercel, so the excess queries pipelined over the Supavisor TRANSACTION pooler and parked in `state=active, wait_event=ClientRead` forever, leaking one pool slot per render until the pool starved. The 200 is a **red herring you must not stop at**: a Next.js server component streams its HTML, so the headers (and the `loading.tsx` skeleton) flush immediately and the status is decided long before the body — a render that hangs mid-stream is a *permanent 200 with no body*, which is why devtools, Vercel's log line, and `get_runtime_errors` were all clean. Discriminator that localizes it in one step: **admin API routes worked while admin pages hung** (routes finish their body; pages stream theirs), and a browser `fetch('/admin/overview')` never resolved `.text()` while `fetch('/api/admin/nav-counts')` returned in 741ms. Confirm with `pg_stat_activity` filtered to `state <> 'idle'` — wedged backends sit at `active`/`ClientRead` with a *rising* `now()-query_start` (observed >3min). `statement_timeout` (set to 30s here) can NEVER save you: in `ClientRead` the statement is not executing, so the timer never arms. CORRECT → the #505 sequential idiom at every fan-out > pool, plus a guard comment naming the fan-out count AND the pool limit so a future 4th query is a visible decision; regression-guard it with a peak-in-flight-concurrency===1 test built on a LAZY-THENABLE fake `sql` (count in-flight on `.then`, never on construction — that is what makes it fragment-safe, since nested `sql` fragments like `optionalAccountPrefix(sql, id)` are built as interpolated values and never awaited), and include a guards-the-guard case asserting the harness reports 3 for a real `Promise.all`, or a silently-broken harness makes every other assertion vacuous. Also falsifies the audit ticket's caveat 2 ("a Vercel wedge may be masked by function teardown") — it is not masked. Two traps met on the way: (a) the console noise was ALL red herrings (a CSP-blocked `vercel.live` toolbar script that was independently 503ing, a Chrome extension's Summarizer warning, and a 400 `grant_type=password` that was simply one mistyped password 6s before a successful login) — read the Supabase **auth log** rather than inferring auth failure from a console 400; (b) adding comment lines above a query shifts every line-anchored CI allowlist pin below it (`SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` in `scripts/ci/static-policy-audit.ts` pins `file:line`), so `ci:static-policy` fails on a pure-comment edit — re-pin in the same change.
