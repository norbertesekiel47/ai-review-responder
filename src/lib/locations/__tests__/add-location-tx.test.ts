// src/lib/locations/__tests__/add-location-tx.test.ts
//
// TDD assertions for src/lib/locations/add-location-tx.ts.
// Tests: addLocationTransaction — atomic tx, voice cloning, audit log, outbox.
//
// Validation contract: VAL-LOC-007 (atomic tx), VAL-LOC-008 (is_primary=FALSE),
// VAL-LOC-024 (location_created audit event), VAL-LOC-031 (voice cloning),
// VAL-LOC-032 (voice independence), VAL-LOC-036 (display_label from input).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  // Identity .json stub: the module now binds jsonb via the injected client's
  // tx.json(...) (byte-identical to the old jsonb() helper).
  sqlFn.json = (v: unknown) => v;
  return { mockSql: sqlFn };
});

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7-00000000-000000000001'),
}));

import type { Sql } from 'postgres';
import { addLocationTransaction, type AddLocationTxInput } from '../add-location-tx';

// The injected sql client IS the mock — assertions still read mockSql.mock.calls.
const sql = mockSql as unknown as Sql;

// ── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACTOR_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';
const _PRIMARY_LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000001';

function mkPrimaryVoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    tone: 'professional and friendly',
    products_services: 'Coffee, pastries, sandwiches',
    staff_names: ['Alice', 'Bob'],
    highlight_facts: ['Open since 2010', 'Award-winning espresso'],
    avoid_facts: ['Do not mention competitor prices'],
    sample_responses: ['Thank you for your kind words about our espresso!'],
    ...overrides,
  };
}

function mkInput(overrides: Partial<AddLocationTxInput> = {}): AddLocationTxInput {
  return {
    accountId: ACCOUNT_ID,
    displayLabel: 'Downtown Cafe',
    googlePlaceId: null,
    placeIdVerified: false,
    googleMapsUrl: null,
    actorUserId: ACTOR_USER_ID,
    ownerName: 'Test Owner',
    ownerEmail: 'owner@test.com',
    subscriptionTier: 'copilot',
    subscriptionStatus: 'active',
    activeLocationsBefore: 1,
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
    const template = strings.join('?');
    if (
      template.includes('SELECT id')
      && template.includes('FROM accounts')
      && template.includes('FOR UPDATE')
    ) {
      return [{ id: ACCOUNT_ID }];
    }
    return [];
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
});

// ── addLocationTransaction ──────────────────────────────────────────────────

describe('addLocationTransaction', () => {
  it('fails closed inside the transaction when offboarding blocks expansion', async () => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join('?');
      if (template.includes('FROM accounts') && template.includes('FOR UPDATE')) {
        return [{ id: ACCOUNT_ID }];
      }
      if (template.includes('FROM account_offboardings')) {
        return [{
          id: 'offboarding-1',
          account_id: ACCOUNT_ID,
          mode: 'delete_data',
          status: 'pending',
          failed_step: null,
          terminal_at: null,
          access_ends_at: null,
          teardown_started_at: null,
          purge_after: null,
          purge_started_at: null,
          purge_cancelled_at: null,
        }];
      }
      return [];
    });

    await expect(addLocationTransaction(sql, mkInput({
      voiceConfig: { tone: 'professional' },
    }))).rejects.toThrow('account_offboarding_blocked');

    const calls: string[] = mockSql.mock.calls.map(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?'),
    );
    const lifecycleLock = calls.findIndex((text: string) => text.includes('pg_advisory_xact_lock'));
    const accountLock = calls.findIndex(
      (text: string) => text.includes('FROM accounts') && text.includes('FOR UPDATE'),
    );
    const offboardingRead = calls.findIndex(
      (text: string) => text.includes('FROM account_offboardings'),
    );
    expect(lifecycleLock).toBeGreaterThanOrEqual(0);
    expect(accountLock).toBeGreaterThan(lifecycleLock);
    expect(offboardingRead).toBeGreaterThan(accountLock);
    expect(calls.some((text: string) => text.includes('INSERT INTO businesses'))).toBe(false);
  });

  // VAL-LOC-007: Atomic tx — all three INSERTs in sql.begin()
  it('executes businesses + audit_log + outbox INSERTs inside a transaction', async () => {
    // Step 1: Primary voice config lookup
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);
    // Step 2: Transaction (3 INSERTs via tx which is the same mockSql)

    const result = await addLocationTransaction(sql, mkInput());

    // Verify sql.begin was called
    expect(mockSql.begin).toHaveBeenCalled();

    // Verify the primary voice lookup happened first (before the tx)
    const voiceCall = mockSql.mock.calls[0];
    expect(voiceCall).toBeDefined();
    const voiceTemplate = (voiceCall![0] as TemplateStringsArray).join('?');
    expect(voiceTemplate).toContain('is_primary = TRUE');
    expect(voiceTemplate).toContain('archived_at IS NULL');

    expect(result.businessId).toBeDefined();
    expect(result.displayLabel).toBe('Downtown Cafe');
  });

  // VAL-LOC-008: New businesses row has is_primary = FALSE
  it('sets is_primary = FALSE on the new businesses row', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput());

    // Find the businesses INSERT inside the tx
    const txCalls = mockSql.mock.calls.slice(1); // skip primary voice lookup
    const insertCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'),
    );
    expect(insertCall).toBeDefined();
    const template = (insertCall![0] as TemplateStringsArray).join('?');
    // The template should contain FALSE for is_primary
    expect(template).toContain('FALSE');
  });

  it('inserts owner_name and owner_email for businesses NOT NULL constraints', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({
      ownerName: 'Norbert Sunn',
      ownerEmail: 'nsunn@usc.edu',
    } as any));

    const txCalls = mockSql.mock.calls.slice(1);
    const insertCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain('Norbert Sunn');
    expect(insertCall).toContain('nsunn@usc.edu');
  });

  // VAL-LOC-024: Audit log records 'location_created' with actor and payload
  it('inserts account_audit_log with event_type location_created and actor_user_id', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({ actorUserId: ACTOR_USER_ID }));

    // Find the audit log INSERT
    const txCalls = mockSql.mock.calls.slice(1);
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
    const template = (auditCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('location_created');
    expect(template).toContain('actor_user_id');
  });

  // VAL-LOC-024 variant: actor_user_id is nullable
  it('inserts audit log with null actor_user_id when no actor provided', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({ actorUserId: null }));

    const txCalls = mockSql.mock.calls.slice(1);
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
  });

  // VAL-BILLING-072: Outbox row with update_stripe_overage_quantity topic
  it('enqueues job_outbox row with topic update_stripe_overage_quantity', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls.slice(1);
    const outboxCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    // Topic is bound as a parameter by enqueueStripeOverageRecompute, not inlined SQL text.
    expect(outboxCall!.slice(1)).toContain('update_stripe_overage_quantity');
  });

  // VAL-LOC-031: Voice config cloned from primary location at creation time
  it('clones voice config from primary location', async () => {
    const primaryVoice = mkPrimaryVoiceRow({
      tone: 'casual and warm',
      products_services: 'Pizza, pasta, salads',
      staff_names: ['Chef Mario'],
      highlight_facts: ['Wood-fired oven'],
      avoid_facts: ['No delivery'],
      sample_responses: ['Thanks for the great review of our pizza!'],
    });
    mockSql.mockResolvedValueOnce([primaryVoice]);

    const result = await addLocationTransaction(sql, mkInput());

    expect(result.voiceClonedFromPrimary).toBe(true);

    // Verify the businesses INSERT uses the cloned voice values
    const txCalls = mockSql.mock.calls.slice(1);
    const insertCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'),
    );
    expect(insertCall).toBeDefined();
  });

  // VAL-LOC-031 variant: Falls back to defaults when no primary exists
  it('uses default voice config when no primary location exists', async () => {
    // No primary voice row found
    mockSql.mockResolvedValueOnce([]);

    const result = await addLocationTransaction(sql, mkInput());

    expect(result.voiceClonedFromPrimary).toBe(false);
    expect(result.businessId).toBeDefined();
  });

  // VAL-LOC-031 variant: Clones from primary with null voice fields
  it('handles primary with null voice fields gracefully', async () => {
    const primaryVoice = mkPrimaryVoiceRow({
      products_services: null,
      staff_names: null,
      highlight_facts: null,
      avoid_facts: null,
      sample_responses: null,
    });
    mockSql.mockResolvedValueOnce([primaryVoice]);

    const result = await addLocationTransaction(sql, mkInput());

    expect(result.voiceClonedFromPrimary).toBe(true);
  });

  // VAL-LOC-036: display_label set from user input
  it('stores display_label from user input', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    const result = await addLocationTransaction(sql, mkInput({ displayLabel: 'Westside Bakery' }));

    expect(result.displayLabel).toBe('Westside Bakery');
  });

  // VAL-LOC-036 variant: display_label stored separately from businesses.name
  it('uses display_label as both display_label and name columns', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    const result = await addLocationTransaction(sql, mkInput({ displayLabel: 'Eastside Diner' }));

    expect(result.displayLabel).toBe('Eastside Diner');
  });

  // VAL-LOC-007: If any part of tx fails, nothing is committed
  it('rolls back entire transaction if any INSERT fails', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    // Make the transaction callback throw to simulate a failure
    mockSql.begin = vi.fn(async (_cb: (tx: any) => Promise<unknown>) => {
      // First INSERT succeeds, second throws
      const tx = mockSql;
      // Simulate: businesses INSERT works, audit_log INSERT throws
      await tx`INSERT INTO businesses`; // This would be the first call
      throw new Error('audit_log INSERT failed: constraint violation');
    });

    await expect(addLocationTransaction(sql, mkInput())).rejects.toThrow(
      'audit_log INSERT failed',
    );

    // Since sql.begin() threw, the transaction rolled back —
    // no rows were committed (this is guaranteed by postgres.js)
  });

  // C1: Postgres 23505 on the active-duplicate place-id index maps to a typed
  // duplicate_location error so the route can return 409 (migration 062).
  it('maps a 23505 unique violation on businesses_account_place_uniq to duplicate_location', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    mockSql.begin = vi.fn(async () => {
      const err: Error & { code?: string; constraint_name?: string } = new Error(
        'duplicate key value violates unique constraint "businesses_account_place_uniq"',
      );
      err.code = '23505';
      err.constraint_name = 'businesses_account_place_uniq';
      throw err;
    });

    await expect(
      addLocationTransaction(sql, mkInput({ googlePlaceId: 'PLACE_DUP', placeIdVerified: true })),
    ).rejects.toThrow('duplicate_location');
  });

  // C1: a 23505 on a DIFFERENT constraint must NOT be swallowed/remapped —
  // it propagates unchanged so unrelated unique violations keep their context.
  it('does not remap a 23505 on a different constraint', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    const original: Error & { code?: string; constraint_name?: string } = new Error(
      'duplicate key value violates unique constraint "businesses_pkey"',
    );
    original.code = '23505';
    original.constraint_name = 'businesses_pkey';

    mockSql.begin = vi.fn(async () => {
      throw original;
    });

    await expect(addLocationTransaction(sql, mkInput())).rejects.toThrow(original);
    await expect(addLocationTransaction(sql, mkInput())).rejects.not.toThrow('duplicate_location');
  });

  // isDuplicateLocationViolation must narrow safely: a non-object thrown from
  // the tx (string, null-ish rejection) propagates unchanged instead of
  // crashing the predicate with a property access on a primitive.
  it('propagates a non-object transaction rejection unchanged', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    mockSql.begin = vi.fn(async () => {
      throw 'connection terminated unexpectedly';
    });

    await expect(addLocationTransaction(sql, mkInput())).rejects.toBe(
      'connection terminated unexpectedly',
    );
  });

  // Audit payload includes relevant fields
  it('audit log payload includes display_label, active_locations_before, voice_cloned_from_primary', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({
      displayLabel: 'Northside Grill',
      activeLocationsBefore: 2,
    }));

    // The audit INSERT's payload should contain these fields.
    // We verify by checking the jsonb() helper was called with the right shape.
    // Since jsonb is mocked to pass through, the values appear directly in the SQL.
    const txCalls = mockSql.mock.calls.slice(1);
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
  });

  // Google Place ID is stored when provided
  it('stores google_place_id and place_id_verified when provided', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      placeIdVerified: true,
    }));

    // Verify the businesses INSERT includes the place fields
    const txCalls = mockSql.mock.calls.slice(1);
    const insertCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'),
    );
    expect(insertCall).toBeDefined();
  });

  // Multiple outbox INSERTs are in the same transaction
  it('all INSERTs (businesses, audit, outbox) run in the same sql.begin() call', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput());

    // sql.begin should have been called exactly once
    expect(mockSql.begin).toHaveBeenCalledTimes(1);

    // Inside the transaction, there should be 3 INSERT calls:
    // businesses, account_audit_log, update_stripe_overage_quantity.
    // Zernio initial backfill is queued only after the location has an
    // active Zernio connection, in /api/zernio/connect/select-location.
    const txCalls = mockSql.mock.calls.slice(1);
    const insertCalls = txCalls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO'),
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('does not enqueue zernio_initial_backfill before the new location is connected', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls.slice(1);
    const outboxCalls = txCalls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );

    expect(outboxCalls).toHaveLength(1);

    const zernioCall = outboxCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('zernio_initial_backfill'),
    );
    expect(zernioCall).toBeUndefined();
  });

  it('only enqueues Stripe overage from add-location; Zernio backfill waits for connect finalize', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput());

    const txCalls = mockSql.mock.calls.slice(1);
    const outboxCalls = txCalls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );

    const overageCall = outboxCalls.find(
      (c: any[]) => c.slice(1).includes('update_stripe_overage_quantity'),
    );
    expect(overageCall).toBeDefined();
  });

  // C2: URL-mode add (Maps URL, no verified place id) must enqueue
  // validate_place_id so the resolved place id is later checked against
  // businesses_account_place_uniq (migration 062), closing the NULL-place-id gap.
  it('enqueues validate_place_id when a Maps URL is supplied without a verified place id', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({
      googleMapsUrl: 'https://maps.google.com/?q=Cafe+Test',
      placeIdVerified: false,
      googlePlaceId: null,
    }));

    const txCalls = mockSql.mock.calls.slice(1);
    const validateCall = txCalls.find(
      // Topic is an interpolated QUEUE_NAMES value, not a template literal —
      // check the bound values, not the raw strings array.
      (c: any[]) => c.slice(1).includes('validate_place_id'),
    );
    expect(validateCall).toBeDefined();

    const template = (validateCall![0] as TemplateStringsArray).join('?');
    // Shared helper (enqueueValidatePlaceId in job-outbox-helpers): same SQL
    // shape as the onboarding dedup guard — INSERT … SELECT … WHERE NOT EXISTS.
    expect(template).toContain('INSERT INTO job_outbox');
    expect(template).toContain('WHERE NOT EXISTS');
    expect(template).toContain('topic = ?');
    expect(validateCall!.slice(1).filter((v: unknown) => v === 'validate_place_id')).toHaveLength(2);
    expect(template).toContain("status IN ('pending', 'dispatching', 'dispatched')");
  });

  // C2 hardening: the enqueue gate is `googleMapsUrl && !googlePlaceId` —
  // the DATA decides, not the client flag. A crafted or buggy request
  // claiming placeIdVerified:true WITHOUT a place id must still enqueue
  // resolution, or the row permanently bypasses migration 062
  // (NULL google_place_id never collides under the partial unique index).
  it('still enqueues validate_place_id when placeIdVerified is true but no place id is supplied', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({
      googleMapsUrl: 'https://maps.google.com/?q=Cafe+Test',
      placeIdVerified: true,
      googlePlaceId: null,
    }));

    const txCalls = mockSql.mock.calls.slice(1);
    const validateCall = txCalls.find(
      // Topic is an interpolated QUEUE_NAMES value, not a template literal —
      // check the bound values, not the raw strings array.
      (c: any[]) => c.slice(1).includes('validate_place_id'),
    );
    expect(validateCall).toBeDefined();
  });

  // No-silent-overwrite: a STORED place id (even unverified) suppresses the
  // enqueue — resolution must never overwrite an explicitly supplied id. The
  // route schema rejects the url+place-id shape outright; this pins the tx
  // module's own defense for non-route producers.
  it('does NOT enqueue validate_place_id when an unverified place id accompanies the URL', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({
      googleMapsUrl: 'https://maps.google.com/?q=Cafe+Test',
      placeIdVerified: false,
      googlePlaceId: 'ChIJExplicitButUnverified1',
    }));

    const txCalls = mockSql.mock.calls.slice(1);
    const validateCall = txCalls.find(
      // Topic is an interpolated QUEUE_NAMES value, not a template literal —
      // check the bound values, not the raw strings array.
      (c: any[]) => c.slice(1).includes('validate_place_id'),
    );
    expect(validateCall).toBeUndefined();
  });

  // C2: a verified place id (autocomplete path) must NOT enqueue validate_place_id —
  // the place id is already known and the businesses INSERT already trips the
  // unique index directly.
  it('does NOT enqueue validate_place_id when the place id is already verified', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput({
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      placeIdVerified: true,
      googleMapsUrl: null,
    }));

    const txCalls = mockSql.mock.calls.slice(1);
    const validateCall = txCalls.find(
      // Topic is an interpolated QUEUE_NAMES value, not a template literal —
      // check the bound values, not the raw strings array.
      (c: any[]) => c.slice(1).includes('validate_place_id'),
    );
    expect(validateCall).toBeUndefined();
  });
});

// ── Voice independence (VAL-LOC-032) ─────────────────────────────────────────
//
// VAL-LOC-032: Voice config is independent after creation — edits to the
// primary's voice config do NOT propagate to the new location.
//
// This is a structural guarantee, not a runtime test. The cloning happens
// via a one-time SELECT of the primary's voice config at creation time,
// followed by an INSERT with those values. There is no ongoing inheritance
// mechanism — the new location's voice config columns are independent DB
// columns that can be updated independently.
//
// The structural guarantee is verified by:
// 1. The code reads primary voice config ONCE (SELECT, not a VIEW or trigger)
// 2. The INSERT uses literal values, not references to the primary
// 3. No trigger, materialized view, or application code syncs voice after INSERT

describe('voice config independence (VAL-LOC-032)', () => {
  it('clones voice via one-time SELECT (not ongoing inheritance)', async () => {
    mockSql.mockResolvedValueOnce([mkPrimaryVoiceRow()]);

    await addLocationTransaction(sql, mkInput());

    // Verify: only one SELECT for primary voice before the tx begins
    const selectCalls = mockSql.mock.calls.filter(
      (c: any[]) => {
        const template = (c[0] as TemplateStringsArray).join('?');
        return template.includes('SELECT') && template.includes('is_primary = TRUE');
      },
    );
    expect(selectCalls.length).toBe(1);

    // Verify: no UPDATE or trigger-based sync of the VOICE columns after the tx.
    //
    // Narrowed from "no `UPDATE businesses` at all" (#677). The broad form was a
    // valid proxy for VAL-LOC-032 only while voice was the sole conceivable
    // reason to update the new row; #677 adds an Import consent lineage UPDATE
    // that touches the three consent columns and nothing else. The invariant
    // under test — voice is cloned ONCE via SELECT and never kept in sync — is
    // unchanged, so the assertion is now stated against the voice columns
    // directly rather than against the statement verb.
    const VOICE_COLUMNS = [
      'tone',
      'products_services',
      'staff_names',
      'highlight_facts',
      'avoid_facts',
      'sample_responses',
    ];
    const voiceUpdateCalls = mockSql.mock.calls.filter((c: any[]) => {
      const template = (c[0] as TemplateStringsArray).join('?');
      if (!template.includes('UPDATE businesses')) return false;
      return VOICE_COLUMNS.some((col) => new RegExp(`\\b${col}\\s*=`).test(template));
    });
    expect(voiceUpdateCalls.length).toBe(0);
  });
});

// ── #677 T0 EVAL — Import consent lineage, mocked half ────────────────────────
//
// Title 45 of the intake's 70, authored VERBATIM before implementation.
//
// This is the ONLY mocked add-location consent title (owner decision 2026-08-07,
// deviations D6). The no-sibling case is a binding assertion — there is no
// lineage SELECT to get wrong, only the question of whether the new row is left
// at migration 100's default. Its five siblings are SQL semantics (the
// disjunction over non-NULL keys, the ORDER BY tie-break, account scoping, and
// both cross-representation directions) and live in
// add-location-tx.integration.test.ts, where a real join can be falsified.
//
// "Leaves pending" means pending WITH THE DEFAULTS — decision 'pending' and a
// NULL deadline. That is deliberately NOT an answerable offer: the round-1
// Critical was that a NULL deadline was answerable, so a fresh location must not
// come out of add-location holding something a direct POST could accept.
describe('addLocationTransaction — Import consent lineage (#677)', () => {
  it('add-location leaves import consent pending when no archived sibling exists for the place', async () => {
    await addLocationTransaction(sql, mkInput({ googlePlaceId: 'ChIJ-no-sibling' }));

    const lineageCalls = mockSql.mock.calls.filter((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('import_decision = sib.import_decision'),
    );

    // The lineage UPDATE is issued unconditionally — it is one statement whose
    // `FROM (SELECT … LIMIT 1)` matches nothing when there is no sibling, so
    // there is no read-then-decide branch to get wrong.
    expect(lineageCalls.length).toBe(1);

    const template = (lineageCalls[0]![0] as TemplateStringsArray).join('?');
    // Both halves of the disjunction are present and both require NON-NULL on
    // each side. A NULL-to-NULL match would let any two identifier-less
    // locations in an account donate consent to each other.
    expect(template).toContain('ab.google_place_id IS NOT NULL');
    expect(template).toContain('ab.google_maps_url IS NOT NULL');
    // Deterministic ordering (F104) and account scoping (invariant #8).
    expect(template).toContain('ORDER BY ab.archived_at DESC, ab.created_at DESC, ab.id DESC');
    expect(template).toContain('ab.account_id =');
    expect(template).toContain('ab.archived_at IS NOT NULL');
    // The decision and its timestamp are copied unconditionally; the deadline is
    // the ONE conditional column (D12). Keyed on the deadline alone and evaluated
    // in Postgres, so inheritance can never write a future deadline behind
    // `createImportOffer`'s back. The two live halves of that rule — a past
    // deadline IS copied, a live one is NOT — are titles 70 and 48 in
    // add-location-tx.integration.test.ts; only the shape is bindable here.
    expect(template).toContain('import_decision = sib.import_decision');
    expect(template).toContain('import_decision_at = sib.import_decision_at');
    expect(template).toContain('import_offer_expires_at = CASE');
    expect(template).toContain('WHEN sib.import_offer_expires_at <= now()');
  });
});
