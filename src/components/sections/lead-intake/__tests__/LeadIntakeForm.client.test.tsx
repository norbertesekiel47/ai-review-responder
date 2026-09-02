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
    await user.click(screen.getByRole('button', { name: /get early access/i }));

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
    // The success card offers one next step: from /pricing that is how it works (M19).
    expect(screen.getByRole('link', { name: /see how it works/i })).toHaveAttribute('href', '/how-it-works');
  });

  it('points the success card at pricing when the visitor is already on /how-it-works (M19)', async () => {
    stubFetch();
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="how-it-works" />);

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /get early access/i }));

    await screen.findByText(/you're on the waitlist/i);
    const next = screen.getByRole('link', { name: /see plans and pricing/i });
    expect(next).toHaveAttribute('href', '/pricing');
    expect(screen.queryByRole('link', { name: /see how it works/i })).not.toBeInTheDocument();
  });

  it('describes the Maps field by its hint and, once invalid, by its error too (M17)', async () => {
    stubFetch();
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="landing" />);

    const maps = screen.getByLabelText(/google maps link/i);
    const hintId = 'lead-intake-waitlist-landing-googleMapsUrl-hint';
    expect(maps).toHaveAttribute('aria-describedby', hintId);
    expect(document.getElementById(hintId)).toHaveTextContent(/paste your listing/i);

    await fillRequired(user);
    await user.type(maps, 'http://maps.google.com/?cid=1');
    await user.click(screen.getByRole('button', { name: /get early access/i }));

    expect(await screen.findByText('Please enter a valid https link.')).toBeInTheDocument();
    expect(maps).toHaveAttribute(
      'aria-describedby',
      `${hintId} lead-intake-waitlist-landing-googleMapsUrl-error`,
    );
  });

  it('omits the plan key entirely for a tier-less door', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="how-it-works" />);

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /get early access/i }));

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

    await user.click(screen.getByRole('button', { name: /get early access/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Please enter your name.')).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toHaveFocus();
  });

  it('surfaces the server error message and keeps the form', async () => {
    stubFetch(429, { error: 'Too many submissions. Try again later.' });
    const user = userEvent.setup();
    render(<LeadIntakeForm intent="waitlist" source="features" />);

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /get early access/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many submissions/i);
    expect(screen.getByRole('button', { name: /get early access/i })).toBeInTheDocument();
  });
});
