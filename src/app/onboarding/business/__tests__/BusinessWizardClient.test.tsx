// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { BusinessWizardClient } from '../BusinessWizardClient';

const initialValues = { category: '', website: '', businessName: 'Bella Vista' };

afterEach(() => vi.unstubAllGlobals());

// Walks the demo-flow wizard Profile → Voice → Connect. Profile is prefilled
// with a business name so Continue is enabled; Voice is all-optional.
function walkToConnect() {
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  fireEvent.click(screen.getByRole('button', { name: /^continue/i }));
}

describe('BusinessWizardClient — one progress system (A10, A27)', () => {
  it('renders the sub-step as text inside the step h2 and no second dot strip', () => {
    const { container } = render(
      <BusinessWizardClient initialValues={initialValues} demoFlowEnabled />,
    );

    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2).toHaveTextContent('Step 1 of 3 — Profile');
    expect(h2).toHaveTextContent('Business profile');
    // The funnel thread (the ONE progress graphic) owns the only aria-current.
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(screen.queryByText('Location')).not.toBeInTheDocument();
    expect(screen.queryByText('Voice')).not.toBeInTheDocument();
  });

  it('uses the legacy names when the location is captured in the wizard', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Step 1 of 3 — Location',
    );
  });

  it('keeps one heading and one subtitle above the first field', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set up your business');
    expect(screen.getAllByRole('heading')).toHaveLength(2); // h1 + the step h2
    expect(screen.queryByText(/then we go live/i)).not.toBeInTheDocument();
  });

  it('advances the sub-step label as the owner moves through the wizard', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 2 of 3 — Voice');
  });
});

describe('BusinessWizardClient — flow-aware Voice button (A11)', () => {
  it('reads "Continue" in the demo flow, where Connect still follows', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByRole('button', { name: /^continue/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /finish setup/i })).not.toBeInTheDocument();
  });

  it('reads "Finish setup" in the legacy flow, where Voice is the last step', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    // Location step: switch to the URL input so Continue enables without Google.
    fireEvent.click(screen.getByRole('button', { name: /paste a google maps url/i }));
    fireEvent.change(screen.getByLabelText('Google Maps URL'), {
      target: { value: 'https://maps.google.com/?cid=1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 3 of 3 — Voice');
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeInTheDocument();
  });
});

describe('BusinessWizardClient — tier-aware Connect promise (A12)', () => {
  it('promises owner approval of every reply on Copilot', () => {
    render(
      <BusinessWizardClient
        initialValues={initialValues}
        demoFlowEnabled
        subscriptionTier="copilot"
      />,
    );
    walkToConnect();

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Step 3 of 3 — Connect',
    );
    expect(screen.getByText('You approve every reply before it goes live.')).toBeInTheDocument();
    expect(screen.queryByText(/veto window/i)).not.toBeInTheDocument();
  });

  it('tells an Autopilot owner that in-policy replies post after the veto window', () => {
    render(
      <BusinessWizardClient
        initialValues={initialValues}
        demoFlowEnabled
        subscriptionTier="autopilot"
      />,
    );
    walkToConnect();

    expect(
      screen.getByText(
        'Replies inside your policy post after the veto window. Everything else waits for you.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/never auto-post/i)).not.toBeInTheDocument();
  });

  it('never names the vendor — describes the role instead', () => {
    const { container } = render(
      <BusinessWizardClient initialValues={initialValues} demoFlowEnabled />,
    );
    walkToConnect();

    expect(container.textContent).not.toMatch(/zernio/i);
    expect(screen.getByText(/secure Google connection partner/i)).toBeInTheDocument();
  });
});
