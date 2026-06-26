# Stage 3 BATCH — notification-channel send cluster config migration

_Branch `refactor/audit-stage3-notification-channels`. Migrates the 5 worker-only
notification-channel SEND adapters' raw `process.env.*` config reads onto the
Stage-2 typed config accessor (`getWorkerConfig()`, `src/lib/config/worker.ts`),
following the conventions established by the email pilot
(`2026-06-25-audit-stage3-pilot-email-config.md`) and the src-lib /
worker-pollers / worker-jobs / worker-ingress / serpapi-redis / zernio-transport
batches._

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** Every default,
fallback, truthy check, non-null assertion, and throw is preserved byte-for-byte.
Every existing behavior **assertion** is preserved; a test's env-setup *mechanism*
is refactored only where the memoized accessor requires it (convention #6 / #9).

## Scope — 5 files, the SEND cluster

| File | Migrated read(s) | Call-site guard |
|---|---|---|
| `src/lib/notifications/channels/email-channel.ts` | `RESEND_FROM_EMAIL` (×2: `sendApprovalRequest`, `sendAutoPostNotice`) | `const from = …; if (!from) throw 'RESEND_FROM_EMAIL not configured'` |
| `src/lib/notifications/channels/telegram-client.ts` | `TELEGRAM_BOT_TOKEN` (constructor default-param) | `botToken = … ?? ''; if (!botToken) throw 'TELEGRAM_BOT_TOKEN is not set'` |
| `src/lib/notifications/channels/whatsapp-client.ts` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (`client()`), `TWILIO_WHATSAPP_NUMBER` (`sendTemplate`/`sendFreeform`) | `if (!sid \|\| !token) throw …`; `from: …TWILIO_WHATSAPP_NUMBER!` |
| `src/lib/notifications/channels/whatsapp-channel.ts` | `WHATSAPP_AUTOPOST_TEMPLATE_SID` (`sendAutoPostNotice`) | `if (!contentSid) return {status:'skipped', reason:'whatsapp_autopost_template_unset'}` |
| `src/lib/notifications/channels/whatsapp-body.ts` | `WHATSAPP_APPROVAL_TEMPLATE_SID` + `WHATSAPP_AUTOPOST_TEMPLATE_SID` (formatter default-params) | `contentSid: string = … ?? ''` |

**LEAVE — `src/lib/notifications/channels/index.ts`.** Its only `process.env`
reads are the `CHANNELS_TELEGRAM_ENABLED` / `CHANNELS_WHATSAPP_ENABLED` feature
flags → Stage 4 (convention #3). Untouched; stays in the baseline.

## Lane decision + WHY — worker-only → `getWorkerConfig()` (#4)

The 5 send adapters are reached **only by the Railway worker**:

- the `getChannel()` factory (`src/lib/notifications/channels/index.ts`),
  instantiated by the worker notification dispatch (`worker/jobs/notification/*`)
  and the auto-post-notice dispatch (`worker/jobs/auto-post-notice/*`);
- the Telegram + Twilio webhook ingress handlers
  (`worker/ingress/telegram/*`, `worker/ingress/twilio/*`) — which run in the
  worker process — do the inline free-form confirmation sends.

No Next.js route imports the send clients (the `src/app/api/.../channels/*`
channel-START routes are SEPARATE out-of-guard files — enrollment/opt-in flows,
not in this batch). So these worker-only modules read config through
`getWorkerConfig()` — which self-loads `.env.local` (`ensureWorkerDotenvLoaded`)
and is safe to call as early as construction time, unlike `getServerConfig()`
(convention #4: worker-ONLY files use the worker accessor).

**Runtime-invocation timing.** All migrated reads happen at runtime, never at
module import: `email-channel`/`whatsapp-channel` read inside the async send
methods; `whatsapp-client` reads inside `client()`/`sendTemplate`/`sendFreeform`;
the `telegram-client` constructor default-param and the `whatsapp-body` formatter
default-params evaluate at construction / call time (TelegramClient is built
inside `TelegramChannel.sendApprovalRequest`, the formatters are called at
send-time) — always after worker-boot dotenv. The module-scope side-effect-free
contract (Phase 3 spec §2.0 rule 2) is preserved: no env read runs at import.

`worker/config/startup-assert.ts` also reads `TWILIO_WHATSAPP_NUMBER` directly,
but it is ALLOWLISTED (a sanctioned process.env home) — left exactly as-is.

## Schema changes (`src/lib/config/worker.ts`)

4 NEW fields (none in any schema before this batch), `rawOptionalVar` (#7),
in a new "Stage-3 notification-channels batch" block:

- `TELEGRAM_BOT_TOKEN: rawOpt`
- `TWILIO_ACCOUNT_SID: rawOpt`
- `TWILIO_WHATSAPP_NUMBER: rawOpt`
- `WHATSAPP_APPROVAL_TEMPLATE_SID: rawOpt`

3 fields are REUSED (already `rawOpt` in worker.ts from earlier batches — NOT
re-added): `RESEND_FROM_EMAIL`, `WHATSAPP_AUTOPOST_TEMPLATE_SID` (worker-jobs
batch) and `TWILIO_AUTH_TOKEN` (worker-ingress batch).

`rawOptionalVar` (#7) preserves `''` / `'   '` / unset byte-for-byte, so each
call site's own normalization stays identical: `!from` / `!botToken` /
`!sid || !token` truthy checks keep `'   '` truthy (the collapsing `optionalVar`
would map a whitespace value to `undefined` and FLIP the check — a spurious
throw); the `TWILIO_WHATSAPP_NUMBER!` non-null is a *type* assertion only, the
runtime value passes to the Twilio SDK verbatim; the `?? ''` formatter
default-params keep `'   '`/`''` instead of collapsing. No asserting accessor is
added (#5): a throw would replace each site's own throw/skip behavior. No new
REQUIRED var → `WORKER_REQUIRED_VARS` unchanged → `ci:config-coverage` unaffected.

## Per-file before → after

| File | Before → After / why |
|---|---|
| `email-channel.ts` | + import `getWorkerConfig`. `const from = process.env.RESEND_FROM_EMAIL` → `getWorkerConfig().RESEND_FROM_EMAIL` (×2). Both `if (!from) throw` + the `from` passthrough to `sendApprovalEmail`/`sendAutoPostNoticeEmail` preserved EXACTLY. |
| `telegram-client.ts` | + import `getWorkerConfig`. `constructor(botToken: string = process.env.TELEGRAM_BOT_TOKEN ?? '')` → `… = getWorkerConfig().TELEGRAM_BOT_TOKEN ?? ''`. `if (!botToken) throw` + `baseUrl` unchanged. Default-param evaluates at construction (runtime), never at import. |
| `whatsapp-client.ts` | + import `getWorkerConfig`. `client()`: `const cfg = getWorkerConfig(); const sid = cfg.TWILIO_ACCOUNT_SID; const token = cfg.TWILIO_AUTH_TOKEN;` keep `if (!sid \|\| !token) throw` + `twilio(sid, token, …)`. `sendTemplate`/`sendFreeform`: `from: process.env.TWILIO_WHATSAPP_NUMBER!` → `from: getWorkerConfig().TWILIO_WHATSAPP_NUMBER!` (the `!` is a type assertion; runtime value identical). |
| `whatsapp-channel.ts` | + import `getWorkerConfig`. `const contentSid = process.env.WHATSAPP_AUTOPOST_TEMPLATE_SID` → `getWorkerConfig().WHATSAPP_AUTOPOST_TEMPLATE_SID`. The graceful-skip (`if (!contentSid) return {status:'skipped', …}`) preserved EXACTLY. `getWorkerPublicUrl()` (already on `getServerConfig`) untouched. |
| `whatsapp-body.ts` | + import `getWorkerConfig`. Both formatter default-params `process.env.WHATSAPP_{APPROVAL,AUTOPOST}_TEMPLATE_SID ?? ''` → `getWorkerConfig().WHATSAPP_{APPROVAL,AUTOPOST}_TEMPLATE_SID ?? ''`. JSDoc + module header updated so the `process.env` mentions now read "via getWorkerConfig() (default-param evaluates at call time)". The `?? ''` fallbacks preserved EXACTLY. |
| `index.ts` | UNCHANGED — flag-only (`CHANNELS_*_ENABLED`), Stage 4. |

## Test conversions (convention #6 — memo reset; #9 — dotenv stub for absence)

`getWorkerConfig()` **memoizes** the first `process.env` parse and self-loads
`.env.local`. A channel test that sets/deletes a migrated var per-test and then
exercises a send must (a) call `resetWorkerConfigForTests()` after the env
mutation so the next read re-parses, and (b) for any case relying on a var being
ABSENT, stub the dotenv loader so the developer's real `.env.local` cannot
repopulate the deleted var. The dotenv stub (#9) is added **only** to files with
an absence/delete scenario.

| Test file | Conversion | dotenv stub (#9)? |
|---|---|---|
| `__tests__/email-channel.test.ts` | Real `EmailChannel` reads `RESEND_FROM_EMAIL` via `getWorkerConfig()`. `beforeEach` sets it; the "throws when RESEND_FROM_EMAIL is not set" test `delete`s it then expects a throw. Import `resetWorkerConfigForTests`; reset at end of `beforeEach`, and again after the `delete` inside the absence test. Every assertion preserved. | YES — absence test relies on the var being unset. |
| `__tests__/telegram-client.test.ts` | Real `TelegramClient` constructor reads `TELEGRAM_BOT_TOKEN` via `getWorkerConfig()`. `beforeEach` sets `'test-token'` and asserts the URL `…/bottest-token/…`. Reset at end of `beforeEach`. No delete/absence case. | NO. |
| `__tests__/whatsapp-client.test.ts` | Real `WhatsAppClient.client()` reads `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`; sends read `TWILIO_WHATSAPP_NUMBER`. Both `describe` `beforeEach`es set all three; reset at end of each. No delete/absence case (twilio is mocked; `from` not asserted). | NO. |
| `__tests__/whatsapp-channel.test.ts` | Real `formatApprovalWhatsApp` reads `WHATSAPP_APPROVAL_TEMPLATE_SID` via the default-param. `beforeEach` sets `'HX_test'`; assertion `contentSid:'HX_test'`. Reset at end of `beforeEach`. WhatsAppClient is mocked; `sendAutoPostNotice` skip path not exercised here → no absence case. | NO. |
| `__tests__/whatsapp-body.test.ts` | Only the "falls back to env.WHATSAPP_APPROVAL_TEMPLATE_SID when contentSid arg omitted" test reads env (sets `'HX_env'`); every other case passes an explicit `contentSid`, so the default-param never evaluates. Import `resetWorkerConfigForTests`; reset right after the `'HX_env'` mutation and again in the `finally` after restore. No case relies on the var being unset. | NO. |

**NOT converted (no migrated read exercised):**
- `__tests__/factory.test.ts` — `getChannel('telegram'/'whatsapp')` constructs
  `TelegramChannel`/`WhatsAppChannel`, whose **constructors do not build a
  client** (the client is built inside the send methods), so no migrated read
  runs. The `TELEGRAM_BOT_TOKEN='test-token'` it sets is never read here.
- `__tests__/telegram-channel.test.ts` — mocks `../telegram-client` (replaces
  `TelegramClient` with a stub whose constructor reads nothing), so the real
  migrated `TELEGRAM_BOT_TOKEN` read is never invoked.

### Added behavior-lock tests (TDD, convention #7)
- `src/lib/config/__tests__/worker.test.ts` — for the 4 new vars
  (`TELEGRAM_BOT_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_WHATSAPP_NUMBER`,
  `WHATSAPP_APPROVAL_TEMPLATE_SID`): present-when-set, undefined-when-unset
  (tolerate-absent, no throw), and whitespace-only `'   '` survives verbatim.
  RED under the collapsing `optionalVar`, GREEN under `rawOptionalVar`. Matches
  the existing worker.test.ts style (top-level dotenv-load stub + per-test
  `process.env = {...CORE, …}` + dynamic `import('../worker')`).

## Baseline (`scripts/ci/process-env-baseline.ts`): 38 → 33 (−5)
**Removed (fully migrated, no remaining counted read):** `email-channel.ts`,
`telegram-client.ts`, `whatsapp-client.ts`, `whatsapp-channel.ts`,
`whatsapp-body.ts`. Each file's only remaining `process.env` would be none —
all reads now go through `getWorkerConfig()`. No import-time reader → none
allowlisted. **KEPT:** `index.ts` (flag-only, Stage 4). The baseline is
regenerated from the audit's own live scan; `pnpm ci:process-env` confirms the
live scan matches the committed baseline (33).

## Conventions applied (full text in the pilot plan)
- **#3** `*_ENABLED` flags stay untouched (`index.ts` `CHANNELS_*_ENABLED` → Stage 4).
- **#4** lane: worker-only `src/lib` modules → `getWorkerConfig()`, read at
  RUNTIME (send-method / constructor / formatter default-param), never at import.
- **#5** tolerate-absent / fail-its-own-way vars → optional schema fields + the
  call site's own guard; no asserting accessor introduced.
- **#6** test-isolation: `resetWorkerConfigForTests()` after env mutations; every
  assertion preserved.
- **#7** migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset
  passthrough) so each `!value` / `X!` / `?? ''` stays byte-for-byte.
- **#9** dotenv-load stub for ABSENCE tests (email-channel only this batch).

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass; `pnpm ci:process-env`
reports baseline 33 and the live scan matches.

## Open risks
- The only structural change is routing 6 distinct reads onto `getWorkerConfig()`
  inside their existing runtime call sites; behavior-faithful because env is
  immutable in prod (memoized snapshot == per-call read), the worker self-loads
  dotenv before any send, and every guard (`!from`/`!botToken`/`!sid||!token`/
  `X!`/`?? ''`/skip-when-unset) is preserved byte-for-byte. The module-scope
  side-effect-free contract is intact — no read evaluates at import.
- `index.ts` and `worker/config/startup-assert.ts` are deliberately left
  (Stage-4 flags / allowlisted home respectively).
