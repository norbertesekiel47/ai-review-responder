// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { routerPush } = vi.hoisted(() => ({
  routerPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

import { ResetPasswordFormClient } from '../ResetPasswordFormClient';

afterEach(() => {
  vi.unstubAllGlobals();
  routerPush.mockClear();
});

describe('ResetPasswordFormClient portal variants', () => {
  it('owner portal renders the branded island with 16px inputs', () => {
    const { container } = render(
      <ResetPasswordFormClient portal="owner" brandName="RepWorth" />,
    );
    expect(container.innerHTML).toContain('bg-[#D2E0D3]');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    expect(container.querySelector('input#new-password')?.className).toContain('text-base');
  });

  it('admin portal keeps gray/blue exactly', () => {
    const { container } = render(
      <ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />,
    );
    expect(container.innerHTML).toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-[#D2E0D3]');
  });

  it('owner happy path — submits and pushes to redirectTo on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ redirectTo: '/dashboard' }),
      }),
    );
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'validPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'validPass1' } });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }).closest('form')!);
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('announces validation errors assertively (owner)', async () => {
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }).closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
    });
  });
});
