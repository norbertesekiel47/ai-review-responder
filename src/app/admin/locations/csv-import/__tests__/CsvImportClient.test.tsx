// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CSV_IMPORT_MACRO_PATH, CsvImportClient } from '../CsvImportClient';
import { validateLocationsCsvClient } from '../csv-validation';

describe('CsvImportClient', () => {
  it('validates row count and required client-side columns', () => {
    const rows = [
      { name: '', placeId: 'ChIJ1234' },
      { name: 'Downtown Cafe', placeId: '' },
      ...Array.from({ length: 100 }, () => ({
        name: 'Overflow Location',
        placeId: 'ChIJoverflow',
      })),
    ];

    expect(validateLocationsCsvClient(rows)).toEqual(
      expect.arrayContaining([
        { row: 0, reason: 'CSV contains more than 100 data rows.' },
        { row: 2, reason: 'Missing name.' },
        { row: 3, reason: 'Missing placeId.' },
      ]),
    );
  });

  it('renders the partial-success import report returned by the API', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          created: 1,
          failedCount: 1,
          failed: [{ row: 2, reason: 'Missing placeId.' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<CsvImportClient />);

    await user.type(
      screen.getByLabelText(/account id/i),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    await user.upload(
      screen.getByLabelText(/csv file/i),
      new File(['Name,PlaceID\nDowntown,ChIJ1234\nUptown,'], 'locations.csv', {
        type: 'text/csv',
      }),
    );
    await user.click(screen.getByRole('button', { name: /import locations/i }));

    expect(await screen.findByText('1 of 2 imported')).toBeInTheDocument();
    expect(screen.getByText('Line 3: Missing placeId.')).toBeInTheDocument();
    expect(screen.getByText('Row 2: Missing placeId.')).toBeInTheDocument();
    // X24: the operator IS support — the report points at the internal runbook,
    // not at the customer-facing contact form.
    expect(screen.queryByRole('link', { name: /contact support/i })).not.toBeInTheDocument();
    expect(screen.getByText(CSV_IMPORT_MACRO_PATH)).toBeInTheDocument();
    expect(screen.getByText(CSV_IMPORT_MACRO_PATH).tagName).toBe('CODE');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/locations/csv-import',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      }),
    );
  });

  // X24: no more pasting a UUID from a database console.
  it('finds the account by business name and fills the Account ID from the picked match', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/admin/businesses?')) {
        return new Response(
          JSON.stringify({
            businesses: [
              {
                id: 'biz-1',
                accountId: '11111111-2222-4333-8444-555555555555',
                name: 'Northstar Dental',
                subscriptionStatus: 'active',
              },
            ],
            total: 1,
            responseMetricsWindowDays: 30,
            limit: 8,
            offset: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CsvImportClient />);

    await user.type(screen.getByRole('combobox', { name: /find the account by business name/i }), 'North');

    const match = await screen.findByRole('button', { name: /Northstar Dental/ });
    // The search reuses the Businesses list's `q` search — one owner of name lookup.
    const searchUrl = String(fetchMock.mock.calls[0]![0]);
    expect(searchUrl).toBe('/api/admin/businesses?q=North&limit=8');
    // Debounced: one request for the settled term, not one per keystroke.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(match);

    expect(screen.getByLabelText(/^account id$/i)).toHaveValue('11111111-2222-4333-8444-555555555555');
    expect(screen.getByText('The billing account for Northstar Dental.')).toBeInTheDocument();
    // The picked list closes.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Northstar Dental/ })).not.toBeInTheDocument();
    });
  });

  it('prevents duplicate submits while an import is in flight', async () => {
    const user = userEvent.setup();
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<CsvImportClient />);

    await user.type(
      screen.getByLabelText(/account id/i),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    await user.upload(
      screen.getByLabelText(/csv file/i),
      new File(['name,placeId\nDowntown,ChIJ1234'], 'locations.csv', {
        type: 'text/csv',
      }),
    );

    const button = screen.getByRole('button', { name: /import locations/i });
    await user.click(button);
    expect(button).toBeDisabled();

    await user.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(
      new Response(JSON.stringify({ created: 1, failedCount: 0, failed: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(await screen.findByText('1 of 1 imported')).toBeInTheDocument();
  });
});
