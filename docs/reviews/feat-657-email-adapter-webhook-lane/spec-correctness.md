# Spec & correctness review — feat-657-email-adapter-webhook-lane

**Reviewer role:** spec faithfulness + correctness. RISK=high (webhook ingress, email sending identity).
**Range:** `a6e38fe9..HEAD` (11 commits, 28 files, +5574/−79).
**Date:** 2026-08-16.

## Verdict

The branch is substantially clean. Every one of the 74 promised test titles is present, and — unusually
— every body I read genuinely asserts what its title claims, including the four that an earlier review
round had caught as comments-only. All ten CI audits pass, typecheck passes, and both test lanes were
run locally (166 unit tests across 10 files; **33/33 live-DB tests actually RAN**, not skipped).

Two findings survive the ≥80% confidence filter. Neither is a runtime defect in the shipped lane; one
is a contract-accuracy defect in the intake, one is a defence-in-depth guard that does not cover the
value it protects.

| severity | file:line | finding |
|---|---|---|
| medium | `.feature/intake.json:46` (and `docs/superpowers/plans/feat-657-email-adapter-webhook-lane-intake.json:46`) | The intake's unmatched-attribution `edge_cases` entry still states "structured warn, ack 200" unconditionally, but the shipped lane **throws → 503 → retry** for `email.bounced`(Permanent), `email.complained` and `email.suppressed` (`worker/ingress/resend/solicitation-lane.ts:233,265,293`). D1/F1 changed the behaviour and corrected only `rollback_plan` in the intake; the contract now contradicts the code on webhook retry semantics. |
| low | `src/lib/messaging/email-adapter.ts:76-77` | `assertSendable` validates the **trimmed** recipient but `send()` puts the **untrimmed** `message.recipient` on the wire (`:37`). `'a@b.test\r\n'` passes every guard — `.trim()` erases the CR/LF before `CRLF.test` and `/[,\s;]/` see it — and reaches `to:` verbatim, contradicting the file's own stated CR/LF rule. `subject` and `ownerEmail` are correctly tested untrimmed (`:80`, `:84`); the recipient is the sole exception. |

---

## Field-by-field intake walkthrough

### `goal`

Five deliverables, all present:

| Goal clause | Where | Verdict |
|---|---|---|
| MessagingAdapter seam | `src/lib/messaging/messaging-adapter.ts` | ✅ Mirrors `review-publisher.ts`: one interface, one method, lazy-singleton `getMessagingAdapter()`. |
| EmailAdapter (Resend) as first implementation | `src/lib/messaging/email-adapter.ts` | ✅ Owns the whole §7.1 envelope. |
| Domain-scoped sending identity + four config vars + boot assertion | `src/lib/config/server.ts:210-221`, `src/lib/notifications/email/client.ts:18-38`, `worker/config/startup-assert.ts:461-498`, `worker/index.ts:536` | ✅ Three NEW vars registered (`SOLICITATION_RESEND_API_KEY`, `SOLICITATION_SEND_FROM_ADDRESS`, `SOLICITATION_PLATFORM_DAILY_CAP`); the fourth, `SOLICITATION_UNSUBSCRIBE_MAILTO`, pre-existed and is asserted alongside them. |
| `getEmailHeaders` `'solicitation'` category that throws on a missing unsubscribe URL | `src/lib/notifications/email/headers.ts:120-167` | ✅ Fail-closed on all three paths. |
| Tag-discriminated solicitation lane recording bounce/complaint/provider-suppressed onto the Outreach row + Suppression ledger | `worker/ingress/resend/solicitation-lane.ts`, wired at `worker/ingress/resend.ts:189-196` | ✅ |

### `non_goals` — each checked against the diff

| Non-goal | Verdict | Evidence |
|---|---|---|
| Any migration | ✅ absent | `git diff --stat` touches no `supabase/migrations/**`. |
| Index on `solicitation_outreach.provider_message_id` | ✅ absent | Live-DB introspection: 10 indexes on the table, none on `provider_message_id`. |
| `delivered_at` write | ✅ impossible | The column does not exist (introspected). |
| `delivery_status` / `sent_at` write from the webhook lane | ✅ absent | Only three UPDATEs exist, all listed in the tenant-scope allowlist; none names either column. Two live-DB tests assert it non-vacuously (`delivery_status` still `'sent'` **while** `bounced_at`/`complained_at` moved). |
| `unsubscribed_at` write | ✅ absent | Same; live-DB test asserts NULL after complaint + suppressed. |
| Actually dispatching an ask | ✅ absent | `getMessagingAdapter()` has **zero** production callers (blast radius confirms 2 importers, both in-module/test). |
| Reputation circuit breaker | ✅ absent | No health-window/latch code. |
| Daily-cap enforcement | ✅ absent | `SOLICITATION_PLATFORM_DAILY_CAP` is registered + boot-asserted only; no read at any decision point. |
| Footer assembly / attested postal address | ✅ absent | Not touched. |
| Creating Resend domains / DNS records | ✅ absent | `docs/runbooks/solicitation-sending-domain.md` authored, not executed; carries the unresolved DMARC `rua` placeholder honestly (D7.3). |
| Changing the existing `notification_deliveries` path | ⚠️ see note | Behaviourally unchanged — the added guard only fires on `tags.lane==='solicitation'`, and the three classifier functions moved **verbatim** (byte-identical bodies + comments) to `worker/ingress/resend/bounce-classifier.ts`. They were **private** (never exported) pre-move, so no importer could break. D6 reports 444 pre-existing `worker/ingress` tests still green. The intake's literal "byte-for-byte unchanged" is not true of the *file*; it is true of the *path*. Not raised as a finding. |
| Push to Resend's suppression API | ✅ absent | No `resend.contacts.*` / suppression-API call anywhere. |
| Reply-based opt-out capture / moving transactional off the apex | ✅ absent | |

### `invariants` — each checked

| Invariant | Verdict |
|---|---|
| #6 ingress terminates on Railway | ✅ `worker/ingress/resend/`; nothing added under `src/app/api/**`. |
| #3 closed sideways by the key split | ✅ `getSolicitationResend()` never falls through to `getResend()`; the test constructs a fake `Resend` and asserts the transactional key is **never** passed to a constructor. |
| #5 closed the same way | ✅ same mechanism. |
| #13 server-only, no `NEXT_PUBLIC_*` companion | ✅ `ci:static-policy` passes (1148 files); no `NEXT_PUBLIC_SOLICITATION_*` anywhere. |
| #15 explicit DB client parameter | ✅ `handleSolicitationResendEvent(sql, …)`; `ci:db-imports` passes strict. |
| #10 `node:crypto` only | ✅ svix HMAC reused verbatim in `resend.ts`; the lane adds no crypto. |
| `notification_deliveries` path unchanged; `isOwnerDirectedTemplate` stays an allowlist | ✅ Untouched. A routing test asserts a solicitation payload emits no `owner_email_bounced`, no `UPDATE businesses`, and no admin alert. |
| `extractBounceType`/`isHardBounceType`/`classifyBounce` reused verbatim | ✅ Verbatim move; `'unknown'` → soft preserved; live-DB test asserts `bounced:soft:unknown`. |
| `recordSuppression` stays the single owner of the ON CONFLICT predicates | ✅ The lane calls it and re-spells nothing. Verified against the two real partial unique indexes. |
| `handles.ts` stays the single owner of normalization | ✅ The lane reads `c.email` (the stored Normalized handle) and never normalizes provider-echoed text. A live-DB test feeds `'  SOMEONE.Else+tag@Example.TEST '` in the payload and asserts the ledger key is the stored handle and that neither the raw nor the would-be-normalized form appears. |
| `sendEmail` stays the single send path / timeout / idempotency owner | ✅ Widened with `opts.client` rather than forked; four tests pin the default path, the injected path, the timeout, and the idempotency key. |
| `getEmailHeaders` stays the single List-Unsubscribe owner | ✅ A category on it, returning from its own branch **before** the marketing body; the marketing form is asserted byte-for-byte unchanged. |
| Every solicitation config var fails closed | ✅ `getSolicitationResend()` throws, `resolveFromAddress()` throws, `solicitationHeaders()` throws (3 paths), boot assertion throws. |
| Suppression write + Outreach signal write in ONE transaction | ✅ `withAttribution` is the single transaction owner. Proven by a µs-equality test (`complained_at` = `NOW()` in the UPDATE vs `suppressed_at`'s `now()` DEFAULT — equal to the microsecond **iff** one transaction; two transactions cannot agree) plus an abort-injection rollback test. |
| Signature verify / `claimInboundEvent` / 503 contract / stale-svix window unchanged and shared | ✅ The lane branch sits *after* the claim and *inside* the same try/catch; two live-DB tests drive the **real** `handleResendWebhook` with a real HMAC signature. |

### `edge_cases` — each checked, and each checked for a test

| Edge case | Handled | Tested |
|---|---|---|
| Unmatched `provider_message_id` → warn + ack, no suppression | ⚠️ **split by event** — see finding 1. Ack side: soft/unknown bounce, `email.failed`. Throw side: hard bounce, complaint, suppressed. | ✅ both sides (`…warns and acks…` uses `email.failed`; the extra `…retries rather than acknowledging an unmatched suppression-bearing event` covers the other half). |
| No tags → existing path | ✅ | ✅ |
| Tags as an array of `{name,value}` | ✅ `readTag` handles map **and** array | ✅ both shapes, plus negatives (`{lane:'notification'}`, `{}`, `null`). |
| Temporary/unknown bounce → record, no suppression | ✅ | ✅ two tests. |
| Permanent bounce → record + `bounce_permanent` global row, same tx | ✅ | ✅ |
| Complaint → `complained_at` + `complaint` global row | ✅ | ✅ |
| `email.suppressed` → `provider_suppressed` global row + loud log | ✅ (loud warn made **conditional** on a row actually being written — F11) | ✅ |
| `email.failed` → `failed.reason` into `provider_error`, never suppresses | ✅ `failed:${reason}` lowercased | ✅ |
| `delivery_delayed` / `sent` / `delivered` ack-and-log only | ✅ | ✅ three tests, each asserting the full column snapshot is unchanged. |
| `opened` / `clicked` / `scheduled` / `received` refused, not crashed | ✅ default branch warns and returns | ✅ `opened` and `clicked` only (the intake promised exactly those two titles). |
| `provider_error` preserved, not overwritten | ✅ `COALESCE(provider_error, …)` on all three UPDATEs | ✅ seeded with `send_failed:429_rate_limited`, asserts preservation **and** that the signal column still moved and the ledger row was still written. |
| Duplicate webhook for an already-suppressed handle → no-op, no duplicate analytics | ✅ `recordSuppression` first-write-wins skips the analytics insert on the no-op path | ✅ |
| Duplicate svix-id → ack without reprocessing | ✅ | ✅ against the real handler: erases `complained_at`, replays the same svix id, asserts it stays NULL. |
| Suppression write throws → whole event fails → 503 | ✅ | ✅ abort injection (real SQLSTATE 23514, never a temporary constraint). |
| `getEmailHeaders('solicitation')` with no URL → throw | ✅ | ✅ incl. whitespace-only. |
| …with a non-HTTPS URL → throw | ✅ | ✅ four bad forms (`http:`, `javascript:`, `mailto:`, `not a url`). |
| `SOLICITATION_RESEND_API_KEY` unset → throw, never falls through | ✅ | ✅ and asserts nothing was cached behind the throw. |
| Unparseable daily cap with the flag on → boot fails | ✅ | ✅ four bad values. |
| Explicit `0` with the flag on → boot succeeds | ✅ | ✅ |
| `MOCK_EXTERNAL_APIS=true` → no-op | ✅ | ✅ |
| >1 recipient refused | ✅ `/[,\s;]/` | ✅ comma form and whitespace form. |
| No plain-text part refused | ✅ `.trim()` emptiness check | ✅ |

### `user_visible_behavior`

All three claims hold, and nothing outside them is present:

1. **Lands inert.** Correct — `getMessagingAdapter()` has zero production callers, and the lane can only
   match a `provider_message_id` that #630 has not yet written.
2. **Boot refuses, naming the missing vars.** Correct, and the message names vars only.
3. **Tag routes before any DB lookup.** Correct. The routing test snapshots every SQL statement issued
   at the instant the lane is entered and asserts `inbound_events` (the shared idempotency claim) is the
   only one — no `notification_deliveries`, no `solicitation_outreach`, no `businesses`.

**One behaviour present that the list does not name:** the lane responds **503** to an unmatched
suppression-bearing event, which is externally visible to Resend (retry). It is covered by finding 1.

### `tests_to_add`

Mechanically verified: **74 promised titles, 0 missing**, all present verbatim across the 8 test files.
182 `it()` blocks total in those files; 108 "extras" are the pre-existing bodies in the two shared files
(`send-email.test.ts`, `startup-assertion.test.ts`) plus the 13 documented additions from D1/D4/D5.2.

I read every body. The three that D3 caught as comments-only now carry real assertions (F2 race, F3
ambiguity, F8 log-leak), and D4/F12's split of the F2 test into a race case and an atomicity case is
real: the race case holds the lock from a second connection first, then asserts via `pg_stat_activity`
that the parked statement is a **locking SELECT** — the discriminator a version reading attribution
outside the transaction would fail. That is genuinely mutation-sensitive.

Two title/body notes are recorded in the appendix; neither reaches the confidence bar.

### `allowed_edit_surface` — no drift

Every changed path maps to a surface entry:

| Changed path | Surface entry |
|---|---|
| `src/lib/messaging/**` (4 files) | `src/lib/messaging/**` |
| `src/lib/notifications/email/{headers,client,send-email}.ts` | named individually |
| `src/lib/notifications/email/__tests__/**` (3 files) | `src/lib/notifications/email/__tests__/**` |
| `src/lib/config/server.ts` | named |
| `worker/ingress/resend.ts`, `worker/ingress/resend/**` (2 new) | named |
| `worker/ingress/__tests__/**` (2 new) | named |
| `worker/config/startup-assert.ts`, `worker/config/__tests__/**` | named |
| `worker/index.ts` | named |
| `scripts/ci/tenant-scope-allowlist.ts` | named |
| `.claude/reference/env-vars.md`, `CONTEXT.md`, `docs/directory.md`, `docs/runbooks/solicitation-sending-domain.md` | named |
| `docs/superpowers/plans/**`, `docs/reviews/**` | named |

Amendment count remains 0 of the 2 budget, as the deviations file claims.

---

## Blast-radius caller analysis

The two large importer sets are the ones that matter.

### `src/lib/notifications/email/headers.ts` — 23 importers (the header widening)

Two distinct changes: `EmailCategory` gained `'solicitation'`, and `getEmailHeaders` gained an optional
second parameter.

- **The second parameter is additive with a default (`opts: EmailHeaderOptions = {}`).** No existing
  call site passes it; none can break.
- **`getEmailHeaders` is called with a *variable* category at exactly one site:**
  `src/lib/notifications/email/templates/internal.ts:52`, whose `sendInternalEmail` params type is
  `category?: EmailCategory` (`:36`). After the widening a caller *could* pass `'solicitation'` and get a
  runtime throw. I enumerated all 17 `sendInternalEmail` call sites: every one passes a string literal
  (`'internal'` or, in `contact-notify.ts:93`, `'internal'`). **No live caller can reach it.** The
  orchestrator triage reached the same conclusion and declined to narrow the type because
  `templates/internal.ts` is outside the edit surface — I agree with the non-action; the failure mode is
  fail-closed. Recorded in the appendix so #630 can close it when it adds the first real caller.
- **`getEmailTags` is generic over `EmailCategory`** and needed no change; the six template files that
  import `type EmailCategory` all annotate a `const category: EmailCategory = 'transactional'` and are
  unaffected by a wider union.
- **No exhaustive `switch` or `Record<EmailCategory, …>` exists anywhere** (grepped), so the widening
  cannot silently drop a branch. Typecheck confirms.
- **The marketing path is proven unmoved** by a byte-for-byte assertion on the exact
  `<url>, <mailto:addr>` string — the solicitation branch returns before that body.

### `src/lib/config/server.ts` — 443 importers

Three new `opt` (collapsing-optional) fields on `serverSchema`. Purely additive: no existing key
changed, no field became required, and `ci:config-coverage` passes at "7 required vars, baseline 7"
(unchanged). Consumers read via `getServerConfig().X` and are unaffected. `ci:process-env` passes
(baseline 9 files unchanged).

### The smaller sets

- `email/client.ts` — 23 importers: one new export added, `getResend()` untouched.
- `email/send-email.ts` — 8 importers: `opts` widened with an optional `client`; the pre-existing test
  still asserts `toHaveBeenCalledWith(payload, undefined)` on the default path, unchanged.
- `worker/ingress/resend.ts` — 5 importers: the three moved functions were **never exported**, so the
  extraction cannot break an importer. Confirmed by grep that no `isRecord`/`lowerNonEmptyString`
  reference is left dangling in `resend.ts`.
- `worker/config/startup-assert.ts` — 3 importers: one new export, one new call in `worker/index.ts`.
- `worker/index.ts` — 91 importers (mostly the audit scripts' file-graph walk): one added call inside
  `main()`.

---

## Correctness deep-dives (the named areas)

### 1. `solicitation-lane.ts` — the transaction boundary

`withAttribution` is the single owner. Inside one `sql.begin`:

1. `loadAttribution(tx, emailId)` — `SELECT … JOIN … LIMIT 2 FOR UPDATE OF o`
2. `apply(tx, attribution)` — the signal `UPDATE … WHERE id = ${attribution.id}` + `assertUpdatedOne`
3. `recordSuppression(tx, …)` — the ledger insert **and** its `enqueueAnalyticsEvent` insert

**Can a ledger row commit without its artifact, or vice versa?** No, with two intentional asymmetries
that are by design, not accident:

- `email.suppressed` writes a ledger row and **no** artifact — there is no Outreach column for it. The
  ledger *is* the record (stated in the intake and CONTEXT.md).
- soft bounce and `email.failed` write an artifact and **no** ledger row.

Every other combination is one commit or none. The `FOR UPDATE OF o` lock is what makes the
`WHERE id = …` UPDATE unable to hit zero rows, and `FOR UPDATE` is only meaningful inside `sql.begin`
under PgBouncer transaction pooling — the house gotcha is correctly respected.

I checked the postgres.js-specific hazards: `sql.begin` resolves with the callback's return value
(D4/F10's CFA fix is in the shipped code — an explicit `Promise<Committed | null>` annotation, no
closure `let`, no cast), and `LIMIT 2 … FOR UPDATE` plans as `Limit → LockRows → Scan`, so at most two
rows are locked even without an index.

The post-commit logging rule (D3/F9) is honoured: every recorder logs **after** `withAttribution`
resolves, so a rollback rejects before any line claims a fact the database does not hold. The one
pre-commit log — `throwUnmatched`'s warn — asserts a *read* fact ("matched no outreach row"), not a
write, so it is correct there.

### 2. The unmatched-event split

| Event | `onMissing` | Correct? |
|---|---|---|
| `email.bounced` (hard) | `throwUnmatched` → 503 | ✅ suppression-bearing |
| `email.bounced` (soft/unknown) | `warnUnmatched` → 200 | ✅ |
| `email.complained` | `throwUnmatched` | ✅ |
| `email.suppressed` | `throwUnmatched` | ✅ |
| **`email.failed`** | **`warnUnmatched`** | ✅ **on the ack side, as required** |
| `sent` / `delivered` / `delivery_delayed` | no attribution at all | ✅ |
| `opened` / `clicked` / `scheduled` / `received` | default warn, no attribution | ✅ |

The split is decided from the **payload** (`classifyBounce` runs before the lookup), which is what lets
`recordBounce` pick its `onMissing` per event rather than per handler. The 503 is genuinely retryable:
`markInboundEventFailed` leaves `status='failed'`, and `claimInboundEvent`'s reclaim branch
(`WHERE status = 'failed' OR …`) re-claims it. Verified end-to-end by a live-DB test that asserts both
the 503 body and `inbound_events.status = 'failed'`.

The retry bound is real: `verifySignature` rejects `ageSeconds > 300`, so a genuinely-unknown id is
401'd rather than retried forever. Note the practical consequence, which is a design property rather
than a defect: with Svix's retry ladder only the first two retries land inside 300s, so the #630
commit window this closes is roughly five minutes wide.

### 3. `COALESCE` preservation on `provider_error`

All three UPDATEs are `provider_error = COALESCE(provider_error, …)`. There is **no** path that can
overwrite a pre-existing bounded error — `email.suppressed` writes no UPDATE at all, and the observability
events do not attribute. Verified by seeding `send_failed:429_rate_limited` and asserting it survives a
permanent bounce while `bounced_at` still moves and the ledger row is still written.

### 4. `assertUpdatedOne`

Cannot be swallowed. It is `await`ed at all three call sites; a throw propagates out of `apply` → the
`sql.begin` callback → `withAttribution` → the recorder → `handleSolicitationResendEvent` →
`processResendEvent` → `handleResendWebhook`'s catch → `markInboundEventFailed` + 503. Zero rows is
structurally impossible anyway (the row is held under `FOR UPDATE` in the same transaction), which is
why the assertion is a bug detector rather than control flow. `updated.count` is postgres.js's rowCount
for an UPDATE without `RETURNING` — correct.

### 5. `email-adapter.ts` — `assertSendable` and header injection

- **`subject`** — `CRLF.test(message.subject)` on the untrimmed value. ✅
- **`ownerEmail` (Reply-To)** — `CRLF.test(message.ownerEmail)` on the untrimmed value. ✅
- **`recipient`** — tested on the **trimmed** value while the untrimmed value is sent. ❌ **Finding 2.**
  The comma/whitespace rule itself is right and is the correct way to enforce "exactly one recipient"
  (`to: ['a@x, b@y']` is one string and two mailboxes); `/[,\s;]/` covers comma, semicolon and any
  internal whitespace. An injection with a payload *after* the CRLF (`a@b\r\nBcc: x@y`) is caught,
  because trim only strips leading/trailing whitespace. Only a trailing/leading whitespace-only CR/LF
  survives — no injected header content, and `solicitation_contacts.email` is `normalizeEmail`-normalized
  at ingest, so the reachable input set today cannot produce it. Low severity, but the guard should
  cover the value it is guarding.

**From display-name escaping** is correct for backslash, quote, and both:

```
businessName.replace(/[\r\n]/g, ' ').replace(/(["\\])/g, '\\$1').trim()
```

`A\B` → `"A\\B"`; `A"B` → `"A\"B"`; `A\"B` → `"A\\\"B"` — all valid RFC 5322 quoted-strings. The single
character-class pass means no double-escaping. The trailing `.trim()` cannot strip half an escape
sequence: the inserted backslash always precedes a `"` or `\`, never whitespace.

### 6. `headers.ts` — the `'solicitation'` branch

Genuinely fail-closed on **every** path, with no fallback:

- `getEmailHeaders` dispatches to `solicitationHeaders()` **before** the `category !== 'marketing'` guard,
  so the degrading marketing chain is unreachable from this category.
- Missing/whitespace URL → throw. Non-HTTPS or unparseable URL → throw (both collapse into one specific
  error, deliberately). Missing `SOLICITATION_UNSUBSCRIBE_MAILTO` → throw.
- The function reads **neither** `LIST_UNSUBSCRIBE_URL` nor `RESEND_FROM_EMAIL`, so it can reach neither
  the global marketing URL nor the RFC 2606 `example.com` mailbox. The tests set `LIST_UNSUBSCRIBE_URL`
  and delete `RESEND_FROM_EMAIL` to prove exactly that.

### 7. `startup-assert.ts` — `assertSolicitationSendEnv`

- Explicit `0` **boots**: `Number('0') === 0`, `Number.isInteger(0)`, `0 >= 0`. ✅
- Unparseable **fails**: `Number('abc') → NaN`, `Number('10/day') → NaN`, `Number('2.5') → 2.5` (not an
  integer). ✅ Negative fails. ✅
- **The API key value is never reachable in any message or log.** The missing-vars message interpolates
  only the *names* (`missing.join(', ')`); the cap message names only the var. The function writes
  nothing to `console`. The test spies on `log`/`warn`/`error`, drives the success path and both failure
  paths, and asserts the key value appears in neither the thrown messages nor the captured output.
- Flag semantics match the runtime accessor exactly (`process.env.X === 'true'` ≡ `readFlag`), and the
  inline `process.env.*_ENABLED` read matches the five sibling assertions in the same file —
  `ci:static-policy` passes.

---

## Tenant scope

`ALLOWLIST_BASELINE` 392 → 397; `pnpm ci:tenant-scope` passes at "entries: 397 (baseline: 397)".

Five entries, all justified, and **every `UPDATE` is keyed on an id established by the locked read in the
same transaction**:

| # | Table | Statement | Justified? |
|---|---|---|---|
| 1 | `solicitation_outreach` | attribution `SELECT` | ✅ A webhook arrives with a provider message id and no tenant context. This statement *establishes* the account scope. |
| 2 | `solicitation_contacts` | **the same** `SELECT` | ✅ One statement the audit attributes per-table. Hoisted once into `SOLICITATION_LANE_ATTRIBUTION_SQL` and referenced by both entries per the file's "Shared snippets" convention — so the two entries cannot drift from each other. The join is already bound to the outreach row, so it inherits that row's scope. |
| 3 | `solicitation_outreach` | bounce `UPDATE` | ✅ `WHERE id = ${attribution.id}`, inside the same `sql.begin`. |
| 4 | `solicitation_outreach` | complaint `UPDATE` | ✅ same. |
| 5 | `solicitation_outreach` | failure `UPDATE` | ✅ same. |

Category `provider-ingress` matches the five sibling `worker/ingress/resend.ts` entries directly above.
The snippets must match the source byte-for-byte or the entries would be dead **and** the real statements
would go unallowlisted — the audit passing at exactly 397 proves all five are live.

The baseline bump carries a dated changelog comment in the format of the four entries above it (D6.1).

---

## Verification run (this review)

| Command | Result |
|---|---|
| `pnpm typecheck` | ✅ clean |
| `pnpm ci:static-policy` | ✅ 1148 files |
| `pnpm ci:process-env` | ✅ baseline 9 |
| `pnpm ci:config-coverage` | ✅ 7 required / baseline 7 |
| `pnpm ci:tenant-scope` | ✅ 397 / 397 |
| `pnpm ci:directory-map` | ✅ 553 files, no stale rows |
| `pnpm ci:live-db-suites` | ✅ |
| `pnpm ci:db-imports` | ✅ strict |
| `pnpm ci:analytics-events` | ✅ |
| `vitest --project parallel` (messaging, email `__tests__`, routing, startup-assert) | ✅ 10 files / 166 tests |
| `vitest --project integration resend-solicitation-lane.integration.test.ts` | ✅ **33 tests RAN and passed** (not skipped) |

Live-DB introspection independently confirmed: no `delivered_at` column; no index on
`provider_message_id`; `solicitation_suppressions.suppressed_at` DEFAULT `now()` (which is what makes the
one-transaction µs-equality test a real discriminator); both partial unique indexes present as
`recordSuppression`'s `ON CONFLICT` clauses spell them.

---

## Low-confidence appendix

Observations below the ≥80% bar, or deliberate design properties recorded so they are visible rather
than rediscovered.

1. **`templates/internal.ts:36` types `category?: EmailCategory`, so `'solicitation'` is now typeable
   into the internal-alert template and would throw at runtime.** All 17 live `sendInternalEmail` call
   sites pass a literal, so it is unreachable today, and the behaviour is fail-closed. Narrowing to
   `Exclude<EmailCategory, 'solicitation'>` would convert a runtime throw into a compile error — strictly
   better, but the file is outside `allowed_edit_surface`. Agreeing with the triage's non-action;
   flagged for #630, which adds the first real caller.

2. **A soft bounce arriving before a hard bounce for the same message masks the hard classification in
   `provider_error`.** `COALESCE` keeps `bounced:soft:transient`, while the ledger correctly records
   `bounce_permanent`. The artifact and the ledger then disagree about severity. No admin metric reads
   `solicitation_outreach.provider_error` (the `bounced:hard:` prefix filter is on
   `notification_deliveries.failure_reason`), and Resend emits one bounce event per message, so this is
   very unlikely to be observed. It is also the direct consequence of the intake's own preservation rule.
   Recorded, not raised.

3. **`loadAttribution` throws when the joined contact's `email` is NULL, including on ack-side events.**
   For `email.failed` or a soft bounce this turns a warn-and-ack into a 503, which is inconsistent with
   the split. The state is genuinely unreachable — `solicitation_contacts.email` is never NULLed
   (`ingest.ts:322` uses `COALESCE(… , email)`), a DELETE cascades the outreach row away, and a
   phone-only contact cannot receive an email ask — and the code says "Impossible" in a comment.

4. **`solicitationHeaders` emits `new URL(raw).toString()`, not `raw`.** For any URL WHATWG normalizes
   (adding a trailing `/` to a bare origin, percent-encoding a path character) the advertised
   List-Unsubscribe URL would not be byte-identical to the token URL minted at dispatch. Base64url
   tokens on a path are unaffected. Worth a glance when #630 mints the real URLs.

5. **Test title vs body, two cases.**
   (a) `the solicitation lane warns and acks when no outreach row matches the provider message id`
   exercises only `email.failed`; after D1/F1 the title is true only for the ack half. The other half is
   covered by a separate extra test, so combined coverage is complete — but the promised title now reads
   broader than its body.
   (b) `a failed suppression write rolls back the outreach signal write` (and its D4/F12 sibling) force
   the abort with a poison INSERT that runs *after* `recordSuppression` has already succeeded, so the
   ledger write does not literally fail. The property proven — the whole callback is all-or-nothing — is
   the one that matters and is arguably stronger; D5.3 is honest about the mechanism.

6. **`Number()` accepts forms a `parseInt`-based reader would not.** `SOLICITATION_PLATFORM_DAILY_CAP=1e3`
   boots as 1000 and `0x10` as 16. Harmless here (nothing enforces the cap), but #630's reader must use
   the same parse or boot and dispatch will disagree. Worth pinning when the cap is enforced.

7. **`resend-solicitation-routing.test.ts:103` sets `process.env.MOCK_EXTERNAL_APIS = 'true'` with no
   `afterEach` restore.** Identical to the pre-existing `resend-webhook-bounce.test.ts:69`, and vitest
   isolates per file, so this is established practice rather than new risk. Noted only because
   CLAUDE.md warns that a leaked `MOCK_EXTERNAL_APIS=true` short-circuits Zernio transport.

8. **The attribution `SELECT` is a sequential scan** (no index on `provider_message_id`, by explicit
   owner decision) executed once per solicitation webhook event, holding a transaction open. Fine at zero
   rows; the index is correctly deferred to #630, which ships the volume. Flagged only so it is not
   forgotten alongside the deferral.

9. **`recordFailure`'s log omits `business_id`**, and the `sent`/`delivered`/`delivery_delayed` and
   refused-event lines carry no attribution ids at all. The `observability` entry describes one line per
   event "carrying event type, outreach id, account_id, business_id". Cosmetic; the ids that matter for
   an incident are present on every line that has attribution.

10. **The `docs/runbooks/solicitation-sending-domain.md` DMARC `rua` placeholder is a real unresolved
    input, not a doc gap** (D7.3, seconded by the orchestrator triage). #633 cannot execute the DNS
    section until the mailbox-or-vendor decision is made. Carried forward to the owner.
