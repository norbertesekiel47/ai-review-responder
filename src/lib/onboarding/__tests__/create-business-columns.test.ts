import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
  type RecordedSqlCall,
} from '../../../../worker/__tests__/helpers/mock-sql';

// Distinct, ordered ids so every uuid column is pinned to the RIGHT id
// (owner_user_id = the users row id, not the business id). createBusinessTx
// draws them in the order businessId, userId, accountId, then the admin
// enrollment row id.
let uuidCounter = 0;
vi.mock('uuid', () => ({ v7: vi.fn(() => `uuid-${++uuidCounter}`) }));

import {
  createBusinessTx,
  PLACEHOLDER_BUSINESS_NAME,
} from '../create-business';
import { resetServerConfigForTests } from '@/lib/config/server';

/**
 * Characterization suite (#1356). Pins, for BOTH createBusinessTx modes, the
 * exact column → value mapping of every row the transaction writes, so the
 * admin and self-serve inserts can share one column list without a silent
 * wrong-column write. `businesses.onboarded_by` (Admin invite marker — trial
 * eligibility, Beta comp coupon, CleanupAbandonedSignupsPoller scope) and the
 * accounts billing snapshot (invariant #9a) are the high-consequence columns.
 *
 * A column maps to `{ sql, value }` when bound (`sql` keeps any cast, e.g.
 * `?::uuid`) and to `{ sql }` when it is a literal in the statement text.
 */

type Cell = { sql: string; value?: unknown };
interface InsertRow {
  table: string;
  columns: Record<string, Cell>;
  /** Anything after the VALUES tuple (e.g. an ON CONFLICT clause), whitespace-collapsed. */
  tail: string;
  inTransaction: boolean;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Returns [inner, indexAfterClose] for the paren group opening at `open`. */
function parenGroup(text: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return [text.slice(open + 1, i), i + 1];
    }
  }
  throw new Error(`unbalanced parens in: ${text}`);
}

function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

function parseInsert(call: RecordedSqlCall): InsertRow {
  const { text } = call;
  const head = /INSERT INTO (\w+)\s*\(/.exec(text);
  if (!head) throw new Error(`not an INSERT: ${text}`);
  const [columnList, afterColumns] = parenGroup(text, head.index + head[0].length - 1);
  const valuesAt = text.indexOf('(', text.indexOf('VALUES', afterColumns));
  const [valueList, afterValues] = parenGroup(text, valuesAt);

  const names = splitTopLevel(columnList);
  const items = splitTopLevel(valueList);
  expect(items).toHaveLength(names.length);

  const bound = [...call.values];
  const columns: Record<string, Cell> = {};
  names.forEach((name, i) => {
    const sql = items[i] ?? '';
    const placeholders = (sql.match(/\?/g) ?? []).length;
    expect(placeholders).toBeLessThanOrEqual(1);
    columns[name] = placeholders === 1 ? { sql, value: bound.shift() } : { sql };
  });
  // Every bound value was consumed by the VALUES tuple.
  expect(bound).toEqual([]);

  return {
    table: head[1] ?? '',
    columns,
    tail: squash(text.slice(afterValues)),
    inTransaction: call.inTransaction,
  };
}

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  uuidCounter = 0;
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  vi.useFakeTimers();
  vi.stubEnv('FOUNDING_DEADLINE', '2027-01-01T00:00:00Z');
  vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', 'price_copilot_list');
  vi.stubEnv('STRIPE_PRICE_COPILOT_FOUNDING', 'price_copilot_founding');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_LIST', 'price_autopilot_list');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_FOUNDING', 'price_autopilot_founding');
  vi.stubEnv('STRIPE_PRICE_COPILOT_OVERAGE', 'price_copilot_overage');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_OVERAGE', 'price_autopilot_overage');
  // At the deadline instant → 'list' price variant.
  vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
  resetServerConfigForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetServerConfigForTests();
});

const BUSINESS_ID = 'uuid-1';
const USER_ID = 'uuid-2';
const ACCOUNT_ID = 'uuid-3';

function accountsRow(displayName: string): InsertRow {
  return {
    table: 'accounts',
    columns: {
      id: { sql: '?::uuid', value: ACCOUNT_ID },
      owner_user_id: { sql: '?::uuid', value: USER_ID },
      display_name: { sql: '?', value: displayName },
      subscription_tier: { sql: '?', value: 'copilot' },
      price_variant: { sql: '?', value: 'list' },
      subscription_status: { sql: '?', value: 'pending_payment' },
      base_price_cents: { sql: '?', value: 7900 },
      locations_overage_price_cents: { sql: '?', value: 7900 },
      locations_included: { sql: '?', value: 1 },
      locations_paid: { sql: '?', value: 0 },
    },
    tail: '',
    inTransaction: true,
  };
}

function businessesRow(v: {
  name: string;
  ownerName: string;
  ownerPhone: string | null;
  onboardedBy: string | null;
}): InsertRow {
  return {
    table: 'businesses',
    columns: {
      id: { sql: '?::uuid', value: BUSINESS_ID },
      account_id: { sql: '?::uuid', value: ACCOUNT_ID },
      is_primary: { sql: 'TRUE' },
      name: { sql: '?', value: v.name },
      category: { sql: '?', value: null },
      google_place_id: { sql: '?', value: null },
      place_id_verified: { sql: '?', value: false },
      google_maps_url: { sql: '?', value: null },
      tone: { sql: '?', value: 'professional and friendly' },
      products_services: { sql: '?', value: null },
      staff_names: { sql: '?', value: [] },
      highlight_facts: { sql: '?', value: [] },
      avoid_facts: { sql: '?', value: [] },
      sample_responses: { sql: '?', value: [] },
      owner_name: { sql: '?', value: v.ownerName },
      owner_email: { sql: '?', value: 'owner@example.com' },
      owner_phone: { sql: '?', value: v.ownerPhone },
      subscription_tier: { sql: '?', value: 'copilot' },
      subscription_status: { sql: '?', value: 'pending_payment' },
      website: { sql: '?', value: null },
      onboarded_by: { sql: '?', value: v.onboardedBy },
    },
    tail: '',
    inTransaction: true,
  };
}

function usersRow(v: { authId: string | null; name: string; phone: string | null }): InsertRow {
  return {
    table: 'users',
    columns: {
      id: { sql: '?::uuid', value: USER_ID },
      auth_id: { sql: '?', value: v.authId },
      name: { sql: '?', value: v.name },
      email: { sql: '?', value: 'owner@example.com' },
      phone: { sql: '?', value: v.phone },
      role: { sql: "'owner'" },
      account_id: { sql: '?::uuid', value: ACCOUNT_ID },
    },
    tail: '',
    inTransaction: true,
  };
}

describe('createBusinessTx — column → value characterization (#1356)', () => {
  it('admin mode writes exactly accounts, businesses, users, channel_enrollments in one transaction', async () => {
    const res = await createBusinessTx(
      mockSql,
      { ownerEmail: '  Owner@Example.COM ', ownerName: 'Jane Owner', businessName: 'Acme Bakery' },
      { mode: 'admin', onboardedBy: 'admin-user-7' },
    );

    expect(harness.mockSql.begin).toHaveBeenCalledTimes(1);
    expect(harness.sqlCalls.map(parseInsert)).toEqual([
      accountsRow('Acme Bakery'),
      businessesRow({
        name: 'Acme Bakery',
        ownerName: 'Jane Owner',
        ownerPhone: null,
        onboardedBy: 'admin-user-7',
      }),
      usersRow({ authId: null, name: 'Jane Owner', phone: null }),
      {
        table: 'channel_enrollments',
        columns: {
          id: { sql: '?::uuid', value: 'uuid-4' },
          account_id: { sql: '?::uuid', value: ACCOUNT_ID },
          business_id: { sql: '?::uuid', value: BUSINESS_ID },
          channel: { sql: "'email'" },
          handle: { sql: '?', value: 'owner@example.com' },
          status: { sql: "'verified'" },
          verified_at: { sql: 'NOW()' },
        },
        tail:
          "ON CONFLICT (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL DO NOTHING",
        inTransaction: true,
      },
    ]);
    expect(res).toMatchObject({ businessId: BUSINESS_ID, userId: USER_ID, accountId: ACCOUNT_ID });
  });

  it('self_serve mode writes exactly accounts, businesses, users in one transaction (no enrollment)', async () => {
    const res = await createBusinessTx(
      mockSql,
      { ownerEmail: 'OWNER@example.com', ownerName: 'Sam Self', ownerPhone: '+15551234567' },
      { mode: 'self_serve', authId: 'auth-abc' },
    );

    expect(harness.mockSql.begin).toHaveBeenCalledTimes(1);
    expect(harness.sqlCalls.map(parseInsert)).toEqual([
      accountsRow(PLACEHOLDER_BUSINESS_NAME),
      businessesRow({
        name: PLACEHOLDER_BUSINESS_NAME,
        ownerName: 'Sam Self',
        ownerPhone: '+15551234567',
        onboardedBy: null,
      }),
      usersRow({ authId: 'auth-abc', name: 'Sam Self', phone: '+15551234567' }),
    ]);
    expect(res).toMatchObject({ businessId: BUSINESS_ID, userId: USER_ID, accountId: ACCOUNT_ID });
  });

  it('self_serve mode without a phone writes NULL to both phone columns', async () => {
    await createBusinessTx(
      mockSql,
      { ownerEmail: 'owner@example.com', ownerName: 'Sam Self' },
      { mode: 'self_serve', authId: 'auth-abc' },
    );
    const [, businesses, users] = harness.sqlCalls.map(parseInsert);
    expect(businesses?.columns.owner_phone).toEqual({ sql: '?', value: null });
    expect(users?.columns.phone).toEqual({ sql: '?', value: null });
  });

  it('founding window writes the founding Copilot snapshot on accounts (both modes)', async () => {
    vi.setSystemTime(new Date('2026-12-31T23:59:59Z'));
    await createBusinessTx(
      mockSql,
      { ownerEmail: 'owner@example.com', ownerName: 'Jane', businessName: 'Acme' },
      { mode: 'admin', onboardedBy: 'admin-1' },
    );
    uuidCounter = 0;
    await createBusinessTx(
      mockSql,
      { ownerEmail: 'owner@example.com', ownerName: 'Sam' },
      { mode: 'self_serve', authId: 'auth-abc' },
    );
    const accounts = harness.sqlCalls.map(parseInsert).filter((r) => r.table === 'accounts');
    expect(accounts).toHaveLength(2);
    for (const row of accounts) {
      expect(row.columns.price_variant).toEqual({ sql: '?', value: 'founding' });
      expect(row.columns.subscription_tier).toEqual({ sql: '?', value: 'copilot' });
      expect(row.columns.base_price_cents).toEqual({ sql: '?', value: 4900 });
      expect(row.columns.locations_paid).toEqual({ sql: '?', value: 0 });
    }
  });
});
