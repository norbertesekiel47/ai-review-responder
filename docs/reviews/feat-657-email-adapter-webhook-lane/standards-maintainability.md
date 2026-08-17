# feat-657 — Standards & maintainability review

**Branch:** `feat-657-email-adapter-webhook-lane`
**Diff under review:** `a6e38fe9..HEAD` (11 commits + 5 docs commits; 28 files, +5,574 / −79)
**Reviewer axis:** repo standards, deep-module discipline, Fowler smells, glossary fidelity
**Tool used:** the repo's `thermo-nuclear-code-quality-review` skill. It invoked successfully
and loaded its criteria; I then executed the audit directly against the diff (the skill is a
criteria/tone contract, not a runner). `/code-review` was not needed as a fallback.
**Date:** 2026-08-16

---

## Verdict

**Approve with findings.** No structural regression, no spaghetti growth, no boundary leak,
no file-size explosion in production code, and every repo audit is green. Two findings are
worth fixing before merge (one high, one medium); the rest are cheap cleanups.

This is unusually disciplined work. The three round-of-review deviations (D1/D3/D4) caught
real defects and the fixes are visible in the shipped code, not just claimed in the doc — I
verified F10 (the CFA-safe callback return), F11 (the conditional §6.2 warn), F2 (the
`FOR UPDATE` inside `sql.begin`) and F3 (`LIMIT 2` + throw) against the source directly.

### Audits run (all green)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `npx eslint` over the changed surface | pass, 0 findings |
| `pnpm ci:static-policy` | pass (1,148 files; no new `NEXT_PUBLIC_*`) |
| `pnpm ci:directory-map` | pass (553 files, no stale rows) |
| `pnpm ci:db-imports` | pass (strict) |
| `pnpm ci:tenant-scope` | pass — 397 entries, baseline 397 |

---

## Findings

| Severity | Location | Finding |
|---|---|---|
| high | `src/lib/messaging/email-adapter.ts:47` + `worker/ingress/resend/solicitation-lane.ts:24` | The Solicitation-lane routing discriminant (`lane` / `'solicitation'`) is spelled as bare string literals on both sides of a cross-module contract, with no shared constant and no test that binds the two halves. |
| medium | `src/lib/notifications/email/headers.ts:66-70` | `getEmailHeaders(category, opts = {})` leaves `opts` optional for every category, so `getEmailHeaders('solicitation')` compiles and fails only at runtime — the mandatory-`unsubscribeUrl` invariant is expressible in the type system, in a file already inside the edit surface. |
| medium | `src/lib/messaging/email-adapter.ts:58-62` | The adapter embeds provider-controlled `result.error?.message` verbatim into a thrown `Error`, while the sibling lane file states and enforces that provider-controlled text may carry a recipient address and must reach a column, never a log. |
| low | `worker/ingress/resend/solicitation-lane.ts:178` | `SuppressionSourceToRecord` hand-rolls a subset of the canonical `SuppressionSource` union exported by the very module this file already imports `recordSuppression` from. |
| low | `worker/ingress/resend/solicitation-lane.ts:180-189` | `withAttribution` models a strictly two-valued policy choice as an open `onMissing` callback inside a 5-positional-parameter, 2-callback signature — speculative generality. |
| low | `worker/ingress/resend/solicitation-lane.ts:218` | `assertUpdatedOne` is declared `async` with no `await` in its body; three call sites `await` a synchronous assertion. |
| low | `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts:1` | New file lands at 1,107 lines with ~430 lines of fixture scaffolding ahead of the first `it`, crossing the 1k threshold on creation. |

---

## Finding detail

### H1 — the lane discriminant has no single owner

`src/lib/messaging/email-adapter.ts:47`

```ts
{ name: 'lane', value: 'solicitation' },
```

`worker/ingress/resend/solicitation-lane.ts:24`

```ts
return readTag(data, 'lane') === 'solicitation';
```

Five independent spellings of one contract exist on this branch: the writer, the reader, and
three test files (`email-adapter.test.ts:227`,
`resend-solicitation-routing.test.ts:95,246`,
`resend-solicitation-lane.integration.test.ts:828,865`). Nothing binds any of them — I
grepped for a shared constant and there is none. `ci:static-policy`'s literal rules do not
cover this vocabulary.

**Named standard.** `.claude/CLAUDE.md` → Working rules: *"No string literals for
subscription status, tier IDs, job names, or review status — import the constant from its
single authoritative TS file."* A webhook routing discriminant is squarely in that class; it
is the same kind of fact as a job name. `src/lib/solicitation/suppression.ts` is the model —
`SUPPRESSION_SOURCES`/`SUPPRESSION_SCOPES`/`SUPPRESSION_CHANNELS` exported `as const`
precisely so no call site spells them.

**Concrete failure scenario.** A rename or typo on either half — say the adapter is later
changed to emit `lane: 'solicitation_email'` when a second channel lands, and the ingress is
not updated in the same edit. Every solicitation webhook then falls through
`isSolicitationLane` into the untouched transactional branch of `processResendEvent`
(`worker/ingress/resend.ts:197-213`), where `email.complained` and `email.bounced` run
`UPDATE notification_deliveries … WHERE external_message_id = <resend id>`. Those match zero
rows. postgres.js does not error on a zero-row UPDATE, `markInboundEventProcessed` runs, and
the handler acks 200. Result: permanent bounces and complaints are silently discarded, no
`solicitation_suppressions` row is written, and the recipient keeps being contacted — the
exact CAN-SPAM outcome the Suppression ledger exists to prevent. There is no error, no
`inbound_events` failure row, and therefore no `checkFailedInboundEvents` alert.

**Why the existing tests do not catch it.** `resend-solicitation-routing.test.ts:206` ("a
solicitation payload never writes notification_deliveries") proves the reader handles a
correctly-tagged payload. It constructs that payload by re-spelling the literal, so it is
blind to a change on the writer side. Symmetrically `email-adapter.test.ts:217` re-spells it
on the writer side. The two suites can never disagree with each other, only with production.

**Remedy.** Export one constant and import it on both sides — the tag *name* and the *value*.
The lane file already imports from `src/lib/solicitation/`, so there is no structural
obstacle; either `src/lib/messaging/messaging-adapter.ts` or `src/lib/solicitation/` is a
defensible home. Have the tests import it too, so the round trip is proven rather than
assumed.

### M1 — the mandatory `unsubscribeUrl` is a doc comment where it could be a type

`src/lib/notifications/email/headers.ts:66-70`

```ts
export function getEmailHeaders(
  category: EmailCategory,
  opts: EmailHeaderOptions = {},
): Record<string, string> {
  if (category === 'solicitation') return solicitationHeaders(opts.unsubscribeUrl);
```

`EmailHeaderOptions.unsubscribeUrl` is `string | undefined`, and `opts` itself defaults to
`{}`. The file's own doc comment (`headers.ts:24-27`) says `unsubscribeUrl` *"is REQUIRED for
'solicitation'"*, and `solicitationHeaders` enforces it — at runtime, with a throw, on the
live send path.

**Named standard.** Thermo-nuclear rule 5 (*"Push hard on type and boundary cleanliness… If a
branch relies on a silent fallback to paper over an unclear invariant, ask whether the
boundary should be made explicit instead"*) and the repo's preference for making illegal
states unrepresentable, which `RecordSuppressionInput`
(`src/lib/solicitation/suppression.ts:164-201`) models beautifully three files away — a
discriminated union chosen *specifically* so `owner_manual` + `global` "cannot even be typed".

**Why the recorded triage does not cover this.** The orchestrator's step-6 read-back
(`…-deviations.md:336-343`) considers the *analogous* hazard in
`src/lib/notifications/email/templates/internal.ts:36`, concludes that narrowing to
`Exclude<EmailCategory, 'solicitation'>` "would convert a runtime throw into a compile-time
error, which is **strictly better**", and declines it **only** because `templates/internal.ts`
is outside `allowed_edit_surface`. That reason does not apply to `headers.ts`, which this
branch already modifies heavily. So the team has already stated the preferred shape and has
the surface to apply it — the call site was simply not examined.

**Concrete failure scenario.** #630's dispatch worker (or any later `MessagingAdapter`
tenant) calls `getEmailHeaders('solicitation')` and forgets the second argument. It compiles,
passes typecheck, passes lint, and throws on the first real send.

**Remedy.** Two overload signatures in the same file, no caller changes:

```ts
export function getEmailHeaders(category: Exclude<EmailCategory, 'solicitation'>): Record<string, string>;
export function getEmailHeaders(category: 'solicitation', opts: { unsubscribeUrl: string }): Record<string, string>;
```

The existing runtime throws stay as defence in depth (they still guard the non-HTTPS and
missing-mailbox cases, which a type cannot express), and the tested behaviour at
`headers-solicitation.test.ts:110` is unaffected.

### M2 — provider-controlled text escapes into an Error message the caller will log

`src/lib/messaging/email-adapter.ts:58-62`

```ts
if (result.error || !result.data?.id) {
  throw new Error(
    `Resend refused the solicitation send: ${result.error?.message ?? 'no message id returned'}`,
  );
}
```

This branch establishes its own explicit standard for provider-controlled strings, twice, in
the sibling file:

- `solicitation-lane.ts:254-256` — *"The KIND only. `reason` embeds provider-controlled text
  that can carry a recipient address; it belongs in `provider_error` (a column) not a log."*
- `solicitation-lane.ts:353-355` — *"Reason is provider-controlled text — stored, never
  logged."*

That standard is applied rigorously in the lane and not at all in the adapter. A Resend API
error message is provider-controlled text of exactly the same character (its validation
errors quote the offending field), and `MessagingAdapter.send`'s contract is *"THROWS on every
failure"* — so the first thing #630 does with it is `catch` and log it. Nothing on the adapter
side keeps it off that log line.

This is a consistency finding, not a claim that a leak exists today (there is no production
caller yet). The point is that the branch is authoring the contract #630 will inherit, and the
contract as written hands the caller a string it has been told elsewhere never to log.

**Remedy.** Throw a small typed error carrying the provider text on a named field
(`providerMessage`) rather than in `.message`, so the caller can persist it to `provider_error`
without the default `err.message` log path carrying it. Or classify at the adapter boundary
and keep the raw text out of the thrown value entirely.

### L1 — a canonical union is re-spelled

`worker/ingress/resend/solicitation-lane.ts:178`

```ts
type SuppressionSourceToRecord = 'bounce_permanent' | 'complaint' | 'provider_suppressed';
```

`src/lib/solicitation/suppression.ts:25-34` exports `SUPPRESSION_SOURCES` `as const` and
`SuppressionSource`, and `RecordSuppressionInput`'s machine variant already narrows it as
`Exclude<SuppressionSource, 'owner_manual' | 'admin_manual'>` (`suppression.ts:188`). This
file already imports `recordSuppression` from that module.

The compiler does catch a rename (the literal flows into `recordSuppression`'s typed `source`
field), so this is a duplication smell rather than a latent bug — hence low. But it is a
second, unowned enumeration of a vocabulary that file explicitly owns, and CONTEXT.md's
Suppression ledger entry says the sources are *"exported as `as const` arrays by the single
authoritative `src/lib/solicitation/suppression.ts`, never string literals at call sites."*

**Remedy.** `type SuppressionSourceToRecord = Extract<SuppressionSource, 'bounce_permanent' | 'complaint' | 'provider_suppressed'>;`
— or reuse the existing `Exclude<…>` alias directly.

### L2 — `onMissing` is a callback where a boolean would do

`worker/ingress/resend/solicitation-lane.ts:180-189`

```ts
async function withAttribution(
  sql: Sql,
  emailId: string,
  event: string,
  onMissing: (emailId: string, event: string) => void,
  apply: (tx, attribution) => Promise<SuppressionSourceToRecord | null>,
): Promise<Committed | null>
```

Five positional parameters, two of them callbacks. `onMissing` has exactly two possible values
in the entire codebase — `warnUnmatched` and `throwUnmatched`, both module-local — and the
choice is 1:1 with a single domain property: is this event suppression-bearing? `recordBounce`
even computes it inline as `isHard ? throwUnmatched : warnUnmatched`.

**Named smell.** Speculative generality (Fowler): a higher-order parameter that will never
have a third value, admitting an open set where the domain has a closed one. It also erases
information — the declared return type `void` cannot express that `throwUnmatched` returns
`never`, so the type system cannot tell a reader that suppression-bearing events never reach
the `return null` line.

**Remedy (behaviour-preserving).** Replace `onMissing` with `suppressionBearing: boolean` (or
move to a single options object). `warnUnmatched` and `throwUnmatched` collapse into one
function with a branch, one parameter disappears, the forwarding of `emailId`/`event` into the
callback disappears, and the call sites read as the domain fact they are.

I want to be clear about what I am *not* flagging: `withAttribution` itself is a good
abstraction and should stay — see "Deep-module assessment" below. This is about its signature,
not its existence.

### L3 — `assertUpdatedOne` is needlessly async

`worker/ingress/resend/solicitation-lane.ts:218-222`

```ts
async function assertUpdatedOne(count: number, outreachId: string): Promise<void> {
  if (count !== 1) { throw new Error(...); }
}
```

No `await` in the body. Three call sites `await` it. Beyond the pointless microtask, an
`async` throwing helper is the shape where a future call site that forgets the `await` turns a
hard assertion into an unhandled rejection — and this one runs inside `sql.begin`, where a
missed rejection would let the transaction commit a state the assertion exists to forbid.

**Remedy.** `function assertUpdatedOne(count: number, outreachId: string): void` and drop the
three `await`s.

### L4 — new test file crosses 1k lines on creation

`worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts` — 1,107 lines, 33
cases, with the first `it` at line 431. Roughly 430 lines are fixture scaffolding
(`seedOutreach`, the two-connection setup, the log capture, the svix signing helper).

Thermo-nuclear rule 1 targets a *file crossing* the 1k threshold; a new file landing above it
is the same smell. I want to give the author full credit here: the scaffolding is genuinely
good — it reuses `seedTenantAccount`, `insertOutreach`, `abortingExecutor`, `acquireLiveDbLock`
and `assertSchemaReady` rather than minting a second seeding vocabulary, and the header
comment justifies the live-DB lock convincingly.

I am **not** recommending splitting the suite: two live-DB suites means two lock acquisitions
and duplicated seeding, and the `integration` project serialises anyway, so that trade is
probably negative.

**Remedy.** Move the fixture layer to `worker/ingress/__tests__/helpers/solicitation-outreach-fixture.ts`.
The #573 rule bars run-time DDL in live-DB files, not helper modules — the repo already keeps
`src/lib/shared/__tests__/helpers/` for exactly this — and `#630` will need the same fixtures.
That takes the suite to ~700 lines of pure cases.

---

## Deep-module assessment

### `MessagingAdapter` — is the seam earning its keep?

Split the question in two, because the two halves score differently.

**`EmailAdapter` is a genuinely deep module. Keep it as is.** Interface: one method, one DTO.
Hidden behind it: From-line construction with quote-escaping and CRLF-stripping, Reply-To
placement, the one-recipient *rule* (not shape — the comment at `email-adapter.ts:74-75` about
`'a@x.test, b@y.test'` being one string and two mailboxes is the sharpest observation on the
branch), the always-multipart requirement, List-Unsubscribe + RFC 8058 headers, four Resend
tags, the idempotency key, fail-closed client and From-address resolution, and the
`{data, error}` → throw conversion. That is a lot of complexity a caller no longer has to
know, in 110 lines. Ousterhout would approve.

**The `MessagingAdapter` interface is the right mitigation for the hypothetical-seam problem.**
I agree with map decision 14. One method plus a DTO derived from a locked spec envelope is
about as close to zero commitment as a seam can get; if WhatsApp wants a different shape,
deleting this costs an afternoon. The `OutboundMessage` DTO in particular is *not* speculative
— it is the envelope #630 must construct regardless of whether an interface exists.

**`getMessagingAdapter()` is the one piece that buys nothing today.** With a single
implementation, "selection" is not an operation; the function is an exported symbol with zero
production callers whose only tested behaviours are "returns the only class" and "caches"
(`messaging-adapter.test.ts`, 45 lines — that suite is testing the language, not the domain).
It also installs process-global mutable state with no reset hook, which #630 inherits without
asking for it.

I am deliberately **not** putting this in the findings table. Map decision 14 records the
hypothetical seam as a considered trade-off, the cited precedent
(`src/lib/publishing/review-publisher.ts:63-71`) is byte-for-byte the same lazy-singleton
shape including the absent reset hook, and the instruction is not to relitigate documented
decisions. Recorded here so the option is visible: if #630 ends up writing
`new EmailAdapter()` directly, `getMessagingAdapter()` should be deleted rather than
retrofitted with a caller.

### `solicitation-lane.ts` — is the transaction boundary smeared?

**No. It has exactly one owner and that is the file's best structural property.** `sql.begin`
appears once (line 193), inside `withAttribution`. Every write in the lane — the `FOR UPDATE`
attribution read, the outreach signal UPDATE, the optional ledger insert — is inside that one
callback. `apply` receives `tx` as an explicit parameter, so callers run *inside* the
transaction without *owning* it: that is proper inversion, not smearing.

Two details deserve credit. First, `withAttribution` returns a value **only on a committed
write** (the F9 fix), so no recorder can log a fact the database does not hold — the inverse
of the house rule that observability must not poison the success path, and correctly reasoned.
Second, the `suppressionWritten` flag exists for exactly one caller and the comment says so
outright (`:169-171`). Normally I would flag a return contract widened for a single consumer,
but here the alternative — `recordProviderSuppressed` re-querying the ledger to find out
whether its own insert won — is worse, and the §6.2 divergence-warning reasoning at `:299-318`
is the single sharpest piece of judgement in the diff. Correct as built.

### `withAttribution` as an abstraction

Good idea, awkward signature. The idea — one function owning the transaction boundary,
parameterised by what varies per event — is right and I would not replace it. The signature is
where it slips: 5 positional parameters, 2 callbacks, and one of the callbacks encoding a
boolean (L2 above). Fixing L2 takes it to 4 parameters and 1 callback, which is a shape a
reader can hold.

### Code-judo search: did I find a reframing that deletes complexity?

I looked hard for one and concluded there is not a good one, which I record explicitly because
the skill demands the search rather than the conclusion.

The obvious candidate is collapsing the four recorders into a data table keyed by event type
(`{ 'email.bounced': { columns, source, suppressionBearing }, … }`). I would push back on that
if it were proposed. The four events differ in ways a table cannot express without escape
hatches: `email.bounced`'s suppression-bearing-ness is *dynamic* (computed from the payload
classification before any lookup), `email.suppressed` performs no UPDATE at all,
`email.failed` formats its value as `` `failed:${reason}` ``, and `recordProviderSuppressed`'s
post-commit logging is conditionally loud in a way no other event is. A table would turn four
legible functions into one table plus four callbacks plus a dispatcher — the same complexity,
relocated, with more magic. The current decomposition (switch → named recorder → shared
transaction owner) is the right one.

### Fowler baseline

| Smell | Verdict |
|---|---|
| Long function | None. Largest new function is `withAttribution` at ~23 lines of body; `handleSolicitationResendEvent` is a 20-line switch. |
| Feature envy | None. `bounce-classifier.ts` was extracted precisely to avoid the lane reaching into `resend.ts`. |
| Primitive obsession | Present but mild, and it is H1: the lane discriminant is a bare string pair rather than a named constant. |
| Shotgun surgery | None introduced. The classifier extraction *reduces* it — "what counts as permanent" now has one owner instead of two. |
| Speculative generality | Two instances: `getMessagingAdapter()` (documented, accepted — see above) and `onMissing` (L2, not documented). |

---

## Repo-standards checklist

| Standard | Result |
|---|---|
| **Invariant #1** — Vercel = UI only | **Pass, with a pre-existing caveat.** Nothing under `src/app/**` or `src/components/**` imports `src/lib/messaging/*` (verified by grep — the only importers are the seam's own two files and its tests). The ESLint ban list (`eslint.config.mjs:40-52`) covers openai / anthropic / bullmq / postgres / the generator / the LLM seam / the queue registry, and does **not** cover `resend`. But that gap predates this branch and is repo-wide: `src/lib/notifications/email/client.ts` holds the only `import { Resend }` in production and is equally unguarded, as is the cited `publishing/review-publisher.ts` seam over the Zernio client. Raising it against #657 would be scope creep. See appendix A1. |
| **Invariant #2** — transactional outbox | N/A. No new async work, no `job_outbox` write. `recordSuppression`'s analytics insert rides the lane's existing transaction. |
| **Invariant #13** — server-authoritative flags | **Pass.** Three new vars registered in `src/lib/config/server.ts:210-220`, all `opt`, no `NEXT_PUBLIC_*` companion; `ci:static-policy` green. |
| **Invariant #15** — explicit DB client | **Pass.** `handleSolicitationResendEvent(sql: Sql, …)` takes its client as a parameter and imports nothing from `@/lib/db/server`; the only importer is `worker/ingress/resend.ts`, a sanctioned composition root. `ci:db-imports` green in strict mode. |
| **Tenant scope** | **Pass.** Five allowlist entries, `provider-ingress` category matching the five sibling `resend.ts` entries, baseline bumped 392 → 397 in the same edit with a dated changelog comment. The shared-snippet hoist (`SOLICITATION_LANE_ATTRIBUTION_SQL`) follows the file's own convention. |
| **No `any`** | **Pass.** Zero occurrences across the new files. `unknown` + narrowing used throughout (`isRecord`, `readTag`, `readFailureReason`). |
| **No silent catches** | **Pass.** One `catch` in the new code (`headers.ts:141`) and it rethrows with a specific message, with a comment explaining why a parse failure and a non-HTTPS scheme are the same defect. Correct. |
| **Structured logging hygiene** | **Pass in the lane, gap in the adapter.** The lane never logs the recipient, the raw bounce reason or the failure reason, and there is a dedicated test for it. See M2 for the adapter. |
| **Entry points orchestrate** | **Pass.** `processResendEvent` gained 4 lines (a guard + delegate). `handleResendWebhook` unchanged. `worker/ingress/resend.ts` *shrank* 350 → 290 lines. |
| **Boot assertion convention** | **Pass.** `assertSolicitationSendEnv` matches `assertChannelsWhatsAppEnv` / `assertAccountOffboardingEnv` exactly: flag gate, `MOCK_EXTERNAL_APIS` early return, raw `process.env`. I checked the one divergence risk — `readFlag` (`src/lib/config/flags.ts:21`) is literally `process.env[name] === 'true'`, so the boot assert and the runtime gate cannot disagree. Names the var, never the value. |
| **`ci:directory-map`** | **Pass.** Six rows, including the two *corrected* existing rows for `email/client.ts` and `email/headers.ts` (D7.1). That correction was the right call and the reasoning generalises. |

## Glossary fidelity

**Clean.** All three coined terms — **Messaging adapter**, **Sending identity**, **Solicitation
lane** — are defined in `CONTEXT.md` with `_Avoid_` lists, and the code respects them. I grepped
the new production files for every banned synonym (`mailer`, `sender`, `transport`,
`email service`, `blocklist`, `opt-out table`, `send record`, `second handler`, `from address`,
`sender config`, `mail identity`) and found no violation. The consumed locked terms are used
correctly: `normalized_handle` is sourced from `solicitation_contacts.email` with a comment
citing migration 086 (`solicitation-lane.ts:47`), the Suppression ledger write goes through the
single-owner `recordSuppression`, and rule DR1 is honoured — `solicitation-lane.ts` reads no
feature flag, which I verified by grep.

One naming note in the right direction: the file header comments consistently say "Solicitation
lane", not "solicitation webhook" or "second handler". The vocabulary discipline here is better
than most of the repo.

---

## Low-confidence appendix

Observations below **did not** meet the ≥80% bar or are stylistic. None belongs in the table.

**A1 — `resend` is not in the invariant-#1 ESLint ban list.** `src/lib/messaging/` exists to make
an outbound provider call, and nothing mechanically stops a future Server Component from
importing it. The honest position is that this is a repo-wide gap (Resend and the Zernio client
are both outside the list) and not something #657 introduced. If it is ever worth closing, the
cheap version is adding `{ group: ['resend', 'resend/*'], allowTypeImports: true }` plus a
`**/lib/messaging/*` group to `VERCEL_FORBIDDEN_RUNTIME_IMPORTS` and the matching dynamic-import
selector — a one-line-each change that `src/__tests__/eslint-boundaries.test.ts` would then pin.
Belongs in its own PR.

**A2 — `sendEmail(payload, { client })` lets the two halves of the Sending identity be chosen
independently.** `send-email.ts:47` is `opts.client ?? getResend()`, so a caller that builds a
solicitation-categorised payload and omits `client` sends it on the *transactional* key. Not
reachable today (`EmailAdapter` always passes `this.resolveClient()`, which throws when unset),
and CONTEXT.md's stated guarantee is specifically about *unset config* — all three fail-closed
throws are in place — so this is not a contract violation. A stronger shape would be
`sendEmail(payload, { identity: 'transactional' | 'solicitation' })` resolving the client
internally, making the mismatch unrepresentable. Hardening suggestion, not a defect.

**A3 — `isRecord` is defined identically in both new files in `worker/ingress/resend/`.**
`bounce-classifier.ts:31` and `solicitation-lane.ts:39` are byte-identical, and the classifier's
header explicitly says the helper "stays private to this file" as part of the verbatim-move
decision. There is no canonical export anywhere in the repo — four file-private copies already
exist — so the branch is following the house idiom, and creating a canonical one is a repo-wide
change. Noted only because a brand-new two-file directory containing the same 3-line helper
twice is the moment that idiom looks least defensible.

**A4 — the 300s retry bound has a quiet terminal case.** `throwUnmatched` relies on
`verifySignature`'s stale-`svix-timestamp` rejection (`resend.ts:57`) to bound retries, which
gives roughly 2–3 Svix attempts inside ~5 minutes before every further retry is 401'd. I
initially had this as a finding — a permanently-lost complaint — and then found the alerting
path: `markInboundEventFailed` leaves `inbound_events.status = 'failed'`, which
`checkFailedInboundEvents` (`worker/background/pollers/health-alert/checks.ts:260-276`) raises
as `inbound_events_failed:resend:email.complained`. So the case is covered by an existing
repo-wide mechanism the lane inherits for free. The only residual is that a single lost event
below `failedThreshold` would not page — a threshold-tuning question on shared infrastructure,
not a #657 defect. Recorded so the next reviewer does not re-derive it.

**A5 — `assertSendable` validates 4 of 10 `OutboundMessage` fields for content.** `businessName`,
`bodyHtml`, `subject` (emptiness), and the four id fields are unchecked, so
`formatFrom('', addr)` yields `"" <addr>` and an empty `outreachId` would be silently dropped as
an idempotency key by `send-email.ts:51`'s truthiness check. The DTO's comment ("every field is
required") is about *presence*, which TypeScript does enforce, so this is not the inconsistency
it first looks like. Every field `assertSendable` *does* check is a header-injection-bearing
one, which is a coherent scope. Stylistic.

**A6 — `type ResendClient = ReturnType<typeof getResend>` via `import { type getResend }`.**
(`email-adapter.ts:9,14`.) Legal TypeScript and it keeps the `resend` package import confined to
`client.ts`, which is good layering — but `ReturnType<typeof aFunction>` used purely to name a
class is an idiom that reads as indirection on first encounter. It mirrors `send-email.ts:12-14`,
so it is at least consistent. Stylistic.

**A7 — the payload carries the lane twice.** `getEmailTags('solicitation')` emits
`category=solicitation` and the adapter separately emits `lane=solicitation`
(`email-adapter.ts:44-47`). Two tags, one fact, different consumers (dashboard filter vs routing
discriminant). Deliberate and documented. Not worth collapsing — but if H1's shared constant
lands, it is worth a comment saying which one routing reads.

---

## What this branch does well

Recording these because a review that only lists defects misrepresents the diff.

1. **The classifier extraction reduces complexity rather than relocating it.**
   `worker/ingress/resend.ts` went 350 → 290 lines, and "what counts as a permanent bounce" now
   has one owner shared by two lanes instead of the copy that a second implementation would have
   produced. The stated reason — exporting from `resend.ts` would make the lane import its own
   parent — is correct and the fix is the right one.
2. **The lane's write surface is stated, narrow, and tested as a negative.** Three dedicated
   cases assert the lane *never* writes `delivery_status`, `sent_at` or `unsubscribed_at`. Testing
   what a module refuses to do is rarer and more valuable than testing what it does.
3. **The F11 fix is genuine engineering judgement.** Recognising that a first-write-wins no-op on
   `email.suppressed` means the two lists *agree* — and that warning anyway would train an admin
   to ignore the signal — is the kind of reasoning that does not come from a checklist.
4. **D5.1 is honest self-correction.** The plan's own F2 test body asserted the ledger had 1 row
   while its title said "writes nothing", and was racy besides. Catching and rewriting that during
   execution, then recording it, is exactly what the deviations file is for.
5. **The deviations file is unusually load-bearing.** I spot-checked five entries against source
   and every one was accurate. That is not typical.
