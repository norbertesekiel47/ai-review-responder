// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OnboardingFunnelShell } from '../OnboardingFunnelShell';

describe('OnboardingFunnelShell', () => {
  it('renders children and the RepWorth wordmark', () => {
    render(
      <OnboardingFunnelShell step="find">
        <p>hello funnel</p>
      </OnboardingFunnelShell>,
    );
    expect(screen.getByText('hello funnel')).toBeInTheDocument();
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
  });

  it('shows the step thread when a step is provided', () => {
    render(
      <OnboardingFunnelShell step="plan">
        <p>x</p>
      </OnboardingFunnelShell>,
    );
    expect(
      screen.getByRole('list', { name: 'Onboarding progress' }),
    ).toBeInTheDocument();
  });

  it('hides the thread when showThread is false', () => {
    render(
      <OnboardingFunnelShell step="setup" showThread={false}>
        <p>x</p>
      </OnboardingFunnelShell>,
    );
    expect(
      screen.queryByRole('list', { name: 'Onboarding progress' }),
    ).toBeNull();
  });
});
