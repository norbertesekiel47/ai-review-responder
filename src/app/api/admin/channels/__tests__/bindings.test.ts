import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * This suite tests BINDINGS, not SQL: which resolver posture each of the six
 * admin shims wires up, which surface it resolves, and which deep-link builder
 * it reaches. Every enrollment helper is therefore mocked, which means the ONLY
 * query any route issues is the resolver's accounts join — exactly one per
 * request, provably, instead of a hand-counted fixture list that silently
 * absorbs a miscount. Exact SQL protocol is asserted in the runner suite
 * (`src/app/api/_shared/channels/__tests__/runners.test.ts`), which is the right
 * altitude for it; do not duplicate statement assertions here.
 */
// `record` lives inside vi.hoisted alongside the state it closes over: the
// vi.mock factory below dereferences it in its BODY (Object.assign(record, …)),
// and that body runs while the hoisted route imports resolve — before a plain
// top-level `const record` would have initialised. Deviation from the plan's
// literal code, recorded in the deviations file; behaviour is identical.
const { sqlLog, accountRow, record } = vi.hoisted(() => {
  const sqlLog: Array<{ raw: string; values: unknown[] }> = [];
  const accountRow = { current: [] as unknown[] };
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlLog.push({ raw: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve(accountRow.current);
  };
  return { sqlLog, accountRow, record };
});

vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(record, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(Object.assign(record, { json: (v: unknown) => v })),
  }),
  jsonb: (v: unknown) => v,
}));

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/admin-mfa-gate', () => ({
  requireAdminWithAal2: (...a: unknown[]) => requireAdminMock(...(a as [])),
}));

const startEnrollmentMock = vi.fn(async () => ({ kind: 'ok' as const }));
const cancelEnrollmentMock = vi.fn(async () => ({ kind: 'ok' as const }));
vi.mock('@/lib/channels/mobile-enrollment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/channels/mobile-enrollment')>();
  return {
    ...actual,
    startMobileEnrollment: (...a: unknown[]) => startEnrollmentMock(...(a as [])),
    cancelMobileEnrollment: (...a: unknown[]) => cancelEnrollmentMock(...(a as [])),
  };
});

const disconnectMock = vi.fn(async () => ({ kind: 'ok' as const }));
vi.mock('@/lib/channels/disable-enrollment', () => ({
  disconnectChannel: (...a: unknown[]) => disconnectMock(...(a as [])),
}));

const invalidateMock = vi.fn(async () => {});
vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: (...a: unknown[]) => invalidateMock(...(a as [])),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') },
}));

import { resetServerConfigForTests } from '@/lib/config/server';
import { POST as tgStart } from '../telegram/start/route';
import { POST as tgCancel } from '../telegram/cancel/route';
import { POST as tgDisable } from '../telegram/disable/route';
import { POST as waStart } from '../whatsapp/start/route';
import { POST as waCancel } from '../whatsapp/cancel/route';
import { POST as waDisable } from '../whatsapp/disable/route';

function mkReq(path: string, body: unknown = { businessId: 'biz-1' }) {
  return new Request(`http://localhost/api/admin/channels/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  }) as never;
}

/** Every route resolves the account through one accounts join; this is its row. */
function seedAccount(subscription_status: string) {
  accountRow.current = [{ id: 'acct-1', subscription_status }];
}
function seedNoAccount() {
  accountRow.current = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlLog.length = 0;
  seedAccount('active');
  requireAdminMock.mockResolvedValue({ ok: true, admin: { id: 'admin-1' } });
  // The six routes are wrapped in withSameOrigin(), which compares the request
  // Origin against NEXT_PUBLIC_APP_URL and 403s when it is unset. The plan's
  // harness omitted it; the frozen route suites all set it. Deviation recorded.
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost';
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
  process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
  process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
  // getServerConfig() memoizes process.env on first read, so without this the
  // deep-link test's in-test TWILIO_WHATSAPP_NUMBER never reaches the builder
  // and the assertion passes vacuously against the beforeEach value. Deviation
  // recorded — the plan's harness omitted this seam.
  resetServerConfigForTests();
});

describe('admin start binds the strict subscription gate (§4.2)', () => {
  it.each([
    ['telegram', tgStart, 'telegram/start'],
    ['whatsapp', waStart, 'whatsapp/start'],
  ])('POST /api/admin/channels/%s/start returns 403 subscription_not_active for a cancelled account', async (_c, handler, path) => {
    seedAccount('cancelled');
    const res = await handler(mkReq(path));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'subscription_not_active' });
    // The gate fired at the resolver: no enrollment was attempted.
    expect(startEnrollmentMock).not.toHaveBeenCalled();
  });
});

describe('admin cancel and disable bind NO subscription gate (§4.2)', () => {
  it.each([
    ['telegram cancel', tgCancel, 'telegram/cancel'],
    ['whatsapp cancel', waCancel, 'whatsapp/cancel'],
  ])('admin %s succeeds on a cancelled account', async (_n, handler, path) => {
    seedAccount('cancelled');
    const res = await handler(mkReq(path));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Positive proof the mutation was reached, not merely that no 403 came back.
    expect(cancelEnrollmentMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['telegram disable', tgDisable, 'telegram/disable'],
    ['whatsapp disable', waDisable, 'whatsapp/disable'],
  ])('admin %s reaches the disconnect on a cancelled account', async (_n, handler, path) => {
    seedAccount('cancelled');
    const res = await handler(mkReq(path));
    expect(res.status).toBe(200);
    // Positive proof, not `not.toBe(403)`: an accidental full-access binding
    // would short-circuit before disconnectChannel was ever called.
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});

describe('admin routes resolve the admin surface', () => {
  it('the channel cache label keeps the admin and dashboard surfaces distinct', async () => {
    await tgCancel(mkReq('telegram/cancel'));
    expect(invalidateMock).toHaveBeenCalledWith(expect.anything(), 'admin.telegram.cancel');
  });

  it('admin disable forwards surface admin to disconnectChannel', async () => {
    await tgDisable(mkReq('telegram/disable'));
    expect(disconnectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: 'admin', actorUserId: 'admin-1' }),
    );
  });
});

describe('admin routes issue exactly one query before their mutation', () => {
  it.each([
    ['telegram start', tgStart, 'telegram/start'],
    ['telegram cancel', tgCancel, 'telegram/cancel'],
    ['telegram disable', tgDisable, 'telegram/disable'],
  ])('admin %s resolves the actor with a single accounts join', async (_n, handler, path) => {
    await handler(mkReq(path));

    // With every enrollment helper mocked, the resolver's accounts join plus (for
    // start/cancel) the advisory lock are the only statements. #773: at most one
    // query in flight per request chain, and never a second account lookup.
    const accountJoins = sqlLog.filter((s) => s.raw.includes('FROM accounts a'));
    expect(accountJoins).toHaveLength(1);
    expect(accountJoins[0].values).toEqual(['biz-1']);
  });
});

describe('admin start failure responses carry the no-store headers', () => {
  it.each([
    ['missing businessId', 400, () => seedAccount('active'), {}],
    ['unknown business', 404, seedNoAccount, { businessId: 'nope' }],
    ['inactive subscription', 403, () => seedAccount('cancelled'), { businessId: 'biz-1' }],
  ])('admin telegram start %s response sets Cache-Control: no-store, private', async (_n, status, seed, body) => {
    seed();
    const res = await tgStart(mkReq('telegram/start', body));
    expect(res.status).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });
});

describe('admin whatsapp start uses the shared deep-link builder', () => {
  it('the wa.me deep link strips every non-digit from TWILIO_WHATSAPP_NUMBER', async () => {
    // The pre-refactor admin builder stripped only /^whatsapp:\+?/ and would
    // leave the spaces and parens in the wa.me path.
    process.env.TWILIO_WHATSAPP_NUMBER = '+1 (555) 123-4567';

    const res = await waStart(mkReq('whatsapp/start'));
    const body = (await res.json()) as { deepLink?: string };

    expect(res.status).toBe(200);
    expect(body.deepLink).toMatch(/^https:\/\/wa\.me\/15551234567\?text=start-/);
  });
});
