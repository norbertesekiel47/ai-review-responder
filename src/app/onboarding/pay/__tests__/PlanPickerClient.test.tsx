// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { PlanPickerClient } from '../PlanPickerClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

const listView = buildPlanPresentation({
  priceVariant: 'list',
  autopilotPurchasable: true,
  trialEnabled: false,
});

describe('PlanPickerClient', () => {
  it('renders only Copilot and Autopilot with exact list and overage prices', () => {
    render(<PlanPickerClient cancelled={false} {...listView} />);

    expect(screen.getByRole('heading', { name: 'Copilot' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Autopilot' })).toBeInTheDocument();
    expect(screen.getByText('$79')).toBeInTheDocument();
    expect(screen.getByText('$149')).toBeInTheDocument();
    expect(screen.getByText(/\$79\/month per extra location/i)).toBeInTheDocument();
    expect(screen.getByText(/\$149\/month per extra location/i)).toBeInTheDocument();
    expect(screen.queryByText(/Basic|Standard|Premium|Founding Member/)).not.toBeInTheDocument();
  });

  it('starts with no selection and rejects submit without one', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<PlanPickerClient cancelled={false} {...listView} />);

    expect(screen.getByRole('radio', { name: 'Choose Copilot plan' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Choose Autopilot plan' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /Continue to secure checkout/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Choose Copilot or Autopilot/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits the explicitly selected Copilot tier', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'checkout_unavailable' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PlanPickerClient cancelled={false} {...listView} />);

    await user.click(screen.getByRole('radio', { name: 'Choose Copilot plan' }));
    await user.click(screen.getByRole('button', { name: /Continue to secure checkout/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/onboarding/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: 'copilot' }),
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Checkout unavailable');
  });

  it('shows founding-for-life amounts and truthful card-up-front trial copy', () => {
    const founding = buildPlanPresentation({
      priceVariant: 'founding',
      autopilotPurchasable: true,
      trialEnabled: true,
    });
    render(<PlanPickerClient cancelled={false} {...founding} />);

    expect(screen.getByText('$49')).toBeInTheDocument();
    expect(screen.getByText('$99')).toBeInTheDocument();
    expect(screen.getAllByText(/Founding rate locked for the account/i)).toHaveLength(2);
    expect(screen.getByText(/30-day trial. Card required up front/i)).toBeInTheDocument();
    expect(screen.queryByText(/14-day|No credit card/i)).not.toBeInTheDocument();
  });

  it('keeps unavailable Autopilot visible, disabled, and explained', () => {
    const unavailable = buildPlanPresentation({
      priceVariant: 'list',
      autopilotPurchasable: false,
      trialEnabled: false,
    });
    render(<PlanPickerClient cancelled={false} {...unavailable} />);

    expect(screen.getByRole('heading', { name: 'Autopilot' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Choose Autopilot plan' })).toBeDisabled();
    expect(screen.getByText(/temporarily unavailable. Choose Copilot/i)).toBeInTheDocument();
    // Internal nouns never reach the owner (contract copy rule).
    expect(screen.queryByText(/safety runtime/i)).not.toBeInTheDocument();
  });

  it('rejects a stale Autopilot selection when server availability changes', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<PlanPickerClient cancelled={false} {...listView} />);

    await user.click(screen.getByRole('radio', { name: 'Choose Autopilot plan' }));
    const unavailable = buildPlanPresentation({
      priceVariant: 'list',
      autopilotPurchasable: false,
      trialEnabled: false,
    });
    rerender(<PlanPickerClient cancelled={false} {...unavailable} />);
    await user.click(screen.getByRole('button', { name: /Continue to secure checkout/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/no longer available/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discloses monthly renewal, taxes, and Terms near checkout', () => {
    render(<PlanPickerClient cancelled={false} {...listView} />);

    expect(screen.getByText(/renew monthly at the listed base price/i)).toBeInTheDocument();
    expect(screen.getByText(/applicable taxes/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Terms/i })).toHaveAttribute('href', '/legal/terms');
    expect(screen.queryByText(/annual|save 20%/i)).not.toBeInTheDocument();
  });

  it('explains the plan choice in plain language, not architect vocabulary (A9)', () => {
    render(<PlanPickerClient cancelled={false} {...listView} />);

    expect(
      screen.getByText('Pick how much RepWorth does on its own. You can change this later.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/authority/i)).not.toBeInTheDocument();
  });

  it('renders the checkout error directly above the CTA, not below the legal text (A9)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn());
    render(<PlanPickerClient cancelled={false} {...listView} />);

    const cta = screen.getByRole('button', { name: /Continue to secure checkout/i });
    await user.click(cta);

    const alert = screen.getByRole('alert');
    // DOCUMENT_POSITION_FOLLOWING: the CTA comes after the alert in DOM order.
    expect(alert.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const terms = screen.getByText(/renew monthly/i);
    expect(alert.compareDocumentPosition(terms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('tells the owner where the card is entered and ties it to the CTA (A18)', () => {
    render(<PlanPickerClient cancelled={false} {...listView} />);

    const cta = screen.getByRole('button', { name: /Continue to secure checkout/i });
    const hint = screen.getByText(
      "You'll enter card details on Stripe's secure page, then return here.",
    );
    expect(cta).toHaveAttribute('aria-describedby', hint.id);
  });
});
