// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { AccountSettingsData } from '@/hooks/useAccountData';
import { BillingPanel, TierChangeModal } from '../BillingPanel';

vi.mock('@/components/dashboard/settings/CancelSubscriptionPanel', () => ({
  CancelSubscriptionPanel: () => <div data-testid="cancel-sub" />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── Tax + renewal compliance disclosure (ported from AccountPanel.test.tsx) ──

describe('TierChangeModal tax + renewal disclosure', () => {
  it('discloses tax + renewal terms on the tier-change estimate', () => {
    render(
      <TierChangeModal
        currentTier="standard"
        newTier="premium"
        accountId="acct_1"
        billingPreview={{
          basePriceCents: 19900,
          overagePriceCents: 2000,
          overageUnits: 0,
          totalCents: 19900,
        }}
        previewLoading={false}
        previewError={null}
        onConfirm={() => {}}
        onCancel={() => {}}
        changing={false}
      />,
    );
    expect(screen.getByText(/before any applicable taxes/i)).toBeInTheDocument();
    expect(screen.getByText(/continues monthly until cancelled/i)).toBeInTheDocument();
  });

  it('warns that downgrading to basic supports only one location', () => {
    render(
      <TierChangeModal
        currentTier="premium"
        newTier="basic"
        accountId="acct_1"
        billingPreview={{
          basePriceCents: 2900,
          overagePriceCents: 0,
          overageUnits: 0,
          totalCents: 2900,
        }}
        previewLoading={false}
        previewError={null}
        onConfirm={() => {}}
        onCancel={() => {}}
        changing={false}
      />,
    );
    expect(screen.getByText(/Basic plan supports only 1 location/i)).toBeInTheDocument();
    expect(screen.getByText(/Archive extra locations before downgrading/i)).toBeInTheDocument();
  });
});

// ── Tier-change preview request is preview-only ─────────────────────────────
// Behavioral rewrite of the AccountPanel source-grep test that asserted the
// modal-opening tier-change POST carries `preview: true`. Rendering BillingPanel
// and clicking an upgrade button is a faithful, source-independent check.

const accountData: AccountSettingsData = {
  accountId: 'acct_42',
  displayName: 'Acme',
  subscription: {
    tier: 'standard',
    tierLabel: 'Standard',
    status: 'active',
    statusLabel: 'Active',
    stripeCustomerId: 'cus_1',
    activatedAt: null,
    trialEndsAt: null,
  },
  quota: { activeLocations: 1, included: 1, paid: 1, overage: 0 },
  billing: { basePriceCents: 7900, overagePriceCents: 2500, overageUnits: 0, totalCents: 7900 },
  timeZone: 'UTC',
};

describe('BillingPanel tier preview request', () => {
  it('marks the modal-opening tier-change request as preview-only', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ newBilling: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BillingPanel
        accountData={accountData}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    // standard ($79) can upgrade to premium ($199); founders/basic are lower base.
    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Premium/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/billing/tier-change',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      accountId: string;
      newTier: string;
      preview?: boolean;
    };
    expect(body).toMatchObject({
      accountId: 'acct_42',
      newTier: 'premium',
      preview: true,
    });
  });

  it('reuses one operation ID for retries and allocates a new ID for a later operation', async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce('operation-one')
      .mockReturnValueOnce('operation-two');
    vi.stubGlobal('crypto', { randomUUID });
    const preview = {
      basePriceCents: 19900,
      overagePriceCents: 2000,
      overageUnits: 0,
      totalCents: 19900,
    };
    let executionAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { preview?: boolean };
      if (body.preview) {
        return new Response(JSON.stringify({ newBilling: preview }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      executionAttempts++;
      if (executionAttempts === 1) {
        return new Response(JSON.stringify({ error: 'temporary_failure' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BillingPanel
        accountData={accountData}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Premium/i }));
    await screen.findByText(/New monthly estimate/i);
    fireEvent.click(screen.getByRole('button', { name: /Confirm upgrade/i }));
    await screen.findByText('temporary_failure');
    fireEvent.click(screen.getByRole('button', { name: /Confirm upgrade/i }));
    await waitFor(() => expect(screen.queryByText(/New monthly estimate/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Premium/i }));
    await screen.findByText(/New monthly estimate/i);
    fireEvent.click(screen.getByRole('button', { name: /Confirm upgrade/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const executionHeaders = fetchMock.mock.calls
      .map(([, init]) => init?.headers as Record<string, string> | undefined)
      .filter((headers) => headers?.['Idempotency-Key'])
      .map((headers) => headers!['Idempotency-Key']);
    expect(executionHeaders).toEqual(['operation-one', 'operation-one', 'operation-two']);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
});
