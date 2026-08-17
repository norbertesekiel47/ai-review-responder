# Email adapter (MessagingAdapter seam) + sending identity + Resend solicitation lane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Messaging adapter seam with EmailAdapter (Resend), the solicitation Sending identity plus four config vars with a boot assertion, the `getEmailHeaders` `'solicitation'` category that throws on a missing URL, and the tag-discriminated Solicitation lane in the Resend webhook ingress.

**Architecture:** Three independent vertical slices that only meet at the adapter. Config + boot assert gate **sending**, never the ingress: per glossary rule **DR1**, `SOLICITATION_SEND_ENABLED` masters sending only, so the Solicitation lane, the unsubscribe ingress and the landing page stay fully live when it is off. Do not add a flag gate to the lane. `getEmailHeaders` gains a fail-closed category rather than a forked second builder. The adapter composes both behind a one-method interface. The webhook lane is separate machinery that shares nothing with the adapter except the `solicitation_outreach` table — it lands and works whether or not the adapter ever sends.

**Tech Stack:** TypeScript, Resend SDK, Postgres.js, Fastify ingress, Vitest, zod config schemas.

**Ticket:** #657. **Spec:** `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §1, §2, §5, §7.1, §7.3, §9. **Amendments:** `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` (A/B — idempotency key is the Outreach row id). **Intake:** `docs/superpowers/plans/feat-657-email-adapter-webhook-lane-intake.json`.

---

## Glossary — use these terms verbatim

From `CONTEXT.md`, already locked:

- **Outreach row** — one `solicitation_outreach` row, one dispatch attempt for one **Ask**. Carries `provider_message_id`, the join key this webhook lane matches on.
- **Suppression ledger** — `solicitation_suppressions`. Seven closed sources. First-write-wins.
- **Suppression scope** — `global` (the recipient spoke) vs `account` (the owner's do-not-contact). Everything this ticket writes is `global`.
- **Normalized handle** — lowercased/trimmed email, computed once at CSV ingest and stored on the contact. Owned by `src/lib/solicitation/handles.ts`.
- **Neutral page** — `/u/<token>`, #644's render for unknown/malformed/already-redeemed tokens.

Coined by this ticket (Task 7 folds them into `CONTEXT.md`):

- **Messaging adapter** — the channel-neutral send seam at `src/lib/messaging/messaging-adapter.ts`. One method, `send`. EmailAdapter (Resend) is its first and today only adapter; WhatsApp is a later *second adapter*, never a rewrite. _Avoid_: mailer, sender, transport, email service.
- **Sending identity** — the solicitation lane's separate sender: the `reviews@feedback.<env>.repworth.net` mailbox, the `feedback.` sending domain, and the domain-scoped `SOLICITATION_RESEND_API_KEY`. Deliberately NOT the transactional identity — a key leaked from this lane cannot forge an approval email. _Avoid_: from address, sender config, mail identity.
- **Solicitation lane** — the branch of the Resend webhook ingress selected by `data.tags.lane === 'solicitation'` before any DB lookup. Its sibling is the untouched `notification_deliveries` path. _Avoid_: solicitation webhook, ask webhook, second handler.

---

## Non-negotiable rules for every task

1. **The `notification_deliveries` path stays behaviourally unchanged.** The only edits to `worker/ingress/resend.ts` are: one import, one guard clause in `processResendEvent`, and moving three classifier functions out (Task 6). No other line changes.
2. **Never log a recipient address, a message body, or an API key value.** Log the Outreach row id, `account_id`, `business_id`, event type, and the classified reason.
3. **Every solicitation config var fails closed.** Unset means no sends — never a degraded send.
4. **No migration.** If a task believes it needs one, stop and report.
5. **Invariant #15.** `solicitation-lane.ts` takes `sql` as a parameter. Only `worker/ingress/resend.ts` (a composition root) imports the singleton.
6. **No `any`.** Use `unknown` and narrow, matching `isRecord`/`lowerNonEmptyString` in the classifier.

---

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `src/lib/messaging/messaging-adapter.ts` | The **Messaging adapter** interface, `OutboundMessage`, and `getMessagingAdapter()` |
| `src/lib/messaging/email-adapter.ts` | `EmailAdapter` — envelope construction and the Resend call |
| `src/lib/messaging/__tests__/messaging-adapter.test.ts` | Accessor tests |
| `src/lib/messaging/__tests__/email-adapter.test.ts` | Envelope tests against a fake Resend client |
| `src/lib/notifications/email/__tests__/headers-solicitation.test.ts` | The `'solicitation'` category |
| `src/lib/notifications/email/__tests__/solicitation-client.test.ts` | `getSolicitationResend()` fail-closed |
| `worker/ingress/resend/bounce-classifier.ts` | `extractBounceType` / `isHardBounceType` / `classifyBounce`, moved verbatim |
| `worker/ingress/resend/solicitation-lane.ts` | **Solicitation lane** — discriminant, attribution lookup, seven event effects |
| `worker/ingress/__tests__/resend-solicitation-routing.test.ts` | Lane routing, pure |
| `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts` | Lane effects, live DB |
| `docs/runbooks/solicitation-sending-domain.md` | Domain create, DNS, DMARC, warm-up ramp, seed-inbox gate |
| `docs/superpowers/plans/feat-657-email-adapter-webhook-lane-deviations.md` | Already created — carries the plan-review round 1 triage. Every later surprise appends here. |

**Modify:**

| File | Change |
|---|---|
| `src/lib/config/server.ts` | +3 optional vars |
| `src/lib/notifications/email/headers.ts` | `EmailCategory` +`'solicitation'`; `getEmailHeaders(category, opts?)` |
| `src/lib/notifications/email/client.ts` | +`getSolicitationResend()` |
| `src/lib/notifications/email/send-email.ts` | `opts.client` |
| `src/lib/notifications/email/__tests__/send-email.test.ts` | +4 client-injection tests |
| `worker/config/startup-assert.ts` | +`assertSolicitationSendEnv()` |
| `worker/config/__tests__/startup-assertion.test.ts` | +7 boot tests |
| `worker/index.ts` | Import + call the assertion |
| `worker/ingress/resend.ts` | One import, one guard; classifier functions move out |
| `scripts/ci/tenant-scope-allowlist.ts` | The lane's cross-account attribution lookup |
| `.claude/reference/env-vars.md` | 3 registry entries |
| `docs/directory.md` | 4 new production-file rows |
| `CONTEXT.md` | 3 coined terms |

**Blocking edges:**

```
Task 1 (eval) ─┬─> Task 2 (config+boot) ──> Task 4 (client+sendEmail) ──> Task 5 (adapter) ──> Task 7 (docs)
               ├─> Task 3 (headers) ───────────────────────────────────────^
               └─> Task 6 (webhook lane) ─────────────────────────────────────────────────────^
```

Tasks 2, 3 and 6 are **mutually independent** — no blocking edges, disjoint file sets. Dispatch them in parallel after Task 1.

---

## Task 1: Eval task — the spec in executable form

Author every promised test as a **failing** test, committed before any implementation. This is the definition of done; the implementation tasks name which tests they turn green.

**Files:**
- Create: `src/lib/notifications/email/__tests__/headers-solicitation.test.ts`
- Create: `src/lib/notifications/email/__tests__/solicitation-client.test.ts`
- Create: `src/lib/messaging/__tests__/messaging-adapter.test.ts`
- Create: `src/lib/messaging/__tests__/email-adapter.test.ts`
- Create: `worker/ingress/__tests__/resend-solicitation-routing.test.ts`
- Create: `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts`
- Modify: `src/lib/notifications/email/__tests__/send-email.test.ts`
- Modify: `worker/config/__tests__/startup-assertion.test.ts`

- [ ] **Step 1: Read the four precedent suites before writing a line**

Read these in full. Match their mocking style, their `describe` nesting, and their assertion vocabulary. Do not invent a new house style.

- `src/lib/notifications/email/__tests__/send-email.test.ts` — how the Resend client is faked
- `src/lib/shared/__tests__/email-headers.test.ts` — how `getServerConfig` is stubbed for header tests
- `worker/config/__tests__/startup-assertion.test.ts` — how `process.env` is saved/restored around boot asserts
- `src/lib/solicitation/__tests__/owner-do-not-contact.integration.test.ts` — the live-DB suite shape, and a solicitation one: `acquireLiveDbLock` from `src/lib/shared/__tests__/helpers/live-db-lock.ts`, `assertSchemaReady` from `helpers/schema-ready.ts`

- [ ] **Step 2: Write all 74 promised test titles VERBATIM**

The titles are the contract. `scripts/verify-gate.sh`'s `promised-tests` row greps for each string, so a retitle is a gate failure. Copy them from `.feature/intake.json`'s `tests_to_add` array — do not retype them.

Distribution:

| File | Titles |
|---|---|
| `headers-solicitation.test.ts` | 10 header + `getEmailTags` (titles 1–10) |
| `solicitation-client.test.ts` | 3 (titles 11–13) |
| `send-email.test.ts` | 4 (titles 14–17) |
| `messaging-adapter.test.ts` | 2 (titles 18–19) |
| `email-adapter.test.ts` | 14 (titles 20–33) |
| `startup-assertion.test.ts` | 7 (titles 34–40) |
| `resend-solicitation-routing.test.ts` | 7 (titles 41–47) |
| `resend-solicitation-lane.integration.test.ts` | 27 (titles 48–74) |

- [ ] **Step 3: Add eleven unpromised tests**

Four from planning, seven from plan review round 1. All are already recorded in
`docs/superpowers/plans/feat-657-email-adapter-webhook-lane-deviations.md` § D1 as
owner-approved additions — read that section before writing them, it states which
finding each one closes.

Header injection first. Business name, subject, recipient and Reply-To are all
owner- or LLM-supplied text landing in SMTP headers.

```typescript
it('the email adapter strips CR and LF from the From display name', async () => {
  const client = fakeResend();
  await new EmailAdapter(() => client).send(message({ businessName: "Joe's\r\nBcc: attacker@evil.test" }));
  expect(client.lastPayload.from).not.toMatch(/[\r\n]/);
});

it('the email adapter escapes a double quote in the From display name', async () => {
  const client = fakeResend();
  await new EmailAdapter(() => client).send(message({ businessName: 'The "Best" Diner' }));
  expect(client.lastPayload.from).toBe('"The \\"Best\\" Diner" <reviews@feedback.test.repworth.net>');
});

it('the email adapter rejects a recipient containing CR or LF', async () => {
  const client = fakeResend();
  await expect(
    new EmailAdapter(() => client).send(message({ recipient: 'a@b.test\r\nBcc: c@d.test' })),
  ).rejects.toThrow(/recipient/i);
  expect(client.sendCalls).toBe(0);
});

it('the email adapter rejects a subject containing CR or LF', async () => {
  const client = fakeResend();
  await expect(
    new EmailAdapter(() => client).send(message({ subject: 'Hi\r\nBcc: c@d.test' })),
  ).rejects.toThrow(/subject/i);
  expect(client.sendCalls).toBe(0);
});

it('the email adapter rejects a Reply-To value containing CR or LF', async () => {
  const client = fakeResend();
  await expect(
    new EmailAdapter(() => client).send(message({ ownerEmail: 'o@b.test\r\nBcc: c@d.test' })),
  ).rejects.toThrow(/reply-to/i);
  expect(client.sendCalls).toBe(0);
});

it('the email adapter rejects a comma-separated recipient value rather than allowing more than one mailbox', async () => {
  const client = fakeResend();
  await expect(
    new EmailAdapter(() => client).send(message({ recipient: 'one@x.test, two@y.test' })),
  ).rejects.toThrow(/recipient/i);
  expect(client.sendCalls).toBe(0);
});
```

Then the four lane tests. The first three need the live-DB suite; the routing one is pure.

```typescript
// resend-solicitation-routing.test.ts — F6
it('the resend webhook routes a solicitation payload whose tags are an object map to the solicitation lane', () => {
  expect(isSolicitationLane({ tags: { lane: 'solicitation' } })).toBe(true);
  expect(isSolicitationLane({ tags: [{ name: 'lane', value: 'solicitation' }] })).toBe(true);
  expect(isSolicitationLane({ tags: { lane: 'notification' } })).toBe(false);
});

// resend-solicitation-lane.integration.test.ts — F1, F2, F3
it('the solicitation lane retries rather than acknowledging an unmatched suppression-bearing event', async () => {
  // No outreach row carries this provider id yet — the #630 commit window.
  await expect(
    handleSolicitationResendEvent(sql, 'email.complained', 'msg_never_committed', {}),
  ).rejects.toThrow(/unmatched/i);
  // A soft bounce in the same state is ack-able, not retryable.
  await expect(
    handleSolicitationResendEvent(sql, 'email.bounced', 'msg_never_committed', {
      bounce: { type: 'Temporary' },
    }),
  ).resolves.toBeUndefined();
});

it('the solicitation lane writes nothing when its attributed outreach row is removed mid-transaction', async () => {
  // Seed, then delete inside a competing transaction that commits first.
  // Assert: zero suppressions for the handle, and the outreach row stays gone.
});

it('the solicitation lane refuses an ambiguous provider message id without mutating an arbitrary outreach row', async () => {
  // Seed TWO outreach rows sharing one provider_message_id (no unique index stops it).
  await expect(
    handleSolicitationResendEvent(sql, 'email.complained', sharedId, {}),
  ).rejects.toThrow(/ambiguous/i);
  // Neither row gained complained_at; no suppression row exists.
});

it('the solicitation lane never logs a raw provider bounce or failure reason', async () => {
  // Feed a reason embedding victim@example.test; assert captured logs contain
  // neither the address nor the raw reason, while provider_error DOES store it.
});
```

- [ ] **Step 4: Write real assertions — no bare `expect(true)`**

Every test asserts observable behaviour. Where the implementation does not exist yet, the test fails on the missing import, which is a legitimate red. Use `.todo` ONLY where a slice is genuinely unbuildable until a later task, and name the task in the todo string.

- [ ] **Step 5: Name the integration suite correctly**

`resend-solicitation-lane.integration.test.ts` — the `.integration.test.ts` suffix selects vitest's serialized `integration` project. It must call `assertSchemaReady` and **must not execute DDL at run time** (40P01 deadlock across concurrent suites). `ci:live-db-suites` enforces both.

- [ ] **Step 6: Run the suites and confirm they FAIL**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run src/lib/messaging src/lib/notifications/email worker/ingress/__tests__/resend-solicitation worker/config 2>&1 | tail -30
```

Expected: failures citing missing modules `src/lib/messaging/*`, `worker/ingress/resend/solicitation-lane`, and missing exports `getSolicitationResend`, `assertSolicitationSendEnv`. A PASS here means the test asserts nothing.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "test(657): failing eval suite for the messaging adapter, sending identity and solicitation lane"
```

---

## Task 2: Sending identity config + boot assertion

**Turns green:** titles 34–40.
**Blocking edges:** Task 1.

**Files:**
- Modify: `src/lib/config/server.ts`
- Modify: `worker/config/startup-assert.ts`
- Modify: `worker/index.ts:76` (import) and `worker/index.ts:535` (call site)
- Modify: `.claude/reference/env-vars.md`

- [ ] **Step 1: Add three vars to the server schema**

In `src/lib/config/server.ts`, immediately after the `SOLICITATION_UNSUBSCRIBE_MAILTO: opt,` block (~line 209). Use the **collapsing** `opt`, matching that var's written rationale: these are NEW config, and a value that is empty or whitespace is not a value.

```typescript
  // #657 spec §1.6/§9: the solicitation lane's Sending identity. All four
  // solicitation vars FAIL CLOSED — unset means no solicitation sends, never a
  // degraded send. The key is deliberately NOT RESEND_API_KEY: a key leaked from
  // this lane cannot send transactional mail, so it cannot forge an approval
  // email or an approval link (invariants #3 and #5 reached sideways).
  // Server-only, NO NEXT_PUBLIC_ companion (invariant #13).
  SOLICITATION_RESEND_API_KEY: opt,
  SOLICITATION_SEND_FROM_ADDRESS: opt,
  // Platform-wide daily ceiling (§3.2A) — the warm-up dial and the emergency
  // brake. Default 0 at read time; this ticket registers and boot-asserts it and
  // enforces nothing (#630 owns enforcement).
  SOLICITATION_PLATFORM_DAILY_CAP: opt,
```

Do **not** add them to `src/lib/config/worker.ts`. Nothing worker-side reads them through `getWorkerConfig()` — the adapter reads `getServerConfig()` (safe from worker-run shared code, per that file's header) and the boot assert reads `process.env` directly, exactly as `assertChannelsWhatsAppEnv` does. An unused schema entry is dead config.

- [ ] **Step 2: Run the config test to confirm it still passes**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run src/lib/config 2>&1 | tail -10
```

Expected: PASS. The root schema is shape-only, so three optional additions change nothing.

- [ ] **Step 3: Write the boot assertion**

Append to `worker/config/startup-assert.ts`, after `assertAccountOffboardingEnv`. This copies `assertChannelsWhatsAppEnv` (line 383) exactly: flag gate, MOCK bypass, required-list check, then a format check that never logs the value.

```typescript
/**
 * Boot-time assertion for the solicitation Sending identity (#657, spec §9).
 * A worker that boots with sending enabled and no From address is a worker that
 * fails at dispatch time instead of boot time.
 *
 * When SOLICITATION_SEND_ENABLED=true:
 *   - verify all 4 solicitation env vars are non-empty
 *   - verify SOLICITATION_PLATFORM_DAILY_CAP parses as a non-negative integer
 *
 * An explicit 0 is VALID — that is the warm-up dial at rest, not a
 * misconfiguration. Unparseable is not: presence alone would let a typo reach
 * dispatch, where §9's "unparseable ⇒ 0" would silently stop every send.
 *
 * No-op when the flag is off or in MOCK_EXTERNAL_APIS=true.
 */
export function assertSolicitationSendEnv(): void {
  if (process.env.SOLICITATION_SEND_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = [
    'SOLICITATION_RESEND_API_KEY',
    'SOLICITATION_SEND_FROM_ADDRESS',
    'SOLICITATION_PLATFORM_DAILY_CAP',
    'SOLICITATION_UNSUBSCRIBE_MAILTO',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(
      `SOLICITATION_SEND_ENABLED=true but missing required env vars: ${missing.join(', ')}`,
    );
  }
  // Names the var, never the value — the key is in the same required list.
  const cap = Number(process.env.SOLICITATION_PLATFORM_DAILY_CAP!.trim());
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(
      'SOLICITATION_SEND_ENABLED=true but SOLICITATION_PLATFORM_DAILY_CAP is not a non-negative integer',
    );
  }
}
```

- [ ] **Step 4: Register it at boot**

In `worker/index.ts` line 76, add `assertSolicitationSendEnv` to the existing import from `./config/startup-assert` (keep the list alphabetical). Then add the call after `assertAccountOffboardingEnv();` at line 535:

```typescript
    assertSolicitationSendEnv();
```

Also add it to the re-export list at line 498 if the neighbouring asserts are re-exported there — match what the block already does, do not extend the pattern.

- [ ] **Step 5: Run the boot tests**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run worker/config 2>&1 | tail -20
```

Expected: the 7 titles 34–40 now PASS.

- [ ] **Step 6: Add three registry entries**

In `.claude/reference/env-vars.md`, beside the existing `SOLICITATION_UNSUBSCRIBE_MAILTO` row (line 104). Match that row's density — it states the lane, the default, the fail-closed behaviour, the invariant, and what it is NOT. Each new entry must state:

- `SOLICITATION_RESEND_API_KEY` — Railway, unset. Domain-scoped Resend key restricted to `feedback.<env>.repworth.net`. **Unset ⇒ no solicitation sends** (`getSolicitationResend()` throws). Deliberately NOT `RESEND_API_KEY`: a key leaked from this lane cannot forge an approval email (invariants #3/#5). Note the 10 req/s Resend limit is per **team**, not per key — the yield-to-transactional obligation (§7.1) is scheduling, owned by #630, and the key split does not solve it.
- `SOLICITATION_SEND_FROM_ADDRESS` — Railway, unset. e.g. `reviews@feedback.repworth.net`. Address only; the display name is per-business (§2.3). Must be a **monitored** mailbox, not `no-reply@` (§2.2) — setting it creates a servicing obligation.
- `SOLICITATION_PLATFORM_DAILY_CAP` — Railway, **0**. Platform-wide daily ceiling; the warm-up dial and the emergency brake. Registered and boot-asserted here, **enforced by #630**. An explicit `0` boots fine; an unparseable value fails boot.

All three: server-only, no `NEXT_PUBLIC_*` companion (invariant #13), flip via the `flag-flip` skill.

- [ ] **Step 7: Run lint, typecheck and the static-policy audit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm lint && pnpm typecheck && pnpm ci:static-policy 2>&1 | tail -15
```

Expected: all PASS. `ci:static-policy` allowlists every `NEXT_PUBLIC_*` — it must not report a new one.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(657): solicitation sending-identity config vars + fail-closed boot assertion"
```

---

## Task 3: `getEmailHeaders` solicitation category

**Turns green:** titles 1–10.
**Blocking edges:** Task 1. Independent of Tasks 2 and 6.

**Files:**
- Modify: `src/lib/notifications/email/headers.ts`

- [ ] **Step 1: Check how #644 interprets `SOLICITATION_UNSUBSCRIBE_MAILTO`**

Before writing anything, read the **Neutral page**'s use of this var and match it exactly. The registry says "one advertised address reached by two code paths" and "a mismatch is a compliance defect rather than a cosmetic one."

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && rg -n "SOLICITATION_UNSUBSCRIBE_MAILTO" src/ worker/ --type ts | grep -v __tests__
```

Determine whether the stored value is a **bare address** (`unsubscribe@feedback.repworth.net`) or a **`mailto:` URI**. Build the header the same way. If the page prefixes `mailto:` itself, the stored value is bare and this code prefixes it too. **Do not guess** — if the two code paths disagree, the header advertises a mailbox the page does not.

- [ ] **Step 2: Widen the category and the signature**

Replace the type and the function head in `src/lib/notifications/email/headers.ts`:

```typescript
export type EmailCategory = 'transactional' | 'marketing' | 'internal' | 'solicitation';

/** Per-call header inputs. `unsubscribeUrl` is REQUIRED for 'solicitation' and
 *  ignored by every other category. */
export interface EmailHeaderOptions {
  unsubscribeUrl?: string;
}

export function getEmailHeaders(
  category: EmailCategory,
  opts: EmailHeaderOptions = {},
): Record<string, string> {
  if (category === 'solicitation') return solicitationHeaders(opts.unsubscribeUrl);
  if (category !== 'marketing') return {};

  // ...existing marketing body, UNCHANGED...
}
```

The existing marketing body is not edited. The `'solicitation'` branch returns before it.

- [ ] **Step 3: Write the fail-closed branch**

Append to the same file. Every failure is a throw. This is the whole point of the category: for a marketing digest a missing URL is a degraded header; for a solicitation ask it ships a legally-required opt-out that cannot work, at up to $53,088 per email.

```typescript
/**
 * Solicitation List-Unsubscribe (spec §7.3). Fail-closed on every path:
 *   - no per-ask URL          -> throw (never the global LIST_UNSUBSCRIBE_URL)
 *   - a non-HTTPS URL         -> throw (RFC 8058 §3 requires HTTPS for one-click)
 *   - no configured mailbox   -> throw (never the repworth.example.com RFC 2606 address)
 *
 * There is deliberately no fallback branch. The marketing category above may
 * degrade to a mailto-only header; this one may not, because the degraded form
 * is a compliance violation that fails silently.
 */
function solicitationHeaders(unsubscribeUrl: string | undefined): Record<string, string> {
  const raw = unsubscribeUrl?.trim();
  if (!raw) {
    throw new Error(
      "[email/headers] the 'solicitation' category requires a per-ask unsubscribeUrl — refusing to ship a List-Unsubscribe header that cannot work",
    );
  }

  let httpsUrl: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') throw new Error('non-https');
    httpsUrl = u.toString();
  } catch {
    throw new Error(
      "[email/headers] the 'solicitation' unsubscribeUrl must be an HTTPS URL (RFC 8058 §3 one-click)",
    );
  }

  const mailbox = getServerConfig().SOLICITATION_UNSUBSCRIBE_MAILTO?.trim();
  if (!mailbox) {
    throw new Error(
      "[email/headers] SOLICITATION_UNSUBSCRIBE_MAILTO is required for the 'solicitation' category — the mailto: member of List-Unsubscribe has no fallback",
    );
  }

  return {
    'List-Unsubscribe': `<${httpsUrl}>, <mailto:${mailbox}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
```

Adjust the `mailto:` interpolation to whatever Step 1 established.

- [ ] **Step 4: Confirm `getEmailTags` needs no change**

It is already generic over `EmailCategory` and returns `[{ name: 'category', value: category }]`. Title 10 verifies that `'solicitation'` flows through. Do not edit it.

- [ ] **Step 5: Run the header suites**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run src/lib/notifications/email/__tests__/headers-solicitation.test.ts src/lib/shared/__tests__/email-headers.test.ts 2>&1 | tail -20
```

Expected: titles 1–10 PASS **and** the existing `email-headers.test.ts` suite still passes untouched. That second suite is the regression anchor proving the widening did not change the marketing contract.

- [ ] **Step 6: Find every existing caller and confirm the widening is source-compatible**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && rg -n "getEmailHeaders\(" src/ worker/ --type ts
```

Every existing call passes one argument, and `opts` defaults to `{}`. If any call site switches exhaustively on `EmailCategory`, the new member will surface as a typecheck error — fix those call sites in this task.

- [ ] **Step 7: Typecheck and commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm typecheck && git add -A && git commit -m "feat(657): fail-closed 'solicitation' category on getEmailHeaders"
```

---

## Task 4: Solicitation Resend client + `sendEmail` client injection

**Turns green:** titles 11–17.
**Blocking edges:** Task 2 (needs `SOLICITATION_RESEND_API_KEY` in the schema).

**Files:**
- Modify: `src/lib/notifications/email/client.ts`
- Modify: `src/lib/notifications/email/send-email.ts`

- [ ] **Step 1: Add the fail-closed lazy client**

Append to `src/lib/notifications/email/client.ts`:

```typescript
let _solicitationResend: Resend | null = null;

/**
 * Domain-scoped Resend client for the solicitation lane (spec §1.6). Same lazy
 * shape as getResend() with one deliberate difference: it FAILS CLOSED. An unset
 * key throws rather than constructing a client with `undefined`, because a
 * solicitation send that silently proceeds without its own key would be a send
 * on the transactional identity.
 */
export function getSolicitationResend(): Resend {
  if (!_solicitationResend) {
    const key = getServerConfig().SOLICITATION_RESEND_API_KEY?.trim();
    if (!key) {
      throw new Error(
        'SOLICITATION_RESEND_API_KEY is not set — the solicitation lane cannot send (fail-closed, spec §1.6/§9)',
      );
    }
    _solicitationResend = new Resend(key);
  }
  return _solicitationResend;
}
```

- [ ] **Step 2: Accept an injected client in `sendEmail`**

Two lines change in `src/lib/notifications/email/send-email.ts`. Nothing else. This is "accept dependencies, don't create them" — and it is what makes the adapter testable without a network.

```typescript
export async function sendEmail(
  payload: SendPayload,
  opts: {
    timeoutMs?: number;
    idempotencyKey?: string;
    /**
     * Which Resend client sends this. Defaults to the transactional getResend().
     * The solicitation lane passes getSolicitationResend() so the two identities
     * never share a key — while the 10s timeout and the idempotency-key plumbing
     * below stay single-owner. Do NOT fork this function for a second lane.
     */
    client?: ReturnType<typeof getResend>;
  } = {},
): Promise<SendResult> {
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs();
  const resend = opts.client ?? getResend();
```

Update the file's header comment to say the send path is shared by both identities.

- [ ] **Step 3: Run the client and send suites**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run src/lib/notifications/email 2>&1 | tail -20
```

Expected: titles 11–17 PASS, and every pre-existing `send-email.test.ts` case still passes — the default path is unchanged.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(657): fail-closed solicitation Resend client + sendEmail client injection"
```

---

## Task 5: Messaging adapter seam + EmailAdapter

**Turns green:** titles 18–33, plus the four header-injection tests from Task 1 Step 3.
**Blocking edges:** Tasks 3 and 4.

**Files:**
- Create: `src/lib/messaging/messaging-adapter.ts`
- Create: `src/lib/messaging/email-adapter.ts`

- [ ] **Step 1: Read the precedent, then mirror its shape**

Read `src/lib/publishing/review-publisher.ts` and `src/lib/publishing/zernio-review-publisher.ts` in full. The interface file owns the types and the accessor; the adapter file owns the provider. Mirror that split. Note what the precedent does **not** do: it does not add methods nobody calls.

- [ ] **Step 2: Write the seam**

Create `src/lib/messaging/messaging-adapter.ts`:

```typescript
// src/lib/messaging/messaging-adapter.ts
//
// The Messaging adapter seam (#657, map decision 14). Solicitation is its first
// tenant, not its owner: a WhatsApp adapter is a SECOND adapter here, never a
// rewrite. Mirrors src/lib/publishing/review-publisher.ts exactly.
//
// HONEST SCOPE: one adapter exists today and this ticket ships zero production
// callers — #630's dispatch worker is the first. That makes this a hypothetical
// seam, accepted deliberately. The mitigation is the interface: ONE method, whose
// message type is derived from spec §7.1's locked envelope rather than invented.
// If a WhatsApp adapter wants a different shape, almost nothing is committed.

import { EmailAdapter } from './email-adapter';

/**
 * One ask, ready to put on the wire. Every field is required — the adapter
 * refuses to build an envelope from a partial message rather than defaulting.
 */
export interface OutboundMessage {
  /**
   * The Outreach row id. Doubles as the provider idempotency key (amendments
   * A/B — §7.1's `solicitation-ask/<ask_id>` is superseded because it collides
   * across attempts, and a timeout-retry is a ROUTINE path here, not an edge).
   */
  outreachId: string;
  accountId: string;
  businessId: string;
  batchId: string;
  /** From display name — the business name, no 'via RepWorth' suffix (§2.3). */
  businessName: string;
  /** Reply-To — businesses.owner_email (§2.4). */
  ownerEmail: string;
  /** Exactly one recipient, always (§7.1). Never an array. */
  recipient: string;
  subject: string;
  bodyHtml: string;
  /** Plain-text alternative. Always present — HTML-only is a spam signal (§7.1). */
  bodyText: string;
  /** Per-ask one-click unsubscribe URL — the Railway ingress form (§7.3). */
  unsubscribeUrl: string;
}

export interface MessagingAdapter {
  /**
   * Put one ask on the wire.
   *
   * Returns the provider's message id, which the caller records as
   * `solicitation_outreach.provider_message_id` — the join key the Solicitation
   * lane matches webhook events on. A caller that discards it makes every later
   * bounce and complaint unattributable.
   *
   * THROWS on every failure, matching the ReviewPublisher transport-method
   * precedent and sendEmail's existing contract: a validation refusal, a Resend
   * API error, or the sendEmail timeout. #630 classifies for retry.
   */
  send(message: OutboundMessage): Promise<{ providerMessageId: string }>;
}

let cached: MessagingAdapter | null = null;

/**
 * The active messaging adapter. Lazy singleton — the factory shape IS the
 * selection seam: when a WhatsApp adapter lands it is chosen here, not at every
 * call-site.
 */
export function getMessagingAdapter(): MessagingAdapter {
  if (cached === null) cached = new EmailAdapter();
  return cached;
}
```

- [ ] **Step 3: Write the EmailAdapter**

Create `src/lib/messaging/email-adapter.ts`:

```typescript
// src/lib/messaging/email-adapter.ts
//
// EmailAdapter — the first Messaging adapter (#657, spec §7.1). Owns the whole
// envelope so no caller has to know it: From-line construction, Reply-To, the
// one-recipient rule, the always-multipart rule, Resend tags, List-Unsubscribe
// via getEmailHeaders, the idempotency key, and the Sending identity's client.

import { getServerConfig } from '@/lib/config/server';
import { getSolicitationResend, type getResend } from '@/lib/notifications/email/client';
import { getEmailHeaders, getEmailTags } from '@/lib/notifications/email/headers';
import { sendEmail } from '@/lib/notifications/email/send-email';
import type { MessagingAdapter, OutboundMessage } from './messaging-adapter';

type ResendClient = ReturnType<typeof getResend>;

/** CR/LF in any header-bound field is header injection. Business name, subject
 *  and recipient are all owner- or LLM-supplied text that lands in SMTP headers. */
const CRLF = /[\r\n]/;

export class EmailAdapter implements MessagingAdapter {
  /**
   * The client is resolved per send, not at construction, so building the
   * adapter never requires the key to exist. Tests inject a fake factory.
   */
  constructor(private readonly resolveClient: () => ResendClient = getSolicitationResend) {}

  async send(message: OutboundMessage): Promise<{ providerMessageId: string }> {
    assertSendable(message);

    const headers = getEmailHeaders('solicitation', {
      unsubscribeUrl: message.unsubscribeUrl,
    });

    const result = await sendEmail(
      {
        from: formatFrom(message.businessName, resolveFromAddress()),
        to: [message.recipient],
        replyTo: message.ownerEmail,
        subject: message.subject,
        html: message.bodyHtml,
        text: message.bodyText,
        headers,
        tags: [
          ...getEmailTags('solicitation'),
          // The routing discriminant the Solicitation lane reads (§5.2). Values
          // are ASCII letters/digits/_/- per Resend's tag constraint; UUIDs pass.
          { name: 'lane', value: 'solicitation' },
          { name: 'account_id', value: message.accountId },
          { name: 'business_id', value: message.businessId },
          { name: 'batch_id', value: message.batchId },
        ],
      },
      { idempotencyKey: message.outreachId, client: this.resolveClient() },
    );

    // The Resend SDK returns { data, error } rather than throwing on an API
    // error. Convert to a throw so every failure reaches the caller one way.
    if (result.error || !result.data?.id) {
      throw new Error(
        `Resend refused the solicitation send: ${result.error?.message ?? 'no message id returned'}`,
      );
    }

    return { providerMessageId: result.data.id };
  }
}

function assertSendable(message: OutboundMessage): void {
  if (!message.bodyText.trim()) {
    throw new Error(
      'solicitation send requires a plain-text part — HTML-only is a spam signal (§7.1)',
    );
  }
  // "Exactly one recipient" is a RULE, not a shape. Wrapping one string in an array
  // does not enforce it: 'a@x.test, b@y.test' is one string and two mailboxes.
  const recipient = message.recipient.trim();
  if (!recipient || CRLF.test(recipient) || /[,\s;]/.test(recipient)) {
    throw new Error('solicitation send requires exactly one well-formed recipient (§7.1)');
  }
  if (CRLF.test(message.subject)) {
    throw new Error('solicitation subject may not contain CR or LF');
  }
  // Reply-To is owner-supplied and lands in a header exactly like the others.
  if (!message.ownerEmail.trim() || CRLF.test(message.ownerEmail)) {
    throw new Error('solicitation Reply-To must be a single well-formed address (§2.4)');
  }
}

/**
 * `"Joe's Diner" <reviews@feedback.repworth.net>` — display name is the business
 * name with NO 'via RepWorth' suffix (§2.3). DKIM d= alignment suppresses Gmail's
 * "via" annotation, so the line renders as purely the business.
 *
 * CR/LF are stripped and quotes escaped: the display name is owner-supplied text
 * landing in an SMTP header.
 */
function formatFrom(businessName: string, address: string): string {
  const safe = businessName.replace(/[\r\n]/g, ' ').replace(/(["\\])/g, '\\$1').trim();
  return `"${safe}" <${address}>`;
}

function resolveFromAddress(): string {
  const address = getServerConfig().SOLICITATION_SEND_FROM_ADDRESS?.trim();
  if (!address) {
    throw new Error(
      'SOLICITATION_SEND_FROM_ADDRESS is not set — the solicitation lane cannot send (fail-closed, §9)',
    );
  }
  return address;
}
```

- [ ] **Step 4: Confirm `resend.batch.send` is never reachable**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && rg -n "batch\.send" src/ worker/ --type ts
```

Expected: no hits. Batch is atomic — one bad address rejects all 100 — and it contradicts per-child consent and suppression re-validation at each child's own dispatch time.

- [ ] **Step 5: Run the adapter suites**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run src/lib/messaging 2>&1 | tail -25
```

Expected: titles 18–33 plus the four injection tests PASS.

- [ ] **Step 6: Confirm the ESLint import boundary**

`src/lib/messaging/` must not be imported by `src/app/**` or `src/components/**` (invariant #1 — it reaches the Resend SDK).

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm lint && pnpm vitest run src/__tests__/eslint-boundaries.test.ts 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(657): MessagingAdapter seam + EmailAdapter with the locked §7.1 envelope"
```

---

## Task 6: Resend solicitation lane

**Turns green:** titles 41–74.
**Blocking edges:** Task 1. Independent of Tasks 2–5.

**Files:**
- Create: `worker/ingress/resend/bounce-classifier.ts`
- Create: `worker/ingress/resend/solicitation-lane.ts`
- Modify: `worker/ingress/resend.ts`
- Modify: `scripts/ci/tenant-scope-allowlist.ts`

- [ ] **Step 1: Move the classifier out — this breaks a circular import**

The spec requires reusing `extractBounceType`/`isHardBounceType`/`classifyBounce` **verbatim**; a second classifier would be a second owner of "what counts as permanent". They are private to `worker/ingress/resend.ts` today. Exporting them in place would make `solicitation-lane.ts` import its own parent — a cycle. So they move.

Create `worker/ingress/resend/bounce-classifier.ts` and move lines 78–189 of `worker/ingress/resend.ts` into it **byte-for-byte**, changing only `function` to `export function` on the three public entry points and keeping `isRecord`/`lowerNonEmptyString` private to the new file. Preserve every comment, including the note that the admin overview SQL filters on the `bounced:hard:` prefix.

`'unknown'` classifies as **soft**. That is the correct fail-safe in this lane too: an ambiguous bounce must not permanently suppress a real customer.

In `worker/ingress/resend.ts`, delete those lines and add:

```typescript
import { classifyBounce, extractBounceType } from './resend/bounce-classifier';
```

`isHardBounceType` is not called directly by `resend.ts` — do not import what you do not use.

- [ ] **Step 2: Verify the move changed no behaviour**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run worker/ingress/__tests__/resend-webhook-bounce.test.ts worker/ingress/__tests__/resend-webhook-signature.test.ts worker/ingress/__tests__/webhook-dedup.test.ts 2>&1 | tail -15
```

Expected: PASS with zero edits to those suites. If a suite imported a moved function from `resend.ts`, update only its import line.

- [ ] **Step 3: Write the lane discriminant**

Create `worker/ingress/resend/solicitation-lane.ts`. Start with the tag reader. Resend echoes tags in webhook payloads, and the shape is not guaranteed — handle both an object map and an array of `{name, value}`, the same defensive posture `extractBounceType` takes toward three payload shapes.

```typescript
// worker/ingress/resend/solicitation-lane.ts
//
// The Solicitation lane (#657, spec §5). Selected by the echoed Resend tag
// BEFORE any DB lookup — chosen over a try-table-A-fall-back-to-B chain, which
// couples the two lanes and makes a genuinely-unknown email_id indistinguishable
// from a lane mismatch.
//
// WRITE SURFACE, deliberately narrow (owner decision 2026-08-16): this lane
// writes ONLY the async signal columns migration 091 calls "columns, NOT statuses
// (D13)" — bounced_at, complained_at, provider_error — plus the Suppression
// ledger. It NEVER writes delivery_status or sent_at (#630 owns the send
// lifecycle, and a webhook write would race 091's ladder CHECKs), and never
// unsubscribed_at (the RFC 8058 POST lands on worker/ingress/unsubscribe.ts).
// Spec §5.3's delivered_at effect is dropped: the column does not exist and this
// ticket carries no migration.

import type { Sql, TransactionSql } from 'postgres';
import { recordSuppression } from '../../../src/lib/solicitation/suppression';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { classifyBounce, extractBounceType } from './bounce-classifier';

const logger = createWorkerLogger('ingress/resend/solicitation');

/** True when this payload belongs to the Solicitation lane (§5.1). */
export function isSolicitationLane(data: unknown): boolean {
  return readTag(data, 'lane') === 'solicitation';
}

function readTag(data: unknown, name: string): string | null {
  if (!isRecord(data)) return null;
  const tags = data.tags;
  if (isRecord(tags) && typeof tags[name] === 'string') return tags[name];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (isRecord(tag) && tag.name === name && typeof tag.value === 'string') return tag.value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
```

- [ ] **Step 4: Write the attribution lookup — read this whole step before writing SQL**

Four review findings land here. Get them all in one pass.

**The column is `email`, not `normalized_handle`.** Migration 086 defines
`solicitation_contacts.email TEXT` with the comment *"Normalized handle:
lowercased/trimmed"*. The **Normalized handle** for the email channel **is** that
column. There is no `normalized_handle` column on that table — a query naming one
throws at runtime on every solicitation event.

**The lookup runs inside the transaction, with `FOR UPDATE`.** Reading attribution
outside `sql.begin` lets the Outreach row be deleted before the `UPDATE`, which then
affects zero rows while the suppression still commits — a ledger row with no artifact
behind it. House gotcha: `SELECT … FOR UPDATE` is a **no-op outside `sql.begin()`**
under PgBouncer transaction pooling, so this only works inside.

**Two matching rows is an impossible state — throw, don't `LIMIT 1`.** There is no
unique index on `provider_message_id`, so `LIMIT 1` would silently mutate an
arbitrary row. Assert the impossible state instead of branching around it.

**A NULL email on a row we emailed is also impossible.** The table's CHECK allows
email OR phone; a phone-only contact can never have received an email ask. Throw.

```typescript
interface OutreachAttribution {
  id: string;
  account_id: string;
  business_id: string;
  /** solicitation_contacts.email — this column IS the Normalized handle (086). */
  normalized_handle: string;
}

/**
 * Cross-account by construction — a webhook arrives with a provider message id and
 * no tenant context, so this is allowlisted in the tenant-scope audit. The row it
 * finds supplies the account scope every later write uses.
 *
 * MUST be called inside sql.begin(): the FOR UPDATE lock is what stops the row
 * being deleted between this read and the UPDATE that follows it.
 */
async function loadAttribution(
  tx: TransactionSql,
  emailId: string,
): Promise<OutreachAttribution | null> {
  const rows = await tx<{ id: string; account_id: string; business_id: string; email: string | null }[]>`
    SELECT o.id, o.account_id, o.business_id, c.email
      FROM solicitation_outreach o
      JOIN solicitation_contacts c ON c.id = o.contact_id
     WHERE o.provider_message_id = ${emailId}
     LIMIT 2
     FOR UPDATE OF o
  `;

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Impossible: #630 writes one provider_message_id per attempt. Refuse rather
    // than mutate whichever row the planner happened to return first.
    throw new Error(
      `ambiguous provider_message_id matched multiple outreach rows: ${emailId}`,
    );
  }

  const row = rows[0]!;
  if (!row.email) {
    // Impossible: a phone-only contact cannot have received an email ask.
    throw new Error(`outreach ${row.id} has an email provider event but no contact email`);
  }

  return {
    id: row.id,
    account_id: row.account_id,
    business_id: row.business_id,
    normalized_handle: row.email,
  };
}
```

- [ ] **Step 4b: Decide what an UNMATCHED event does — the two answers differ**

Spec §5.1 says an unmatched id gets a structured warn and a 200 ack. That is right
for an observability-only event and **wrong for a suppression-bearing one**: #630
persists `provider_message_id` only after Resend responds, so a fast hard bounce can
arrive before the row commits. Warn-and-ack in that window permanently loses a
compliance-relevant fact.

Split the behaviour:

```typescript
/** Observability-only events: §5.1's warn-and-ack, unchanged. */
function warnUnmatched(emailId: string, event: string): void {
  // Never logs the recipient address. A sustained rate here means the lane tag is
  // being emitted for sends we are not recording.
  logger.warn({
    msg: 'solicitation webhook matched no outreach row — nothing written',
    event,
    provider_message_id: emailId,
  });
}

/**
 * Suppression-bearing events (permanent bounce, complaint, provider-suppressed):
 * throw so handleResendWebhook returns 503 and Resend retries. This closes the
 * window where #630 has not yet committed provider_message_id.
 *
 * The retry is bounded for free: verifySignature already rejects any event whose
 * svix-timestamp is more than 300s old, so a genuinely-unknown id gets 401'd rather
 * than retrying forever. No new constant, no new env var.
 */
function throwUnmatched(emailId: string, event: string): never {
  logger.warn({
    msg: 'solicitation webhook matched no outreach row for a suppression-bearing event — retrying',
    event,
    provider_message_id: emailId,
  });
  throw new Error(`unmatched provider_message_id for ${event}: ${emailId}`);
}
```

- [ ] **Step 5: Write the seven event effects**

```typescript
export async function handleSolicitationResendEvent(
  sql: Sql,
  eventType: string,
  emailId: string,
  data: Record<string, unknown>,
): Promise<void> {
  switch (eventType) {
    case 'email.bounced':
      return recordBounce(sql, emailId, data);
    case 'email.complained':
      return recordComplaint(sql, emailId);
    case 'email.suppressed':
      return recordProviderSuppressed(sql, emailId);
    case 'email.failed':
      return recordFailure(sql, emailId, data);
    case 'email.sent':
    case 'email.delivered':
    case 'email.delivery_delayed':
      // Observability only. #630 owns delivery_status and sent_at; there is no
      // delivered_at column; delivery_delayed NEVER suppresses.
      logger.log({ msg: 'solicitation webhook observed', event: eventType, provider_message_id: emailId });
      return;
    default:
      // Refused, not crashed on: opened/clicked/scheduled/received (§5.3).
      logger.warn({ msg: 'solicitation webhook refused unsupported event', event: eventType });
      return;
  }
}

/**
 * Every signal write runs through here so the transaction boundary has ONE owner:
 * attribution, its FOR UPDATE lock, the outreach UPDATE and the optional ledger
 * write are one commit or none.
 *
 * `onMissing` decides what an unmatched id means for THIS event (Step 4b).
 * `apply` returns the ledger source to record, or null to record none.
 */
async function withAttribution(
  sql: Sql,
  emailId: string,
  event: string,
  onMissing: (emailId: string, event: string) => void,
  apply: (
    tx: TransactionSql,
    attribution: OutreachAttribution,
  ) => Promise<SuppressionSourceToRecord | null>,
): Promise<void> {
  await sql.begin(async (tx) => {
    const attribution = await loadAttribution(tx, emailId);
    if (!attribution) {
      // For suppression-bearing events this THROWS, rolling back and returning 503.
      onMissing(emailId, event);
      return;
    }

    const source = await apply(tx, attribution);
    if (source) {
      await recordSuppression(tx, {
        scope: 'global',
        channel: 'email',
        normalizedHandle: attribution.normalized_handle,
        accountId: attribution.account_id,
        source,
      });
    }
  });
}

type SuppressionSourceToRecord = 'bounce_permanent' | 'complaint' | 'provider_suppressed';

/** The UPDATE must hit the row the lock protects. Zero rows is a bug, not a no-op. */
async function assertUpdatedOne(count: number, outreachId: string): Promise<void> {
  if (count !== 1) {
    throw new Error(`expected to update exactly 1 outreach row, updated ${count}: ${outreachId}`);
  }
}

async function recordBounce(sql: Sql, emailId: string, data: unknown): Promise<void> {
  // Classified from the PAYLOAD, before any lookup — so we know whether this event
  // is suppression-bearing and therefore whether an unmatched id may be acked.
  const { reason, isHard } = classifyBounce(extractBounceType(data));

  await withAttribution(
    sql,
    emailId,
    'email.bounced',
    isHard ? throwUnmatched : warnUnmatched,
    async (tx, attribution) => {
      const updated = await tx`
        UPDATE solicitation_outreach
           SET bounced_at = COALESCE(bounced_at, NOW()),
               provider_error = COALESCE(provider_error, ${reason}),
               updated_at = NOW()
         WHERE id = ${attribution.id}
      `;
      await assertUpdatedOne(updated.count, attribution.id);

      logger.log({
        msg: 'solicitation bounce recorded',
        outreach_id: attribution.id,
        account_id: attribution.account_id,
        business_id: attribution.business_id,
        // The KIND only. `reason` embeds provider-controlled text that can carry a
        // recipient address; it belongs in provider_error (a column) not a log.
        bounce_kind: isHard ? 'hard' : 'soft',
      });

      // Permanent only. Soft and 'unknown' record the fact and never suppress.
      return isHard ? 'bounce_permanent' : null;
    },
  );
}

async function recordComplaint(sql: Sql, emailId: string): Promise<void> {
  await withAttribution(sql, emailId, 'email.complained', throwUnmatched, async (tx, attribution) => {
    const updated = await tx`
      UPDATE solicitation_outreach
         SET complained_at = COALESCE(complained_at, NOW()),
             updated_at = NOW()
       WHERE id = ${attribution.id}
    `;
    await assertUpdatedOne(updated.count, attribution.id);

    logger.log({
      msg: 'solicitation complaint recorded',
      outreach_id: attribution.id,
      account_id: attribution.account_id,
      business_id: attribution.business_id,
    });

    return 'complaint';
  });
}

async function recordProviderSuppressed(sql: Sql, emailId: string): Promise<void> {
  await withAttribution(sql, emailId, 'email.suppressed', throwUnmatched, async (_tx, attribution) => {
    // No Outreach column exists for this — the ledger IS the record.
    //
    // Loud by design (§6.2): Resend's suppression list is team-wide across every
    // domain and API key INCLUDING transactional, so a divergence between their
    // list and ours is an admin-attention condition, not routine traffic.
    logger.warn({
      msg: 'Resend independently suppressed a solicitation recipient — team-wide list diverging from our ledger (§6.2)',
      outreach_id: attribution.id,
      account_id: attribution.account_id,
      business_id: attribution.business_id,
    });
    return 'provider_suppressed';
  });
}

async function recordFailure(sql: Sql, emailId: string, data: unknown): Promise<void> {
  const reason = readFailureReason(data);

  // Send-side failure. NEVER suppresses, never touches bounced_at, and an unmatched
  // id is genuinely ack-able: nothing is lost that a later event cannot re-establish.
  await withAttribution(sql, emailId, 'email.failed', warnUnmatched, async (tx, attribution) => {
    const updated = await tx`
      UPDATE solicitation_outreach
         SET provider_error = COALESCE(provider_error, ${`failed:${reason}`}),
             updated_at = NOW()
       WHERE id = ${attribution.id}
    `;
    await assertUpdatedOne(updated.count, attribution.id);

    logger.log({
      msg: 'solicitation send failure recorded',
      outreach_id: attribution.id,
      account_id: attribution.account_id,
      // Reason is provider-controlled text — stored, never logged.
      has_reason: reason !== 'unknown',
    });

    return null;
  });
}

function readFailureReason(data: unknown): string {
  if (!isRecord(data)) return 'unknown';
  const failed = data.failed;
  if (isRecord(failed) && typeof failed.reason === 'string' && failed.reason.length > 0) {
    return failed.reason.toLowerCase();
  }
  return 'unknown';
}
```

**Why every `provider_error` write is `COALESCE`-preserving:** #630 writes a bounded error class at dispatch, and a later generic webhook string would erase it. This is the same rule the Watchdog terminalizer adopted in #736 — preserve a non-empty error, write the generic text only as a fallback.

- [ ] **Step 6: Wire the lane into the ingress — three lines**

In `worker/ingress/resend.ts`, add the import and one guard at the top of `processResendEvent`. Nothing else in the file changes.

```typescript
import { handleSolicitationResendEvent, isSolicitationLane } from './resend/solicitation-lane';
```

```typescript
async function processResendEvent(
  eventType: string,
  emailId: string | undefined,
  body: ResendWebhookBody,
): Promise<void> {
  if (!emailId) {
    return;
  }

  // Lane selection by echoed tag, BEFORE any delivery-row lookup (§5.1). The
  // claimInboundEvent above is idempotency, not a lane lookup — it is the same
  // write for both lanes and must stay shared.
  if (isSolicitationLane(body.data)) {
    await handleSolicitationResendEvent(sql, eventType, emailId, body.data);
    return;
  }

  switch (eventType) {
    // ...existing notification_deliveries path, UNCHANGED...
  }
}
```

- [ ] **Step 7: Allowlist the cross-account attribution lookup**

Read `scripts/ci/tenant-scope-allowlist.ts` and follow its existing entry format. The justification: a webhook arrives with a provider message id and no tenant context; this query *establishes* the account scope every later write uses.

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm ci:tenant-scope 2>&1 | tail -15
```

Expected: PASS.

- [ ] **Step 8: Run every ingress suite**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run worker/ingress 2>&1 | tail -25
```

Expected: titles 41–47 PASS and every pre-existing ingress suite still passes.

- [ ] **Step 9: Run the live-DB lane suite**

Export both vars first — live-DB suites self-skip without them, and a silent skip is not a pass.

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && export TEST_DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL" DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL" && pnpm vitest run --project integration worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts 2>&1 | tail -25
```

Expected: titles 48–74 PASS. A `skipped` result means the DB is not wired — fix that before proceeding, do not accept it.

- [ ] **Step 10: Run the live-DB-suite conventions audit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm ci:live-db-suites 2>&1 | tail -10
```

Expected: PASS — the suite is named `*.integration.test.ts` and executes no run-time DDL.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat(657): tag-discriminated solicitation lane in the Resend webhook ingress"
```

---

## Task 7: Runbook, directory map, glossary

**Turns green:** nothing — docs. The gate auto-detects a docs-only diff and records `"mode":"docs_only"`.
**Blocking edges:** Tasks 2–6 (documents what shipped).

**Files:**
- Create: `docs/runbooks/solicitation-sending-domain.md`
- Modify: `docs/directory.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Write the runbook**

`docs/runbooks/solicitation-sending-domain.md`. Two domains, run independently: `feedback.repworth.net` (prod) and `feedback.staging.repworth.net` (staging). It is authored here and **executed at #633** — say so at the top. Required sections, each carrying the reason, not just the step:

1. **Resend domain create** — `resend.domains.create({ name, customReturnPath: 'bounce', openTracking: false, clickTracking: false })`. Resend defaults `openTracking` to **true**, so it must be set explicitly. `clickTracking: false` is non-negotiable: click tracking rewrites every URL through `links.<domain>`, which would rewrite **the Google review link** — phishing-shaped, and it destroys the link's provenance. **Do not create the `links.` CNAME** either; its absence is the belt to that braces.
2. **Cloudflare DNS table** — the MX + TXT on `bounce.feedback`, three DKIM CNAMEs, the DMARC TXT. **Proxy OFF (grey cloud) on every record** — proxying a CNAME breaks DKIM resolution silently.
3. **DMARC** — `v=DMARC1; p=reject; adkim=s; aspf=r; rua=<mailbox we control>; pct=100`. **`aspf` must stay relaxed**: the custom `bounce.` return-path is not an exact From match, so `aspf=s` would fail SPF alignment on every single message. An `spf=pass` with `dmarc=fail` is the signature of that trap. `p=reject` from day one — there are no unknown legitimate senders to discover on a brand-new subdomain.
4. **Mailbox** — `reviews@feedback.<env>.repworth.net` must accept and route mail (Cloudflare Email Routing forward is sufficient). Not `no-reply@`. Reply-based opt-outs are entered into the **Suppression ledger** manually inside CAN-SPAM's 10 business days.
5. **Five-stage warm-up ramp table** — from spec §3.3.
6. **Seed-inbox gate** — before any real recipient. Confirm raw headers show `spf=pass`, `dkim=pass header.d=feedback.<env>.repworth.net`, `dmarc=pass`, and that the one-click POST executes.
7. **Env vars to set at each stage**, cross-linked to `.claude/reference/env-vars.md` and the `flag-flip` skill.

- [ ] **Step 2: Add four rows to `docs/directory.md`**

`ci:directory-map` fails on a production file under `worker/` or `src/lib/` with no row. Four new files need rows:

- `src/lib/messaging/messaging-adapter.ts`
- `src/lib/messaging/email-adapter.ts`
- `worker/ingress/resend/bounce-classifier.ts`
- `worker/ingress/resend/solicitation-lane.ts`

`src/lib/messaging/` is a new folder — add its `§ folder` section too, and put the *why* there rather than in `CLAUDE.md`: the seam exists so WhatsApp is a second adapter, not a rewrite; it is a hypothetical seam today with zero production callers, accepted by map decision 14.

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm ci:directory-map 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 3: Add three glossary terms to `CONTEXT.md`**

Append **Messaging adapter**, **Sending identity** and **Solicitation lane** to the `## Solicitation (send-mode)` section, using the definitions from this plan's Glossary verbatim. Match the section's existing entry style: definition, the load-bearing constraint, `_Avoid_:` list, `*(coined in #657)*`.

- [ ] **Step 4: Run the CLAUDE.md shape guard**

`CLAUDE.md` is unedited by this task, but the guard also runs in the full suite. Confirm nothing regressed:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane && pnpm vitest run src/__tests__/claude-md-shape.test.ts 2>&1 | tail -6
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(657): sending-domain runbook, directory rows, three coined glossary terms"
```

---

## Self-review — run before dispatching Task 1

**Spec coverage.** §1.4/§1.5/§8 → Task 7 runbook. §1.6 → Tasks 2 and 4. §2.3/§2.4 → Task 5 `formatFrom`/`replyTo`. §5.1 → Task 6 Step 6. §5.2 → Task 5 tags. §5.3 → Task 6 Step 5, with the `delivered_at` row dropped and recorded as a non-goal. §7.1 → Task 5. §7.3 → Task 3. §9 → Task 2.

**Deliberate spec deviations, both owner-approved 2026-08-16:**
1. §5.3's `email.delivered → delivered_at` is dropped — no such column, no migration.
2. No index on `provider_message_id` — follow-up owned by #630.

**Not covered here, by design:** §3.2B reputation breaker (#630), §4 cap enforcement (#630), §6.3 owner copy (#629), §7.2 footer (#628), §7.4 subject lint (#628), §7.5 postal address (#656, shipped).

**Type consistency check.** `OutboundMessage` field names are identical in Tasks 1 and 5. `getEmailHeaders(category, opts)` has the same signature in Tasks 3 and 5. `handleSolicitationResendEvent(sql, eventType, emailId, data)` is identical in Task 6 Steps 5 and 6. `getSolicitationResend` is spelled the same in Tasks 4 and 5.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries real code.
