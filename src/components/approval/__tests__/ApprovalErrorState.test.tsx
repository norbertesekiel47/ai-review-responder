// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApprovalErrorState } from '../ApprovalErrorState';

describe('ApprovalErrorState', () => {
  it('shows the message plus dashboard and support recovery links', () => {
    render(<ApprovalErrorState message="This approval link has expired." />);

    expect(
      screen.getByText('This approval link has expired.'),
    ).toBeInTheDocument();

    const dashboard = screen.getByRole('link', { name: /dashboard/i });
    expect(dashboard).toHaveAttribute('href', '/dashboard');

    const support = screen.getByRole('link', { name: /contact support/i });
    expect(support).toHaveAttribute('href', '/help/contact');

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
