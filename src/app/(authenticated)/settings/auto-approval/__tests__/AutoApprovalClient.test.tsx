// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutoApprovalClient } from '../AutoApprovalClient';
import type { AutoApprovalSettingsResponse } from '@/lib/auto-approval/types';

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

const baseState: AutoApprovalSettingsResponse = {
  accountDefault: { ...emptyPolicyState },
  locations: [
    {
      locationId: 'bbbbbbbb-0000-0000-0000-000000000001',
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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('AutoApprovalClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders current account and location policy state', () => {
    render(<AutoApprovalClient initialState={baseState} />);

    expect(screen.getByRole('heading', { name: 'Auto-approval' })).toBeInTheDocument();
    expect(screen.getByLabelText('Account default policy')).toHaveValue('manual');
    expect(screen.getByText('Main Cafe')).toBeInTheDocument();
    expect(screen.getByText(/Inherited from account/)).toBeInTheDocument();
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
    expect(within(select).getByRole('option', { name: '4-5' })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'Off/manual' })).not.toBeDisabled();
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
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    });
  });
});
