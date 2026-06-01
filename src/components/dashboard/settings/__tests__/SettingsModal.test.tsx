// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../SettingsModal';

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
  });

  it('calls onClose when the backdrop button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.click(screen.getByRole('button', { name: 'Cancel archive' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('removes the Escape listener on unmount', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(
      <SettingsModal title="Archive location" closeLabel="Cancel archive" onClose={onClose}>
        <p>Body content</p>
      </SettingsModal>,
    );

    unmount();
    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
  });
});
