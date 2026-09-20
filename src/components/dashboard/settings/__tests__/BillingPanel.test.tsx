// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AccountSettingsData } from '@/hooks/useAccountData';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import {
  AUTOPILOT_UNAVAILABLE_COPY,
  BillingPanel,
  TIER_CAPABILITY,
  TierChangeModal,
  monthlyTotalCents,
} from '../BillingPanel';

vi.mock('@/components/dashboard/settings/CancelSubscriptionPanel', () => ({
  CancelSubscriptionPanel: () => <div data-testid="cancel-sub" />,
}));
const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock('@/components/dashboard/shell/toast/ToastProvider', () => ({
  useToast: () => ({ toast: mockToast, dismiss: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
      ? tier === 'copilot' ? 4900 : 9900
      : tier === 'copilot' ? 7900 : 14900);
  const overagePriceCents = tier === 'copilot' ? 7900 : 14900;
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
  basePriceCents: 14900,
  includedLocations: 1,
  overagePriceCents: 14900,
  overageUnits: 0,
  totalCents: 14900,
};

const COPILOT_LIST_PREVIEW = {
  basePriceCents: 7900,
  includedLocations: 1,
  overagePriceCents: 7900,
  overageUnits: 0,
  totalCents: 7900,
};

describe('TierChangeModal billing disclosure', () => {
  it('discloses taxes, monthly renewal, and exact target snapshot', () => {
    render(
      <TierChangeModal
        newTier="autopilot"
        direction="up"
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
    expect(screen.getAllByText('$149.00/month')).toHaveLength(2);
    expect(screen.getByText('$149.00/month each')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows founding preview parity and the lifetime variant', () => {
    render(
      <TierChangeModal
        newTier="autopilot"
        direction="up"
        priceVariant="founding"
        trialing={false}
        billingPreview={{ ...AUTOPILOT_LIST_PREVIEW, basePriceCents: 9900, totalCents: 9900 }}
        previewLoading={false}
        previewError={null}
        onConfirm={() => {}}
        onCancel={() => {}}
        changing={false}
      />,
    );

    expect(screen.getByText('Founding-for-life')).toBeInTheDocument();
    expect(screen.getAllByText('$99.00/month')).toHaveLength(2);
    expect(screen.queryByText('$149.00/month')).not.toBeInTheDocument();
  });

  it('keeps mid-trial plan-change copy trial safe', () => {
    render(
      <TierChangeModal
        newTier="autopilot"
        direction="up"
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

/** Catalogue prices the card must NOT read a direction from. */
function withCataloguePrices(
  data: AccountSettingsData,
  copilotCents: number,
  autopilotCents: number,
): AccountSettingsData {
  data.planPresentation.prices = {
    copilot: { ...data.planPresentation.prices.copilot, basePriceCents: copilotCents },
    autopilot: { ...data.planPresentation.prices.autopilot, basePriceCents: autopilotCents },
  };
  return data;
}

describe('TierChangeModal autonomy warning', () => {
  it('tier change modal warns that replies stop posting on their own when moving to copilot', () => {
    render(
      <TierChangeModal
        newTier="copilot"
        direction="down"
        priceVariant="list"
        trialing={false}
        billingPreview={COPILOT_LIST_PREVIEW}
        previewLoading={false}
        previewError={null}
        onConfirm={() => {}}
        onCancel={() => {}}
        changing={false}
      />,
    );

    expect(screen.getByText(/Replies will stop posting on their own/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Every reply waits for your approval from the moment the plan changes/i),
    ).toBeInTheDocument();
  });

  it('tier change modal omits the autonomy warning when moving to autopilot', () => {
    render(
      <TierChangeModal
        newTier="autopilot"
        direction="up"
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

    expect(screen.queryByText(/Replies will stop posting on their own/i)).toBeNull();
  });
});

function previewFetch(preview: typeof AUTOPILOT_LIST_PREVIEW) {
  return vi.fn(async () => new Response(JSON.stringify({ newBilling: preview }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('BillingPanel tier-change modal direction', () => {
  it('opening the copilot modal from a grandfathered autopilot account shows downgrade wording regardless of stored price', async () => {
    vi.stubGlobal('fetch', previewFetch(COPILOT_LIST_PREVIEW));
    render(
      <BillingPanel
        accountData={accountData({ tier: 'autopilot', basePriceCents: 3900 })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /to Copilot/i }));
    // SettingsModal exposes its title as the dialog's accessible name.
    const dialog = await screen.findByRole('dialog', { name: 'Downgrade plan' });
    expect(within(dialog).getByText(/Downgrade to Copilot\?/i)).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: /Confirm downgrade/i })).toBeInTheDocument();
  });

  it('opening the autopilot modal from a copilot account whose stored price exceeds both catalogue prices shows upgrade wording', async () => {
    vi.stubGlobal('fetch', previewFetch(AUTOPILOT_LIST_PREVIEW));
    render(
      <BillingPanel
        accountData={accountData({ tier: 'copilot', basePriceCents: 20000 })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /to Autopilot/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Upgrade plan' });
    expect(within(dialog).getByText(/Upgrade to Autopilot\?/i)).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: /Confirm upgrade/i })).toBeInTheDocument();
  });

  it('trialing autopilot to copilot modal preserves trial billing copy and warns that replies stop posting on their own', async () => {
    vi.stubGlobal('fetch', previewFetch(COPILOT_LIST_PREVIEW));
    render(
      <BillingPanel
        accountData={accountData({ tier: 'autopilot', status: 'trialing' })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /to Copilot/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/current trial continues/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Replies will stop posting on their own/i)).toBeInTheDocument();
  });
});

describe('BillingPanel plan-switch direction', () => {
  it('billing card labels the copilot option Downgrade for an autopilot account', () => {
    render(
      <BillingPanel
        accountData={accountData({ tier: 'autopilot' })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: /Downgrade to Copilot/i })).toBeInTheDocument();
  });

  it('billing card labels the autopilot option Upgrade for a copilot account', () => {
    render(
      <BillingPanel
        accountData={accountData({ tier: 'copilot' })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: /Upgrade to Autopilot/i })).toBeInTheDocument();
  });

  it('billing card direction ignores a grandfathered stored base price', () => {
    // Stored 39.00 sits below BOTH catalogue prices (invariant #9a), so a
    // price comparison labels the Copilot card "Upgrade".
    render(
      <BillingPanel
        accountData={accountData({ tier: 'autopilot', basePriceCents: 3900 })}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );

    expect(
      screen.getByRole('button', { name: /Downgrade to Copilot \(\$79.00\/month\)/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade to Copilot/i })).toBeNull();
  });

  it('billing cards retain upgrade and downgrade labels when both catalogue prices are equal', () => {
    render(
      <BillingPanel
        accountData={withCataloguePrices(
          accountData({ tier: 'copilot', basePriceCents: 9900 }),
          9900,
          9900,
        )}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Upgrade to Autopilot/i })).toBeInTheDocument();

    cleanup();

    render(
      <BillingPanel
        accountData={withCataloguePrices(
          accountData({ tier: 'autopilot', basePriceCents: 9900 }),
          9900,
          9900,
        )}
        accountLoading={false}
        accountError={null}
        onAccountRefetch={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Downgrade to Copilot/i })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Autopilot \(\$149.00\/month\)/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      accountId: 'acct_42',
      newTier: 'autopilot',
      preview: true,
    });
  });

  it('shows founding target price and uses the founder preview returned by the server', async () => {
    const preview = { ...AUTOPILOT_LIST_PREVIEW, basePriceCents: 9900, totalCents: 9900 };
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

    const button = screen.getByRole('button', { name: /Upgrade to Autopilot \(\$99.00\/month\)/i });
    expect(screen.queryByRole('button', { name: /\$149.00\/month/i })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText('Founding-for-life')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getAllByText('$99.00/month')).toHaveLength(2);
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

    // S17: plain copy — never "safety runtime".
    const button = screen.getByRole('button', { name: 'Autopilot not available yet' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(AUTOPILOT_UNAVAILABLE_COPY);
    expect(screen.getByText(AUTOPILOT_UNAVAILABLE_COPY)).toBeInTheDocument();
    expect(screen.queryByText(/safety runtime/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // S15: the one number the owner came for, from the STORED snapshot.
  it('shows the monthly total computed from base + overage × extra locations', () => {
    const data = accountData({ basePriceCents: 2900 });
    data.billing = { basePriceCents: 2900, overagePriceCents: 1500, overageUnits: 2, totalCents: 5900 };
    render(
      <BillingPanel accountData={data} accountLoading={false} accountError={null} onAccountRefetch={() => {}} />,
    );

    expect(monthlyTotalCents(data.billing)).toBe(5900);
    expect(screen.getByText('Monthly total')).toBeInTheDocument();
    expect(screen.getByText('$59.00/month')).toBeInTheDocument();
  });

  // S16: what each tier does, and Autopilot links to where its limits live.
  it('describes each tier in one line and links Autopilot to Auto-approval', () => {
    render(
      <BillingPanel accountData={accountData()} accountLoading={false} accountError={null} onAccountRefetch={() => {}} />,
    );

    expect(screen.getByText(TIER_CAPABILITY.copilot)).toBeInTheDocument();
    expect(TIER_CAPABILITY.copilot).toMatch(/you approve every reply/i);
    expect(screen.getByText(/replies to 4–5★ reviews post on their own/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /set your auto-approval limits/i })).toHaveAttribute(
      'href',
      '/settings/auto-approval',
    );
  });

  // S35: the branded skeleton on first load, not "Loading account data…".
  it('renders SettingsSkeleton while the first load is in flight', () => {
    render(<BillingPanel accountData={null} accountLoading accountError={null} onAccountRefetch={() => {}} />);

    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
    expect(screen.queryByText(/loading account data/i)).toBeNull();
  });

  it('keeps the card (no skeleton) during a refetch that already has data', () => {
    render(<BillingPanel accountData={accountData()} accountLoading accountError={null} onAccountRefetch={() => {}} />);

    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.getByText('Monthly total')).toBeInTheDocument();
  });

  // S18: a completed tier change confirms with the shared toast.
  it('toasts "Plan changed to Autopilot" after a confirmed tier change', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { preview?: boolean };
      return new Response(JSON.stringify(body.preview ? { newBilling: AUTOPILOT_LIST_PREVIEW } : { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onAccountRefetch = vi.fn();
    render(
      <BillingPanel accountData={accountData()} accountLoading={false} accountError={null} onAccountRefetch={onAccountRefetch} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Autopilot/i }));
    await screen.findByText(/New monthly estimate/i);
    fireEvent.click(screen.getByRole('button', { name: /Confirm upgrade/i }));

    await waitFor(() => expect(onAccountRefetch).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith({ tone: 'success', title: 'Plan changed to Autopilot' });
  });

  it('does not toast when the tier change fails', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { preview?: boolean };
      if (body.preview) {
        return new Response(JSON.stringify({ newBilling: AUTOPILOT_LIST_PREVIEW }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'card_declined' }), { status: 402 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BillingPanel accountData={accountData()} accountLoading={false} accountError={null} onAccountRefetch={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Autopilot/i }));
    await screen.findByText(/New monthly estimate/i);
    fireEvent.click(screen.getByRole('button', { name: /Confirm upgrade/i }));

    await screen.findByText('card_declined');
    expect(mockToast).not.toHaveBeenCalled();
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
