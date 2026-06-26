# Stage 3 BATCH — worker-ingress config migration (webhook signature secrets)

_Branch `refactor/audit-stage3-worker-ingress`. Migrates the `worker/ingress/**`
raw `process.env.*` reads onto the Stage-2 typed config accessors
(`src/lib/config/worker.ts`), following the Stage-3 conventions established by the
email pilot (`docs/superpowers/plans/2026-06-25-audit-stage3-pilot-email-config.md`),
the Stripe batch (`2026-06-25-audit-stage3-stripe-config.md`), the worker-pollers
batch (`2026-06-25-audit-stage3-worker-pollers.md`), and the worker-jobs batch
(`2026-06-25-audit-stage3-worker-jobs.md`)._

## Why this batch — SECURITY-CRITICAL

`worker/ingress/**` terminates every third-party webhook (invariant #6). The
non-flag config reads here are the **webhook signature-verification secrets**:
`RESEND_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`,
`ZERNIO_WEBHOOK_SECRET` (plus the already-in-schema `ADMIN_NOTIFICATION_EMAIL`
hard-bounce-alert recipient). A change to the verification logic could disable a
signature check (a security hole) OR reject valid webhooks. So this batch changes
**ONLY the env SOURCE** (`process.env.X` → `getWorkerConfig().X`) and touches
NOTHING else: not the HMAC/`timingSafeEqual`/Twilio validator, not the presence
checks (`if (!secret) reject`), not the fail-open-in-mock branches, not the order,
not the reject/throw paths. Every webhook signature-verification test passes
**unchanged in assertion** — only the env-setup *mechanism* is refactored to work
with the memoized accessor (convention #6), which is assertion-preserving (runtime
env is immutable, so a memoized snapshot equals a live read).

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** If a migration
could not be made byte-for-byte equivalent, the read would be left as-is and
reported — never forced green by weakening a verification test. (None needed to be
left as-is in this batch.)

The Stage-3 conventions that govern this batch (full text in the pilot plan):
- **#2** env-indicator exempt (`NODE_ENV`, `MOCK_EXTERNAL_APIS`, `VERCEL_*`) — stay direct.
- **#3** `*_ENABLED`/`*_DISABLED` flag-like toggles → Stage 4 — left untouched.
- **#4 (Stripe refinement)** worker-ONLY files use **`getWorkerConfig()`** (worker
  lane: self-loads dotenv, safe to call from a worker module at runtime). All
  ingress handler files are worker-only (invariant #6 — they terminate on Railway,
  never proxy through Next), so all use `getWorkerConfig()`, never `getServerConfig()`.
- **#5** tolerate-absent → optional schema field, NOT an asserting accessor.
- **#6** test-isolation: a test that sets/deletes a migrated secret (in `beforeEach`
  or per-test, before the handler runs) needs the memo cleared via
  `resetWorkerConfigForTests()` (the worker-pollers seam).
- **#7** migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset passthrough).

### Why `rawOptionalVar` is MANDATORY here (not just a convention default)

These secrets are **compared RAW in the verification primitives**, so a whitespace
value MUST survive byte-for-byte:
- `RESEND_WEBHOOK_SECRET`: `secret.replace(/^whsec_/, '')` → `Buffer.from(..., 'base64')`
  → HMAC key. `if (!secret)` is the raw presence gate. The collapsing `optionalVar`
  would map `'   '`→`undefined`, flipping the gate (spurious fail-closed reject).
- `TELEGRAM_WEBHOOK_SECRET`: `Buffer.from(expected, 'utf8')` is one side of
  `timingSafeEqual`. `if (!expected)` is the raw presence gate.
- `TWILIO_AUTH_TOKEN`: passed RAW as `authToken` into `twilio.validateRequest(...)`
  (HMAC-SHA1 key). `if (!v.authToken)` is the raw presence/mock-fail-open gate.
- `ZERNIO_WEBHOOK_SECRET`: passed RAW as `secret` into
  `createHmac('sha256', secret)`. `if (!webhookSecret)` is the raw presence gate.

Routing any of these through the collapsing `optionalVar` would change the
whitespace edge case and could alter a verification outcome — exactly what #7
forbids. `rawOptionalVar = z.string().optional()` is the faithful passthrough.

---

## Per-site treatment (6 sites — source-swap only; verification UNCHANGED)

For every site the change is: read the secret from `getWorkerConfig().X` instead of
`process.env.X`. The presence check, the signature algorithm, the compare, and the
reject/throw path are **byte-for-byte identical** before and after.

| # | File:line | Var | Verification logic — CONFIRMED UNCHANGED | Before → After |
|---|---|---|---|---|
| 1 | `worker/ingress/resend.ts:29` | `RESEND_WEBHOOK_SECRET` | **Presence:** `if (!secret)` → mock fail-open (`MOCK_EXTERNAL_APIS==='true'` → `return true`) else fail-closed `return false`. **Algorithm:** Svix — `secretBytes=base64(secret.replace(/^whsec_/,''))`, `createHmac('sha256', secretBytes).update("${svixId}.${svixTimestamp}.${rawBody}").digest('base64')`; stale-timestamp window (`>300`/`<-60`); multi-sig split. **Compare:** `timingSafeEqual` over each base64 sig. **Reject:** caller sends 401 `invalid_signature`. ALL untouched. | `const secret = process.env.RESEND_WEBHOOK_SECRET` → `const secret = getWorkerConfig().RESEND_WEBHOOK_SECRET` |
| 2 | `worker/ingress/resend.ts:325` | `ADMIN_NOTIFICATION_EMAIL` | Not a verification secret — the hard-bounce admin-alert recipient. `if (!adminEmail) return;` raw tolerate-absent guard preserved. Already `rawOptionalVar` in schema (worker-pollers batch). | `const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL` → `const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL` |
| 3 | `worker/ingress/telegram/telegram-verify.ts:10` | `TELEGRAM_WEBHOOK_SECRET` | **Presence:** `if (!expected \|\| !headerValue) return false`. **Algorithm/compare:** constant-time `timingSafeEqual(Buffer.from(headerValue,'utf8'), Buffer.from(expected,'utf8'))` with the length-mismatch early-`false` guard (no length leak). ALL untouched. | `const expected = process.env.TELEGRAM_WEBHOOK_SECRET` → `const expected = getWorkerConfig().TELEGRAM_WEBHOOK_SECRET` |
| 4 | `worker/ingress/twilio/twilio-delivery-status.ts:47` | `TWILIO_AUTH_TOKEN` | The verifier `verifyTwilioSignature` lives in `twilio-verify.ts` and takes `authToken` as a PARAM — it is NOT touched. The migrated read only changes the SOURCE of the `authToken` argument. **Presence/mock:** `if (!v.authToken)` → mock fail-open / non-mock fail-closed (in the unchanged verifier). **Algorithm:** `twilio.validateRequest(authToken, sig, url, params)` (HMAC-SHA1). **Reject:** 401 `invalid_signature`. ALL untouched. | `authToken: process.env.TWILIO_AUTH_TOKEN` → `authToken: getWorkerConfig().TWILIO_AUTH_TOKEN` |
| 5 | `worker/ingress/twilio/twilio-whatsapp-inbound.ts:63` | `TWILIO_AUTH_TOKEN` | Same verifier (`verifyTwilioSignature`, param-injected `authToken`) — UNCHANGED. Same 401 `invalid_signature` reject path. The migrated read only changes the SOURCE of the `authToken` argument. | `authToken: process.env.TWILIO_AUTH_TOKEN` → `authToken: getWorkerConfig().TWILIO_AUTH_TOKEN` |
| 6 | `worker/ingress/zernio/zernio.ts:308` | `ZERNIO_WEBHOOK_SECRET` | **Presence:** `if (!webhookSecret) { console.error; reply.status(401).send({error:'webhook_secret_not_configured'}); return; }`. **Format gate:** `HEX_64` test + `sha256=` strip → 401 `invalid_signature_format`. **Algorithm/compare:** `verifyZernioSignature(rawBody, strippedSignature, webhookSecret)` (in `zernio-verify.ts`, secret param-injected — NOT touched: `createHmac('sha256', secret)` + `timingSafeEqual`). **Reject:** 401 `invalid_signature`. ALL untouched. The `ZERNIO_PUBLISHING_ENABLED` flag read at `:298` stays (Stage 4, #3). | `const webhookSecret = process.env.ZERNIO_WEBHOOK_SECRET` → `const webhookSecret = getWorkerConfig().ZERNIO_WEBHOOK_SECRET` |

**Verification primitives are param-injected or inline and NEVER read env:**
`verifyTwilioSignature` (`twilio-verify.ts`) and `verifyZernioSignature`
(`zernio-verify.ts`) both take the secret/token as a parameter — this batch does
not touch either file. The Resend and Telegram verifiers compute the HMAC/compare
inline in the same function as the env read, but the read line is the only line
changed; the HMAC, the `timingSafeEqual`, the presence checks, and the reject paths
are byte-for-byte identical.

### Lane choice — worker lane (`getWorkerConfig()`) for all 6

All ingress handlers are worker-only (invariant #6: third-party ingress terminates
on Railway; never proxied through Next). So all reads use `getWorkerConfig()` (worker
lane — self-loads dotenv, safe to call at request/runtime time inside the handler/
verifier function), never `getServerConfig()`. Each read is at request/runtime time
inside a function body, never at module import.

### NOT migrated (left as-is, reported)

- **Flags → Stage 4:** `ZERNIO_PUBLISHING_ENABLED` (`zernio.ts:298`) — `!== 'true'`
  feature gate, left untouched (#3). Keeps `zernio.ts` in the baseline.
- **Env indicators (exempt #2):** `MOCK_EXTERNAL_APIS` (`resend.ts:32`, and inside
  the untouched `twilio-verify.ts` mock-fail-open branch) — stay direct reads.

---

## Schema changes (`src/lib/config/worker.ts`)

- **NEW `rawOptionalVar` fields (4):** `RESEND_WEBHOOK_SECRET`,
  `TELEGRAM_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `ZERNIO_WEBHOOK_SECRET`. Each is a
  migrated raw read compared raw in HMAC/verification, so `rawOptionalVar` preserves
  `''`/`'   '`/unset byte-for-byte (#7 — see "Why rawOptionalVar is MANDATORY").
- `ADMIN_NOTIFICATION_EMAIL` is ALREADY `rawOptionalVar` (worker-pollers batch) — its
  raw `if (!adminEmail)` read in `resend.ts:325` is already byte-faithful; no change.
- `WORKER_REQUIRED_VARS` unchanged (all new fields optional) → `ci:config-coverage`
  unaffected (it only audits REQUIRED-var declarations). These secrets are
  tolerate-absent at the read site (the handlers OWN the missing-secret behavior:
  fail-closed reject in prod, fail-open in mock), so no asserting accessor is added
  (#5) — that would `throw` where the handler today returns a 401/`false`.

## Test-only memo reset (`resetWorkerConfigForTests`) — convention #6

`getWorkerConfig()` memoizes the first `process.env` parse. The ingress test files
below set/delete a migrated secret (in `beforeEach` and several per-test, BEFORE the
handler/verifier runs), then assert the verification branch. A single
`resetWorkerConfigForTests()` in each file's `beforeEach` clears the memo so the
next `getWorkerConfig()` re-parses the current `process.env` (re-populates lazily on
the first read inside the handler, which is after all of that test's mutations).
Every assertion is preserved; only a `resetWorkerConfigForTests()` line is added.

**Converted (one `beforeEach` line each):**
- `worker/ingress/__tests__/resend-webhook-signature.test.ts` — `RESEND_WEBHOOK_SECRET`
  set in `beforeEach`; the `fails closed` case deletes it per-test. Reset added so
  both the signed-OK path and the missing-secret fail-closed path see the right value.
- `worker/ingress/__tests__/resend-webhook-bounce.test.ts` — sets
  `MOCK_EXTERNAL_APIS='true'` (bypasses sig — exempt) AND `ADMIN_NOTIFICATION_EMAIL`
  in `beforeEach`; the handler reads `ADMIN_NOTIFICATION_EMAIL` (`:325`) via the
  memoized accessor for the hard-bounce admin alert. Reset added.
- `worker/ingress/telegram/__tests__/telegram-verify.test.ts` — deletes/sets
  `TELEGRAM_WEBHOOK_SECRET` per-test, then calls `verifyTelegramSecret` (now reads via
  `getWorkerConfig()`). Reset added.
- `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts` — sets
  `TWILIO_AUTH_TOKEN` in `beforeEach` (the status + inbound handlers read it for the
  `authToken` arg). NOTE: this file mocks `verifyTwilioSignature` (so the token value
  never reaches a real verifier), but the handler still calls `getWorkerConfig()`;
  reset added for consistency + isolation safety.

**NOT converted (no migrated secret mutated against an assertion):**
- `worker/ingress/twilio/__tests__/twilio-verify.test.ts` — passes `authToken`
  DIRECTLY as a param (never reads env), and `twilio-verify.ts` is not touched. No
  reset needed.
- `worker/ingress/zernio/__tests__/zernio-verify.test.ts` — calls
  `verifyZernioSignature(body, sig, SECRET)` with a local `SECRET` constant (never
  reads env), and `zernio-verify.ts` is not touched. No reset needed.
- `worker/ingress/zernio/__tests__/zernio-webhook.test.ts` — sets
  `ZERNIO_WEBHOOK_SECRET` + `ZERNIO_PUBLISHING_ENABLED` in `beforeEach`; the handler
  reads `ZERNIO_WEBHOOK_SECRET` via the memoized accessor. Reset added.

The conversion is mechanical and assertion-preserving — a memoized snapshot of an
immutable runtime env equals a live read, so production behavior is identical.

## Tests added

- `src/lib/config/__tests__/worker.test.ts` — the 4 new ingress secrets
  present-when-set / `undefined`-when-unset via `getWorkerConfig()` (tolerate-absent,
  no throw), and a whitespace `'   '` passthrough on each (rawOptionalVar #7; RED
  under the collapsing `optionalVar` — proves a whitespace secret survives to the
  HMAC/compare exactly as the old raw read).
- Behavior-preservation for the verification paths is covered by the EXISTING
  signature tests (kept green with the memo-reset): Resend real-HMAC accept/reject/
  stale/tamper/missing-headers/fail-closed; Telegram match/mismatch/length-leak;
  Zernio HMAC accept/reject/format. No verification assertion is added or relaxed.

## Baseline (`scripts/ci/process-env-baseline.ts`): 58 → 54 (−4)

**Removed (no remaining non-exempt/non-flag `process.env` read after migration):**
- `worker/ingress/resend.ts` — only `MOCK_EXTERNAL_APIS` (exempt #2) remains.
- `worker/ingress/telegram/telegram-verify.ts` — no `process.env` read remains.
- `worker/ingress/twilio/twilio-delivery-status.ts` — no `process.env` read remains.
- `worker/ingress/twilio/twilio-whatsapp-inbound.ts` — no `process.env` read remains.

**Stays in baseline (still reads a Stage-4 flag):**
- `worker/ingress/zernio/zernio.ts` — `ZERNIO_PUBLISHING_ENABLED` (`:298`, Stage 4).
- `worker/ingress/stripe/shared.ts` — `ZERNIO_PUBLISHING_ENABLED` flag (not in this
  batch's scope; untouched).

The baseline is regenerated from the audit's own live scan (the 4 removals above);
`pnpm ci:process-env` confirms the live scan matches the committed baseline.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass.

## Status / open risks
- Migrated: 4 webhook-signature secrets (`RESEND_WEBHOOK_SECRET`,
  `TELEGRAM_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `ZERNIO_WEBHOOK_SECRET`) + the
  already-in-schema `ADMIN_NOTIFICATION_EMAIL` hard-bounce recipient, across 5 ingress
  files (6 reads), onto `getWorkerConfig()` — SOURCE-ONLY swap; every verification
  presence-check + algorithm + compare + reject path byte-for-byte unchanged.
- Left as-is (reported): `ZERNIO_PUBLISHING_ENABLED` flag (Stage 4, keeps `zernio.ts`
  in baseline), the exempt `MOCK_EXTERNAL_APIS` indicators.
- Risk surface is the security-critical verification logic — mitigated by NOT
  touching any verifier function (Twilio/Zernio are param-injected and untouched;
  Resend/Telegram change only the env-read line) and by keeping every signature test's
  assertions unchanged. If any swap could not be made byte-for-byte equivalent, the
  read would have been left as-is and reported — none needed to be.
