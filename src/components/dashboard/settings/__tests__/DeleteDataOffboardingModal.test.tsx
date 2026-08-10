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
