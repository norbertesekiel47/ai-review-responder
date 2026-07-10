// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutoApprovalClient } from '../AutoApprovalClient';
import type {
  AutoApprovalLocationSettings,
  AutoApprovalSettingsResponse,
} from '@/lib/auto-approval/types';

// Column-default dial values (the WS4 Task 12 API-state widening); the Task 13
// UI renders them.
const emptyPolicyState = {
  policyId: null,
  threshold: null,
  exists: false,
  vetoWindowMinutes: 15,
  dailyAutoPostCap: null,
  effectiveDailyCap: 10,
  suspended: false,
  suspendedReason: null,
} as const;

const LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000001';

const baseState: AutoApprovalSettingsResponse = {
  accountDefault: { ...emptyPolicyState },
  locations: [
    {
      locationId: LOCATION_ID,
      displayName: 'Main Cafe',
      override: { ...emptyPolicyState },
      effective: {
        threshold: null,
        source: 'none',
        inherited: true,
        vetoWindowMinutes: 15,
        dailyAutoPostCap: null,
        effectiveDailyCap: 10,
        suspended: false,
      },
    },
  ],
  readiness: {
    runtimeEnabled: true,
    providerModerationEnabled: true,
    providerModerationValidated: true,
    accountWritable: true,
    canExpand: true,
    blockReasons: [],
  },
};

/** A location that already has its own override row (threshold 5). */
function overriddenLocation(): AutoApprovalLocationSettings {
  return {
    locationId: LOCATION_ID,
    displayName: 'Main Cafe',
    override: {
      ...emptyPolicyState,
      policyId: 'policy-loc-1',
      threshold: 5,
      exists: true,
    },
    effective: {
      threshold: 5,
      source: 'location_override',
      inherited: false,
      vetoWindowMinutes: 15,
      dailyAutoPostCap: null,
      effectiveDailyCap: 10,
      suspended: false,
    },
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function patchBody(fetchMock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

describe('AutoApprovalClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders current account and location policy state, including dials', () => {
    render(<AutoApprovalClient initialState={baseState} />);

    expect(screen.getByRole('heading', { name: 'Auto-approval' })).toBeInTheDocument();
    expect(screen.getByLabelText('Account default policy')).toHaveValue('manual');
    expect(screen.getByText('Main Cafe')).toBeInTheDocument();
    expect(screen.getByText(/Inherited from account/)).toBeInTheDocument();

    expect(screen.getByLabelText('Account default veto window')).toHaveValue('15');
    expect(screen.getByLabelText('Veto window for Main Cafe')).toHaveValue('15');

    const accountCap = screen.getByLabelText('Account default daily auto-post cap');
    expect(accountCap).toHaveValue(null);
    expect(accountCap).toHaveAttribute('placeholder', 'Default (10)');
    expect(screen.getByLabelText('Daily auto-post cap for Main Cafe')).toHaveAttribute(
      'placeholder',
      'Default (10)',
    );
  });

  it('offers exactly Off / 5-star only / 4-5-star as threshold options', () => {
    render(<AutoApprovalClient initialState={baseState} />);

    const select = screen.getByLabelText('Account default policy');
    const options = within(select).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Off', '5★ only', '4–5★']);
  });

  it('disables expansion choices when readiness blocks expansion', () => {
    render(<AutoApprovalClient initialState={{
      ...baseState,
      readiness: {
        ...baseState.readiness,
        runtimeEnabled: false,
        canExpand: false,
        blockReasons: ['auto_approval_disabled'],
      },
    }} />);

    const select = screen.getByLabelText('Account default policy');
    expect(within(select).getByRole('option', { name: '4–5★' })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'Off' })).not.toBeDisabled();
    expect(screen.getByText(/Auto-approval is not enabled for this environment/i)).toBeInTheDocument();
  });

  it('requires confirmation before sending an expansion PATCH', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        ...baseState,
        accountDefault: { ...emptyPolicyState, policyId: 'policy-1', threshold: 4, exists: true },
      }));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.selectOptions(screen.getByLabelText('Account default policy'), '4');

    expect(await screen.findByRole('dialog', { name: 'Confirm auto-approval change' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/settings/auto-approval');
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    });
  });

  it('shows the suspended banner with the reason and blocks expansion when the account is suspended', () => {
    render(<AutoApprovalClient initialState={{
      ...baseState,
      accountDefault: {
        ...emptyPolicyState,
        policyId: 'policy-1',
        threshold: 5,
        exists: true,
        suspended: true,
        suspendedReason: 'Suspended after repeated owner vetoes',
      },
      readiness: {
        ...baseState.readiness,
        canExpand: false,
        blockReasons: ['policy_suspended'],
      },
    }} />);

    expect(screen.getByText(/Auto-approval is suspended for this account/i)).toBeInTheDocument();
    expect(screen.getByText('Suspended after repeated owner vetoes')).toBeInTheDocument();

    const select = screen.getByLabelText('Account default policy');
    expect(within(select).getByRole('option', { name: '4–5★' })).toBeDisabled();
  });

  it('surfaces a location-only suspension on that location row, not the global banner', () => {
    const suspendedLocation = overriddenLocation();
    suspendedLocation.override = {
      ...suspendedLocation.override,
      suspended: true,
      suspendedReason: 'Suspended after repeated owner vetoes',
    };
    suspendedLocation.effective = { ...suspendedLocation.effective, suspended: true };

    render(<AutoApprovalClient initialState={{ ...baseState, locations: [suspendedLocation] }} />);

    expect(screen.queryByText(/Auto-approval is suspended for this account/i)).not.toBeInTheDocument();
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    // The reason is visible text on the row, not just a hover-only chip title.
    expect(screen.getByText('Suspended after repeated owner vetoes')).toBeInTheDocument();
  });

  it('fires set_account_veto_window with the selected minutes', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({
      ...baseState,
      accountDefault: { ...emptyPolicyState, policyId: 'policy-1', exists: true, vetoWindowMinutes: 30 },
    }));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.selectOptions(screen.getByLabelText('Account default veto window'), '30');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({ operation: 'set_account_veto_window', minutes: 30 });
  });

  it('submits a location dial change directly when the location already has an override row', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(baseState));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={{ ...baseState, locations: [overriddenLocation()] }} />);

    await user.selectOptions(screen.getByLabelText('Veto window for Main Cafe'), '30');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_location_veto_window',
      locationId: LOCATION_ID,
      minutes: 30,
    });
  });

  it('interstitial: a dial change on an inheriting location submits only after confirm', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(baseState));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.selectOptions(screen.getByLabelText('Veto window for Main Cafe'), '30');

    const dialog = await screen.findByRole('dialog', { name: 'Give this location its own settings?' });
    expect(within(dialog).getByText(/switches to manual approval until you pick a threshold/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Main Cafe/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Give it its own settings' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_location_veto_window',
      locationId: LOCATION_ID,
      minutes: 30,
    });
  });

  it('interstitial: cancel submits nothing and the control snaps back', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.selectOptions(screen.getByLabelText('Veto window for Main Cafe'), '30');
    await screen.findByRole('dialog', { name: 'Give this location its own settings?' });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    // Controlled by server state, so the select snaps back to the inherited value.
    expect(screen.getByLabelText('Veto window for Main Cafe')).toHaveValue('15');
  });

  it('interstitial: a typed cap draft snaps back to the stored state on cancel', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    // Blur arms the draft: on an inheriting location the cap commit raises the
    // interstitial instead of PATCHing.
    const capInput = screen.getByLabelText('Daily auto-post cap for Main Cafe');
    await user.type(capInput, '7');
    await user.tab();
    await screen.findByRole('dialog', { name: 'Give this location its own settings?' });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    // The epoch bump remounts the draft-holding input back to the stored
    // (blank → placeholder) state instead of keeping the unsaved 7.
    const remountedCap = screen.getByLabelText('Daily auto-post cap for Main Cafe');
    expect(remountedCap).toHaveValue(null);
    expect(remountedCap).toHaveAttribute('placeholder', 'Default (10)');
  });

  it('a failed cap save shows the error and snaps the cap input back to the server value', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'internal_error' }, false, 500));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.type(screen.getByLabelText('Account default daily auto-post cap'), '25');
    await user.tab();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({ operation: 'set_account_daily_cap', cap: 25 });

    // Error surfaces (inline banner + live region) …
    expect((await screen.findAllByText('internal error')).length).toBeGreaterThan(0);
    // … and the epoch bump remounts the cap input back to the server value
    // instead of leaving the unsaved 25 on a safety dial.
    const remountedCap = screen.getByLabelText('Account default daily auto-post cap');
    expect(remountedCap).toHaveValue(null);
    expect(remountedCap).toHaveAttribute('placeholder', 'Default (10)');
  });

  it('daily cap commits on blur with the exact PATCH body', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({
      ...baseState,
      accountDefault: { ...emptyPolicyState, policyId: 'policy-1', exists: true, dailyAutoPostCap: 25, effectiveDailyCap: 25 },
    }));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.type(screen.getByLabelText('Account default daily auto-post cap'), '25');
    await user.tab();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({ operation: 'set_account_daily_cap', cap: 25 });
  });

  it('daily cap clamps to 1..50 before submitting', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(baseState));
    const user = userEvent.setup();

    const first = render(<AutoApprovalClient initialState={baseState} />);
    const highInput = screen.getByLabelText('Account default daily auto-post cap');
    await user.type(highInput, '99');
    await user.tab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock, 0)).toEqual({ operation: 'set_account_daily_cap', cap: 50 });
    first.unmount();

    render(<AutoApprovalClient initialState={baseState} />);
    const lowInput = screen.getByLabelText('Account default daily auto-post cap');
    await user.type(lowInput, '0');
    await user.tab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(patchBody(fetchMock, 1)).toEqual({ operation: 'set_account_daily_cap', cap: 1 });
  });

  it('clearing the daily cap submits null and falls back to the default placeholder', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(baseState));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={{
      ...baseState,
      accountDefault: { ...emptyPolicyState, policyId: 'policy-1', exists: true, dailyAutoPostCap: 25, effectiveDailyCap: 25 },
    }} />);

    const input = screen.getByLabelText('Account default daily auto-post cap');
    expect(input).toHaveValue(25);

    await user.clear(input);
    await user.tab();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({ operation: 'set_account_daily_cap', cap: null });
    expect(screen.getByLabelText('Account default daily auto-post cap')).toHaveAttribute(
      'placeholder',
      'Default (10)',
    );
  });

  it('location daily cap on an overridden location submits directly with the location op', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(baseState));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={{ ...baseState, locations: [overriddenLocation()] }} />);

    await user.type(screen.getByLabelText('Daily auto-post cap for Main Cafe'), '5');
    await user.tab();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_location_daily_cap',
      locationId: LOCATION_ID,
      cap: 5,
    });
  });

  it('does not submit when the committed daily cap equals the stored value', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.click(screen.getByLabelText('Account default daily auto-post cap'));
    await user.tab();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
