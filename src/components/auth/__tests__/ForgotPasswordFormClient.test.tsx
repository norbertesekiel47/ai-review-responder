// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ForgotPasswordFormClient } from '../ForgotPasswordFormClient';

afterEach(() => vi.unstubAllGlobals());

describe('ForgotPasswordFormClient portal variants', () => {
  it('owner portal renders the branded island (sage bg, no gray/blue)', () => {
    const { container } = render(
      <ForgotPasswordFormClient portal="owner" brandName="RepWorth" />,
    );
    expect(container.innerHTML).toContain('bg-[#D2E0D3]');
    expect(container.innerHTML).not.toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    expect(container.querySelector('input#forgot-email')?.className).toContain('text-base');
  });

  it('admin portal keeps the utilitarian gray/blue card exactly', () => {
    const { container } = render(
      <ForgotPasswordFormClient portal="admin" brandName="RepWorth Admin" />,
    );
    expect(container.innerHTML).toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-[#D2E0D3]');
  });

  it('announces the sent confirmation via a polite live region (owner)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<ForgotPasswordFormClient portal="owner" brandName="RepWorth" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.submit(screen.getByRole('button', { name: /send reset link/i }).closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/we.+sent a reset link/i);
    });
  });

  it('offers Resend and Back-to-sign-in after the sent state (owner)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<ForgotPasswordFormClient portal="owner" brandName="RepWorth" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.submit(screen.getByRole('button', { name: /send reset link/i }).closest('form')!);

    const resend = await screen.findByRole('button', { name: /resend/i });
    const back = screen.getByRole('link', { name: /back to sign in/i });
    expect(back).toHaveAttribute('href', '/login');

    fireEvent.click(resend);
    await waitFor(() => {
      // One submit + one resend = two POSTs to the same endpoint.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('preserves no-enumeration: identical success copy on connection failure (owner)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    render(<ForgotPasswordFormClient portal="owner" brandName="RepWorth" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.submit(screen.getByRole('button', { name: /send reset link/i }).closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/we.+sent a reset link/i);
    });
    // Same dead-end-avoidance affordances appear even though the request failed.
    expect(screen.getByRole('button', { name: /resend/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toBeInTheDocument();
  });

  it('admin portal does not gain the owner sent-state affordances', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<ForgotPasswordFormClient portal="admin" brandName="RepWorth Admin" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.submit(screen.getByRole('button', { name: /send reset link/i }).closest('form')!);
    await waitFor(() => {
      expect(screen.getByText(/we.+sent a reset link/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /resend/i })).not.toBeInTheDocument();
  });
});
