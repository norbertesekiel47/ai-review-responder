// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CsvImportClient } from '../CsvImportClient';
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
    expect(screen.getByRole('link', { name: /contact support/i })).toHaveAttribute(
      'href',
      '/help/contact',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/locations/csv-import',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      }),
    );
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
