// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteDataOffboardingModal } from '../DeleteDataOffboardingModal';

it('shows a recoverable status-bearing message when password verification is not JSON', async () => {
  const json = vi.fn();
  vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: false,
    status: 401,
    headers: new Headers({ 'Content-Type': 'text/html' }),
    json,
  } as unknown as Response);
  const onConfirmed = vi.fn();
  const user = userEvent.setup();

  render(
    <DeleteDataOffboardingModal
      idempotencyKey="delete-test-key"
      onClose={() => {}}
      onConfirmed={onConfirmed}
    />,
  );

  await user.click(screen.getByRole('radio', { name: 'Too expensive' }));
  await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
  await user.type(screen.getByLabelText('Type DELETE DATA'), 'DELETE DATA');
  await user.click(screen.getByRole('button', { name: 'Confirm delete data' }));

  expect(await screen.findByText('Unable to verify password (401)')).toBeInTheDocument();
  expect(json).not.toHaveBeenCalled();
  expect(onConfirmed).not.toHaveBeenCalled();
});

// S4: the two most consequential inputs on the page use the shared `.input`
// primitive (console.css) — `set-input` existed in no stylesheet, so they
// rendered as browser defaults with no focus ring.
it('styles the password and confirmation inputs with the shared input primitive', () => {
  render(
    <DeleteDataOffboardingModal
      idempotencyKey="delete-test-key"
      onClose={() => {}}
      onConfirmed={() => {}}
    />,
  );

  expect(screen.getByLabelText('Password')).toHaveClass('input');
  expect(screen.getByLabelText('Type DELETE DATA')).toHaveClass('input');
  expect(document.querySelector('.set-input')).toBeNull();
});
