// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CompetitorsClient } from '../CompetitorsClient';
import type { RivalPickerView } from '@/lib/competitors/named-rival';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_BUSINESS_ID = '22222222-2222-4222-8222-222222222222';

const LOCATIONS = [{ id: BUSINESS_ID, name: 'Sunrise Cafe' }];

// The pack as `loadRivalPickerView` hands it over: our own row and any
// blank-place_id row already dropped, ordered rank ASC NULLS LAST then
// place_id ASC.
const READY_VIEW: RivalPickerView = {
  state: 'ready',
  businessId: BUSINESS_ID,
  keyword: 'coffee shop',
  options: [
    { placeId: 'place-ruby', title: 'Ruby Diner', rankPosition: 1, reviewCount: 412, rating: 4.6 },
    { placeId: 'place-bean', title: 'Bean & Bread', rankPosition: 4, reviewCount: 118, rating: 4.2 },
    { placeId: 'place-aaa', title: 'Corner Roasters', rankPosition: null, reviewCount: null, rating: null },
    { placeId: 'place-zzz', title: 'Night Owl Coffee', rankPosition: null, reviewCount: 51, rating: 3.9 },
  ],
  pick: null,
};

function jsonResponse(view: RivalPickerView, status = 200): Response {
  return new Response(JSON.stringify(view), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function optionTexts(select: HTMLElement): (string | null)[] {
  return within(select).getAllByRole('option').map((option) => option.textContent);
}

function renderClient(views: RivalPickerView[], multiLocation = false, locations = LOCATIONS) {
  return render(
    <CompetitorsClient views={views} locations={locations} multiLocation={multiLocation} />,
  );
}

describe('CompetitorsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('excludes is_self and blank-place_id rows from the pickable options and orders by rank then place_id', () => {
    // The server owns both exclusions and the ordering; what this asserts is
    // that the component renders the `options` it is handed verbatim — no
    // re-sorting, no re-filtering, and nothing invented. 'Sunrise Cafe' is our
    // own (is_self) row, and the blank-place_id row has no title here at all.
    renderClient([READY_VIEW]);

    const select = screen.getByRole('combobox');
    expect(optionTexts(select)).toEqual([
      'Auto-selected (nearest ahead)',
      '#1  Ruby Diner  412 · 4.6',
      '#4  Bean & Bread  118 · 4.2',
      '#—  Corner Roasters  — · —',
      '#—  Night Owl Coffee  51 · 3.9',
    ]);
    expect(within(select).queryByRole('option', { name: /Sunrise Cafe/ })).toBeNull();
  });

  it('lists a pick absent from the latest pack as the selected option using the stored title snapshot', () => {
    renderClient([{
      ...READY_VIEW,
      pick: { placeId: 'place-gone', title: 'Old Town Grill', inLatestPack: false },
    }]);

    const select = screen.getByRole<HTMLSelectElement>('combobox');
    expect(select.value).toBe('place-gone');
    expect(optionTexts(select).at(-1)).toBe('Old Town Grill — not in the latest pack');

    const dropped = within(select).getByRole<HTMLOptionElement>('option', {
      name: 'Old Town Grill — not in the latest pack',
    });
    expect(dropped.selected).toBe(true);
  });

  it('shows the not-configured state for a location with no primary tracked keyword', () => {
    renderClient([{ state: 'not_configured', businessId: BUSINESS_ID }]);

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(
      screen.getByText("Competitor tracking isn't set up for this location yet."),
    ).toBeInTheDocument();
  });

  it('shows the teaser state for a configured location with no persisted pack yet', () => {
    renderClient([{ state: 'awaiting_pack', businessId: BUSINESS_ID, keyword: 'coffee shop' }]);

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(
      screen.getByText(
        "We're watching 'coffee shop' — the first competitor pack lands after the next check.",
      ),
    ).toBeInTheDocument();
  });

  it('clears the pick and returns the location to the Auto-default rival when Auto-selected is chosen', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...READY_VIEW, pick: null }));
    vi.stubGlobal('fetch', fetchMock);

    renderClient([{
      ...READY_VIEW,
      pick: { placeId: 'place-ruby', title: 'Ruby Diner', inLatestPack: true },
    }]);

    const select = screen.getByRole<HTMLSelectElement>('combobox');
    expect(select.value).toBe('place-ruby');

    await userEvent.selectOptions(select, '');

    await waitFor(() => expect(select.value).toBe(''));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings/competitors');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ businessId: BUSINESS_ID, placeId: null });
  });

  it('reports a refreshed pack and reloads the view when the PUT is rejected as stale', async () => {
    const refreshed: RivalPickerView = {
      ...READY_VIEW,
      options: [
        { placeId: 'place-new', title: 'Third Wave', rankPosition: 1, reviewCount: 90, rating: 4.9 },
      ],
      pick: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse('pack_refreshed', 409))
      .mockResolvedValueOnce(jsonResponse(refreshed));
    vi.stubGlobal('fetch', fetchMock);

    renderClient([READY_VIEW]);

    await userEvent.selectOptions(screen.getByRole('combobox'), 'place-bean');

    expect(
      await screen.findByText(
        "The competitor pack refreshed while you were choosing — we've reloaded the latest rivals.",
        { selector: 'p' },
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(optionTexts(screen.getByRole('combobox'))).toEqual([
        'Auto-selected (nearest ahead)',
        '#1  Third Wave  90 · 4.9',
      ]);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/settings/competitors?businessId=${BUSINESS_ID}`,
    );
  });

  it('renders one labelled block per location when the account is multi-location', () => {
    renderClient(
      [
        READY_VIEW,
        { state: 'awaiting_pack', businessId: SECOND_BUSINESS_ID, keyword: 'bakery' },
      ],
      true,
      [...LOCATIONS, { id: SECOND_BUSINESS_ID, name: 'Harbour Bakery' }],
    );

    const sunrise = screen.getByRole('group', { name: 'Sunrise Cafe' });
    expect(within(sunrise).getByRole('combobox')).toBeInTheDocument();

    const harbour = screen.getByRole('group', { name: 'Harbour Bakery' });
    expect(within(harbour).queryByRole('combobox')).toBeNull();
    expect(
      within(harbour).getByText(
        "We're watching 'bakery' — the first competitor pack lands after the next check.",
      ),
    ).toBeInTheDocument();
  });
});
