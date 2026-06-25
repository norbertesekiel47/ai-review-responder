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

**Hard rule for this pilot (and the campaign): ZERO PRODUCTION behavior change.**
Every default, fallback, parse, trim, optionality, mock-mode tolerance, and throw
condition is preserved byte-for-byte, and every existing behavior **assertion** is
preserved. A test's env-setup *mechanism* may be refactored (set→reset→import) so
it works with the memoized accessor — that is assertion-preserving, not a behavior
change (runtime env is immutable, so a memoized snapshot equals a live read). If a
migration would alter a real production semantic, the read is **left as-is and
reported**, never forced green.

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

### 6. Test-isolation prerequisite (DEMONSTRATED end-to-end by this pilot)
`getServerConfig()` **memoizes** the first `process.env` parse. A test that mutates
`process.env` mid-file and expects a migrated read to reflect the change will break
unless it calls `vi.resetModules()` (which re-evaluates the config module and clears
the memo) and re-imports the module under test dynamically.

This is the campaign's central hidden cost. For a file whose existing tests mutate
env mid-run **without** `vi.resetModules()`, migrating its reads to
`getServerConfig()` breaks those tests even though **production behavior is
identical** (runtime env is immutable, so a memoized snapshot equals a live read).
Editing the test's env-setup *mechanism* while preserving every assertion is normal,
safe refactoring — NOT a production-behavior change.

**The pattern (proven here on 3 files):** set env → `vi.resetModules()` →
`await import('<module-under-test>')` → assert. Hoisted `vi.mock` factories
(`resend`, `@sentry/nextjs`, `mock-mode`, `sendInternalEmail`) re-apply on
re-import, so module-level mock references (`mockSend`, `mockCaptureMessage`, …)
survive `resetModules` — no mock rewiring needed. A one-line local helper captures
the dance, e.g.:
```ts
async function freshEmail() { vi.resetModules(); return import('../email'); }
```
Applied to `email-headers.test.ts` (12 cases), `email-send.test.ts` (6 cases), and
`contact-notify.test.ts` (13 cases) — every scenario and assertion unchanged, only
the env-setup mechanism converted to set-env-then-reset-then-import.

**Campaign rule:** before migrating a file, check its tests. If they mutate relevant
env vars per-test, convert those cases to the set→reset→import pattern in the SAME
migration PR. Budget for it — it is the main per-file cost, but it is mechanical and
assertion-preserving.

---

## Per-file before → after (email subsystem)

| File | Var | Status | Before → After / why |
|---|---|---|---|
| `email/client.ts` | `RESEND_API_KEY` | ✅ migrated | `new Resend(process.env.RESEND_API_KEY)` → `new Resend(getServerConfig().RESEND_API_KEY)`. Optional field; still tolerates `undefined` (no assert). `getResend()` already memoizes `_resend`, so read-once semantics unchanged. |
| `email/send-email.ts` | `EMAIL_SEND_TIMEOUT_MS` | ✅ migrated | `const raw = process.env.EMAIL_SEND_TIMEOUT_MS` → `getServerConfig().EMAIL_SEND_TIMEOUT_MS`. Identical `if (!raw) return DEFAULT; parseInt(raw,10); Number.isFinite && >0 ? : DEFAULT` — the default + NaN/non-positive guard preserved byte-for-byte. |
| `email/headers.ts` | `LIST_UNSUBSCRIBE_URL`, `LIST_UNSUBSCRIBE_EMAIL`, `RESEND_FROM_EMAIL` | ✅ migrated | `process.env.X?.trim()` / `extractMailbox(process.env.RESEND_FROM_EMAIL)` → `const cfg = getServerConfig(); cfg.X?.trim()` / `extractMailbox(cfg.RESEND_FROM_EMAIL)`. The `?.trim()`, the example.com non-functional fallback branch, and the HTTPS-only One-Click logic are byte-for-byte intact. Tests (`email-headers.test.ts`, `email-send.test.ts`) converted to set→reset→import (convention #6). |
| `email/templates/internal.ts` | `RESEND_FROM_EMAIL` | ✅ migrated | `from ?? process.env.RESEND_FROM_EMAIL; if(!from) throw 'RESEND_FROM_EMAIL not configured'` → `from ?? getServerConfig().RESEND_FROM_EMAIL; if(!from) throw …`. Same throw condition. Tests converted (convention #6). |
| `contact-notify.ts` | `CONTACT_NOTIFY_TO`, `RESEND_FROM_EMAIL`, `RESEND_API_KEY` | ✅ migrated | All three → `getServerConfig().X` (`CONTACT_NOTIFY_TO?.trim()` precedence chain, `extractMailbox(…RESEND_FROM_EMAIL)`, `RESEND_FROM_EMAIL?.trim() \|\| COMPANY_NOREPLY`, `emailConfigured()` = `isMockMode() \|\| Boolean(…RESEND_API_KEY)`). `NODE_ENV` read stays a direct exempt read (#2). Mock-mode tolerance unchanged. `contact-notify.test.ts` converted (convention #6). |

**Net pilot result: 5 of 5 files migrated — email subsystem FULLY migrated. The
memo/test-isolation prerequisite (convention #6) was demonstrated end-to-end: the
3 initially-blocked files were unblocked by converting their tests' env-setup
mechanism (set→reset→import), preserving every assertion.**

### Schema additions (`src/lib/config/server.ts`)
Added as `optionalVar` (tolerate-absent), so a UI-only preview never throws and
call-site fallbacks stay authoritative:
`RESEND_FROM_EMAIL`, `EMAIL_SEND_TIMEOUT_MS`, `LIST_UNSUBSCRIBE_URL`,
`LIST_UNSUBSCRIBE_EMAIL`. (`RESEND_API_KEY` + `CONTACT_NOTIFY_TO` were already
present.) All consumers of these vars are now migrated.

### Baseline (`scripts/ci/process-env-baseline.ts`): 100 → 88 (−12)
- 5 migrated email files removed: `email/client.ts`, `email/send-email.ts`,
  `email/headers.ts`, `email/templates/internal.ts`, `contact-notify.ts`.
- 7 exempt-only files dropped by convention #2 (each reads ONLY `NODE_ENV` or
  `MOCK_EXTERNAL_APIS`): `src/lib/shared/mock-mode.ts`,
  `src/lib/account-offboarding/destructive-auth.ts`, `src/lib/approval/cookies.ts`,
  `src/lib/demos/generate-responses.ts`, `src/lib/zernio/connect-session-cookie.ts`,
  `worker/ingress/twilio/twilio-verify.ts`, `worker/jobs/OnboardingDemoWorker.ts`.
- No email-subsystem file remains in the baseline.

---

## Tests

Behavior preserved unchanged (existing tests — semantics + every assertion intact):
- `src/lib/notifications/email/__tests__/send-email.test.ts` — untouched (its env
  setup never mutated a migrated var mid-file).
- `src/lib/notifications/__tests__/email-templates.test.ts` — untouched (pure HTML
  builders, no env).
- `scripts/ci/__tests__/process-env-audit.test.ts`,
  `src/lib/config/__tests__/server.test.ts` — existing cases untouched.

Env-setup mechanism converted to set→reset→import (convention #6) — **every
scenario and assertion preserved, only the env-setup changed**:
- `src/lib/shared/__tests__/email-headers.test.ts` (12 cases) — `getEmailHeaders`
  reads LIST_UNSUBSCRIBE_*/RESEND_FROM_EMAIL via `getServerConfig()`.
- `src/lib/notifications/__tests__/email-send.test.ts` (6 cases) —
  `sendInternalEmail`/`sendApprovalEmail` via the migrated `headers`/`internal`.
- `src/lib/notifications/__tests__/contact-notify.test.ts` (13 cases) —
  `resolveContactNotifyTo`/`notifyContactSubmission` via `getServerConfig()`.

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

## Status

**Email subsystem FULLY migrated — no reads left un-migrated.** All 5 files read
config through `getServerConfig()` (except the exempt `NODE_ENV` read in
`contact-notify.ts`, which stays direct per convention #2). Baseline 100 → 88;
no email file remains in it.

## Open risks / follow-ups for the campaign
- **The test-isolation prerequisite (convention #6) is the campaign's main cost
  driver** — now demonstrated end-to-end on 3 files. Every file whose tests mutate
  relevant env mid-run needs its cases converted to set→reset→import in the same
  batch. Mechanical and assertion-preserving, but not free; budget for it.
- A per-file one-liner (`async function freshX() { vi.resetModules(); return
  import('…'); }`) sufficed here. If several upcoming batches share the exact same
  module + env shape, a small shared `withFreshConfig(envPatch, () => import('…'))`
  helper may be worth extracting — defer until the repetition is real (rules: wait
  for the second concrete use case).
