# Attested postal address (#656) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the owner-**Attested postal address** on `businesses` (migration **099**) with a per-location attestation surface on `settings/profile`, and withhold the **Send handoff** for any location whose address is unattested or whose owner email has bounced.

**Architecture:** One new domain module (`src/lib/solicitation/postal-address.ts`) owns the attestation-text version, the light lint, the atomic attestation write, the read model, and the withheld-reason rule. Migration 099 adds **five** nullable columns to `businesses` under **two** CHECKs — one all-or-nothing over the tuple, one binding the attestation to the *current bytes* via a stored SHA-256 digest — so no caller ever branches on "is this attested" and an address-only UPDATE by any writer fails closed. Everything else is a thin edit at an existing seam: the settings page server-fetches and passes props, the batch builder widens a `SELECT` it already runs, the worker adds one log field, the purge adds five columns to a `SET` it already writes, and ask-generation **deletes** its `to_jsonb` shim.

**Tech Stack:** Postgres.js (`postgres`) for writes, Supabase for auth, Next.js 16 App Router server components, Vitest + a live test DB for the integration lane.

**Binding constraints:**
- Migration number is **099**. ✅ The #645/098 merge blocker is **cleared** — see deviations D1. T2 still runs the existence check, so a resumed session never re-derives this.
- Locked spec: `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §7.5, §7.6, §2.4.
- Amended by: `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` — **T9 writes the §7.6.1/§2.4 override into it.**
- Intake contract (the drift detector): `.feature/intake.json` — **v3**, 47 promised tests, 20 surface globs (v3 widened the test list only — the surface is untouched, so the amendment budget stays at #1 of 2).
- Deviations so far: `docs/superpowers/plans/feat-656-postal-address-attestation-deviations.md` — read D1–D4 before starting.

**Revision history:** this document is the **intake-v3 plan**. It supersedes the intake-v1 plan that plan review round 1 returned **REVISE** on (3 Critical / 5 High / 2 Medium / 1 Low, all ACCEPTED; one finding REJECTED). Findings and triage verdicts: `docs/reviews/feat-656-postal-address-attestation/`. Round-1 post-mortem: `feat-656-postal-address-attestation-postmortem.md`. Every claim below that cites a file, line, helper or export was re-verified against the working tree at `32e8c84e` before this revision was written — the round-1 report's central lesson was that four plan citations were false.

---

## Glossary (CONTEXT.md terms — use these verbatim, never paraphrase)

Existing terms this plan consumes, from `CONTEXT.md` → "Solicitation (watch-mode)" and "Solicitation (send-mode)":

- **Solicitation batch** — one evaluated cohort of candidates; lifecycle `built → reviewed → expired` owned by the batch domain entity, never the run spine.
- **Ask** — one per-candidate `send | withhold` decision inside a batch, with a closed withhold-reason enum.
- **Withhold reason** — one code from the closed six-reason enum (`no_consent`, `suppressed`, `already_reviewed`, `stale_visit`, `over_contacted`, `velocity_banked`). **First-match precedence; one reason per withhold.** Adding a member bumps `RESTRAINT_POLICY_VERSION` and invalidates comparability with existing watch-mode evidence — **this plan adds none.**
- **Outreach row** — one `solicitation_outreach` row; one dispatch attempt for one Ask.
- **Consent attestation** / **Consent ledger** — the *other* attestation in this domain. Different fact, different version namespace, different table. Never cross-referenced.

Two terms this plan **coins** (T10 writes them into `CONTEXT.md`):

- **Attested postal address** — the owner-attested `businesses.solicitation_postal_address` plus its attestation quartet (`_attested_at`, `_attested_by_user_id`, `_attestation_version`, `_attested_digest`): the CAN-SPAM §7704(a)(5) sender address baked **verbatim** into every ask footer, and a send precondition. Deliberately **not** `google_place_address`, which is Google's `formattedAddress` — it can be a service-area value like `"Austin, TX, USA"`, is not owner-attested, cannot express a USPS-registered PO box, and is NULLed by the offboarding purge (spec §7.5). Address and attestation are **all-or-nothing by DB CHECK**, and the attestation is welded to the address's **current bytes** by a second CHECK over `_attested_digest` — so no code path can read an unattested address as attested, and no writer can change the stored bytes without recomputing that digest (see "Design decisions" #1 for the exact scope of that guarantee — it is narrower than "the attestation is always current"). `_attested_by_user_id` is a **plain UUID with no FK** — a point-in-time capture, per migration 093's written lesson that 086's `ON DELETE CASCADE` meant deleting a staff member deleted their uploads. Because there is no FK, the *writer* verifies the actor. _Avoid_: business address, mailing address, footer address.
- **Send handoff** — the `enqueueGenerateSolicitationAsks` call at the end of batch construction (`batch-builder.ts:766`): the single point where a **Solicitation batch** becomes send-mode work. It is **withheld** — not the batch, and not the individual **Asks** — when the location has no **Attested postal address** or `owner_email_bounced` is TRUE. This is why a missing address is not a **Withhold reason**: it is one per-location fact, not 25 per-candidate decisions (spec §7.6, as overridden — see T9). _Avoid_: send gate, generation gate, dispatch gate (that last is #630's, a different thing).

---

## Design decisions this revision locks

Round 1 found the v1 plan cited the wrong auth helpers and under-specified the schema. These are the corrected calls, each with the verified evidence.

**1. The schema binds the attestation to the bytes, not merely to tuple completeness.**
The all-or-nothing CHECK enforces *completeness*. An address-only `UPDATE` on an already-attested row keeps all four original columns non-NULL, passes that CHECK, and leaves an attestation dated before bytes it never covered — the precise defect this feature exists to prevent. `attestPostalAddress` being well-behaved constrains no other writer. The fix is schema-level and trigger-free: a fifth column `solicitation_postal_address_attested_digest` CHECKed to equal `encode(sha256(convert_to(solicitation_postal_address,'UTF8')),'hex')`. An address-only UPDATE by **any** writer then fails closed — verified empirically against the test DB, not merely reasoned about.

> **Scope of the guarantee, stated exactly** (round 2, defect 1). The digest CHECK guarantees that *no writer can change the stored address without also recomputing sha256 of the new bytes.* It does **not** make the attestation metadata total: a writer that sets the address **and** recomputes the digest while preserving the old `_attested_at` / `_attested_by_user_id` / `_attestation_version` satisfies both constraints. This was reproduced on the live test DB. Closing that residual needs `OLD` vs `NEW`, which a CHECK cannot see — it is a `BEFORE UPDATE` trigger. The accidental path (a future `UPDATE … SET solicitation_postal_address = $1` that forgets the attestation) is closed; the residual path requires lifting the digest expression out of the migration and deliberately keeping a stale timestamp, which is forgery rather than oversight. **Do not restate the guarantee more broadly than this paragraph does.**

**2. The route's auth helper is `resolveOwnerScope`, not `requireSettingsOwner`.**
Verified in `src/lib/auth/route-helpers.ts:221-238`: `requireSettingsOwner` resolves **no location** and — per its own doc comment at :217-220 — **deliberately skips the writable-subscription gate** ("settings reads and rival/auto-approval writes stay available to past-due accounts"). The intake demands both a cookie-resolved active location *and* a non-writable-subscription refusal, and `requireSettingsOwner` supplies neither.

`src/lib/auth/resolve-owner-scope.ts:93` supplies all three facts this route needs in one call: `{ accountId, locationId, userId }` — where `locationId` is the `rw_location_scope` cookie resolved through `getRequestScope` (falling back to primary), and `userId` is `users.id`, the app-user PK the attestation column stores (**not** the Supabase Auth UID). It gates the subscription itself (`past_due_read_only` → 402, non-full-access → 403). Its own doc comment states it does **not** do CSRF, so the route still wraps with `withSameOrigin()`.

*What we give up, and what we must add back.* Dropping `requireSettingsOwner` also drops two of its behaviours:

- The `?accountId` rejection. **Safe to lose:** this route reads no query parameters at all, so the parameter is inert rather than half-honoured.
- The operational-UI offboarding block. **NOT safe to lose — the route must re-add it explicitly.** Round 2 disproved the earlier claim that the subscription gate covers it: `isFullBlockState` returns true for `mode === 'delete_data'` at *any* status (`src/lib/account-offboarding/gate.ts:212-215`), and confirming offboarding does not itself cancel the subscription — Stripe is the source of truth and cancellation is a separate async step. So an account in `delete_data/pending` is still `active`, sails through `assertSubscriptionAllowsOwnerScope`, and would be able to mutate its sender address mid-teardown.

The precedent handles this exactly the same way: `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts:103-106` calls `resolveOwnerScope` and *then* applies `getOffboardingState` + `isOperationalUIBlocked` itself. T4 does the same.

`src/app/api/settings/competitors/route.ts` remains the precedent for the route's **shape** — `z.strictObject`, one module call, `jsonResponse`, `export const PUT = withSameOrigin()(handler)` — but **not** for its auth. It takes an explicit `businessId` because it is a multi-location picker; ours must write the location the owner is *currently looking at*.

**3. `attestPostalAddress` validates the actor, because no FK does.**
`_attested_by_user_id` is deliberately FK-free (093's lesson). That preserves history but leaves nothing stopping a writer from stamping an arbitrary or cross-tenant UUID as legal provenance. The membership predicate therefore rides the same scoped UPDATE.

**4. `sendHandoffWithheldReason` is pure and first-match**, mirroring `closedGateReason`'s shape (`batch-builder.ts:130-138`). `postal_address_missing` wins over `owner_email_bounced`: it is the CAN-SPAM one.

**5. `it.todo` satisfies the gate's `promised-tests` row.** So the gate can go green with the feature absent. T1's first promised test is a guard that scans this branch's own suites for residual `todo`/`skip`, and T11 is a closing task that re-runs it plus `verify-gate.sh --review`.

---

## File structure

| File | Responsibility | New? |
|---|---|---|
| `supabase/migrations/099_solicitation_postal_address.sql` | Five columns + two CHECKs | Create |
| `src/lib/solicitation/postal-address.ts` | Attestation version/text, lint, atomic attest, read model, withheld-reason rule | Create |
| `src/app/api/settings/postal-address/route.ts` | PUT composition root: parse → one module call → map to HTTP | Create |
| `src/components/dashboard/settings/SolicitationAddressPanel.tsx` | The owner-facing field + attestation checkbox | Create |
| `src/app/(authenticated)/settings/profile/page.tsx` | Server-fetch the state, pass as prop | Modify |
| `src/app/(authenticated)/settings/profile/ProfileClient.tsx` | Accept the prop, render the panel beside `ProfilePanel` | Modify |
| `src/lib/solicitation/batch-builder.ts` | Widen the existing `businesses` SELECT; add `sendHandoff` to the result | Modify |
| `worker/jobs/solicitation-batch/index.ts` | One `send_handoff` field on the existing structured log | Modify |
| `src/lib/solicitation/ask-generation.ts` | **Delete** the `to_jsonb` shim → direct column read | Modify |
| `worker/jobs/account-offboarding/purge-stages.ts` | Five columns onto the existing `businesses` SET | Modify |
| `src/lib/shared/__tests__/helpers/schema-ready.ts` | `MIGRATION_099_SOLICITATION_POSTAL_ADDRESS` requirement | Modify |
| `.claude/reference/migrations-log.md` | 099 entry + head bump | Modify |
| `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` | The §7.6.1 / §2.4 override, in the spec directory | Modify |
| `CONTEXT.md`, `docs/directory.md` | Glossary + code map | Modify |

**Why `postal-address.ts` is a new file rather than joining `src/lib/solicitation/attestation.ts`:** that module owns the **Consent attestation** — a different fact with its own version namespace (`CONSENT_ATTESTATION_VERSION = 'consent_attestation_v2'`) and its own eligibility allowlist (`SEND_ELIGIBLE_ATTESTATION_VERSIONS`). Two independently-versioned attestations behind one interface is a compliance bug waiting to happen: confusing them silently authorizes or blocks sends.

**Test files — five Creates, six Extends.**

| Test file | New? | Promised titles |
|---|---|---|
| `src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts` | Create (mirrors `migration-096-*`) | 4 |
| `src/lib/solicitation/__tests__/postal-address.test.ts` | Create (gate guard + pure lint) | 6 |
| `src/lib/solicitation/__tests__/postal-address.integration.test.ts` | Create (attestation writes + read model) | 7 |
| `src/app/api/settings/postal-address/__tests__/route.test.ts` | Create | 9 |
| `src/components/dashboard/settings/__tests__/solicitation-address-panel.test.tsx` | Create | 5 |
| `src/app/(authenticated)/settings/profile/__tests__/ProfileClient.test.tsx` | **Extend** | 1 |
| `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` | **Extend** | 8 |
| `src/lib/solicitation/__tests__/batch-builder.test.ts` | **Extend** (+ fixture repair) | 2 |
| `worker/jobs/solicitation-batch/__tests__/index.test.ts` | **Extend** (+ fixture repair) | 1 |
| `src/lib/solicitation/__tests__/ask-generation.integration.test.ts` | **Extend** | 1 |
| `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts` | **Extend** | 3 |
| | | **47** |

> **Live-DB convention (#573, `ci:live-db-suites`):** a suite touching the live DB MUST be named `*.integration.test.ts` and MUST NOT apply migration SQL. Provision with `pnpm test:db:setup`; assert with `assertSchemaReady` from `src/lib/shared/__tests__/helpers/schema-ready.ts`. `acquireLiveDbLock` is a **separate** module — `src/lib/shared/__tests__/helpers/live-db-lock.ts` — and migration-**shape** suites are the sanctioned exception that must hold it. Follow `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts` exactly; its import block (lines 1-21) is the template.

**Surface check.** Every file above is already inside `.feature/intake.json`'s `allowed_edit_surface` (v2, 20 globs). **This plan needs no surface amendment.** If a task believes it does, STOP — that is scope drift, and the amendment budget is #1 of 2 against v2.

---

## Task dependency graph

```
T1 (eval) ──▶ T2 (099 + schema req) ──┬──▶ T3 (domain module) ──┬──▶ T4 (route) ──▶ T5 (UI)
                                      │                         └──▶ T6 (send handoff + log)
                                      ├──▶ T7 (retire shim)
                                      └──▶ T8 (purge)

T9 (spec amendment) — independent of T2-T8, needs only T1
                                                    all ──▶ T10 (docs) ──▶ T11 (final verification)
```

**Serial:** T1 → T2 → T3, then T4 → T5. T10 after T2–T9. **T11 is last and runs alone.**
**Mutually independent, parallel-dispatchable after T2:** **T7, T8, T9.**
**Mutually independent, parallel-dispatchable after T3:** **T4, T6.**
T1 runs **alone** — the first-task enforcement spot check depends on it.

*(Round-1 finding 11: T7 and T8 depend on **T2**, not T3 — they touch columns, not the module. Fixed here.)*

---

## Task 1: Eval — author all 47 promised tests as failing tests

The `tests_to_add` titles in `.feature/intake.json` are the failable definition of done, and the gate's `promised-tests` row matches them **verbatim**. Write every one now. Slices not yet buildable use `it.todo(...)` with the exact title; the gate accepts a `todo` as present, and each later task converts its own todos to real assertions. **T11 proves none survived.**

**Files:** all eleven from the table above.

- [ ] **Step 1: Read the precedents before writing a line**

Read, don't skim:
- `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts` — shape-suite structure, the `acquireLiveDbLock` / `assertSchemaReady` split across two helper modules, and the *exhaustive generated matrix* idiom (its header comment explains why asserting a CHECK merely exists is worth nothing).
- `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` — the fixture helpers (`seedBatch`, `seedContact`, `seedCompletedUpload`, `build`) T6's cases reuse. Note the existing result assertions use `toMatchObject`, not `toEqual`.
- `src/lib/solicitation/__tests__/batch-builder.test.ts` — the **unit** suite. `pushConstructionPreamble()` pushes `mkTaggedResult([{ category: 'automotive' }])` for the business row at three sites (~:426, ~:594, ~:773). T6 widens that row; these fixtures must widen with it.
- `src/lib/reviews/__tests__/sentiment.test.ts` — house style for a pure-function unit suite.

There is **no flag-stubbing helper** in the batch-builder suites. The integration suite mutates `process.env.SOLICITATION_WATCH_ENABLED` / `SOLICITATION_SEND_ENABLED` directly; the unit suite mocks `solicitationSendEnabled` via `mocks.solicitationSendEnabled.mockReturnValue(true)`. Follow whichever suite you are in.

- [ ] **Step 2: The gate-integrity guard**

First test in `src/lib/solicitation/__tests__/postal-address.test.ts`, title verbatim:

```
every #656 promised test is executable with zero pending cases
```

It reads this branch's eleven test files off disk and asserts none contains `it.todo(`, `describe.todo(`, `it.skip(` or `describe.skip(`. It is expected to **fail** from T1 until T11. That is the point: it is the only thing standing between "the gate found 47 titles" and "47 tests actually ran".

- [ ] **Step 3: The migration-099 shape suite** — 4 tests, titles verbatim

`src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts`:

```
migration 099 rejects every partially populated postal-address attestation tuple
migration 099 rejects replacing an attested address without replacing its attestation
migration 099 adds no foreign key on solicitation_postal_address_attested_by_user_id
migration 099 keeps the complete attestation tuple after the attesting user is deleted
```

The first is an **exhaustive generated matrix** over the five columns (2^5 = 32 nullability combinations), following 096. Exactly two combinations are legal — all-NULL, and all-present *with a matching digest*; the other 30 must be rejected. Do not hand-write three cases and call it exhaustive.

The second is the round-1 Critical, and it is the load-bearing test of this feature:

```ts
it('migration 099 rejects replacing an attested address without replacing its attestation', async () => {
  await attestFixture(businessId, userId, '123 Main St\nAustin, TX 78701');
  // Address-only UPDATE: all four attestation columns stay non-NULL, so the
  // all-or-nothing CHECK is satisfied. Only the digest CHECK catches it.
  await expect(
    sql()`UPDATE businesses
          SET solicitation_postal_address = '999 Other Rd\nAustin, TX 78702'
          WHERE id = ${businessId}::uuid`,
  ).rejects.toThrow(/businesses_solicitation_postal_address_digest/);
});
```

The third asserts absence by introspection — no `pg_constraint` row of `contype = 'f'` referencing `solicitation_postal_address_attested_by_user_id` — **and** behaviourally, that an arbitrary UUID inserts fine.

Every behavioural write runs inside a transaction that is always rolled back (096's discipline), and the suite holds `acquireLiveDbLock`.

- [ ] **Step 4: The lint unit suite** — 5 tests, titles verbatim

Appended to `src/lib/solicitation/__tests__/postal-address.test.ts` after the Step 2 guard:

```ts
it('lintPostalAddress rejects a blank or whitespace-only address', () => {
  expect(lintPostalAddress('   \n  ')).toEqual({ ok: false, reason: 'empty' });
  expect(lintPostalAddress('')).toEqual({ ok: false, reason: 'empty' });
});

it('lintPostalAddress requires two non-empty lines', () => {
  // The service-area trap from spec §7.5: Google returns "Austin, TX, USA" for
  // a mobile locksmith. One line, no postal code — never a valid sender address.
  expect(lintPostalAddress('Austin, TX, USA')).toEqual({ ok: false, reason: 'single_line' });
  // Two lines, one of them blank, is ONE line. A \n is not a second line.
  expect(lintPostalAddress('123 Main St\n   \n')).toEqual({ ok: false, reason: 'single_line' });
});

it('lintPostalAddress rejects an address with no postal code', () => {
  expect(lintPostalAddress("Joe's Diner\nAustin, TX")).toEqual({ ok: false, reason: 'no_postal_code' });
});

it('lintPostalAddress does not treat a five-digit street number as the postal code', () => {
  // "12345 Elm St" is a street number, not a ZIP. The postal-code probe must
  // look at the LAST non-empty line, not anywhere in the blob.
  expect(lintPostalAddress('12345 Elm St\nAustin, TX')).toEqual({ ok: false, reason: 'no_postal_code' });
});

it('lintPostalAddress accepts a two-line US address with a ZIP code', () => {
  const result = lintPostalAddress('  123 Main St  \r\n  Austin, TX 78701  ');
  expect(result).toEqual({ ok: true, normalized: '123 Main St\nAustin, TX 78701' });
});
```

- [ ] **Step 5: The attestation-write suite** — 7 tests, titles verbatim

`src/lib/solicitation/__tests__/postal-address.integration.test.ts`:

```
attestPostalAddress writes the whole attestation tuple in one account-scoped UPDATE
attestPostalAddress re-attests on edit so the attestation never covers stale bytes
attestPostalAddress records the new actor on re-attestation
a failed re-attestation preserves the previous attestation tuple byte-for-byte
attestPostalAddress rejects an attesting user outside the caller's account
attestPostalAddress refuses to write for a business outside the caller's account
readPostalAddressState returns no data for a business outside the supplied account
```

Notes that decide whether these tests are real:
- *one account-scoped UPDATE* — assert the statement count, not just the outcome. Capture the issued SQL and assert exactly one `UPDATE businesses` carrying both `id` and `account_id` predicates.
- *never covers stale bytes* — after a second attestation with different bytes, assert `_attested_at` **advanced**, the stored address equals the new bytes, **and** `_attested_digest` equals sha256 of the new bytes.
- *failed re-attestation preserves the previous tuple byte-for-byte* — drive the failure with a lint-invalid address and an actor outside the account; snapshot all five columns before and after and `toEqual` them.
- the two rejections must be **distinguishable**: `{ status: 'actor_not_in_account' }` vs `{ status: 'business_not_found' }`.

- [ ] **Step 6: The route suite** — 9 tests, titles verbatim

`src/app/api/settings/postal-address/__tests__/route.test.ts`:

```
PUT /api/settings/postal-address rejects unauthenticated and non-owner callers before writing
PUT /api/settings/postal-address rejects cross-origin mutation requests
PUT /api/settings/postal-address refuses writes for a non-writable subscription
PUT /api/settings/postal-address refuses writes while the account is offboarding
PUT /api/settings/postal-address rejects a request that omits the attestation
PUT /api/settings/postal-address rejects an unknown attestation version without writing
PUT /api/settings/postal-address rejects an address that fails the lint
PUT /api/settings/postal-address records the authenticated app user as the attester
PUT /api/settings/postal-address writes the cookie-resolved active location
```

Every rejection asserts **zero writes** — `expect(mockAttest).not.toHaveBeenCalled()` — not merely a status code. Follow `src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts` for the same-origin case and `.../draft.test.ts` for the `resolveOwnerScope` mocking shape.

The last two are the round-1 High: mock `resolveOwnerScope` to return a `locationId` that is **not** the account's primary location and a `userId` that is the `users.id`, then assert those exact values reach `attestPostalAddress`.

- [ ] **Step 7: The UI suites** — 6 tests, titles verbatim

Extend `src/app/(authenticated)/settings/profile/__tests__/ProfileClient.test.tsx`:

```
the profile page renders the active location postal-address state
```

Create `src/components/dashboard/settings/__tests__/solicitation-address-panel.test.tsx`:

```
the profile settings surface prefills the postal address from google_place_address as an editable suggestion
google_place_address prefill is never persisted before explicit attestation
the profile settings surface refuses to submit until the attestation is checked
the profile settings surface requires a fresh attestation after a saved address is edited
the profile settings checkbox uses POSTAL_ADDRESS_ATTESTATION_TEXT verbatim
```

*never persisted before explicit attestation* means: render with `address: null, suggestion: '…'`, assert the textarea shows the suggestion **and** that no fetch/PUT fires on mount or on blur. *Verbatim* means `toBe(POSTAL_ADDRESS_ATTESTATION_TEXT)` against the imported constant, never a hand-copied string — the constant is the compliance record.

- [ ] **Step 8: The batch-builder suites** — 10 tests, titles verbatim

Append to `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` (8):

```
batch build still produces a watch-mode batch when the location has no attested postal address
batch build withholds the send handoff when the location has no attested postal address
batch build withholds the send handoff when owner_email_bounced is TRUE
postal_address_missing wins when the postal address is missing and owner email has bounced
a withheld send handoff creates no generate_solicitation_asks outbox row
withholding the send handoff does not change any per-candidate decision or reason count
batch build performs the send handoff when the address is attested and the owner email is deliverable
a send-handoff enqueue failure rolls back the batch build
```

Append to `src/lib/solicitation/__tests__/batch-builder.test.ts` (2):

```
batch build scopes the postal precondition read by business_id and account_id
send handoff is not_applicable when SOLICITATION_SEND_ENABLED is off
```

The load-bearing ones:
- *still produces a watch-mode batch* — assert `status === 'built'` with a non-zero `candidateCount` and an intact `withheldByReason`. This is the regression guard for the watch-mode/send-handoff decision recorded on **ticket #656 and map #617** and written into the spec by **T9** — *not* in the deviations file, which carries D1 (renumber), D2 (allowlist), D3 (surface narrowing), D4 (log seam) and nothing about this.
- *does not change any per-candidate decision or reason count* — run the identical fixture cohort twice, once attested and once not, and assert the two `withheldByReason` maps and the two `sendCount`/`withholdCount` pairs are **byte-identical**. Asserting merely "no new key appeared" is insufficient: the failure mode is a candidate leaking into `no_consent`.
- *not_applicable when SOLICITATION_SEND_ENABLED is off* — the unit suite's default. All the integration cases turn the flag **on**, so without this one the watch-only path (prod today) is untested.
- *enqueue failure rolls back the batch build* — make `enqueueGenerateSolicitationAsks` throw, then assert `built_at IS NULL` and zero ask rows. A built batch with no generation work is not a reachable state.

- [ ] **Step 9: The remaining five**

- Extend `worker/jobs/solicitation-batch/__tests__/index.test.ts`: `the solicitation batch worker logs the send handoff status and location-level reason`.
- Extend `src/lib/solicitation/__tests__/ask-generation.integration.test.ts`: `ask generation reads solicitation_postal_address directly without the to_jsonb shim`.
- Extend `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts` (3):

```
the offboarding purge clears a populated attestation tuple in one statement
the offboarding purge clears the attestation for every location in the account
the offboarding purge leaves another account's attested postal address untouched
```

> There is **no existing `google_place_address` assertion** in the offboarding suite to sit alongside — that v1 claim was false. These three are freestanding; seed the attested tuple yourself.

- [ ] **Step 10: Run the whole set and confirm they FAIL for the right reason**

```bash
pnpm vitest run src/lib/solicitation/__tests__/postal-address.test.ts
```
Expected: FAIL — `Cannot find module '../postal-address'`. A failure for any *other* reason means the test is wrong, not the code.

- [ ] **Step 11: Verify the gate can see every promised title**

```bash
bash scripts/verify-gate.sh
```
Read only the `promised-tests` row. Expected: PASS — all **47** titles found verbatim. (Other rows will be red; that is expected at T1.)

- [ ] **Step 12: Commit**

```bash
git add -A && git commit -m "test(#656): eval task — 47 promised tests as failing spec"
```

---

## Task 2: Migration 099 + the schema requirement

**Blocking edge:** T1. **Turns green:** the four `migration 099 …` tests.

- [ ] **Step 1: Blocking pre-flight — 098 must exist**

```bash
test -f supabase/migrations/098_solicitation_suppression_corrections.sql \
  || { echo "STOP — migration 098 is absent; this branch is not rebased onto merged #645"; exit 1; }
grep -q "Current head: \*\*098\*\*" .claude/reference/migrations-log.md \
  || { echo "STOP — migrations-log head is not 098"; exit 1; }
echo OK
```

A non-zero exit **stops the task**: the branch is not rebased onto merged #645 and recording head 099 would corrupt the log. (Expected `OK` — deviations D1 records the resolution at `4a16bcfd`. The check exists so a resumed session proves it rather than trusting prose.)

> Written as two guarded statements with explicit `exit 1`, not as `A && B && echo OK || echo STOP`. That one-liner exits **0** on failure — the `echo` succeeds — so it *reports* a failure without *being* one, and a runner that checks the exit code sails past. Round 2 caught exactly that.

- [ ] **Step 2: Re-read the migration rules**

Invoke the **`new-migration` skill** and read `.claude/reference/migrations-log.md` (head is **098**; we take **099**).

- [ ] **Step 3: Write `supabase/migrations/099_solicitation_postal_address.sql`**

Header comment in the style of `096_solicitation_suppressions.sql` — design notes with spec sections in parentheses. Must state: why not `google_place_address` (§7.5); why no FK on `_attested_by_user_id` (093's lesson); that CHECK #1 is all-or-nothing so no reader branches on attestation; and that **CHECK #2 is the one that matters** — completeness is not coverage, and without the digest an address-only UPDATE by any writer leaves a stale attestation.

```sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS solicitation_postal_address                      TEXT,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_by_user_id  UUID,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attestation_version  TEXT,
  ADD COLUMN IF NOT EXISTS solicitation_postal_address_attested_digest      TEXT;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_solicitation_postal_address_attested;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_solicitation_postal_address_attested
  CHECK (
    (solicitation_postal_address                        IS NULL
     AND solicitation_postal_address_attested_at        IS NULL
     AND solicitation_postal_address_attested_by_user_id IS NULL
     AND solicitation_postal_address_attestation_version IS NULL
     AND solicitation_postal_address_attested_digest    IS NULL)
    OR
    (solicitation_postal_address                        IS NOT NULL
     AND solicitation_postal_address_attested_at        IS NOT NULL
     AND solicitation_postal_address_attested_by_user_id IS NOT NULL
     AND solicitation_postal_address_attestation_version IS NOT NULL
     AND solicitation_postal_address_attested_digest    IS NOT NULL)
  );

-- The attestation covers THESE BYTES, not merely "some address". Completeness
-- is not coverage: an address-only UPDATE keeps the quartet non-NULL and passes
-- the constraint above.
--
-- Volatility, precisely: sha256() and encode() are IMMUTABLE, but convert_to()
-- is STABLE (provolatile 's') because its result depends on server_encoding.
-- Postgres does NOT reject a STABLE function in a CHECK the way it rejects one
-- in an index predicate, and this database is UTF8 — an encoding that cannot
-- change under a live table — so the expression is deterministic in practice.
-- Verified empirically: both constraints create, and an address-only UPDATE is
-- rejected. Do NOT copy this expression into an index.
ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_solicitation_postal_address_digest;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_solicitation_postal_address_digest
  CHECK (
    solicitation_postal_address IS NULL
    OR solicitation_postal_address_attested_digest
       = encode(sha256(convert_to(solicitation_postal_address, 'UTF8')), 'hex')
  );
```

No index: every read is already scoped by `businesses.id` (PK) or `account_id` (existing index). No FK, deliberately.

> `sha256(bytea)` is core Postgres (11+), not pgcrypto — no extension needed. If `pnpm test:db:setup` errors on it, STOP and report the server version rather than reaching for pgcrypto.

- [ ] **Step 4: Add the schema requirement**

In `src/lib/shared/__tests__/helpers/schema-ready.ts`, following `MIGRATION_098_SUPPRESSION_CORRECTIONS` (~:335):

```ts
export const MIGRATION_099_SOLICITATION_POSTAL_ADDRESS: SchemaRequirement = {
  migration: '099_solicitation_postal_address',
  tables: ['businesses'],
  columns: [
    'businesses.solicitation_postal_address',
    'businesses.solicitation_postal_address_attested_at',
    'businesses.solicitation_postal_address_attested_by_user_id',
    'businesses.solicitation_postal_address_attestation_version',
    'businesses.solicitation_postal_address_attested_digest',
  ],
  indexes: [],
};
```

Assert it in **every** affected live-DB suite: the 099 shape suite, `postal-address.integration.test.ts`, `batch-builder.integration.test.ts`, `ask-generation.integration.test.ts`, and `offboarding-lifecycle.integration.test.ts`. A behind-head DB must fail with the actionable `pnpm test:db:setup` message, not an undefined-column error.

- [ ] **Step 5: Provision and run the shape suite**

```bash
pnpm test:db:setup
pnpm vitest run src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts
```
Expected: 4 PASS.

- [ ] **Step 6: Add the migrations-log entry and bump the head to 099**

Follow the existing entry shape. Record: additive-only, no backfill, no CONCURRENTLY, applies in a single transaction, **staging Supabase first then prod in lockstep at promotion**, and that 098/#645 landed first.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(#656): migration 099 — attested solicitation postal address bound to its bytes"
```

---

## Task 3: `src/lib/solicitation/postal-address.ts`

**Blocking edge:** T2. **Turns green:** 5 lint + 7 attestation/read tests.

- [ ] **Step 1: Write the module**

Invariant #15 — the client is an explicit parameter; this module never imports `@/lib/db/server`.

```ts
/** Versioned attestation text. Precedent: src/lib/solicitation/attestation.ts,
 *  which owns the CONSENT attestation — a DIFFERENT fact with its own version
 *  namespace. Never cross-reference the two. */
export const POSTAL_ADDRESS_ATTESTATION_VERSION = 'postal_address_attestation_v1' as const;

/** Spec §7.5 verbatim — the checkbox label AND the stored record of what was
 *  agreed. Changing the wording MUST bump the version above. */
export const POSTAL_ADDRESS_ATTESTATION_TEXT =
  'This is a valid physical postal address or USPS-registered PO box for this business.' as const;

export type PostalAddressLintReason = 'empty' | 'single_line' | 'no_postal_code';

export type PostalAddressLintResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: PostalAddressLintReason };

/** LIGHT lint only (§7.5): non-empty, >=2 NON-EMPTY lines, and a postal code on
 *  the LAST non-empty line (so "12345 Elm St" is a street number, not a ZIP).
 *  US-first by decision — do NOT add structured international address
 *  validation; the spec names it a trap. Normalization is minimal because the
 *  address is baked into the footer VERBATIM: CRLF -> LF, strip per-line
 *  trailing whitespace, drop empty lines at the edges, trim. Nothing else. */
export function lintPostalAddress(raw: string): PostalAddressLintResult;

export type AttestPostalAddressResult =
  | { status: 'attested' }
  | { status: 'invalid'; reason: PostalAddressLintReason }
  | { status: 'actor_not_in_account' }
  | { status: 'business_not_found' };

/** Takes the RAW address and lints internally, so there is no code path that
 *  writes an unlinted address.
 *
 *  ONE UPDATE, scoped by business id AND account_id, AND carrying the actor
 *  membership predicate — `_attested_by_user_id` has no FK (093's lesson), so
 *  nothing else stops a caller stamping an arbitrary or cross-tenant UUID as
 *  legal provenance. The digest is computed SERVER-SIDE from the same bound
 *  parameter the column stores, so it cannot disagree with what the CHECK
 *  recomputes.
 *
 *  On zero rows updated, one read-only diagnostic SELECT classifies the failure
 *  for the caller's status code. The security property lives entirely in the
 *  UPDATE's predicates; the diagnostic only picks a string. */
export async function attestPostalAddress(
  sql: Sql | TransactionSql,
  params: { accountId: string; businessId: string; userId: string; address: string },
): Promise<AttestPostalAddressResult>;
```

The write, spelled out because its predicates are the whole security story:

```ts
const updated = await sql`
  UPDATE businesses
  SET solicitation_postal_address                       = ${normalized},
      solicitation_postal_address_attested_at           = NOW(),
      solicitation_postal_address_attested_by_user_id   = ${userId}::uuid,
      solicitation_postal_address_attestation_version   = ${POSTAL_ADDRESS_ATTESTATION_VERSION},
      solicitation_postal_address_attested_digest       =
        encode(sha256(convert_to(${normalized}::text, 'UTF8')), 'hex'),
      updated_at = NOW()
  WHERE id = ${businessId}::uuid
    AND account_id = ${accountId}::uuid
    AND EXISTS (
      SELECT 1 FROM users
      WHERE id = ${userId}::uuid AND account_id = ${accountId}::uuid
    )
  RETURNING id
`;
```

Read model and rule:

```ts
export interface PostalAddressState {
  address: string | null;
  attestedAt: string | null;
  attestationVersion: string | null;
  /** google_place_address, offered as an editable SUGGESTION only when no
   *  attested address exists. Never written silently (§7.5). */
  suggestion: string | null;
}

/** Account-scoped: a business outside `accountId` returns null, never a row. */
export async function readPostalAddressState(
  sql: Sql,
  params: { accountId: string; businessId: string },
): Promise<PostalAddressState | null>;

export type SendHandoffWithheldReason = 'postal_address_missing' | 'owner_email_bounced';

/** First-match precedence, mirroring closedGateReason (batch-builder.ts:130).
 *  Postal address first: it is the CAN-SPAM one. Pure — the caller supplies the
 *  row it already loaded. */
export function sendHandoffWithheldReason(row: {
  solicitation_postal_address_attested_at: Date | string | null;
  owner_email_bounced: boolean | null;
}): SendHandoffWithheldReason | null;
```

- [ ] **Step 2: Run the two suites**

```bash
pnpm vitest run src/lib/solicitation/__tests__/postal-address.test.ts          # gate guard still RED, 5 lint PASS
pnpm vitest run src/lib/solicitation/__tests__/postal-address.integration.test.ts   # 7 PASS
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(#656): postal-address domain module — lint, byte-bound attestation, read model"
```

---

## Task 4: `PUT /api/settings/postal-address`

**Blocking edge:** T3. **Turns green:** the nine route tests. **Independent of T6, T7, T8, T9.**

- [ ] **Step 1: Read the precedents — both of them**

- **Shape:** `src/app/api/settings/competitors/route.ts` — `z.strictObject`, one module call, `jsonResponse`, `export const PUT = withSameOrigin()(handler)`, `reportCaughtError` + 500 fallback.
- **Auth:** `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts` — the `resolveOwnerScope` + `ScopeError` mapping shape.

Then re-read **"Design decisions this revision locks" #2** above. Do **not** reach for `requireSettingsOwner`: it resolves no location and deliberately skips the writable-subscription gate.

- [ ] **Step 2: Write the route — orchestration only**

```ts
const UpdatePostalAddressSchema = z.strictObject({
  address: z.string().min(1).max(500),
  attestationVersion: z.literal(POSTAL_ADDRESS_ATTESTATION_VERSION),
  attested: z.literal(true),
});
```

`strictObject` is load-bearing: a client-supplied `businessId` or `userId` must be a **400**, never a silently ignored field. Both facts are server-derived from the session — the location from the `rw_location_scope` cookie, the attester from `users.id`. A body that could name either is a tenant-selection knob.

An unchecked box is a 400, never a silent skip. An unknown `attestationVersion` is a 400 **before any write** — a client must never assent to one text while the server records another.

```ts
async function putPostalAddress(request: NextRequest): Promise<NextResponse> {
  let scope;
  try {
    scope = await resolveOwnerScope(sql, request);     // { accountId, locationId, userId }
  } catch (error) {
    if (error instanceof ScopeError) {
      return jsonResponse({ error: error.message }, error.statusCode);
    }
    throw error;
  }

  // resolveOwnerScope gates the SUBSCRIPTION, not offboarding — and the two come
  // apart: `delete_data/pending` is operationally blocked while the subscription
  // is still `active`. Without this the owner can edit the sender address
  // mid-teardown. Same shape as the draft route (:103-106).
  const offboardingState = await getOffboardingState(scope.accountId, sql);
  if (isOperationalUIBlocked(offboardingState)) {
    return jsonResponse({ error: 'account_offboarding_blocked' }, 403);
  }

  // … parse body → attestPostalAddress(sql, {
  //      accountId: scope.accountId,
  //      businessId: scope.locationId,   // cookie-resolved, NOT the primary location
  //      userId: scope.userId,           // users.id, NOT the Supabase Auth UID
  //      address: parsed.data.address,
  //    })
}

export const PUT = withSameOrigin()(putPostalAddress);
```

The offboarding read runs **before** the body parse and before any write, and its test asserts zero writes like every other rejection.

Map the result: `attested` → 200, `invalid` → 400 with `reason`, `actor_not_in_account` → 403, `business_not_found` → 404. No business logic in the handler (working rule: entry points orchestrate).

- [ ] **Step 3: Run and commit**

```bash
pnpm vitest run src/app/api/settings/postal-address/__tests__/route.test.ts   # 9 PASS
git add -A && git commit -m "feat(#656): PUT /api/settings/postal-address attestation route"
```

---

## Task 5: Settings surface on `settings/profile`

**Blocking edge:** T4. **Turns green:** the six UI tests.

Per deviations D3 this does **not** touch `/api/settings`, `useSettingsForm`, or `ProfilePanel`. The page server-fetches and passes a prop; the new panel is a sibling of `ProfilePanel`.

- [ ] **Step 1: Invoke the `repworth-brand-design` skill** before writing any JSX. Read `src/components/dashboard/settings/BrandVoicePanel.tsx` for the panel shape and `set-section` conventions.

- [ ] **Step 2: Server-fetch in `page.tsx`**

`settings/profile/page.tsx` currently **discards** the guard's return (`await requireOwnerAccess(sql);`). Destructure it:

```tsx
const { accountId, currentLocationId } = await requireOwnerAccess(sql);
const postalAddress = await readPostalAddressState(sql, {
  accountId,
  businessId: currentLocationId,     // cookie-resolved via getRequestScope
});
```

and pass `postalAddress` into `ProfileClient`. `page.tsx` is a composition root, so importing `sql` here is correct (invariant #15). This is the pattern `settings/locations/page.tsx` already uses.

**`currentLocationId`, never the account primary location.** In a multi-location account the two differ, and the panel would then show one location's address while the route wrote another's.

- [ ] **Step 3: `SolicitationAddressPanel.tsx`**

Props: `{ state: PostalAddressState }`. Behavior the tests pin:
- When `state.address` is null and `state.suggestion` is non-null, the textarea renders **prefilled with the suggestion**, editable, and **nothing is submitted** until the owner acts.
- The submit control is **disabled until the attestation checkbox is checked**, and the checkbox label is `POSTAL_ADDRESS_ATTESTATION_TEXT` imported verbatim — never a hand-copied string.
- Editing a saved address **clears the checkbox and re-arms the requirement** — an edit is a re-attestation, matching the schema's digest CHECK.
- Lint failures returned by the route render the reason inline.

- [ ] **Step 4: Run, build, commit**

```bash
pnpm vitest run src/components/dashboard/settings/__tests__/solicitation-address-panel.test.tsx   # 5 PASS
pnpm vitest run "src/app/(authenticated)/settings/profile/__tests__/ProfileClient.test.tsx"       # +1 PASS
pnpm build
git add -A && git commit -m "feat(#656): postal address attestation panel on settings/profile"
```

---

## Task 6: Send-handoff precondition + log field

**Blocking edge:** T3. **Turns green:** the ten send-handoff tests + the worker log test. **Independent of T4, T7, T8, T9.**

> The watch-mode decision — withhold the **Send handoff**, never the build — is recorded on **ticket #656** and **wayfinder map #617**, and **T9** writes it into the spec directory. §7.6 point 1's "no batch produced" predates the shared watch/send builder. It is **not** in the deviations file.

- [ ] **Step 1: Widen the SELECT the builder already runs**

`batch-builder.ts:705` already loads a business row. Add two columns to it — **no new query**, and both tenant predicates stay:

```ts
const [business] = await tx<{
  category: string | null;
  owner_email_bounced: boolean | null;
  solicitation_postal_address_attested_at: Date | null;
}[]>`
  SELECT category, owner_email_bounced, solicitation_postal_address_attested_at
  FROM businesses
  WHERE id = ${businessId}::uuid
    AND account_id = ${accountId}::uuid
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

`summarize()` (`:515`) currently returns `BuiltSolicitationBatchResult` and knows nothing about the business row. Keep it pure over decisions: give it the return type `Omit<BuiltSolicitationBatchResult, 'sendHandoff'>` and have `constructBatch` return `{ ...summary, sendHandoff }`.

**Not** a `withheldByReason` entry — that map is per-candidate and its keys are the closed `WITHHOLD_REASONS` enum (see Glossary).

- [ ] **Step 3: Gate the handoff at `:766`**

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

Still inside the `built_at` CAS transaction (invariant #2) — an enqueue failure must roll the whole build back.

- [ ] **Step 4: Add the log field**

`worker/jobs/solicitation-batch/index.ts` — one field on the existing `'solicitation batch build finished'` object, in the `status === 'built'` branch only:

```ts
send_handoff: result.sendHandoff,
```

No PII: the value is a status and a reason code. Do not log the address. The emitter is the **worker**, not `batch-builder.ts`, which returns results and deliberately does no logging (deviations D4).

- [ ] **Step 5: Repair the fixtures this task necessarily breaks**

Both are exact-match assertions that widening the shape invalidates. This is not optional cleanup — the suites go red without it.

1. `worker/jobs/solicitation-batch/__tests__/index.test.ts:100` asserts the log object with `toHaveBeenCalledWith(...)` — an **exact** object. Add `send_handoff` to it, and add the new promised test (`the solicitation batch worker logs the send handoff status and location-level reason`) covering the withheld case.
2. `src/lib/solicitation/__tests__/batch-builder.test.ts` — `pushConstructionPreamble()` pushes `mkTaggedResult([{ category: 'automotive' }])` at ~:426, ~:594 and ~:773. Those rows must gain `owner_email_bounced: false` and a non-null `solicitation_postal_address_attested_at`; otherwise the existing test *"enqueues generate_solicitation_asks inside the built_at transaction after the CAS when the flag is on"* (~:663) sees `undefined` for both, withholds, and fails.

3. `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` — the shared `beforeAll` business fixture (~:365-374) inserts **no** postal address, and *"flag-on build with send asks enqueues one generation row and the real 091 index dedups a second enqueue"* (~:508) asserts `generationRows` has length 1. Under the new gate that build is **withheld**, so the assertion sees zero rows. Attest the fixture before the flag-on build, and reset all five attestation columns plus `owner_email_bounced` between cases so the new withheld-path tests do not leak state into it.

The integration suite's **result-shape** assertions use `toMatchObject` (verified at :453, :515, :552), so they tolerate the new `sendHandoff` field — do not "fix" those. It is the **enqueue** assertion inside that same test that breaks, not the shape assertion; keep the distinction straight while editing.

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run src/lib/solicitation/__tests__/batch-builder.test.ts
pnpm vitest run src/lib/solicitation/__tests__/batch-builder.integration.test.ts
pnpm vitest run worker/jobs/solicitation-batch/__tests__/index.test.ts
git add -A && git commit -m "feat(#656): withhold the send handoff without an attested postal address"
```

---

## Task 7: Retire the `to_jsonb` shim

**Blocking edge:** T2. **Turns green:** the ask-generation test. **Independent of T4, T5, T6, T8, T9.**

This is a **deletion** task — net-negative by design.

- [ ] **Step 1: Replace the shim at `ask-generation.ts:188-193`**

Delete the six-line comment block and the `to_jsonb(b) ->> 'solicitation_postal_address' AS postal_address` projection; replace with `b.solicitation_postal_address AS postal_address`. No fallback, no compatibility branch — the column exists as of T2, and this is a pre-launch codebase with no external consumer (anti-slop rule).

> The comment cites **#627** as the migration that would land the column; **#656** is the ticket that actually does. The shim's purpose is unchanged — delete it, don't correct it.

- [ ] **Step 2: Run and commit**

```bash
pnpm vitest run src/lib/solicitation/__tests__/ask-generation.integration.test.ts
git add -A && git commit -m "refactor(#656): direct postal-address column read, retiring the to_jsonb shim"
```

---

## Task 8: Offboarding purge

**Blocking edge:** T2. **Turns green:** the three purge tests. **Independent of T4, T5, T6, T7, T9.**

- [ ] **Step 1: Extend the existing `businesses` SET**

`purge-stages.ts` already NULLs `google_place_address` in one account-scoped `UPDATE businesses … WHERE account_id = …` (~:655-682). Add the five columns to **that same statement** — all five together, or the all-or-nothing CHECK rejects the row:

```sql
          solicitation_postal_address = NULL,
          solicitation_postal_address_attested_at = NULL,
          solicitation_postal_address_attested_by_user_id = NULL,
          solicitation_postal_address_attestation_version = NULL,
          solicitation_postal_address_attested_digest = NULL,
```

The statement is already `WHERE account_id = ${row.account_id}::uuid` — every location in the account, never across tenants. Do not add a second statement.

- [ ] **Step 2: Run and commit**

```bash
pnpm vitest run worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
git add -A && git commit -m "feat(#656): purge clears the attested postal address"
```

---

## Task 9: Record the §7.6.1 / §2.4 override in the spec directory

**Blocking edge:** T1 only. **Independent of T2–T8.** Turns no test green — and that is exactly why it is a task rather than a footnote.

Round-1 finding 4: the decision to withhold the **Send handoff** rather than block batch construction was agreed with the owner and recorded on **ticket #656** and **map #617** — but nowhere in `docs/superpowers/specs/`. A reader of the locked spec still gets "no batch produced". That is the **#643 lesson** in a new shape: a binding decision living outside the spec directory.

- [ ] **Step 1:** Add a binding entry to `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`, in the file's existing amendment format, stating:
  - **Overrides:** `2026-07-28-sender-deliverability-design.md` §7.6 point 1 ("no batch produced") and the §2.4 `owner_email_bounced` interaction.
  - **New rule:** `buildSolicitationBatch` is ONE builder shared by watch-mode and send-mode. The postal-address / bounced-email precondition withholds the **Send handoff** at `batch-builder.ts:766`; the batch still builds and the Spoilage report is unchanged. "No batch produced" predates the shared builder.
  - **Why not a Withhold reason:** the enum is closed, precedence-ordered and versioned by `RESTRAINT_POLICY_VERSION`; every member is a per-candidate reason and this is one per-location fact.
  - **Provenance:** ticket #656, wayfinder map #617, owner call 2026-08-03.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs(#656): record the send-handoff override of spec §7.6.1/§2.4"
```

---

## Task 10: Domain sweep + docs

**Blocking edge:** T2–T9 complete.

- [ ] **Step 1:** Add **Attested postal address** and **Send handoff** to `CONTEXT.md` under "Solicitation (send-mode)", using this plan's Glossary section verbatim including the `_Avoid_` lines and a `*(coined in #656)*` attribution.
- [ ] **Step 2:** Add `src/lib/solicitation/postal-address.ts`, `src/app/api/settings/postal-address/route.ts` and `src/components/dashboard/settings/SolicitationAddressPanel.tsx` to `docs/directory.md`.
- [ ] **Step 3:** Confirm `.claude/reference/migrations-log.md` head reads **099** (T2 did this — verify, don't duplicate).
- [ ] **Step 4:** Run `pnpm ci:tenant-scope`. **Only if it fails**, append the minimum entries to `scripts/ci/tenant-scope-allowlist.ts` and **recompute `ALLOWLIST_BASELINE` from the actual entry count** — never reuse #645's number (deviations D2). Expected: no entries needed, since this feature adds columns to `businesses` rather than a new table, and every new read carries both predicates.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(#656): glossary terms, code map, migrations-log"
```

---

## Task 11: Final verification — no pending tests, gate green

**Blocking edge:** T10. **Runs alone, last.** Turns green: `every #656 promised test is executable with zero pending cases`.

The gate's `promised-tests` row matches titles, and `it.todo` satisfies it. Without this task the branch can present 47 green rows with the feature absent.

- [ ] **Step 1: Zero pending**

```bash
pnpm vitest run src/lib/solicitation/__tests__/postal-address.test.ts
```
The guard test must now PASS. If it fails, it names the file and title still holding a `todo`/`skip` — convert it, do not delete it.

- [ ] **Step 2: Full gate in review mode**

```bash
bash scripts/verify-gate.sh --review
```

`TEST_DATABASE_POOL_URL` **must be set**. This branch is `db_touching: true`; a SKIP row on the live-DB suites is not review-ready (#520 class — an existing-but-not-run suite is how that defect shipped). Run the DB-touching suites explicitly if the gate reports a skip:

```bash
pnpm vitest run src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts \
                src/lib/solicitation/__tests__/postal-address.integration.test.ts \
                src/lib/solicitation/__tests__/batch-builder.integration.test.ts \
                src/lib/solicitation/__tests__/ask-generation.integration.test.ts \
                worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
```

- [ ] **Step 3:** Record the gate result in `.feature/gate-status.json` (the script does this) and run `bash scripts/feature-state.sh set-phase gate_green`.

- [ ] **Step 4: Commit** (only if step 1 or 2 required edits)

```bash
git add -A && git commit -m "test(#656): final verification — zero pending, gate green"
```

---

## Self-review

**Spec coverage.** §7.5 columns + no-`google_place_address` rationale → T2, T3. §7.5 attestation checkbox + editable prefill → T4, T5. §7.5 light lint / no international validation → T3. §7.6 point 1 (as overridden) → T6, **recorded in the spec directory by T9**. §2.4 `owner_email_bounced` → T6. Purge interaction (§7.5's "not even a stable field") → T8. §7.6 points 2 and 3 are **out of scope** by intake — #628 and #630 own them.

**Round-1 findings, disposition.** All eleven ACCEPTED findings are actioned: digest column (#3 → T2/T3, and its own promised test); route auth against the real helpers (#5 → design decision 2, T4, T5); actor validation without an FK (#6 → T3); `it.todo` gate integrity (#7 → T1 step 2, T11); broken fixtures (#8 → T6 step 5); schema requirement (#9 → T2 step 4); pre-T2 098 check (#10 → T2 step 1); dependency graph + the "two new test files" contradiction (#11 → graph, file table). Findings #1 and #2 (v1's `098` test titles and the missing surface entries) were fixed by the **intake v2 re-issue**, which is why this plan has 47 promised tests (v2 had 46; round 2 added the offboarding refusal) and needs no SURFACE amendment. The four miscitations are corrected in place: the watch-mode decision cites **#656/#617 and T9**, not D2; the offboarding suite has **no existing `google_place_address` assertion**; there is **no flag-stubbing helper**; `acquireLiveDbLock` is in **`helpers/live-db-lock.ts`**. The REJECTED finding (`subagent-driven-development` / `executing-plans` "do not exist" — they are user-level skills; codex searched only the repo) is not actioned.

**Placeholder scan.** No TBDs. Every code step carries real code or a named precedent file verified to exist. The two places showing signatures rather than bodies (T3's module, T5's panel) pin the exact exported names, types and asserted behaviors, and the T1 tests are the executable spec for both.

**Type consistency.** `PostalAddressLintReason` / `PostalAddressLintResult` / `AttestPostalAddressResult` / `PostalAddressState` / `SendHandoffWithheldReason` are defined once in T3 and used unchanged in T4, T5, T6. `POSTAL_ADDRESS_ATTESTATION_VERSION` is the same literal in T2's SQL fixture, T3's constant and T4's zod schema. All five column names are identical across T2, T3, T6, T7, T8 and the schema requirement.

**Known gap, deliberate:** nothing in this plan surfaces the withheld reason in owner UI on the Requests surface — that is #629's, per the intake's non-goals. The owner's only path today is the settings panel plus the worker log.

---

## Review appendix

| Round | Reviewer | Verdict | Artifacts |
|---|---|---|---|
| 1 | `codex exec`, read-only sandbox | **REVISE** — 3 Critical, 5 High, 2 Medium, 1 Low; 11 ACCEPT / 1 REJECT | `plan-review-round1-codex.md` + `-triage.md` |
| 2 | `codex exec`, read-only sandbox, verification-only | **REVISE** — 7/11 findings ADDRESSED, 3 PARTIAL, 1 NOT; 4 defects introduced by fixes; all 4 miscitations corrected; all 12 new citations verified | `plan-review-round2-codex.md` + `-triage.md` |
| 3 | *(pending — verification-only, final round)* | | |

Rounds 2 and 3 are **verification-only** under feature.md's cap: each verifies the prior round's findings are addressed and may flag a defect a fix introduced, but may **not** open new fronts against unchanged plan sections. `planReviewRounds` is cumulative across sessions and lives in `.feature/state.json` — round 3 is the cap, and this branch is `RISK=high`, so a disagreement surviving round 3 escalates to the owner rather than being decided by the runner.

**Round-2 dispositions applied to this document:** defect 2 (offboarding block) → "Design decisions" #2 rewritten and T4 Step 2 gains the explicit gate; defect 3 (third broken fixture) → T6 Step 5 item 3; defect 4 (`convert_to` is STABLE) → T2 Step 3 migration comment; finding 10 (non-blocking pre-flight) → T2 Step 1 rewritten with `exit 1`. Defect 1's **fact** is accepted and the guarantee narrowed in "Design decisions" #1; its suggested **remedy** (a trigger) is escalated to the owner, not applied.
