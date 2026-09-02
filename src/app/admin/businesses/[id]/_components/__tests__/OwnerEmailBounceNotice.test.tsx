// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OwnerEmailBounceNotice } from '../OwnerEmailBounceNotice';

const idle = { submitting: false, error: null };

describe('OwnerEmailBounceNotice', () => {
  it('renders the notice with the bouncing address and a single arm button', () => {
    render(<OwnerEmailBounceNotice ownerEmail="owner@cafe.com" state={idle} onClear={() => {}} />);

    expect(screen.getByText(/Owner email is bouncing/)).toBeInTheDocument();
    expect(screen.getByText('owner@cafe.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear bounce flag…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clear flag and resume/ })).toBeNull();
  });

  it('arms into an inline confirm that states the consequence and needs a reason (X3)', async () => {
    const onClear = vi.fn();
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    render(<OwnerEmailBounceNotice ownerEmail="owner@cafe.com" state={idle} onClear={onClear} />);

    await userEvent.click(screen.getByRole('button', { name: 'Clear bounce flag…' }));

    expect(screen.getByText(/resumes every owner email to/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Clear flag and resume owner email' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/How was the address verified/), 'Owner replied from it');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Cancel disarms without clearing', async () => {
    const onClear = vi.fn();
    render(<OwnerEmailBounceNotice ownerEmail="owner@cafe.com" state={idle} onClear={onClear} />);

    await userEvent.click(screen.getByRole('button', { name: 'Clear bounce flag…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Clear bounce flag…' })).toBeInTheDocument();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('shows the in-flight and error states inline, where the button is', async () => {
    const { rerender } = render(
      <OwnerEmailBounceNotice ownerEmail="owner@cafe.com" state={idle} onClear={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clear bounce flag…' }));

    rerender(
      <OwnerEmailBounceNotice
        ownerEmail="owner@cafe.com"
        state={{ submitting: true, error: null }}
        onClear={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();

    rerender(
      <OwnerEmailBounceNotice
        ownerEmail="owner@cafe.com"
        state={{ submitting: false, error: 'Failed to clear flag: HTTP 502' }}
        onClear={() => {}}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to clear flag: HTTP 502');
  });
});
