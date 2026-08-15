// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Module-scope spies referenced only from inside the factories' inner arrows, so
// they are dereferenced at render time — never while vi.mock's hoisted factory
// runs (the PaymentSuccessClient.test.tsx precedent).
const push = vi.fn();
const refresh = vi.fn();
const signOut = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/dashboard',
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut } }),
}));

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ isMultiLocation: false }),
}));

vi.mock('@/contexts/PendingCountContext', () => ({
  usePendingCount: () => 0,
}));

import { Sidebar } from '@/components/dashboard/shell/Sidebar';

function renderSidebar() {
  return render(
    <Sidebar
      businessName="Bella Vista Dental"
      ownerName="Ada Lovelace"
      ownerEmail="ada@example.com"
      solicitationEnabled={false}
    />,
  );
}

describe('Sidebar sign out', () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    signOut.mockReset();
  });

  it('pushes /login after a successful sign out', async () => {
    signOut.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(push).not.toHaveBeenCalledWith('/admin/login');
  });

  it('does not navigate when sign out fails', async () => {
    signOut.mockResolvedValue({ error: { message: 'nope' } });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByText('Sign out failed')).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it('does not navigate when sign out throws', async () => {
    signOut.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByText('Sign out failed')).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });
});
