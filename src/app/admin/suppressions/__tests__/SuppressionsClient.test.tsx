// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SuppressionsClient } from '../SuppressionsClient';

// The admin §7.2 servicing surface (#645; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.3,
// §8.2). Two of these tests exist because the Correction path's framing is the
// product decision, not styling: an affordance that reads as "undo the
// unsubscribe" invites the self-serve re-subscribe the spec forbids, and a
// failed correction that optimistically drops the row leaves an admin believing
// an opt-out was removed when it was not — the inverse hazard.

const SUPPRESSION_ID = '01900000-0000-7000-8000-000000000001';

const GLOBAL_ROW = {
  id: SUPPRESSION_ID,
  channel: 'email',
  normalizedHandle: 'person@example.com',
  scope: 'global',
  source: 'unsubscribe_one_click',
  accountId: null,
  accountName: null,
  createdByUserId: null,
  note: null,
  suppressedAt: '2026-08-01T10:00:00.000Z',
};

// The lookup wire body carries exactly what the surface renders — no `ok`
// discriminant. The route maps the service union at the boundary so a future
// variant of it cannot silently change what arrives here.
const LOOKUP_OK = {
  handle: 'person@example.com',
  rows: [GLOBAL_ROW],
  corrections: [],
};

const LOOKUP_URL = '/api/admin/suppressions/lookup';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(
  overrides: {
    lookup?: () => Response;
    entry?: () => Response;
    correct?: () => Response;
  } = {},
) {
  const spy = vi.fn(async (...args: FetchArgs) => {
    const url = String(args[0]);
    if (url === LOOKUP_URL) {
      return overrides.lookup?.() ?? jsonResponse(LOOKUP_OK);
    }
    if (url === '/api/admin/suppressions') {
      return (
        overrides.entry?.() ?? jsonResponse({ created: true, handle: 'person@example.com' })
      );
    }
    if (url === '/api/admin/suppressions/correct') {
      return overrides.correct?.() ?? jsonResponse({ corrected: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function callsTo(spy: ReturnType<typeof installFetch>, url: string): FetchArgs[] {
  return spy.mock.calls.filter((call) => String(call[0]) === url);
}

function lastCallTo(spy: ReturnType<typeof installFetch>, url: string): FetchArgs {
  const call = callsTo(spy, url).at(-1);
  if (call === undefined) throw new Error(`expected a fetch to ${url}`);
  return call;
}

function bodyOf(call: FetchArgs): unknown {
  return JSON.parse(String(call[1]?.body ?? '{}'));
}

function renderClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SuppressionsClient />
    </QueryClientProvider>,
  );
}

/** Drives region 1 to a rendered result — every correction test starts here. */
async function lookUpAddress(user: UserEvent): Promise<void> {
  await user.type(screen.getByLabelText('Email address', { selector: '#lookup-email' }), 'person@example.com');
  await user.click(screen.getByRole('button', { name: 'Look up' }));
}

describe('SuppressionsClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('never offers a re-subscribe affordance on the correction control', async () => {
    installFetch();
    const user = userEvent.setup();
    renderClient();
    await lookUpAddress(user);

    const control = await screen.findByRole('button', { name: 'Correct this record' });
    expect(control).toBeInTheDocument();

    // Every affordance on the page, not just the one: "Unsuppress" hiding on a
    // secondary button would be the same defect.
    const affordances = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .join(' | ');
    expect(affordances).toMatch(/correct/i);
    expect(affordances).not.toMatch(/re-?subscribe|unsuppress|restore|undo|opt.?back.?in/i);
  });

  it('keeps the correction submit disabled until a reason is entered', async () => {
    installFetch();
    const user = userEvent.setup();
    renderClient();
    await lookUpAddress(user);
    await user.click(await screen.findByRole('button', { name: 'Correct this record' }));

    expect(screen.getByRole('button', { name: 'Confirm correction' })).toBeDisabled();

    await user.type(screen.getByLabelText('Why is this record wrong?'), 'a');
    expect(screen.getByRole('button', { name: 'Confirm correction' })).toBeEnabled();
  });

  it('reports an already-suppressed entry as a no-op success, not an error', async () => {
    installFetch({
      entry: () => jsonResponse({ created: false, handle: 'person@example.com' }),
    });
    const user = userEvent.setup();
    renderClient();

    await user.type(
      screen.getByLabelText('Email address', { selector: '#entry-email' }),
      'person@example.com',
    );
    await user.type(
      screen.getByLabelText('Originating message reference'),
      'Re: your review request — 2026-08-01',
    );
    await user.click(screen.getByRole('button', { name: 'Record opt-out' }));

    // First-write-wins (§2.1): the ledger state is already correct, so this is a
    // success. Rendering it as a failure invites a confused admin to "fix" it.
    await waitFor(() => {
      expect(screen.getByText(/Already suppressed — no change/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('submits the selected suppression id and trimmed reason to the correction endpoint only after confirmation', async () => {
    const spy = installFetch();
    const user = userEvent.setup();
    renderClient();
    await lookUpAddress(user);
    await user.click(await screen.findByRole('button', { name: 'Correct this record' }));

    // Selecting a row is not the act. Nothing has been removed yet.
    expect(callsTo(spy, '/api/admin/suppressions/correct')).toHaveLength(0);

    await user.type(
      screen.getByLabelText('Why is this record wrong?'),
      '  admin typo on a mailbox reply  ',
    );
    expect(callsTo(spy, '/api/admin/suppressions/correct')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Confirm correction' }));

    await waitFor(() => {
      expect(callsTo(spy, '/api/admin/suppressions/correct')).toHaveLength(1);
    });
    expect(bodyOf(lastCallTo(spy, '/api/admin/suppressions/correct'))).toEqual({
      suppressionId: SUPPRESSION_ID,
      reason: 'admin typo on a mailbox reply',
    });
  });

  it('keeps the live suppression visible when correction fails', async () => {
    installFetch({ correct: () => jsonResponse({ error: 'internal_error' }, 500) });
    const user = userEvent.setup();
    renderClient();
    await lookUpAddress(user);
    await user.click(await screen.findByRole('button', { name: 'Correct this record' }));
    await user.type(screen.getByLabelText('Why is this record wrong?'), 'admin typo');
    await user.click(screen.getByRole('button', { name: 'Confirm correction' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/still in place/i);
    });
    // The row must survive the failure: an admin who believes an opt-out was
    // removed when it was not will re-enter it and mail the person twice.
    expect(screen.getByText('unsubscribe_one_click')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Correct this record' })).toBeInTheDocument();
  });

  it('tells the admin an already-corrected record was removed and never that it is still in place', async () => {
    let lookups = 0;
    const spy = installFetch({
      lookup: () => {
        lookups += 1;
        // Read 2 is the post-correction re-read: the row is gone, because the
        // other admin's correction removed it.
        return jsonResponse(lookups === 1 ? LOOKUP_OK : { ...LOOKUP_OK, rows: [] });
      },
      correct: () => jsonResponse({ error: 'not_found' }, 404),
    });
    const user = userEvent.setup();
    renderClient();
    await lookUpAddress(user);
    await user.click(await screen.findByRole('button', { name: 'Correct this record' }));
    await user.type(screen.getByLabelText('Why is this record wrong?'), 'admin typo');
    await user.click(screen.getByRole('button', { name: 'Confirm correction' }));

    // A 404 means the row was ALREADY removed — a concurrent correction by
    // another admin. The recipient is mailable again, so telling this admin the
    // suppression is "still in place" claims a protection that no longer
    // exists. That is the one sentence this screen must never produce here.
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(/already removed/i);
    expect(notice).toHaveTextContent(/no longer suppressing anyone/i);
    expect(notice).not.toHaveTextContent(/still in place/i);
    expect(screen.queryByText(/still in place/i)).toBeNull();
    // A raw API token is not copy: it says nothing about who is suppressed.
    expect(screen.queryByText(/not_found/)).toBeNull();

    // And the admin is left looking at current ledger state, not at the stale
    // row they just acted on.
    await waitFor(() => {
      expect(callsTo(spy, LOOKUP_URL)).toHaveLength(2);
    });
    expect(await screen.findByText('Not suppressed')).toBeInTheDocument();
  });

  it('sends the looked-up address in the request body and never in the URL', async () => {
    const spy = installFetch();
    const user = userEvent.setup();
    renderClient();
    await lookUpAddress(user);

    await waitFor(() => {
      expect(callsTo(spy, LOOKUP_URL)).toHaveLength(1);
    });
    // §9.5: a raw handle in a query string is logged by construction — access
    // logs, log drains, browser history — and no care inside the handler takes
    // it back out.
    const requestedUrls = spy.mock.calls.map((call) => String(call[0]));
    for (const url of requestedUrls) {
      expect(url).not.toMatch(/person@example\.com|person%40example/i);
    }
    const call = lastCallTo(spy, LOOKUP_URL);
    expect(call[1]?.method).toBe('POST');
    expect(bodyOf(call)).toEqual({ email: 'person@example.com' });
  });

  it('manual entry posts the email and required originating message reference to the entry endpoint', async () => {
    const spy = installFetch();
    const user = userEvent.setup();
    renderClient();

    // The note is what makes the entry auditable ten business days later, so
    // the submit stays closed until it exists.
    await user.type(
      screen.getByLabelText('Email address', { selector: '#entry-email' }),
      ' Person@Example.COM ',
    );
    expect(screen.getByRole('button', { name: 'Record opt-out' })).toBeDisabled();

    await user.type(
      screen.getByLabelText('Originating message reference'),
      'Re: stop emailing me — 2026-08-01',
    );
    await user.click(screen.getByRole('button', { name: 'Record opt-out' }));

    await waitFor(() => {
      expect(callsTo(spy, '/api/admin/suppressions')).toHaveLength(1);
    });
    expect(bodyOf(lastCallTo(spy, '/api/admin/suppressions'))).toEqual({
      email: 'Person@Example.COM',
      note: 'Re: stop emailing me — 2026-08-01',
    });
  });

  it('renders an unnormalizable address as an invalid email and never as not found', async () => {
    installFetch({ lookup: () => jsonResponse({ error: 'invalid_handle' }, 400) });
    const user = userEvent.setup();
    renderClient();
    await lookUpAddress(user);

    // "Not found" would read as "this person is not suppressed" — the one
    // wrong answer, because the address was never actually checked.
    expect(await screen.findByText('That is not a valid email address')).toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });
});
