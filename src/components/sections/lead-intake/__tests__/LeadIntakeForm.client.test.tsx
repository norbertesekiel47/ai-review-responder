// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true,
}));

import { LeadIntakeForm } from '../LeadIntakeForm';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(status = 200, body: unknown = { success: true }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/your name/i), 'Dana Owner');
  await user.type(screen.getByLabelText(/email address/i), 'dana@example.com');
  await user.type(screen.getByLabelText(/business name/i), 'Dana Salon');
}

describe('LeadIntakeForm submit path', () => {
  it('sends the tier the visitor asked about when a per-plan door set it', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="pricing" plan="autopilot" />);

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /join waitlist/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      name: 'Dana Owner',
      email: 'dana@example.com',
      businessName: 'Dana Salon',
      intent: 'waitlist',
      source: 'pricing',
      plan: 'autopilot',
    });
    expect(await screen.findByText(/you're on the waitlist/i)).toBeInTheDocument();
  });

  it('omits the plan key entirely for a tier-less door', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="how-it-works" />);

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /join waitlist/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('plan');
    expect(body.source).toBe('how-it-works');
  });

  it('does not submit when a required field is empty, shows the field error and focuses it', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="pricing" />);

    await user.click(screen.getByRole('button', { name: /join waitlist/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Please enter your name.')).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toHaveFocus();
  });

  it('surfaces the server error message and keeps the form', async () => {
    stubFetch(429, { error: 'Too many submissions. Try again later.' });
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="features" />);

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /join waitlist/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many submissions/i);
    expect(screen.getByRole('button', { name: /join waitlist/i })).toBeInTheDocument();
  });
});
