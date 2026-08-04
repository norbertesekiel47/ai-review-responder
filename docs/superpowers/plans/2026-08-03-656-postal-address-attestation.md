# Attested postal address (#656) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the owner-**Attested postal address** on `businesses` (migration **099**) with a per-location attestation surface on `settings/profile`, and withhold the **Send handoff** for any location whose address is unattested or whose owner email has bounced.

**Architecture:** One new domain module (`src/lib/solicitation/postal-address.ts`) owns the attestation-text version, the light lint, the atomic attestation write, the read model, and the withheld-reason rule. Migration 099 adds four nullable columns to `businesses` under one all-or-nothing CHECK, so no caller ever branches on "is this attested" — the schema carries the invariant. Everything else is a thin edit at an existing seam: the settings page server-fetches and passes props, the batch builder widens a `SELECT` it already runs, the worker adds one log field, the purge adds four columns to a `SET` it already writes, and ask-generation **deletes** its `to_jsonb` shim.

**Tech Stack:** Postgres.js (`postgres`) for writes, Supabase for auth, Next.js 16 App Router server components, Vitest + a live test DB for the integration lane.

**Binding constraints:**
- Migration number is **099**, not 098 — see deviations D1. **Do not open the PR to `main` until #645 has merged.**
- Locked spec: `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §7.5, §7.6, §2.4.
- Amended by: `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`.
- Intake contract (the drift detector): `.feature/intake.json`.
- Deviations so far: `docs/superpowers/plans/feat-656-postal-address-attestation-deviations.md` — read D1–D4 before starting.

---

## Glossary (CONTEXT.md terms — use these verbatim, never paraphrase)

Existing terms this plan consumes, from `CONTEXT.md` → "Solicitation (watch-mode)" and "Solicitation (send-mode)":

- **Solicitation batch** — one evaluated cohort of candidates; lifecycle `built → reviewed → expired` owned by the batch domain entity, never the run spine.
- **Ask** — one per-candidate `send | withhold` decision inside a batch, with a closed withhold-reason enum.
- **Withhold reason** — one code from the closed six-reason enum (`no_consent`, `suppressed`, `already_reviewed`, `stale_visit`, `over_contacted`, `velocity_banked`). **First-match precedence; one reason per withhold.** Adding a member bumps `RESTRAINT_POLICY_VERSION` and invalidates comparability with existing watch-mode evidence — **this plan adds none.**
- **Outreach row** — one `solicitation_outreach` row; one dispatch attempt for one Ask.

Two terms this plan **coins** (Task 9 writes them into `CONTEXT.md`):

- **Attested postal address** — the owner-attested `businesses.solicitation_postal_address` plus its attestation trio (`_attested_at`, `_attested_by_user_id`, `_attestation_version`): the CAN-SPAM §7704(a)(5) sender address baked **verbatim** into every ask footer, and a send precondition. Deliberately **not** `google_place_address`, which is Google's `formattedAddress` — it can be a service-area value like `"Austin, TX, USA"`, is not owner-attested, cannot express a USPS-registered PO box, and is NULLed by the offboarding purge (spec §7.5). Address and attestation are **all-or-nothing by DB CHECK**, so no code path can read an unattested address as attested. `_attested_by_user_id` is a **plain UUID with no FK** — a point-in-time capture, per migration 093's written lesson that 086's `ON DELETE CASCADE` meant deleting a staff member deleted their uploads. _Avoid_: business address, mailing address, footer address.
- **Send handoff** — the `enqueueGenerateSolicitationAsks` call at the end of batch construction (`batch-builder.ts:766`): the single point where a **Solicitation batch** becomes send-mode work. It is **withheld** — not the batch, and not the individual **Asks** — when the location has no **Attested postal address** or `owner_email_bounced` is TRUE. This is why a missing address is not a **Withhold reason**: it is one per-location fact, not 25 per-candidate decisions (spec §7.6). _Avoid_: send gate, generation gate, dispatch gate (that last is #630's, a different thing).

---

## File structure

| File | Responsibility | New? |
|---|---|---|
| `supabase/migrations/099_solicitation_postal_address.sql` | Four columns + one all-or-nothing CHECK | Create |
| `src/lib/solicitation/postal-address.ts` | Attestation version/text, lint, atomic attest, read model, withheld-reason rule | Create |
| `src/app/api/settings/postal-address/route.ts` | PUT composition root: parse → one module call → map to HTTP | Create |
| `src/components/dashboard/settings/SolicitationAddressPanel.tsx` | The owner-facing field + attestation checkbox | Create |
| `src/app/(authenticated)/settings/profile/page.tsx` | Server-fetch the state, pass as prop | Modify |
| `src/app/(authenticated)/settings/profile/ProfileClient.tsx` | Accept the prop, render the panel beside `ProfilePanel` | Modify |
| `src/lib/solicitation/batch-builder.ts` | Widen the existing `businesses` SELECT; add `sendHandoff` to the result | Modify |
| `worker/jobs/solicitation-batch/index.ts` | One `send_handoff` field on the existing structured log | Modify |
| `src/lib/solicitation/ask-generation.ts` | **Delete** the `to_jsonb` shim → direct column read | Modify |
| `worker/jobs/account-offboarding/purge-stages.ts` | Four columns onto the existing `businesses` SET | Modify |
| `.claude/reference/migrations-log.md` | 099 entry + head bump | Modify |
| `CONTEXT.md`, `docs/directory.md` | Glossary + code map | Modify |

**Why `postal-address.ts` is a new file rather than joining `src/lib/solicitation/attestation.ts`:** that module owns the **consent** attestation — a different fact with its own version namespace (`CONSENT_ATTESTATION_VERSION`) and its own eligibility allowlist (`SEND_ELIGIBLE_ATTESTATION_VERSIONS`). Two independently-versioned attestations behind one interface is a compliance bug waiting to happen: confusing them silently authorizes or blocks sends.

**Test files.** Extend existing suites wherever one exists; only two new test files.

| Test file | New? |
|---|---|
| `src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts` | Create (mirrors `migration-096-*`) |
| `src/lib/solicitation/__tests__/postal-address.test.ts` | Create (pure lint unit tests) |
| `src/lib/solicitation/__tests__/postal-address.integration.test.ts` | Create (attestation writes) |
| `src/app/api/settings/postal-address/__tests__/route.test.ts` | Create |
| `src/components/dashboard/settings/__tests__/solicitation-address-panel.test.tsx` | Create |
| `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` | **Extend** — send-handoff cases |
| `src/lib/solicitation/__tests__/ask-generation.integration.test.ts` | **Extend** — shim retirement |
| `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts` | **Extend** — purge |

> **Live-DB convention (#573, `ci:live-db-suites`):** a suite touching the live DB MUST be named `*.integration.test.ts` and MUST NOT apply migration SQL. Provision with `pnpm test:db:setup`; assert with `assertSchemaReady` from `src/lib/shared/__tests__/helpers/schema-ready.ts`. Migration-**shape** suites are the sanctioned exception and must hold `acquireLiveDbLock`. Follow `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts` exactly.

---

## Task dependency graph

```
T1 (eval) ──▶ T2 (099) ──▶ T3 (domain module) ──┬──▶ T4 (route) ──▶ T5 (UI)
                                                 ├──▶ T6 (send handoff + log)
                                                 ├──▶ T7 (retire shim)
                                                 └──▶ T8 (purge)
                                                          all ──▶ T9 (docs)
```

**Serial:** T1 → T2 → T3, then T4 → T5, then T9 last.
**Mutually independent (parallel-dispatchable after T3):** **T4, T6, T7, T8** — disjoint file sets (`src/app/api/...` / `batch-builder.ts`+`worker/jobs/solicitation-batch/` / `ask-generation.ts` / `purge-stages.ts`).
T1 runs **alone** — the first-task enforcement spot check depends on it.

---

## Task 1: Eval — author all 22 promised tests as failing tests

The `tests_to_add` titles in `.feature/intake.json` are the failable definition of done, and the gate's `promised-tests` row matches them **verbatim**. Write every one now. Slices not yet buildable use `it.todo(...)` with the exact title; the gate accepts a `todo` as present, and each later task converts its own todos to real assertions.

**Files:** all eight from the table above.

- [ ] **Step 1: Read the precedents before writing a line**

Read, don't skim:
- `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts` — migration-shape suite structure, `acquireLiveDbLock`, `assertSchemaReady`.
- `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` — the fixture helpers (`buildSolicitationBatch(sql(), {...})` at :278) you will reuse for T6's cases.
- `src/lib/reviews/__tests__/sentiment.test.ts` — house style for a pure-function unit suite.

- [ ] **Step 2: Write the schema-CHECK suite**

`src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts`, three tests, titles verbatim:

```ts
it('migration 099 rejects a postal address stored without an attestation', async () => {
  await expect(
    sql()`UPDATE businesses SET solicitation_postal_address = '123 Main St\nAustin, TX 78701'
          WHERE id = ${businessId}::uuid`,
  ).rejects.toThrow(/businesses_solicitation_postal_address_attested/);
});

it('migration 099 rejects an attestation stored without a postal address', async () => {
  await expect(
    sql()`UPDATE businesses
          SET solicitation_postal_address_attested_at = NOW(),
              solicitation_postal_address_attested_by_user_id = ${userId}::uuid,
              solicitation_postal_address_attestation_version = 'postal_address_attestation_v1'
          WHERE id = ${businessId}::uuid`,
  ).rejects.toThrow(/businesses_solicitation_postal_address_attested/);
});

it('migration 099 keeps the attestation after the attesting user is deleted', async () => {
  // No FK on _attested_by_user_id (093's lesson): deleting the attesting user
  // must NOT cascade into businesses and must NOT null the attestation.
  await attestFixture(businessId, userId);
  await sql()`DELETE FROM users WHERE id = ${userId}::uuid`;
  const [row] = await sql()`SELECT solicitation_postal_address,
                                   solicitation_postal_address_attested_by_user_id
                            FROM businesses WHERE id = ${businessId}::uuid`;
  expect(row.solicitation_postal_address).not.toBeNull();
  expect(row.solicitation_postal_address_attested_by_user_id).toBe(userId);
});
```

- [ ] **Step 3: Write the lint unit suite**

`src/lib/solicitation/__tests__/postal-address.test.ts`, four tests, titles verbatim:

```ts
it('lintPostalAddress rejects a blank or whitespace-only address', () => {
  expect(lintPostalAddress('   \n  ')).toEqual({ ok: false, reason: 'empty' });
  expect(lintPostalAddress('')).toEqual({ ok: false, reason: 'empty' });
});

it('lintPostalAddress rejects a single-line address', () => {
  // The service-area trap from spec §7.5: Google returns "Austin, TX, USA" for
  // a mobile locksmith. One line, no postal code — never a valid sender address.
  expect(lintPostalAddress('Austin, TX, USA')).toEqual({ ok: false, reason: 'single_line' });
});

it('lintPostalAddress rejects an address with no postal code', () => {
  expect(lintPostalAddress('Joe\'s Diner\nAustin, TX')).toEqual({ ok: false, reason: 'no_postal_code' });
});

it('lintPostalAddress accepts a two-line US address with a ZIP code', () => {
  const result = lintPostalAddress('  123 Main St  \r\n  Austin, TX 78701  ');
  expect(result).toEqual({ ok: true, normalized: '123 Main St\nAustin, TX 78701' });
});
```

- [ ] **Step 4: Write the attestation-write suite**

`src/lib/solicitation/__tests__/postal-address.integration.test.ts`, three tests, titles verbatim: `attestPostalAddress writes address, attested_at, attesting user and version atomically`, `attestPostalAddress re-attests on edit so the attestation never covers stale bytes`, `attestPostalAddress refuses to write for a business outside the caller's account`.

The middle one is the load-bearing case — assert that after a second `attestPostalAddress` with different bytes, `solicitation_postal_address_attested_at` **advanced** and the stored address equals the new bytes. A stale `attested_at` over new bytes is the defect.

- [ ] **Step 5: Write the route suite**

`src/app/api/settings/postal-address/__tests__/route.test.ts`, three tests, titles verbatim: `PUT /api/settings/postal-address rejects a request that omits the attestation`, `PUT /api/settings/postal-address rejects an address that fails the lint`, `PUT /api/settings/postal-address is scoped to the caller's active location`.

- [ ] **Step 6: Write the send-handoff cases into the EXISTING batch-builder suite**

Append to `src/lib/solicitation/__tests__/batch-builder.integration.test.ts`, five tests, titles verbatim:

```
batch build still produces a watch-mode batch when the location has no attested postal address
batch build withholds the send handoff when the location has no attested postal address
batch build withholds the send handoff when owner_email_bounced is TRUE
batch build performs the send handoff when the address is attested and the owner email is deliverable
the withheld send handoff reports one location-level reason, not a per-candidate withhold
```

The **first** is the regression guard for deviations D2 — it must assert `result.status === 'built'` with a non-zero `candidateCount` and an intact `withheldByReason`, proving watch-mode is untouched. The **last** must assert that `withheldByReason` gained **no** new key and that `sendHandoff.reason` is the only place the reason appears.

All five need `SOLICITATION_SEND_ENABLED` on and `sendCount > 0`; follow the existing suite's flag-stubbing helper.

- [ ] **Step 7: Write the remaining three**

- Extend `src/lib/solicitation/__tests__/ask-generation.integration.test.ts`: `ask generation reads solicitation_postal_address directly without the to_jsonb shim`.
- Extend `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts`: `the offboarding purge clears the attested postal address with the rest of the location data` — assert all four columns are NULL after purge, alongside the existing `google_place_address` assertion.
- Create `src/components/dashboard/settings/__tests__/solicitation-address-panel.test.tsx`: `the profile settings surface prefills the postal address from google_place_address as an editable suggestion` and `the profile settings surface refuses to submit until the attestation is checked`.

- [ ] **Step 8: Run the whole set and confirm they FAIL for the right reason**

Run: `pnpm vitest run src/lib/solicitation/__tests__/postal-address.test.ts`
Expected: FAIL — `Cannot find module '../postal-address'`. A failure for any *other* reason means the test is wrong, not the code.

- [ ] **Step 9: Verify the gate can see every promised title**

Run: `bash scripts/verify-gate.sh` and read only the `promised-tests` row.
Expected: PASS — all 22 titles found verbatim. (Other rows will be red; that is expected at T1.)

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "test(#656): eval task — 22 promised tests as failing spec"
```

---

## Task 2: Migration 099

**Blocking edge:** T1. **Turns green:** the three `migration 099 …` tests.

- [ ] **Step 1: Re-read the migration rules**

Invoke the **`new-migration` skill** and read `.claude/reference/migrations-log.md` (head is **097**; 098 belongs to #645 — see deviations D1, we take **099**).

- [ ] **Step 2: Write `supabase/migrations/099_solicitation_postal_address.sql`**

Header comment in the style of `096_solicitation_suppressions.sql` — design notes with spec sections in parentheses. Must state: why not `google_place_address` (§7.5), why no FK on `_attested_by_user_id` (093's lesson), and that the CHECK is all-or-nothing so no reader branches on attestation.

```sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS solicitation_postal_address                  TEXT,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attestation_version TEXT;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_solicitation_postal_address_attested;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_solicitation_postal_address_attested
  CHECK (
    (solicitation_postal_address                     IS NULL
     AND solicitation_postal_address_attested_at     IS NULL
     AND solicitation_postal_address_attested_by_user_id IS NULL
     AND solicitation_postal_address_attestation_version IS NULL)
    OR
    (solicitation_postal_address                     IS NOT NULL
     AND solicitation_postal_address_attested_at     IS NOT NULL
     AND solicitation_postal_address_attested_by_user_id IS NOT NULL
     AND solicitation_postal_address_attestation_version IS NOT NULL)
  );
```

No index: every read is already scoped by `businesses.id` (PK) or `account_id` (existing index). No FK, deliberately.

- [ ] **Step 3: Provision and run the shape suite**

```bash
pnpm test:db:setup
pnpm vitest run src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts
```
Expected: 3 PASS.

- [ ] **Step 4: Add the migrations-log entry and bump the head to 099**

Follow the existing entry shape (`- **097** — …`). Record: additive-only, no backfill, no CONCURRENTLY, applies in a single transaction, staging Supabase first then prod in lockstep at promotion, and **the 098/#645 ordering note**.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(#656): migration 099 — attested solicitation postal address"
```

---

## Task 3: `src/lib/solicitation/postal-address.ts`

**Blocking edge:** T2. **Turns green:** 4 lint + 3 attestation-write tests.

- [ ] **Step 1: Write the module**

Invariant #15 — the client is an explicit parameter; this module never imports `@/lib/db/server`.

```ts
/** Versioned attestation text. Precedent: src/lib/solicitation/attestation.ts,
 *  which owns the CONSENT attestation — a DIFFERENT fact with its own version
 *  namespace. Never cross-reference the two. */
export const POSTAL_ADDRESS_ATTESTATION_VERSION = 'postal_address_attestation_v1' as const;

/** Spec §7.5 verbatim — the checkbox label AND the stored record of what was agreed. */
export const POSTAL_ADDRESS_ATTESTATION_TEXT =
  'This is a valid physical postal address or USPS-registered PO box for this business.' as const;

export type PostalAddressLintReason = 'empty' | 'single_line' | 'no_postal_code';

export type PostalAddressLintResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: PostalAddressLintReason };

/** LIGHT lint only (§7.5): non-empty, ≥2 non-empty lines, contains a postal
 *  code. US-first by decision — do NOT add structured international address
 *  validation; the spec names it a trap. Normalization is minimal because the
 *  address is baked into the footer VERBATIM: CRLF→LF, strip per-line trailing
 *  whitespace, trim the outer edges. Nothing else. */
export function lintPostalAddress(raw: string): PostalAddressLintResult;

export type AttestPostalAddressResult =
  | { status: 'attested' }
  | { status: 'invalid'; reason: PostalAddressLintReason }
  | { status: 'business_not_found' };

/** Takes the RAW address and lints internally, so there is no code path that
 *  writes an unlinted address. One UPDATE, scoped by id AND account_id,
 *  setting all four columns — the CHECK makes a partial write impossible. */
export async function attestPostalAddress(
  sql: Sql | TransactionSql,
  params: { accountId: string; businessId: string; userId: string; address: string },
): Promise<AttestPostalAddressResult>;

export interface PostalAddressState {
  address: string | null;
  attestedAt: string | null;
  attestationVersion: string | null;
  /** google_place_address, offered as an editable SUGGESTION only when no
   *  attested address exists. Never written silently (§7.5). */
  suggestion: string | null;
}

export async function readPostalAddressState(
  sql: Sql,
  params: { accountId: string; businessId: string },
): Promise<PostalAddressState | null>;

export type SendHandoffWithheldReason = 'postal_address_missing' | 'owner_email_bounced';

/** First-match precedence, mirroring closedGateReason's shape in
 *  batch-builder.ts. Postal address first: it is the CAN-SPAM one. Pure — the
 *  caller supplies the row it already loaded. */
export function sendHandoffWithheldReason(row: {
  solicitation_postal_address_attested_at: Date | string | null;
  owner_email_bounced: boolean | null;
}): SendHandoffWithheldReason | null;
```

- [ ] **Step 2: Run the two suites**

```bash
pnpm vitest run src/lib/solicitation/__tests__/postal-address.test.ts
pnpm vitest run src/lib/solicitation/__tests__/postal-address.integration.test.ts
```
Expected: 4 PASS, 3 PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(#656): postal-address domain module — lint, atomic attestation, read model"
```

---

## Task 4: `PUT /api/settings/postal-address`

**Blocking edge:** T3. **Turns green:** the three route tests. **Independent of T6, T7, T8.**

- [ ] **Step 1: Read the precedent**

`src/app/api/settings/competitors/route.ts` — the per-concern settings sub-route shape: `requireRoleOr401(request, 'owner')`, `user.locationId` / `user.accountId` 403s, `assertWritableSubscriptionForAccount`, zod parse, one module call, `jsonResponse`.

- [ ] **Step 2: Write the route — orchestration only**

Body schema requires the attestation explicitly; **an unchecked box is a 400, never a silent skip**:

```ts
const UpdatePostalAddressSchema = z.object({
  address: z.string().min(1).max(500),
  attestationVersion: z.literal(POSTAL_ADDRESS_ATTESTATION_VERSION),
  attested: z.literal(true),
});
```

Map `attestPostalAddress`'s result: `attested` → 200, `invalid` → 400 with `reason`, `business_not_found` → 404. No business logic in the handler (working rule: entry points orchestrate).

- [ ] **Step 3: Run and commit**

```bash
pnpm vitest run src/app/api/settings/postal-address/__tests__/route.test.ts   # 3 PASS
git add -A && git commit -m "feat(#656): PUT /api/settings/postal-address attestation route"
```

---

## Task 5: Settings surface on `settings/profile`

**Blocking edge:** T4. **Turns green:** the two UI tests.

Per deviations D3 this does **not** touch `/api/settings`, `useSettingsForm`, or `ProfilePanel`. The page server-fetches and passes a prop; the new panel is a sibling of `ProfilePanel`.

- [ ] **Step 1: Invoke the `repworth-brand-design` skill** before writing any JSX. Read `src/components/dashboard/settings/BrandVoicePanel.tsx` for the panel shape and `set-section` conventions.

- [ ] **Step 2: Server-fetch in `page.tsx`**

`settings/profile/page.tsx` is already a server component that calls `requireOwnerAccess(sql)`. Add `readPostalAddressState(sql, { accountId, businessId })` and pass the result into `ProfileClient` as a prop — the pattern `settings/locations/page.tsx` already uses. `page.tsx` is a composition root, so importing `sql` here is correct (invariant #15).

- [ ] **Step 3: `SolicitationAddressPanel.tsx`**

Props: `{ state: PostalAddressState }`. Behavior the tests pin:
- When `state.address` is null and `state.suggestion` is non-null, the textarea renders **prefilled with the suggestion** and is editable — never auto-saved.
- The submit control is **disabled until the attestation checkbox is checked**, and the checkbox label is `POSTAL_ADDRESS_ATTESTATION_TEXT` verbatim.
- Editing a saved address **re-enables the checkbox requirement** — an edit is a re-attestation.
- Lint failures from the route render the reason inline.

- [ ] **Step 4: Run, build, commit**

```bash
pnpm vitest run src/components/dashboard/settings/__tests__/solicitation-address-panel.test.tsx   # 2 PASS
pnpm build
git add -A && git commit -m "feat(#656): postal address attestation panel on settings/profile"
```

---

## Task 6: Send-handoff precondition + log field

**Blocking edge:** T3. **Turns green:** the five send-handoff tests. **Independent of T4, T7, T8.**

> Read deviations **D2** first. §7.6 point 1 says "no batch produced"; that predates the shared watch/send builder. We withhold the **Send handoff**, never the build.

- [ ] **Step 1: Widen the SELECT the builder already runs**

`batch-builder.ts:705` already loads a business row (`SELECT category`). Add two columns to it — **no new query**:

```ts
const [business] = await tx<{
  category: string | null;
  owner_email_bounced: boolean | null;
  solicitation_postal_address_attested_at: Date | null;
}[]>`
  SELECT category, owner_email_bounced, solicitation_postal_address_attested_at
  FROM businesses
  WHERE id = ${businessId}::uuid AND account_id = ${accountId}::uuid
`;
```

- [ ] **Step 2: Add `sendHandoff` to the result type**

```ts
export interface BuiltSolicitationBatchResult {
  // … existing fields unchanged …
  sendHandoff:
    | { status: 'enqueued' }
    | { status: 'not_applicable' }               // sendCount === 0, or the flag is off
    | { status: 'withheld'; reason: SendHandoffWithheldReason };
}
```

**Not** a `withheldByReason` entry — that map is per-candidate and its keys are the closed `WITHHOLD_REASONS` enum (see Glossary).

- [ ] **Step 3: Gate the handoff at :766**

```ts
let sendHandoff: BuiltSolicitationBatchResult['sendHandoff'] = { status: 'not_applicable' };
if (summary.sendCount > 0 && solicitationSendEnabled()) {
  const reason = sendHandoffWithheldReason(business);
  if (reason) {
    sendHandoff = { status: 'withheld', reason };
  } else {
    await enqueueGenerateSolicitationAsks(tx, { /* unchanged */ });
    sendHandoff = { status: 'enqueued' };
  }
}
```

- [ ] **Step 4: Add the log field**

`worker/jobs/solicitation-batch/index.ts:31` — one field on the existing structured object:

```ts
send_handoff: result.sendHandoff,
```

No PII: the value is a status and a reason code. Do not log the address.

- [ ] **Step 5: Run and commit**

```bash
pnpm vitest run src/lib/solicitation/__tests__/batch-builder.integration.test.ts   # existing + 5 new PASS
git add -A && git commit -m "feat(#656): withhold the send handoff without an attested postal address"
```

---

## Task 7: Retire the `to_jsonb` shim

**Blocking edge:** T2. **Turns green:** the ask-generation test. **Independent of T4, T5, T6, T8.**

This is a **deletion** task — net-negative by design.

- [ ] **Step 1: Replace the shim at `ask-generation.ts:193`**

Delete the six-line comment block and the `to_jsonb(b) ->> 'solicitation_postal_address' AS postal_address` projection; replace with `b.solicitation_postal_address AS postal_address`. No fallback, no compatibility branch — the column exists as of T2, and this is a pre-launch codebase with no external consumer (anti-slop rule).

- [ ] **Step 2: Run and commit**

```bash
pnpm vitest run src/lib/solicitation/__tests__/ask-generation.integration.test.ts
git add -A && git commit -m "refactor(#656): direct postal-address column read, retiring the to_jsonb shim"
```

---

## Task 8: Offboarding purge

**Blocking edge:** T2. **Turns green:** the purge test. **Independent of T4, T5, T6, T7.**

- [ ] **Step 1: Extend the existing `businesses` SET**

`purge-stages.ts:673` already NULLs `google_place_address` in a `SET` list. Add the four columns to the same statement — all four together, or the CHECK rejects the row:

```sql
          solicitation_postal_address = NULL,
          solicitation_postal_address_attested_at = NULL,
          solicitation_postal_address_attested_by_user_id = NULL,
          solicitation_postal_address_attestation_version = NULL,
```

- [ ] **Step 2: Run and commit**

```bash
pnpm vitest run worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
git add -A && git commit -m "feat(#656): purge clears the attested postal address"
```

---

## Task 9: Domain sweep + docs

**Blocking edge:** T2–T8 complete.

- [ ] **Step 1:** Add **Attested postal address** and **Send handoff** to `CONTEXT.md` under "Solicitation (send-mode)", using the Glossary section of this plan verbatim including the `_Avoid_` lines and the `*(coined in #656)*` attribution.
- [ ] **Step 2:** Add `src/lib/solicitation/postal-address.ts`, the new route and the new panel to `docs/directory.md`.
- [ ] **Step 3:** Confirm `.claude/reference/migrations-log.md` head reads **099** (T2 did this — verify, don't duplicate).
- [ ] **Step 4:** Commit: `docs(#656): glossary terms, code map, migrations-log`.

---

## Self-review

**Spec coverage.** §7.5 column + no-`google_place_address` rationale → T2, T3. §7.5 attestation checkbox + editable prefill → T4, T5. §7.5 light lint / no international validation → T3. §7.6 point 1 (as amended) → T6. §2.4 `owner_email_bounced` → T6. Purge interaction (§7.5's "not even a stable field") → T8. §7.6 points 2 and 3 are **out of scope** by intake — #628 and #630 own them.

**Placeholder scan.** No TBDs. Every code step carries real code or a named precedent file to copy. The two places showing signatures rather than bodies (T3's module, T5's panel) pin the exact exported names, types and asserted behaviors, and the T1 tests are the executable spec for both.

**Type consistency.** `PostalAddressLintReason` / `PostalAddressLintResult` / `AttestPostalAddressResult` / `PostalAddressState` / `SendHandoffWithheldReason` are defined once in T3 and used unchanged in T4, T5, T6. `POSTAL_ADDRESS_ATTESTATION_VERSION` is the same literal in T2's SQL fixture, T3's constant and T4's zod schema. Column names are identical across T2, T3, T6, T7, T8.

**Known gap, deliberate:** nothing in this plan surfaces the withheld reason in owner UI on the Requests surface — that is #629's, per the intake's non-goals. The owner's only path today is the settings panel plus the worker log.
