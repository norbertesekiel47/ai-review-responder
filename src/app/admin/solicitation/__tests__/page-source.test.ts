import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The real constants: the vi.mock below spreads `importOriginal`, so only
// `readSendBreaker` is stubbed and these are the enforced values.
import {
  BREAKER_COMPLAINT_RATE,
  BREAKER_HARD_BOUNCE_RATE,
  BREAKER_MIN_SENDS,
  BREAKER_WINDOW_DAYS,
} from '@/lib/solicitation/send-breaker';

// The /admin/solicitation page gate (#898).
//
// This page does NOT delegate its read to the route beside it: it calls
// `readSendBreaker(sql)` itself to server-render the first paint, so its own
// gate is the only thing protecting that read. It therefore gets the same
// unconditional AAL2 check `requireAdminWithAal2` puts on both breaker routes,
// exercised the way src/app/admin/suppressions/__tests__/page.test.tsx does it
// — the page function is invoked against a mocked gate rather than merely
// grepped, so "gates before reading" is proved by the call order, not by text.
//
// The source assertions from src/app/admin/autonomy/__tests__/page-source.test.ts
// ride along: they pin the SSR-root/client-component split this file is named for.

const { mockRequireAdminPage, mockSql, mockReadSendBreaker, mockSendBreakerClient } = vi.hoisted(
  () => ({
    mockRequireAdminPage: vi.fn(),
    mockSql: { marker: 'sql-singleton' },
    mockReadSendBreaker: vi.fn(),
    mockSendBreakerClient: vi.fn(() => null),
  }),
);

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@/lib/auth/page-gate', () => ({ requireAdminPage: mockRequireAdminPage }));
vi.mock('@/lib/solicitation/send-breaker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solicitation/send-breaker')>();
  return { ...actual, readSendBreaker: mockReadSendBreaker };
});
vi.mock('../SendBreakerClient', () => ({ SendBreakerClient: mockSendBreakerClient }));

const TRIPPED_AT = new Date('2026-08-18T09:30:00.000Z');

/** The page returns `<AdminPage>…<SendBreakerClient initialData=… thresholds=… /></AdminPage>`. */
interface RenderedPage {
  props: { children: { type: unknown; props: { initialData: unknown; thresholds: unknown } } };
}

describe('admin solicitation page source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdminPage.mockResolvedValue({ id: 'admin-1', role: 'admin' });
    mockReadSendBreaker.mockResolvedValue({ open: false, trip: null });
  });

  it('the admin solicitation page gates on requireAdminPage with aal2', async () => {
    const { default: AdminSolicitationPage } = await import('../page');

    await AdminSolicitationPage();

    expect(mockRequireAdminPage).toHaveBeenCalledWith(mockSql, {
      from: '/admin/solicitation',
      aal2: true,
    });

    // Gate FIRST: a rejected gate redirects and the breaker is never read, so
    // an under-authenticated viewer learns nothing about the platform's send
    // health — not even whether it is halted.
    vi.clearAllMocks();
    mockRequireAdminPage.mockRejectedValue(new Error('NEXT_REDIRECT'));

    await expect(AdminSolicitationPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockReadSendBreaker).not.toHaveBeenCalled();
    expect(mockSendBreakerClient).not.toHaveBeenCalled();
  });

  it('hands the client an initialData shaped exactly like a refetch', async () => {
    // `trippedAt` crosses the wire as an ISO string on GET, so the
    // server-rendered seed must serialise its Date the same way — otherwise
    // the first background refetch silently changes the prop's type.
    mockReadSendBreaker.mockResolvedValue({
      open: true,
      trip: {
        id: 'trip-1',
        trippedAt: TRIPPED_AT,
        tripReason: 'hard_bounce_rate',
        metrics: {
          sends: 2_000,
          hardBounces: 50,
          complaints: 2,
          hardBounceRate: 0.025,
          complaintRate: 0.001,
        },
      },
    });
    const { default: AdminSolicitationPage } = await import('../page');

    const page = (await AdminSolicitationPage()) as unknown as RenderedPage;

    expect(mockReadSendBreaker).toHaveBeenCalledWith(mockSql);
    expect(page.props.children.type).toBe(mockSendBreakerClient);
    expect(page.props.children.props.initialData).toEqual({
      open: true,
      trip: {
        id: 'trip-1',
        trippedAt: '2026-08-18T09:30:00.000Z',
        tripReason: 'hard_bounce_rate',
        metrics: {
          sends: 2_000,
          hardBounces: 50,
          complaints: 2,
          hardBounceRate: 0.025,
          complaintRate: 0.001,
        },
      },
    });

    // The four enforcement thresholds travel as a prop, read from the module
    // that enforces them. The client cannot import them itself — see the
    // source assertions below — so this is the only thing standing between the
    // panel and a hardcoded second copy of numbers the send path owns.
    expect(page.props.children.props.thresholds).toEqual({
      windowDays: BREAKER_WINDOW_DAYS,
      minSends: BREAKER_MIN_SENDS,
      hardBounceRate: BREAKER_HARD_BOUNCE_RATE,
      complaintRate: BREAKER_COMPLAINT_RATE,
    });
  });

  it('keeps the page as an SSR root and delegates interactivity to the client component', async () => {
    const source = await readFile('src/app/admin/solicitation/page.tsx', 'utf8');

    expect(source).not.toContain("'use client'");
    expect(source).toContain('SendBreakerClient');
    expect(source).not.toMatch(/gradient|bg-\[#|text-\[#/);

    // The other half of the split, and a build-breakage regression guard.
    // `send-breaker.ts` instantiates a worker logger at module scope, which
    // reaches `node:async_hooks`; a RUNTIME import of it from the client
    // component puts that chain in a client chunk and Turbopack fails the
    // route build outright ("the chunking context (unknown) does not support
    // external modules"). Type imports are erased and cost nothing, so the
    // client may name the module — but only after `import type`.
    const client = await readFile('src/app/admin/solicitation/SendBreakerClient.tsx', 'utf8');

    expect(client).toContain("'use client'");
    for (const statement of client.match(/^import[\s\S]*?from '[^']*';$/gm) ?? []) {
      if (statement.includes('@/lib/solicitation/send-breaker')) {
        expect(statement.startsWith('import type ')).toBe(true);
      }
    }
  });
});
