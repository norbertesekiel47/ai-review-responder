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

import { AccountMenu } from '@/components/dashboard/shell/AccountMenu';
import { OwnerIdentityProvider } from '@/contexts/OwnerIdentityContext';
import { ToastProvider } from '@/components/dashboard/shell/toast/ToastProvider';

function renderMenu(identity = { name: 'Ada Lovelace', email: 'ada@example.com' }) {
  return render(
    <OwnerIdentityProvider name={identity.name} email={identity.email}>
      <ToastProvider>
        <AccountMenu />
      </ToastProvider>
    </OwnerIdentityProvider>,
  );
}

/** The trigger is closed at rest, so every menu assertion opens it first. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /ada lovelace/i }));
  return screen.findByRole('menu');
}

describe('AccountMenu', () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    signOut.mockReset();
  });

  it('shows the owner name on the trigger and keeps the menu closed at rest', () => {
    renderMenu();

    const trigger = screen.getByRole('button', { name: /ada lovelace/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('falls back to the email local part when the owner has no name', () => {
    renderMenu({ name: '   ', email: 'grace@example.com' });

    expect(screen.getByRole('button', { name: /grace/i })).toBeInTheDocument();
  });

  it('opens to the account destinations and sign out', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    expect(screen.getByRole('menuitem', { name: /profile/i })).toHaveAttribute(
      'href',
      '/settings/profile',
    );
    expect(screen.getByRole('menuitem', { name: /plan and billing/i })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    expect(screen.getByRole('menuitem', { name: /security/i })).toHaveAttribute(
      'href',
      '/settings/security',
    );
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('moves focus through the menu with Arrow and End, then restores it on Escape', async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole('button', { name: /ada lovelace/i });

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /profile/i })).toHaveFocus(),
    );

    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('pushes /login after a successful sign out', async () => {
    signOut.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(push).not.toHaveBeenCalledWith('/admin/login');
  });

  it('raises an error toast and does not navigate when sign out returns an error', async () => {
    signOut.mockResolvedValue({ error: { message: 'nope' } });
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Sign out failed'));
    expect(push).not.toHaveBeenCalled();
  });

  it('raises an error toast and does not navigate when sign out throws', async () => {
    signOut.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Sign out failed'));
    expect(push).not.toHaveBeenCalled();
  });
});
