// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

import { BETA_COMP_OFF_COPY, BETA_COMP_ON_COPY, NewBusinessClient } from '../NewBusinessClient';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('NewBusinessClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'biz-new' }, 201)));
  });

  // X10: the operator sees the Beta comp state BEFORE inviting; the boolean is
  // server-passed (invariant #13 — no NEXT_PUBLIC_ twin of BETA_COMP_COUPON_ID).
  it.each([
    [true, BETA_COMP_ON_COPY, 'bg-green-50'],
    [false, BETA_COMP_OFF_COPY, 'bg-yellow-50'],
  ])('renders the Beta comp notice for betaCompActive=%s', (active, copy, tone) => {
    render(<NewBusinessClient betaCompActive={active} />);
    const notice = screen.getByTestId('beta-comp-notice');
    expect(notice).toHaveTextContent(copy);
    expect(notice.className).toContain(tone);
  });

  // X12: `Field` generates the id, so the label is associated with its input.
  it('associates every label with its input through Field', () => {
    render(<NewBusinessClient betaCompActive={false} />);
    for (const label of ['Business Name *', 'Owner Name *', 'Email *']) {
      const input = screen.getByLabelText(label);
      expect(input.tagName).toBe('INPUT');
      expect(input.id).not.toBe('');
    }
  });

  it('marks an invalid field and points aria-describedby at its error line', async () => {
    const user = userEvent.setup();
    render(<NewBusinessClient betaCompActive={false} />);

    await user.click(screen.getByRole('button', { name: 'Create Business & Invite Owner' }));

    const name = await screen.findByLabelText('Business Name *');
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    const describedBy = name.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent('Business name is required');
    expect(fetch).not.toHaveBeenCalled();
  });

  // X11: the detail page flashes "Invite email sent to …" from a URL flag —
  // the flag, never the address, rides in the URL.
  it('redirects to the detail page with the invited flag after a successful invite', async () => {
    const user = userEvent.setup();
    render(<NewBusinessClient betaCompActive={true} />);

    await user.type(screen.getByLabelText('Business Name *'), 'Bella Vista');
    await user.type(screen.getByLabelText('Owner Name *'), 'Jane Smith');
    await user.type(screen.getByLabelText('Email *'), 'jane@example.com');
    await user.click(screen.getByRole('button', { name: 'Create Business & Invite Owner' }));

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/admin/businesses/biz-new?invited=1');
    });
    const pushed = String(routerPush.mock.calls[0]![0]);
    expect(pushed).not.toContain('jane');
  });

  it('shows the server error inline and stays on the form', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Email already in use' }, 409)));
    render(<NewBusinessClient betaCompActive={false} />);

    await user.type(screen.getByLabelText('Business Name *'), 'Bella Vista');
    await user.type(screen.getByLabelText('Owner Name *'), 'Jane Smith');
    await user.type(screen.getByLabelText('Email *'), 'jane@example.com');
    await user.click(screen.getByRole('button', { name: 'Create Business & Invite Owner' }));

    expect(await screen.findByText('Email already in use')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });
});
