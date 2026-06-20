// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApprovalErrorState } from '../ApprovalErrorState';

describe('ApprovalErrorState', () => {
  it('renders genuine errors as an alert with support recovery and a demoted dashboard link', () => {
    render(<ApprovalErrorState message="This approval link has expired." />);

    expect(
      screen.getByText('This approval link has expired.'),
    ).toBeInTheDocument();

    // Genuine errors keep the alert role + support as the primary recovery.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /contact support/i }),
    ).toHaveAttribute('href', '/help/contact');

    // Dashboard is present but demoted (not the universal CTA for logged-out users).
    expect(
      screen.getByRole('link', { name: /dashboard/i }),
    ).toHaveAttribute('href', '/dashboard');
  });

  it('renders a used link as a neutral status, not an alarm', () => {
    render(
      <ApprovalErrorState
        message="This link has already been used."
        variant="used"
      />,
    );

    expect(
      screen.getByText('This link has already been used.'),
    ).toBeInTheDocument();
    // Neutral: status role (no alarm), reassurance, no support CTA.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByText(/no action is needed/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /contact support/i }),
    ).not.toBeInTheDocument();
    // Dashboard stays only as a quiet secondary link.
    expect(
      screen.getByRole('link', { name: /dashboard/i }),
    ).toHaveAttribute('href', '/dashboard');
  });
});
