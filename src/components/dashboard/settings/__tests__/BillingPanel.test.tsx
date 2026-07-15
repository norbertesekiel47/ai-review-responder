// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AccountSettingsData } from '@/hooks/useAccountData';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { BillingPanel, TierChangeModal } from '../BillingPanel';

vi.mock('@/components/dashboard/settings/CancelSubscriptionPanel', () => ({
  CancelSubscriptionPanel: () => <div data-testid="cancel-sub" />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function accountData(input?: {
  tier?: 'copilot' | 'autopilot';
  variant?: 'list' | 'founding';
  autopilotPurchasable?: boolean;
  status?: string;
  basePriceCents?: number;
}): AccountSettingsData {
  const tier = input?.tier ?? 'copilot';
  const variant = input?.variant ?? 'list';
  const basePriceCents = input?.basePriceCents
    ?? (variant === 'founding'
      ? tier === 'copilot' ? 1900 : 4900
      : tier === 'copilot' ? 2900 : 6900);
  const overagePriceCents = tier === 'copilot' ? 1500 : 2000;
  return {
    accountId: 'acct_42',
    displayName: 'Acme',
    subscription: {
      tier,
      tierLabel: tier === 'copilot' ? 'Copilot' : 'Autopilot',
      priceVariant: variant,
      status: input?.status ?? 'active',
      statusLabel: input?.status === 'trialing' ? 'Trialing' : 'Active',
      stripeCustomerId: 'cus_1',
      activatedAt: null,
      trialEndsAt: null,
    },
    quota: { activeLocations: 1, included: 1, paid: 0, overage: 0 },
    billing: { basePriceCents, overagePriceCents, overageUnits: 0, totalCents: basePriceCents },
    planPresentation: buildPlanPresentation({
      priceVariant: variant,
      autopilotPurchasable: input?.autopilotPurchasable ?? true,
      trialEnabled: input?.status === 'trialing',
    }),
    timeZone: 'UTC',
  };
}

const AUTOPILOT_LIST_PREVIEW = {
  basePriceCents: 6900,
  includedLocations: 1,
  overagePriceCents: 2000,
  overageUnits: 0,
  totalCents: 6900,
};

describe('TierChangeModal billing disclosure', () => {
  it('discloses taxes, monthly renewal, and exact target snapshot', () => {
    render(
      <TierChangeModal
        newTier="autopilot"
        isDowngrade={false}
        priceVariant="list"
        trialing={false}
        billingPreview={AUTOPILOT_LIST_PREVIEW}
        previewLoading={false}
        previewError={null}
        onConfirm={() => {}}
        onCancel={() => {}}
        changing={false}
      />,
    );

    expect(screen.getByText(/before any applicable taxes/i)).toBeInTheDocument();
    expect(screen.getByText(/continues monthly until cancelled/i)).toBeInTheDocument();
    expect(screen.getAllByText('$69.00/month')).toHaveLength(2);
    expect(screen.getByText('$20.00/month each')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows founding preview parity and the lifetime variant', () => {
    render(
      <TierChangeModal
        newTier="autopilot"
        isDowngrade={false}
        priceVariant="founding"
        trialing={false}
        billingPreview={{ ...AUTOPILOT_LIST_PREVIEW, basePriceCents: 4900, totalCents: 4900 }}
        previewLoading={false}
        previewError={null}
        onConfirm={() => {}}
        onCancel={() => {}}
        changing={false}
      />,
    );

    expect(screen.getByText('Founding-for-life')).toBeInTheDocument();
    expect(screen.getAllByText('$49.00/month')).toHaveLength(2);
    expect(screen.queryByText('$69.00/month')).not.toBeInTheDocument();
  });

  it('keeps mid-trial plan-change copy trial safe', () => {
    render(
      <TierChangeModal
        newTier="autopilot"
        isDowngrade={false}
        priceVariant="list"
        trialing
        billingPreview={AUTOPILOT_LIST_PREVIEW}
        previewLoading={false}
        previewError={null}
        onConfirm={() => {}}
        onCancel={() => {}}
        changing={false}
      />,
    );

    expect(screen.getByText(/current trial continues/i)).toBeInTheDocument();
    expect(screen.getByText(/price applies when the trial ends/i)).toBeInTheDocument();
  });
});

describe('BillingPanel tier changes', () => {
  it('renders only the two launch tiers and reads the current amount from the stored snapshot', () => {
    render(
      <BillingPanel
        accountData={accountData({ basePriceCents: 3100 })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    expect(screen.getByText('$31.00/month base')).toBeInTheDocument();
    expect(screen.getAllByText('Copilot')).toHaveLength(2);
    expect(screen.getByText('Autopilot')).toBeInTheDocument();
    expect(screen.queryByText(/Basic|Standard|Premium|Founders/)).not.toBeInTheDocument();
  });

  it('marks the modal-opening request preview-only', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ newBilling: AUTOPILOT_LIST_PREVIEW }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BillingPanel
        accountData={accountData()}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Autopilot \(\$69.00\/month\)/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      accountId: 'acct_42',
      newTier: 'autopilot',
      preview: true,
    });
  });

  it('shows founding target price and uses the founder preview returned by the server', async () => {
    const preview = { ...AUTOPILOT_LIST_PREVIEW, basePriceCents: 4900, totalCents: 4900 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ newBilling: preview }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    render(
      <BillingPanel
        accountData={accountData({ variant: 'founding' })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    const button = screen.getByRole('button', { name: /Upgrade to Autopilot \(\$49.00\/month\)/i });
    expect(screen.queryByRole('button', { name: /\$69.00\/month/i })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText('Founding-for-life')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getAllByText('$49.00/month')).toHaveLength(2);
  });

  it('keeps unavailable Autopilot disabled and does not call preview', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BillingPanel
        accountData={accountData({ autopilotPurchasable: false })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Autopilot unavailable' })).toBeDisabled();
    expect(screen.getByText(/safety runtime is closed. Copilot remains available/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses one operation ID for retries and allocates a new ID later', async () => {
    const randomUUID = vi.fn().mockReturnValueOnce('operation-one').mockReturnValueOnce('operation-two');
    vi.stubGlobal('crypto', { randomUUID });
    let executionAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { preview?: boolean };
      if (body.preview) {
        return new Response(JSON.stringify({ newBilling: AUTOPILOT_LIST_PREVIEW }), {
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
        accountData={accountData()}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Autopilot/i }));
    await screen.findByText(/New monthly estimate/i);
    fireEvent.click(screen.getByRole('button', { name: /Confirm upgrade/i }));
    await screen.findByText('temporary_failure');
    fireEvent.click(screen.getByRole('button', { name: /Confirm upgrade/i }));
    await waitFor(() => expect(screen.queryByText(/New monthly estimate/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Autopilot/i }));
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
