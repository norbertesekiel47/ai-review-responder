// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { ToastProvider } from '@/components/dashboard/shell/toast/ToastProvider';

function renderShell(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('SettingsShell announcements (P1 #18)', () => {
  it('announces "Settings saved" as a polite toast when savedFlash turns true', () => {
    renderShell(<SettingsShell savedFlash>body</SettingsShell>);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Settings saved');
  });

  it('says nothing when not flashing', () => {
    renderShell(<SettingsShell>body</SettingsShell>);

    // The always-mounted empty live region is gone: the toast IS the
    // announcement, so there is nothing to announce until one is raised.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('raises the confirmation once, not on every re-render', () => {
    const { rerender } = renderShell(<SettingsShell savedFlash>body</SettingsShell>);

    rerender(
      <ToastProvider>
        <SettingsShell savedFlash>body again</SettingsShell>
      </ToastProvider>,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('announces a save error in an assertive alert region', () => {
    renderShell(<SettingsShell saveError="Network error">body</SettingsShell>);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('Network error');
  });

  it('does not double-announce: the error keeps its live region, the save does not', () => {
    renderShell(
      <SettingsShell savedFlash saveError="Network error">
        body
      </SettingsShell>,
    );

    // One announcer per message — the toast for the confirmation, the live
    // region for the error, whose visible copy is an inline paragraph in each
    // settings client and carries no live semantics of its own.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
