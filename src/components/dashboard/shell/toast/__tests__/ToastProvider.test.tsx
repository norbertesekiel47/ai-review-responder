// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastInput } from '@/components/dashboard/shell/toast/ToastProvider';

/** A button per tone, so a test raises a toast the way a real call site does. */
function Raiser({ inputs }: { inputs: ToastInput[] }) {
  const { toast } = useToast();
  return (
    <>
      {inputs.map((input) => (
        <button key={input.title} type="button" onClick={() => toast(input)}>
          raise {input.title}
        </button>
      ))}
    </>
  );
}

function renderWithProvider(inputs: ToastInput[]) {
  return render(
    <ToastProvider>
      <Raiser inputs={inputs} />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastProvider', () => {
  it('renders nothing until something is raised', () => {
    renderWithProvider([{ tone: 'success', title: 'Settings saved' }]);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('raises a success toast as a polite status', async () => {
    const user = userEvent.setup();
    renderWithProvider([{ tone: 'success', title: 'Settings saved' }]);

    await user.click(screen.getByRole('button', { name: /raise settings saved/i }));

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Settings saved');
    expect(toast).toHaveAttribute('aria-live', 'polite');
  });

  it('raises an error toast assertively and shows its body', async () => {
    const user = userEvent.setup();
    renderWithProvider([
      { tone: 'error', title: 'Sign out failed', body: 'You are still signed in.' },
    ]);

    await user.click(screen.getByRole('button', { name: /raise sign out failed/i }));

    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('Sign out failed');
    expect(toast).toHaveTextContent('You are still signed in.');
    expect(toast).toHaveAttribute('aria-live', 'assertive');
  });

  it('stacks more than one toast at a time', async () => {
    const user = userEvent.setup();
    renderWithProvider([
      { tone: 'success', title: 'First' },
      { tone: 'success', title: 'Second' },
    ]);

    await user.click(screen.getByRole('button', { name: /raise first/i }));
    await user.click(screen.getByRole('button', { name: /raise second/i }));

    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('dismisses on the close button', async () => {
    const user = userEvent.setup();
    renderWithProvider([{ tone: 'success', title: 'Settings saved' }]);

    await user.click(screen.getByRole('button', { name: /raise settings saved/i }));
    await user.click(screen.getByRole('button', { name: /dismiss: settings saved/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('auto-dismisses a success toast, and keeps an error up longer', async () => {
    vi.useFakeTimers();
    renderWithProvider([
      { tone: 'success', title: 'Settings saved' },
      { tone: 'error', title: 'Sign out failed' },
    ]);

    // fireEvent, not userEvent: userEvent awaits real timers between events and
    // deadlocks against the fake clock this test needs.
    fireEvent.click(screen.getByRole('button', { name: /raise settings saved/i }));
    fireEvent.click(screen.getByRole('button', { name: /raise sign out failed/i }));

    // `act` + the async advance, not `waitFor`: waitFor polls on real timers
    // and deadlocks against the fake clock this test installs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // The failure arm asks the owner to do something, so it outlives the
    // confirmation.
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is a no-op outside a provider, so a completed action never crashes', async () => {
    const user = userEvent.setup();
    render(<Raiser inputs={[{ tone: 'success', title: 'Orphan' }]} />);

    await user.click(screen.getByRole('button', { name: /raise orphan/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
