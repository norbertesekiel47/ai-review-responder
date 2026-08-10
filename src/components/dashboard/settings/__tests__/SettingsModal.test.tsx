// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';

describe('SettingsModal', () => {
  function renderModal(onClose = vi.fn()) {
    render(
      <SettingsModal title="Archive location" closeLabel="Cancel archive" onClose={onClose}>
        <p>Body content</p>
      </SettingsModal>,
    );
    return onClose;
  }

  it('exposes dialog semantics with the title as the accessible name', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Archive location' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Cancel archive. Press Escape to close.');
  });

  it('calls onClose when the full-viewport dialog backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onClose = renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Archive location' });

    await user.click(dialog);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when dialog content is clicked', async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.click(screen.getByText('Body content'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose from the native Escape cancel event', () => {
    const onClose = renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Archive location' });

    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
