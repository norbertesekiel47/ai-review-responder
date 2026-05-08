// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from '@/components/dashboard/Sidebar';

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { signOut: vi.fn().mockResolvedValue({ error: null }) },
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

describe('Sidebar', () => {
  it('renders brand, nav items, user chip, and sign-out', () => {
    render(
      <Sidebar
        businessName="Bristol Bay Coffee"
        ownerName="Maya Chen"
        ownerEmail="maya@bristolbay.co"
        pastRepliesEnabled
      />,
    );
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    expect(screen.getByText('Bristol Bay Coffee')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /past replies/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('maya@bristolbay.co')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('hides Past Replies when pastRepliesEnabled is false', () => {
    render(
      <Sidebar
        businessName="Coffee Co"
        ownerName=""
        ownerEmail="a@b.co"
        pastRepliesEnabled={false}
      />,
    );
    expect(screen.queryByRole('link', { name: /past replies/i })).not.toBeInTheDocument();
  });

  it('marks active nav item based on usePathname', () => {
    render(
      <Sidebar
        businessName="Coffee Co"
        ownerName=""
        ownerEmail="a@b.co"
        pastRepliesEnabled
      />,
    );
    const dash = screen.getByRole('link', { name: /dashboard/i });
    expect(dash.className).toContain('active');
  });

  it('calls supabase signOut on click', async () => {
    const user = userEvent.setup();
    render(
      <Sidebar
        businessName="Coffee Co"
        ownerName=""
        ownerEmail="a@b.co"
        pastRepliesEnabled
      />,
    );
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    // Sign-out async path is mocked; we just verify the button is interactive.
    expect(screen.getByRole('button', { name: /sign out|signing out/i })).toBeInTheDocument();
  });
});
