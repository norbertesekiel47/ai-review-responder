// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UploadStatus } from '@/lib/solicitation/uploads';
import type { IngestReport } from '@/lib/solicitation/ingest';

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: 'loc-1' }),
}));

import { UploadCard } from '../UploadCard';
import { ContactList } from '../ContactList';

const ATTESTATION = {
  attestationText: 'I confirm these customers are mine.',
  attestationVersion: 'v1',
};

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function report(overrides: Partial<IngestReport> = {}): IngestReport {
  return {
    contactsCreated: 0,
    contactsMerged: 0,
    visitsAdded: 0,
    duplicateVisits: 0,
    rejected: [],
    structuralFailure: null,
    ...overrides,
  };
}

function uploadStatus(overrides: Partial<UploadStatus> = {}): UploadStatus {
  return {
    id: 'u1',
    status: 'completed',
    filename: 'customers.csv',
    createdAt: '2026-07-24T00:00:00Z',
    completedAt: '2026-07-24T00:00:05Z',
    report: report(),
    ...overrides,
  };
}

async function chooseFileAndAttest(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(['name,email,last_visit_date\n'], 'customers.csv', {
    type: 'text/csv',
  });
  await user.upload(screen.getByLabelText(/csv file/i), file);
  await user.click(screen.getByLabelText(ATTESTATION.attestationText));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('UploadCard', () => {
  it('disables the submit button until a file is chosen and the attestation is checked', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn());
    render(<UploadCard {...ATTESTATION} onIngestCompleted={() => {}} />);

    const submit = screen.getByRole('button', { name: /upload csv/i });
    expect(submit).toBeDisabled();
    await chooseFileAndAttest(user);
    expect(submit).toBeEnabled();
  });

  it('submits, polls to the completed report, renders counts + rejected rows, and fires onIngestCompleted', async () => {
    const user = userEvent.setup();
    const completed = uploadStatus({
      report: report({
        contactsCreated: 3,
        contactsMerged: 1,
        visitsAdded: 4,
        duplicateVisits: 2,
        rejected: [{ row: 5, reason: 'invalid_email' }],
      }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { uploadId: 'u1' }))
      .mockResolvedValueOnce(jsonResponse(200, completed));
    vi.stubGlobal('fetch', fetchMock);
    const onIngestCompleted = vi.fn();
    render(<UploadCard {...ATTESTATION} onIngestCompleted={onIngestCompleted} />);

    await chooseFileAndAttest(user);
    await user.click(screen.getByRole('button', { name: /upload csv/i }));

    // The visible copy and the sr-only LiveRegion both carry the message.
    expect(await screen.findAllByText(/finished processing/i)).toHaveLength(2);
    expect(screen.getByText('Contacts created')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/rejected rows \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText('Invalid email')).toBeInTheDocument();
    expect(onIngestCompleted).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/uploads/u1?scope=loc-1');
  });

  it('renders each terminal failure distinctly (structural vs subscription_inactive)', async () => {
    const user = userEvent.setup();
    const failed = uploadStatus({
      status: 'failed',
      report: report({ structuralFailure: 'row_count_over_cap' }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { uploadId: 'u1' }))
      .mockResolvedValueOnce(jsonResponse(200, failed));
    vi.stubGlobal('fetch', fetchMock);
    render(<UploadCard {...ATTESTATION} onIngestCompleted={() => {}} />);

    await chooseFileAndAttest(user);
    await user.click(screen.getByRole('button', { name: /upload csv/i }));

    // The visible alert and the sr-only LiveRegion both carry the message.
    expect(
      await screen.findAllByText(/has more than 5,000 data rows\. Nothing was imported\./i),
    ).toHaveLength(2);
    expect(screen.getByRole('button', { name: /try another upload/i })).toBeInTheDocument();
  });

  it('maps a 413 submit response onto the file-field error', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(413, {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<UploadCard {...ATTESTATION} onIngestCompleted={() => {}} />);

    await chooseFileAndAttest(user);
    await user.click(screen.getByRole('button', { name: /upload csv/i }));

    expect(await screen.findByText('File exceeds 5 MB.')).toBeInTheDocument();
  });
});

describe('ContactList', () => {
  const contact = {
    id: 'c1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+14155552671',
    lastVisitDate: '2026-01-05',
    visitCount: 2,
    suppression: null,
  };

  /** The §7.4 display seam's own output, hand-built: the component's contract is
   *  that it renders `label`/`detail` verbatim and branches only on
   *  `clearableByOwner`, so it must never re-derive copy of its own. Mirrors
   *  SUPPRESSION_DISPLAY_COPY without importing the server module. */
  const GLOBAL_DISPLAY = {
    state: 'global',
    label: 'Opted out of RepWorth review requests',
    detail: 'This person opted out of review requests. We will not contact them.',
    clearableByOwner: false,
  };
  const ACCOUNT_DISPLAY = {
    state: 'account',
    label: 'You marked this contact do-not-contact',
    detail: 'You asked us not to send this contact review requests. You can undo this.',
    clearableByOwner: true,
  };

  /** Exactly what `withSolicitationScope` builds for each mutation. Written out
   *  in full because the whole hazard is these two being confused: the first
   *  changes whether we may mail a handle, the second erases a customer. */
  const SUPPRESSION_URL = '/api/dashboard/contacts/c1/suppression?scope=loc-1';
  const CONTACT_DELETE_URL = '/api/dashboard/contacts/c1?scope=loc-1';

  const urlsOf = (mock: ReturnType<typeof vi.fn>) =>
    mock.mock.calls.map((call) => String(call[0]));

  /** One-contact page whose suppression field is whatever the API sent. */
  const page = (suppression: unknown) =>
    jsonResponse(200, { contacts: [{ ...contact, suppression }], total: 1 });

  it('renders the fetched page with formatted visit date and total', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { contacts: [contact], total: 1 })),
    );
    render(<ContactList epoch={0} onRefresh={() => {}} />);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Jan 5, 2026')).toBeInTheDocument();
    expect(screen.getByText('1 total')).toBeInTheDocument();
  });

  it('renders the empty state when the page has no contacts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { contacts: [], total: 0 })),
    );
    render(<ContactList epoch={0} onRefresh={() => {}} />);

    expect(await screen.findByText(/no contacts yet/i)).toBeInTheDocument();
  });

  it('renders the error state with a Retry button wired to onRefresh', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const onRefresh = vi.fn();
    render(<ContactList epoch={0} onRefresh={onRefresh} />);

    expect(await screen.findByText(/failed to load contacts \(500\)/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('confirm-step hard delete: DELETE on confirm, then onRefresh', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { contacts: [contact], total: 1 }))
      .mockResolvedValueOnce({ status: 204, ok: true, json: async () => null } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const onRefresh = vi.fn();
    render(<ContactList epoch={0} onRefresh={onRefresh} />);

    await user.click(await screen.findByRole('button', { name: /delete ada lovelace/i }));
    expect(screen.getByText(/hard delete/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/contacts/c1?scope=loc-1');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  // ── §7.4 suppression state + the do-not-contact controls (#645) ───────────

  it('shows an opted-out contact as opted out and offers no way to undo a global row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(GLOBAL_DISPLAY)));
    render(<ContactList epoch={0} onRefresh={() => {}} />);

    expect(await screen.findByText(GLOBAL_DISPLAY.label)).toBeInTheDocument();
    // §7.6: not a disabled clear control, not a tooltip explaining why — NOTHING.
    // A greyed-out button would present clearing a recipient's own revocation
    // and clearing the owner's preference as the same act.
    expect(
      screen.queryByRole('button', { name: /allow|undo|clear/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /don'?t contact/i }),
    ).not.toBeInTheDocument();
    // The copy states the opt-out honestly and never as a scheduling accident.
    expect(document.body.textContent?.toLowerCase()).not.toContain('skipped');
  });

  it('offers the owner a way to undo their own do-not-contact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(ACCOUNT_DISPLAY)));
    render(<ContactList epoch={0} onRefresh={() => {}} />);

    expect(await screen.findByText(ACCOUNT_DISPLAY.label)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /allow requests again/i }),
    ).toBeInTheDocument();
    // Already marked: the surface must not offer to mark it a second time.
    expect(
      screen.queryByRole('button', { name: /don'?t contact/i }),
    ).not.toBeInTheDocument();
  });

  it('never renders another account name on a suppressed contact', async () => {
    // The API excludes provenance by construction (the display seam returns a
    // closed four-key object). This asserts the component does not reintroduce
    // it: extra keys are fed in exactly as a widened API would ship them.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        page({
          ...GLOBAL_DISPLAY,
          accountName: 'Sunrise Diner',
          accountId: '11111111-2222-3333-4444-555555555555',
          source: 'complaint',
          note: 'forwarded mailbox reply',
        }),
      ),
    );
    render(<ContactList epoch={0} onRefresh={() => {}} />);

    expect(await screen.findByText(GLOBAL_DISPLAY.label)).toBeInTheDocument();
    const rendered = document.body.innerHTML;
    for (const leak of [
      'Sunrise Diner',
      '11111111-2222-3333-4444-555555555555',
      'complaint',
      'forwarded mailbox reply',
    ]) {
      expect(rendered).not.toContain(leak);
    }
  });

  it('marking do-not-contact posts to the suppression endpoint and never hard-deletes the contact', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(null))
      .mockResolvedValueOnce(jsonResponse(200, { state: 'marked', alreadyMarked: false }));
    vi.stubGlobal('fetch', fetchMock);
    const onRefresh = vi.fn();
    render(<ContactList epoch={0} onRefresh={onRefresh} />);

    await user.click(await screen.findByRole('button', { name: /don'?t contact ada/i }));
    // Same confirm-step pattern as the delete control: nothing is sent yet.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /stop sending requests/i }));

    expect(urlsOf(fetchMock)).toContain(SUPPRESSION_URL);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    // The hazard this test exists for: wiring the mark button to the contact
    // endpoint would erase a customer record instead of suppressing a handle.
    expect(urlsOf(fetchMock)).not.toContain(CONTACT_DELETE_URL);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('clearing owner do-not-contact deletes the suppression endpoint and never deletes the contact endpoint', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(ACCOUNT_DISPLAY))
      .mockResolvedValueOnce(jsonResponse(200, { state: 'cleared' }));
    vi.stubGlobal('fetch', fetchMock);
    const onRefresh = vi.fn();
    render(<ContactList epoch={0} onRefresh={onRefresh} />);

    await user.click(await screen.findByRole('button', { name: /allow requests again/i }));

    expect(urlsOf(fetchMock)).toContain(SUPPRESSION_URL);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
    // Mirrored hazard: the clear control shares a verb with the hard delete.
    expect(urlsOf(fetchMock)).not.toContain(CONTACT_DELETE_URL);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('a failed suppression mutation does not refresh into an apparently successful state', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(null))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'Failed to update contact' }));
    vi.stubGlobal('fetch', fetchMock);
    const onRefresh = vi.fn();
    render(<ContactList epoch={0} onRefresh={onRefresh} />);

    await user.click(await screen.findByRole('button', { name: /don'?t contact ada/i }));
    await user.click(screen.getByRole('button', { name: /stop sending requests/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update contact');
    // Bumping the epoch here would refetch an unchanged page and re-render the
    // row as though the change landed.
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText(GLOBAL_DISPLAY.label)).not.toBeInTheDocument();
    expect(screen.queryByText(ACCOUNT_DISPLAY.label)).not.toBeInTheDocument();
    // Still retryable, still not marked.
    expect(
      screen.getByRole('button', { name: /stop sending requests/i }),
    ).toBeInTheDocument();
  });
});
