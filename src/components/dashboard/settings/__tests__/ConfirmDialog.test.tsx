// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog';

afterEach(cleanup);

function arrange(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      title="Remove thing"
      closeLabel="Keep the thing"
      heading="Remove this thing?"
      body="It will be gone."
      cancelLabel="Keep it"
      confirmLabel="Remove thing"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onCancel, onConfirm };
}

describe('ConfirmDialog', () => {
  it('names the dialog, states the question and the consequence', () => {
    arrange();
    const dialog = screen.getByRole('dialog', { name: 'Remove thing' });
    expect(dialog).toHaveTextContent('Remove this thing?');
    expect(dialog).toHaveTextContent('It will be gone.');
    expect(dialog).toHaveTextContent('Keep the thing. Press Escape to close.');
  });

  it('routes the cancel button to onCancel and the confirm button to onConfirm', () => {
    const { onCancel, onConfirm } = arrange();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove thing' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('defaults the confirm control to the danger style and can render it as primary', () => {
    arrange();
    expect(screen.getByRole('button', { name: 'Remove thing' })).toHaveClass('btn-danger');
    cleanup();

    arrange({ confirmTone: 'primary', confirmLabel: 'Leave' });
    const confirm = screen.getByRole('button', { name: 'Leave' });
    expect(confirm).toHaveClass('btn', 'btn-primary');
    expect(confirm).not.toHaveClass('btn-danger');
  });

  it('disables both controls while busy, and neither otherwise', () => {
    arrange();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove thing' })).toBeEnabled();
    cleanup();

    arrange({ busy: true });
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove thing' })).toBeDisabled();
  });

  it('treats Escape as cancel', () => {
    const { onCancel } = arrange();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
