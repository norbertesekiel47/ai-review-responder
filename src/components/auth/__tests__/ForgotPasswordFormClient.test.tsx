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
});
