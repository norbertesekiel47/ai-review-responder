// @vitest-environment jsdom
//
// Step 4 is the wizard's only surface with money and a write on it, and it had
// no render coverage at all. Added with #781, whose terminal success state is
// visible here: an add that succeeded must read as succeeded even when the
// redirect never lands, and must not offer a second click that would duplicate
// the location.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BillingSnapshot } from '@/lib/accounts/quota';
import { Step4Confirm } from '../wizard/steps/Step4Confirm';

vi.mock('@/components/dashboard/shell/Icon', () => ({ Icon: () => null }));

const CONNECT_HREF = '/dashboard/connect?locationId=loc-9';

const BILLING_SNAPSHOT: BillingSnapshot = {
  basePriceCents: 9900,
  includedLocations: 1,
  overagePriceCents: 1500,
  overageUnits: 0,
  totalCents: 9900,
};

type Props = Parameters<typeof Step4Confirm>[0];

function renderStep4(overrides: Partial<Props> = {}) {
  const onSubmit = vi.fn();
  render(
    <Step4Confirm
      displayLabel="  Tanicia 2  "
      placeSelection={{
        placeId: 'place_abc',
        formattedAddress: '123 Main St, Springfield',
        lat: 0,
        lng: 0,
      }}
      inputMode="autocomplete"
      googleMapsUrl=""
      copyFromLocationId=""
      existingLocations={[]}
      billingSnapshot={BILLING_SNAPSHOT}
      billingPreview={{
        nextOverageUnits: 1,
        additionalLocationMonthlyCents: 1500,
        newMonthlyTotalCents: 11400,
      }}
      proration={{ prorationCents: 774, daysRemaining: 16, daysInMonth: 31 }}
      newMonthlyTotalCents={11400}
      submitting={false}
      submitted={false}
      connectHref={null}
      submitError={null}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit };
}

function submitButton() {
  return screen.getByRole('button');
}

describe('Step4Confirm — summary and billing', () => {
  it('renders the trimmed label, the address, and the billing totals', () => {
    renderStep4();

    expect(screen.getByText('Tanicia 2')).toBeInTheDocument();
    expect(screen.getByText('123 Main St, Springfield')).toBeInTheDocument();
    expect(screen.getByText('$99.00/mo')).toBeInTheDocument();
    expect(screen.getByText('$114.00/mo')).toBeInTheDocument();
    // VAL-LOC-066: an actual prorated amount, not a placeholder.
    expect(screen.getByText('$7.74')).toBeInTheDocument();
  });

  it('shows the manual Maps URL instead of an address when there is no place selection', () => {
    renderStep4({
      placeSelection: null,
      inputMode: 'url',
      googleMapsUrl: '  https://maps.google.com/?cid=123  ',
    });

    expect(screen.getByText('https://maps.google.com/?cid=123')).toBeInTheDocument();
  });

  it('names the source location when the voice config was copied', () => {
    renderStep4({
      copyFromLocationId: 'loc-1',
      existingLocations: [
        {
          locationId: 'loc-1',
          displayName: 'Terry Business',
          tone: 'warm',
          productsServices: '',
          avoidFacts: [],
          sampleResponses: [],
        },
      ],
    });

    expect(screen.getByText('Copied from Terry Business')).toBeInTheDocument();
  });

  it('omits the proration row when the location adds no monthly cost', () => {
    renderStep4({
      billingPreview: {
        nextOverageUnits: 0,
        additionalLocationMonthlyCents: 0,
        newMonthlyTotalCents: 9900,
      },
      newMonthlyTotalCents: 9900,
    });

    expect(screen.getByText('Included')).toBeInTheDocument();
    expect(screen.queryByText(/days remaining/)).not.toBeInTheDocument();
  });
});

describe('Step4Confirm — submit states', () => {
  it('offers the submit action when idle', () => {
    renderStep4();

    expect(submitButton()).toBeEnabled();
    expect(submitButton()).toHaveTextContent('Confirm & add location');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('disables the button while the add is in flight', () => {
    renderStep4({ submitting: true });

    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveTextContent('Adding location…');
  });

  it('renders the inline error and re-offers the submit action after a failure', () => {
    renderStep4({ submitError: 'This location is already added' });

    expect(screen.getByText('This location is already added')).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  // #781 — the visible half of the terminal success state.
  it('confirms the add and links to setup once the location exists', () => {
    renderStep4({ submitted: true, connectHref: CONNECT_HREF });

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Location added');
    expect(screen.getByRole('link', { name: 'Continue now' })).toHaveAttribute(
      'href',
      CONNECT_HREF,
    );
  });

  it('keeps the button disabled after success so a stalled redirect cannot duplicate the location', () => {
    renderStep4({ submitted: true, connectHref: CONNECT_HREF });

    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveTextContent('Location added');
  });

  it('still confirms the add when no connect href is available', () => {
    renderStep4({ submitted: true, connectHref: null });

    expect(screen.getByRole('status')).toHaveTextContent('Location added');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
