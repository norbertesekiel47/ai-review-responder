// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinishSignupClient } from '../FinishSignupClient';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('FinishSignupClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders visible (non-sr-only) labels for each field', () => {
    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);

    for (const text of [/email/i, /^your name$/i, /phone/i]) {
      const label = screen.getByText(text);
      expect(label.className).not.toContain('sr-only');
    }
  });

  it('renders the account email as disabled', () => {
    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);

    const email = screen.getByLabelText(/email/i);

    expect(email).toBeDisabled();
    expect(email).not.toHaveAttribute('readOnly');
  });

  it('renders the branded island, not gray/blue', () => {
    const { container } = render(
      <FinishSignupClient defaultEmail="a@b.co" defaultName="Ada" />,
    );
    expect(container.innerHTML).toContain('bg-[#D2E0D3]');
    expect(container.innerHTML).not.toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    const name = container.querySelector('input#finish-name');
    expect(name).not.toBeNull();
    expect(name!.className).toContain('text-base');
  });

  it('announces a submission error via an assertive live region', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ message: 'Submission failed' }),
      })) as unknown as typeof fetch,
    );

    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Submission failed');
    });
  });
});
