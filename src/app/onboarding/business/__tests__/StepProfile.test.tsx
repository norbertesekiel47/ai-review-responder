// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StepProfile } from '../StepProfile';
import type { WizardFormData } from '../BusinessWizardClient';

const baseData: WizardFormData = {
  inputMode: 'autocomplete',
  googlePlaceId: '',
  googlePlaceAddress: '',
  googleMapsUrl: '',
  businessName: 'Test Biz',
  category: '',
  website: '',
  tone: '',
  productsServices: '',
  staffNames: '',
  highlightFacts: '',
  avoidFacts: '',
  sampleResponses: '',
};

function makeDirtyRef() {
  return { current: { category: false, website: false } };
}

describe('StepProfile', () => {
  it('hides the Back button when no onBack is provided (demo-flow first step)', () => {
    render(
      <StepProfile
        data={baseData}
        update={vi.fn()}
        dirtyRef={makeDirtyRef()}
        onNext={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
    expect(
      screen.getByRole('button', { name: /continue/i }),
    ).toBeInTheDocument();
  });

  it('shows a working Back button when onBack is provided', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <StepProfile
        data={baseData}
        update={vi.fn()}
        dirtyRef={makeDirtyRef()}
        onNext={vi.fn()}
        onBack={onBack}
      />,
    );
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
