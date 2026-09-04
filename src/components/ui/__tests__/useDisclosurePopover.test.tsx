// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDisclosurePopover } from '../useDisclosurePopover';

/** The smallest thing that exercises the core: a trigger and a panel. */
function Harness({ idPrefix = 'test' }: { idPrefix?: string }) {
  const {
    open,
    containerRef,
    triggerRef,
    panelRef,
    triggerId,
    panelId,
    closeAndRestoreFocus,
    toggle,
  } = useDisclosurePopover<HTMLButtonElement>(idPrefix);

  return (
    <div>
      <div ref={containerRef}>
        <button type="button" id={triggerId} ref={triggerRef} onClick={toggle}>
          Open
        </button>
        <div id={panelId} ref={panelRef} hidden={!open}>
          Panel body
          <button type="button" onClick={closeAndRestoreFocus}>Dismiss</button>
        </div>
      </div>
      <p data-testid="outside">Somewhere else entirely</p>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Open' });
const panel = () => document.getElementById(trigger().id.replace('-trigger-', '-panel-'));

describe('useDisclosurePopover', () => {
  it('starts closed and toggles open', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(panel()).toHaveAttribute('hidden');
    await user.click(trigger());
    expect(panel()).not.toHaveAttribute('hidden');
  });

  it('mints ids from the prefix, so a caller can wire aria-controls', () => {
    render(<Harness idPrefix="account-menu" />);

    expect(trigger().id).toMatch(/^account-menu-trigger-/);
    expect(panel()?.id).toMatch(/^account-menu-panel-/);
  });

  // The behaviour change this seam carries. iOS Safari synthesises mouse
  // events from a tap only for elements it treats as clickable, so a
  // `mousedown` listener never fires for a tap on a plain <p> — which is most
  // of the dashboard body. `pointerdown` covers mouse, touch and pen at once.
  it('dismisses on an outside POINTERDOWN, not only a mouse press', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    expect(panel()).not.toHaveAttribute('hidden');

    // A bare pointerdown with no mousedown behind it — the touch case.
    screen.getByTestId('outside').dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );

    await waitFor(() => expect(panel()).toHaveAttribute('hidden'));
  });

  it('leaves a pointerdown INSIDE the container alone', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    panel()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(panel()).not.toHaveAttribute('hidden');
  });

  it('hands focus back to the trigger when it closes that way', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(panel()).toHaveAttribute('hidden');
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('stops listening once closed, so a stray pointerdown costs nothing', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    await user.click(trigger());
    expect(panel()).toHaveAttribute('hidden');

    screen.getByTestId('outside').dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );

    expect(panel()).toHaveAttribute('hidden');
  });
});
