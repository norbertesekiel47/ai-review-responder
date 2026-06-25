# Stage 3 PILOT — email/Resend config migration + campaign conventions

_Branch `refactor/audit-stage3-pilot-email-config`. Pilot for the ~180-file
Stage-3 campaign that migrates raw `process.env.*` reads onto the Stage-2 typed
config accessors (`src/lib/config/{server,worker,client}.ts`)._

## Why this pilot exists

Stage 2 (PR #377) landed the typed config foundation: lazy + memoized
`getServerConfig()` / `getWorkerConfig()`, lane-scoped boot asserts, the
`process-env` baseline guard, and the config-coverage audit. Those accessors have
**no production consumer yet**. Stage 3 migrates the ~990 raw reads onto them,
batched by area. This pilot migrates the smallest real subsystem (email/Resend)
to **establish and document the repeatable pattern** and to surface the campaign's
hidden hazards on a small blast radius before the bulk batches.

**Hard rule for this pilot (and the campaign): ZERO behavior change.** Every
default, fallback, parse, trim, optionality, mock-mode tolerance, and throw
condition is preserved byte-for-byte. The existing email tests encode that
behavior and must pass unchanged. Where a migration would alter an observable
semantic (including a test-harness semantic), the read is **left as-is and
reported**, not forced green.

---

## Stage-3 migration conventions (govern the WHOLE campaign)

### 1. `NEXT_PUBLIC_*` reads are EXEMPT
They stay statically-inlined `process.env.NEXT_PUBLIC_X`. Next.js inlines a public
var at **build time** only for a statically-written `process.env.<LITERAL>` ref; a
dynamic `getClientConfig()[name]` lookup reads raw runtime env and can false-throw
on a deploy where the inlined app actually works. So public reads stay literal.
(Not exercised by this pilot — email reads no `NEXT_PUBLIC_*` — but documented for
the campaign.)

### 2. Env INDICATORS are EXEMPT
`NODE_ENV`, `MOCK_EXTERNAL_APIS`, and `VERCEL_*` describe **which environment** the
process runs in, not subsystem **config**. They stay direct `process.env.X` reads
and are **never** routed through a config accessor.

- The `process-env` audit was updated so its detection does **not** count an
  access whose single statically-known property is one of these indicators
  (`scripts/ci/process-env-audit.ts`: `isExemptIndicatorName` +
  `accessedExemptVarName` + `isCountedProcessEnvAccess`, AST parse now uses
  `setParentNodes:true` to inspect the access target).
- Conservative: a destructure (`const { X } = process.env`) or alias
  (`const e = process.env`) reads the whole env object — the property name isn't
  knowable from the env node alone — so those **still count** (could read any var).
- Consequence: a file that reads **only** exempt indicators drops out of the
  migration baseline with no code change. This pilot's exemption dropped 7 such
  files (see "Baseline" below) in addition to the 2 migrated email files.
- Unit-tested in `scripts/ci/__tests__/process-env-audit.test.ts` (the
  `env-indicator exemption` cases).

### 3. `*_ENABLED` flags are Stage 4 — do NOT migrate them
Feature flags get the shared `readFlag` primitive + per-feature `flags.ts` in
Stage 4, NOT the config accessors (they're runtime-agnostic and own the
`VERCEL_TARGET_ENV` resolution gotcha). Leave every `*_ENABLED` read untouched.
(None in the email subsystem.)

### 4. Shared dual-runtime `src/lib` modules read via `getServerConfig()`
A module under `src/lib/**` that runs in **both** the Railway worker and a Next
server route reads config through `getServerConfig()`. It works in both runtimes:
`process.env` is populated at call time in the worker after `worker/env.ts` loads
dotenv, and `serverSchema` covers the shared vars. The email modules run in both
lanes (the worker NotificationWorker rail **and** the public contact/demo/lead
server routes), so they use `getServerConfig()`, not `getWorkerConfig()`.

**Validated empirically:** the full suite (6842 tests) — which exercises the email
send path from worker-job tests (`NotificationWorker`, `WeeklySummaryWorker`,
`AccountOffboardingEmailWorker`, …) and from the server contact route — stays green
with `send-email.ts` reading `getServerConfig().EMAIL_SEND_TIMEOUT_MS`.

### 5. Optional/fallback vars use the OPTIONAL schema field, not an asserting accessor
A var the current code **tolerates absent** (has a default/fallback) is added to
the schema as `optionalVar` and read via `getServerConfig().X` (→ `string |
undefined`), KEEPING the existing fallback at the call site. Do **not** introduce
an asserting `get*Config()` for a tolerate-absent var — it would throw where the
code currently doesn't, a behavior change. (`getResendConfig()` exists and asserts
`RESEND_API_KEY`, but the email client tolerates an absent key, so the client
reads the **optional** `getServerConfig().RESEND_API_KEY`, not the asserting
accessor.)

### 6. ⚠️ Test-isolation prerequisite (NEW — surfaced by this pilot)
`getServerConfig()` **memoizes** the first `process.env` parse. A test that mutates
`process.env` mid-file and expects a migrated read to reflect the change will break
unless it calls `vi.resetModules()` (which re-evaluates the config module and clears
the memo) and re-imports the module under test dynamically.

This is the campaign's central hidden cost. For a file whose existing tests mutate
env mid-run **without** `vi.resetModules()`, migrating its reads to
`getServerConfig()` breaks those tests even though **production behavior is
identical** (runtime env is immutable, so a memoized snapshot equals a live read).

**Campaign rule:** before migrating a file, check its tests. If they mutate
relevant env vars per-test, the migration PR must first add `vi.resetModules()` +
dynamic import to those tests (a test change). In **this pilot** such test changes
were out of scope ("existing tests pass unchanged"), so the 3 affected files were
left un-migrated and reported (see below). The bulk campaign should budget for the
test refactor that unblocks them.

---

## Per-file before → after (email subsystem)

| File | Var | Status | Before → After / why |
|---|---|---|---|
| `email/client.ts` | `RESEND_API_KEY` | ✅ migrated | `new Resend(process.env.RESEND_API_KEY)` → `new Resend(getServerConfig().RESEND_API_KEY)`. Optional field; still tolerates `undefined` (no assert). `getResend()` already memoizes `_resend`, so read-once semantics unchanged. |
| `email/send-email.ts` | `EMAIL_SEND_TIMEOUT_MS` | ✅ migrated | `const raw = process.env.EMAIL_SEND_TIMEOUT_MS` → `getServerConfig().EMAIL_SEND_TIMEOUT_MS`. Identical `if (!raw) return DEFAULT; parseInt(raw,10); Number.isFinite && >0 ? : DEFAULT` — the default + NaN/non-positive guard preserved byte-for-byte. |
| `email/headers.ts` | `LIST_UNSUBSCRIBE_URL`, `LIST_UNSUBSCRIBE_EMAIL`, `RESEND_FROM_EMAIL` | ⛔ left as-is | Migration trialed and **reverted**: its unit test (`email-send.test.ts`) sets `RESEND_FROM_EMAIL`/`LIST_UNSUBSCRIBE_URL` per-test without `vi.resetModules()`; the memo froze the first (unset) snapshot → tests failed. Reads unchanged (`process.env.X?.trim()` + example.com fallback intact). |
| `email/templates/internal.ts` | `RESEND_FROM_EMAIL` | ⛔ left as-is | Same memo blocker (`email-send.test.ts` `sendInternalEmail` block sets `RESEND_FROM_EMAIL` in `beforeEach`; the file's first describe block memoized it unset → `RESEND_FROM_EMAIL not configured` throw). `from ?? process.env.RESEND_FROM_EMAIL; if(!from) throw` unchanged. |
| `contact-notify.ts` | `CONTACT_NOTIFY_TO`, `RESEND_FROM_EMAIL`, `RESEND_API_KEY` | ⛔ left as-is | Same memo blocker (`contact-notify.test.ts` mutates all three per-test without reset). `NODE_ENV` read stays (exempt, #2). `emailConfigured()` mock-mode tolerance unchanged. |

**Net pilot result: 2 of 5 files migrated cleanly; 3 blocked by the memo/test
prerequisite (convention #6) and reported, not forced.**

### Schema additions (`src/lib/config/server.ts`)
Added as `optionalVar` (tolerate-absent), so a UI-only preview never throws and
call-site fallbacks stay authoritative:
`RESEND_FROM_EMAIL`, `EMAIL_SEND_TIMEOUT_MS`, `LIST_UNSUBSCRIBE_URL`,
`LIST_UNSUBSCRIBE_EMAIL`. (`RESEND_API_KEY` + `CONTACT_NOTIFY_TO` were already
present.) All four are added even though 3 of their consumers stayed un-migrated —
they describe the email subsystem's shape and unblock the consumers once their
tests get `vi.resetModules()`.

### Baseline (`scripts/ci/process-env-baseline.ts`): 100 → 91 (−9)
- 2 migrated email files removed: `email/client.ts`, `email/send-email.ts`.
- 7 exempt-only files dropped by convention #2 (each reads ONLY `NODE_ENV` or
  `MOCK_EXTERNAL_APIS`): `src/lib/shared/mock-mode.ts`,
  `src/lib/account-offboarding/destructive-auth.ts`, `src/lib/approval/cookies.ts`,
  `src/lib/demos/generate-responses.ts`, `src/lib/zernio/connect-session-cookie.ts`,
  `worker/ingress/twilio/twilio-verify.ts`, `worker/jobs/OnboardingDemoWorker.ts`.
- `contact-notify.ts`, `email/headers.ts`, `email/templates/internal.ts` stay in
  the baseline (still read non-exempt vars — un-migrated).

---

## Tests

Existing (must pass unchanged — verified):
- `src/lib/notifications/email/__tests__/send-email.test.ts`
- `src/lib/notifications/__tests__/email-send.test.ts`
- `src/lib/notifications/__tests__/contact-notify.test.ts`
- `src/lib/notifications/__tests__/email-templates.test.ts`
- `scripts/ci/__tests__/process-env-audit.test.ts` (existing cases unchanged)
- `src/lib/config/__tests__/server.test.ts` (existing cases unchanged)

Added (this pilot):
- `scripts/ci/__tests__/process-env-audit.test.ts` — env-indicator exemption cases
  (NODE_ENV / MOCK_EXTERNAL_APIS / VERCEL_* not counted; non-exempt still counted;
  destructure/alias conservatively counted).
- `src/lib/config/__tests__/server.test.ts` — the 4 new optional email vars are
  present-when-set and `undefined`-when-unset (tolerate-absent, no throw).
- `src/lib/notifications/email/__tests__/config-migration.test.ts` — the migrated
  reads preserve semantics: `EMAIL_SEND_TIMEOUT_MS` default-on-unset,
  honors-valid, default-on-NaN; `RESEND_API_KEY` constructs-with-key and
  tolerates-undefined. Uses `vi.resetModules()` per convention #6.

---

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all green (see commit + report).

## Open risks / follow-ups for the campaign
- **The memo/test-isolation prerequisite (convention #6) is the campaign's main
  cost driver.** Every file whose tests mutate relevant env mid-run needs a test
  refactor (`vi.resetModules()` + dynamic import) in the same batch before its
  reads can migrate. Budget for it; it is not optional.
- The 3 blocked email files (`headers.ts`, `templates/internal.ts`,
  `contact-notify.ts`) should migrate in a follow-up that is allowed to add
  `vi.resetModules()` to `email-send.test.ts` and `contact-notify.test.ts`.
- Consider whether a small test helper (`withFreshConfig(envPatch, fn)`) is worth
  extracting once several batches need the reset dance.
