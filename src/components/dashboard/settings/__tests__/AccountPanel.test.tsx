// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TierChangeModal } from '../AccountPanel';

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
});
