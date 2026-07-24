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
  };

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
});
