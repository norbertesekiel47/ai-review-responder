// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  // #1314: no Posting block — the account is structurally eligible to auto-post.
  posting: { blocked: false, reasons: [] },
  // #631 D20: unavailable by default so the existing Reply-lane tests render
  // no Solicitation card; the solicitation describe block opts in explicitly.
  solicitation: {
    available: false,
    enabled: false,
    dailySendCap: null,
    vetoWindowMinutes: null,
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

  it('renders current account and location policy state, with account dials', () => {
    render(<AutoApprovalClient initialState={baseState} />);

    expect(screen.getByRole('heading', { name: 'Auto-approval' })).toBeInTheDocument();
    expect(screen.getByLabelText('Account default policy')).toHaveValue('manual');
    expect(screen.getByText('Main Cafe')).toBeInTheDocument();
    expect(screen.getByText(/Follows the account default/)).toBeInTheDocument();

    expect(screen.getByLabelText('Account default veto window')).toHaveValue('15');

    const accountCap = screen.getByLabelText('Account default daily auto-post cap');
    expect(accountCap).toHaveValue(null);
    expect(accountCap).toHaveAttribute('placeholder', 'Default (10)');
  });

  // S3: a location that follows the account default shows NO dials — a dial
  // change used to create an override row and silently flip the location to
  // manual approval. The owner opts in through one explicit button instead.
  it('hides the per-location dials while the location follows the account default', () => {
    render(<AutoApprovalClient initialState={baseState} />);

    expect(screen.queryByLabelText('Veto window for Main Cafe')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Daily auto-post cap for Main Cafe')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Give Main Cafe its own veto window and daily cap/ })).toBeInTheDocument();
  });

  it('shows the per-location dials once the location has its own settings', () => {
    render(<AutoApprovalClient initialState={{ ...baseState, locations: [overriddenLocation()] }} />);

    expect(screen.getByLabelText('Veto window for Main Cafe')).toHaveValue('15');
    expect(screen.getByLabelText('Daily auto-post cap for Main Cafe')).toHaveAttribute('placeholder', 'Default (10)');
    expect(screen.queryByRole('button', { name: /its own veto window and daily cap/ })).not.toBeInTheDocument();
  });

  // S2: the page leads with the current state in one sentence.
  describe('status banner', () => {
    it('says Off when the account default is manual and no location posts on its own', () => {
      render(<AutoApprovalClient initialState={baseState} />);
      const banner = screen.getByTestId('auto-approval-status');
      expect(within(banner).getByText(/^Off\. You approve every reply before it posts\.$/)).toBeInTheDocument();
      expect(within(banner).queryByRole('button', { name: 'Turn off auto-posting' })).not.toBeInTheDocument();
    });

    it('interpolates threshold, veto window and daily cap, explains the veto window, and offers one-tap off', async () => {
      const state: AutoApprovalSettingsResponse = {
        ...baseState,
        accountDefault: {
          ...emptyPolicyState,
          policyId: 'policy-1',
          exists: true,
          threshold: 4,
          vetoWindowMinutes: 30,
          dailyAutoPostCap: 12,
          effectiveDailyCap: 12,
        },
      };
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(baseState));
      const user = userEvent.setup();
      render(<AutoApprovalClient initialState={state} />);

      const banner = screen.getByTestId('auto-approval-status');
      expect(within(banner).getByText(
        "4–5★ reviews post a reply automatically 30 minutes after you're notified, up to 12 a day.",
      )).toBeInTheDocument();
      expect(within(banner).getByText(/Those 30 minutes are your veto window, the time you have to stop a reply before it posts\./))
        .toBeInTheDocument();

      // Turning off is a contraction: no confirmation, straight to the same
      // server route the select uses.
      await user.click(within(banner).getByRole('button', { name: 'Turn off auto-posting' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/settings/auto-approval');
      expect(patchBody(fetchMock)).toEqual({ operation: 'set_account_manual' });
    });

    // #1314 — the Posting block: the headline stops claiming replies post when
    // the account is not structurally eligible to auto-post.
    describe('posting block', () => {
      const armedAccount = {
        ...emptyPolicyState,
        policyId: 'policy-1',
        exists: true,
        threshold: 5 as const,
      };

      function blocked(
        reasons: AutoApprovalSettingsResponse['posting']['reasons'],
        overrides: Partial<AutoApprovalSettingsResponse> = {},
      ): AutoApprovalSettingsResponse {
        return {
          ...baseState,
          accountDefault: { ...armedAccount },
          posting: { blocked: true, reasons },
          ...overrides,
        };
      }

      it('headline does not claim automatic posting for an armed policy on a copilot tier', () => {
        render(<AutoApprovalClient initialState={blocked(['autopilot_tier_required'])} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).queryByText(/post a reply automatically/)).not.toBeInTheDocument();
        expect(within(banner).getByText(
          'Set to 5★ only, but no reply posts automatically right now.',
        )).toBeInTheDocument();
      });

      it('headline names the autopilot tier reason for an armed policy on a copilot tier', () => {
        render(<AutoApprovalClient initialState={blocked(['autopilot_tier_required'])} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).getByText(
          'Auto-posting is part of the Autopilot plan, and this account is on Copilot.',
        )).toBeInTheDocument();
        expect(within(banner).getByText(
          'Every reply waits for your approval until that changes.',
        )).toBeInTheDocument();
      });

      it('headline does not claim automatic posting for an armed policy when the runtime flag is off', () => {
        render(<AutoApprovalClient initialState={blocked(['runtime_disabled'])} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).queryByText(/post a reply automatically/)).not.toBeInTheDocument();
        expect(within(banner).getByText('Auto-posting is not switched on for RepWorth yet.'))
          .toBeInTheDocument();
      });

      // THE TRAP, at the screen. AUTOPILOT_PURCHASABLE=false gives an Autopilot
      // account the readiness reason while the runtime keeps posting. A headline
      // driven by readiness would print a correction over a true sentence.
      it('headline still claims automatic posting for an autopilot tier whose sale is paused', () => {
        render(<AutoApprovalClient initialState={{
          ...baseState,
          accountDefault: { ...armedAccount },
          posting: { blocked: false, reasons: [] },
          readiness: {
            ...baseState.readiness,
            canExpand: false,
            blockReasons: ['autopilot_unavailable'],
          },
        }} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).getByText(/post a reply automatically/)).toBeInTheDocument();
        expect(within(banner).queryByText(/no reply posts automatically right now/))
          .not.toBeInTheDocument();
      });

      it('headline does not claim automatic posting for an armed autopilot policy when the judge flag is off', () => {
        render(<AutoApprovalClient initialState={blocked(['judge_disabled'])} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).queryByText(/post a reply automatically/)).not.toBeInTheDocument();
        expect(within(banner).getByText(
          'Our reply review step is switched off right now, and nothing posts without it.',
        )).toBeInTheDocument();
      });

      it('suspended headline wins over a posting block', () => {
        render(<AutoApprovalClient initialState={blocked(['runtime_disabled'], {
          accountDefault: {
            ...emptyPolicyState,
            policyId: 'policy-1',
            exists: true,
            threshold: 5,
            suspended: true,
            suspendedReason: 'Too many owner edits.',
          },
        })} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).getByText('Auto-approval is suspended for this account.'))
          .toBeInTheDocument();
        expect(within(banner).queryByText(/no reply posts automatically right now/))
          .not.toBeInTheDocument();
        expect(banner).toHaveAttribute('role', 'alert');
      });

      it('headline does not claim location overrides post when posting is structurally blocked', () => {
        render(<AutoApprovalClient initialState={blocked(['runtime_disabled'], {
          accountDefault: { ...emptyPolicyState },
          locations: [overriddenLocation()],
        })} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).queryByText(/posts replies automatically with its own settings/))
          .not.toBeInTheDocument();
        expect(within(banner).getByText(
          'Main Cafe is set to post replies automatically, but no reply posts automatically right now.',
        )).toBeInTheDocument();
      });

      // The plain "Off" sentence is already true, so a structural block must not
      // turn it into a correction.
      it('plain off headline still renders when no threshold is set and posting is blocked', () => {
        render(<AutoApprovalClient initialState={blocked(['runtime_disabled'], {
          accountDefault: { ...emptyPolicyState },
        })} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).getByText('Off. You approve every reply before it posts.'))
          .toBeInTheDocument();
        expect(within(banner).queryByText(/no reply posts automatically right now/))
          .not.toBeInTheDocument();
      });

      it('blocked headline keeps the turn off auto-posting action', () => {
        render(<AutoApprovalClient initialState={blocked(['runtime_disabled'])} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).getByRole('button', { name: 'Turn off auto-posting' }))
          .toBeInTheDocument();
      });

      // `set_account_manual` clears only the account default, so on an
      // override-only account it changes nothing and leaves those locations
      // armed to resume the moment the block clears.
      it('blocked override-only headline does not offer an account-default turn-off action', () => {
        render(<AutoApprovalClient initialState={blocked(['runtime_disabled'], {
          accountDefault: { ...emptyPolicyState },
          locations: [overriddenLocation()],
        })} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).queryByRole('button', { name: 'Turn off auto-posting' }))
          .not.toBeInTheDocument();
      });

      it('headline does not claim automatic posting when provider moderation is the only posting block', () => {
        render(<AutoApprovalClient initialState={blocked(['provider_moderation_disabled'])} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).queryByText(/post a reply automatically/)).not.toBeInTheDocument();
        expect(within(banner).getByText(
          'Safety screening for replies is switched off right now, so nothing posts on its own.',
        )).toBeInTheDocument();
      });

      it('headline does not claim automatic posting when publisher subscription denial is the only posting block', () => {
        render(<AutoApprovalClient initialState={blocked(['publisher_subscription_denied'])} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).queryByText(/post a reply automatically/)).not.toBeInTheDocument();
        expect(within(banner).getByText('Your billing needs attention before any reply can post.'))
          .toBeInTheDocument();
      });

      // The two facts are contradictory on purpose: posting happens, expansion
      // is blocked. A headline driven by `!readiness.canExpand` fails only here.
      it('headline remains on when posting is unblocked but readiness blocks expansion for autopilot_unavailable', () => {
        render(<AutoApprovalClient initialState={{
          ...baseState,
          accountDefault: { ...armedAccount },
          posting: { blocked: false, reasons: [] },
          readiness: {
            runtimeEnabled: true,
            providerModerationEnabled: true,
            providerModerationValidated: true,
            accountWritable: true,
            canExpand: false,
            blockReasons: ['autopilot_unavailable'],
          },
        }} />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(within(banner).getByText(/post a reply automatically/)).toBeInTheDocument();
        expect(banner).toHaveClass('banner-blue');
      });

      // Text-only assertions would let the presentation stay wrong: an alarm
      // colour, role="alert", or only the first reason rendered.
      it('blocked headline uses the attention banner and renders every posting reason on its own detail line', () => {
        render(<AutoApprovalClient
          initialState={blocked(['runtime_disabled', 'judge_disabled'])}
        />);

        const banner = screen.getByTestId('auto-approval-status');
        expect(banner).toHaveClass('banner-attn');
        expect(banner).not.toHaveClass('banner-red');
        expect(banner).toHaveAttribute('role', 'status');

        const lines = Array.from(banner.querySelectorAll('.b-sub')).map((node) => node.textContent);
        expect(lines).toEqual([
          'Auto-posting is not switched on for RepWorth yet.',
          'Our reply review step is switched off right now, and nothing posts without it.',
          'Every reply waits for your approval until that changes.',
        ]);
      });
    });

    it('names a location that posts on its own while the account default is Off', () => {
      render(<AutoApprovalClient initialState={{ ...baseState, locations: [overriddenLocation()] }} />);
      const banner = screen.getByTestId('auto-approval-status');
      expect(within(banner).getByText(/Off by default. Main Cafe posts replies automatically with its own settings\./))
        .toBeInTheDocument();
    });
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
    expect(screen.getByText(/Auto-posting is not switched on for RepWorth yet/i)).toBeInTheDocument();
  });

  it('renders the server-authoritative Autopilot readiness reason', () => {
    render(<AutoApprovalClient initialState={{
      ...baseState,
      readiness: {
        ...baseState.readiness,
        canExpand: false,
        blockReasons: ['autopilot_unavailable'],
      },
    }} />);

    expect(screen.getByText(/Auto-posting is part of the Autopilot plan/i))
      .toBeInTheDocument();
    // S7: a Copilot owner gets the way up, not just the wall.
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/billing');
    expect(within(screen.getByLabelText('Account default policy'))
      .getByRole('option', { name: '5★ only' })).toBeDisabled();
  });

  it('renders every readiness reason in owner language with no internal nouns', () => {
    render(<AutoApprovalClient initialState={{
      ...baseState,
      readiness: {
        ...baseState.readiness,
        canExpand: false,
        blockReasons: [
          'auto_approval_disabled',
          'autopilot_unavailable',
          'provider_moderation_disabled',
          'provider_moderation_not_validated',
          'subscription_not_writable',
          'preview_environment',
          'impersonation_not_allowed',
        ],
      },
    }} />);

    const block = screen.getByText(/Auto-posting is part of the Autopilot plan/i).closest('.auto-policy-readiness');
    expect(block).not.toBeNull();
    const text = block!.textContent ?? '';
    for (const jargon of ['environment', 'Provider moderation', 'Policy expansion', 'readiness', 'validated', 'writable', 'View-as']) {
      expect(text).not.toMatch(new RegExp(jargon));
    }
    expect(screen.getByRole('link', { name: 'Review billing' })).toHaveAttribute('href', '/settings/billing');
  });

  it('says plainly that auto-posting can be widened when nothing blocks it', () => {
    render(<AutoApprovalClient initialState={baseState} />);
    expect(screen.getByText(/You can widen or narrow auto-posting whenever you like/)).toBeInTheDocument();
    expect(screen.queryByText(/Expansion changes are available/)).not.toBeInTheDocument();
  });

  it('disables only the veto-window expansion when readiness is blocked', () => {
    render(<AutoApprovalClient initialState={{
      ...baseState,
      accountDefault: {
        ...emptyPolicyState,
        policyId: 'policy-1',
        exists: true,
        vetoWindowMinutes: 30,
      },
      readiness: {
        ...baseState.readiness,
        canExpand: false,
        blockReasons: ['autopilot_unavailable'],
      },
    }} />);

    const veto = screen.getByLabelText('Account default veto window');
    expect(within(veto).getByRole('option', { name: '15 minutes' })).toBeDisabled();
    expect(within(veto).getByRole('option', { name: '30 minutes' })).not.toBeDisabled();
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

    const dialog = await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(fetchMock).not.toHaveBeenCalled();
    // S9: the dialog states the exact move and one concrete example.
    expect(within(dialog).getByText('Auto-posting: Off → 4–5★')).toBeInTheDocument();
    expect(within(dialog).getByText(/For example: a 4★ review saying/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/settings/auto-approval');
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    });
  });

  it('the veto-window expansion dialog states before → after in minutes', async () => {
    const state = {
      ...baseState,
      accountDefault: { ...emptyPolicyState, policyId: 'policy-1', exists: true, threshold: 5 as const, vetoWindowMinutes: 30 as const },
    };
    const user = userEvent.setup();
    render(<AutoApprovalClient initialState={state} />);

    await user.selectOptions(screen.getByLabelText('Account default veto window'), '15');
    const dialog = await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(within(dialog).getByText('Veto window: 30 min → 15 min')).toBeInTheDocument();
    expect(within(dialog).getByText(/posts after 15 minutes instead of 30/)).toBeInTheDocument();
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

    // One banner owns the suspended state: it is the status banner (S2), not a
    // second warning stacked under it.
    const banners = screen.getAllByText(/Auto-approval is suspended for this account/i);
    expect(banners).toHaveLength(1);
    expect(screen.getByTestId('auto-approval-status')).toHaveAttribute('role', 'alert');
    expect(screen.getByText('Suspended after repeated owner vetoes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off auto-posting' })).not.toBeInTheDocument();

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

  it('disables a location-suspended row\'s OWN expansion options while contraction, dials, and other locations stay enabled', () => {
    // Global readiness allows expansion (canExpand: true) — only THIS location
    // is suspended, so only its expansion options may be disabled (the server
    // 409s them; the UI must not offer what the PATCH rejects).
    const suspendedLocation = overriddenLocation();
    suspendedLocation.override = {
      ...suspendedLocation.override,
      suspended: true,
      suspendedReason: 'Suspended after repeated owner vetoes',
    };
    suspendedLocation.effective = { ...suspendedLocation.effective, suspended: true };

    const healthyLocation = overriddenLocation();
    healthyLocation.locationId = 'bbbbbbbb-0000-0000-0000-000000000002';
    healthyLocation.displayName = 'Second Cafe';

    render(<AutoApprovalClient initialState={{
      ...baseState,
      locations: [suspendedLocation, healthyLocation],
    }} />);

    // Suspended row (effective threshold 5★): moving to 4–5★ is an expansion → disabled.
    const suspendedSelect = screen.getByLabelText('Auto-approval policy for Main Cafe');
    expect(within(suspendedSelect).getByRole('option', { name: '4–5★' })).toBeDisabled();
    // Contraction / same-level options remain enabled.
    expect(within(suspendedSelect).getByRole('option', { name: 'Off' })).not.toBeDisabled();
    expect(within(suspendedSelect).getByRole('option', { name: '5★ only' })).not.toBeDisabled();
    // Dial controls (veto window, daily cap) remain enabled — suspension only
    // blocks expansions.
    expect(screen.getByLabelText('Veto window for Main Cafe')).not.toBeDisabled();
    expect(screen.getByLabelText('Daily auto-post cap for Main Cafe')).not.toBeDisabled();

    // The healthy sibling is unaffected: its expansion stays offered.
    const healthySelect = screen.getByLabelText('Auto-approval policy for Second Cafe');
    expect(within(healthySelect).getByRole('option', { name: '4–5★' })).not.toBeDisabled();
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

  it('requires standard confirmation before shortening the veto window', async () => {
    const state = {
      ...baseState,
      accountDefault: {
        ...emptyPolicyState,
        policyId: 'policy-1',
        exists: true,
        vetoWindowMinutes: 30 as const,
      },
    };
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(state));
    const user = userEvent.setup();
    render(<AutoApprovalClient initialState={state} />);

    await user.selectOptions(screen.getByLabelText('Account default veto window'), '15');
    await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_account_veto_window',
      minutes: 15,
      confirmationLevel: 'standard',
    });
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

  it('customize: an inheriting Off location gets its own row as manual, only after confirm', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(baseState));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.click(screen.getByRole('button', { name: /Give Main Cafe its own veto window and daily cap/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Give this location its own settings?' });
    expect(within(dialog).getByText(/Main Cafe keeps its current policy \(Off\)/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Give it its own settings' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_location_manual',
      locationId: LOCATION_ID,
    });
  });

  it('customize preserves the inherited threshold: the new row is created at 4–5★, no expansion confirmation', async () => {
    const state: AutoApprovalSettingsResponse = {
      ...baseState,
      accountDefault: {
        ...emptyPolicyState,
        policyId: 'policy-account',
        exists: true,
        threshold: 4,
        vetoWindowMinutes: 30,
        dailyAutoPostCap: 2,
        effectiveDailyCap: 2,
      },
      locations: [{
        ...baseState.locations[0]!,
        effective: {
          threshold: 4,
          source: 'account_default',
          inherited: true,
          vetoWindowMinutes: 30,
          dailyAutoPostCap: 2,
          effectiveDailyCap: 2,
          suspended: false,
        },
      }],
      readiness: {
        ...baseState.readiness,
        canExpand: false,
        blockReasons: ['autopilot_unavailable'],
      },
    };
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(state));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={state} />);

    // Readiness blocks expansion, yet customizing is exposure-neutral (the row
    // carries the same 4–5★), so the button stays available.
    await user.click(screen.getByRole('button', { name: /Give Main Cafe its own veto window and daily cap/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Give this location its own settings?' });
    expect(within(dialog).getByText(/keeps its current policy \(4–5★\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Give it its own settings' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_location_override',
      locationId: LOCATION_ID,
      threshold: 4,
    });
  });

  it('manual-to-manual inherited dial widening still requires expansion confirmation', async () => {
    const location = overriddenLocation();
    location.override = {
      ...location.override,
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
      effectiveDailyCap: 2,
    };
    location.effective = {
      threshold: null,
      source: 'location_override',
      inherited: false,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 2,
      effectiveDailyCap: 2,
      suspended: false,
    };
    const state: AutoApprovalSettingsResponse = {
      ...baseState,
      accountDefault: {
        ...emptyPolicyState,
        policyId: 'policy-account',
        exists: true,
        vetoWindowMinutes: 15,
        dailyAutoPostCap: null,
      },
      locations: [location],
    };
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(state));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={state} />);
    await user.selectOptions(
      screen.getByLabelText('Auto-approval policy for Main Cafe'),
      'inherit',
    );
    await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'delete_location_override',
      locationId: LOCATION_ID,
      confirmationLevel: 'standard',
    });
  });

  it('customize: cancel submits nothing and the location keeps following the account default', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.click(screen.getByRole('button', { name: /Give Main Cafe its own veto window and daily cap/ }));
    await screen.findByRole('dialog', { name: 'Give this location its own settings?' });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Veto window for Main Cafe')).not.toBeInTheDocument();
    expect(screen.getByText(/Follows the account default/)).toBeInTheDocument();
  });

  it('a failed cap save shows the error and snaps the cap input back to the server value', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'internal_error' }, false, 500));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.type(screen.getByLabelText('Account default daily auto-post cap'), '25');
    await user.tab();

    await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_account_daily_cap',
      cap: 25,
      confirmationLevel: 'standard',
    });

    // S10: the code is mapped to a sentence, shown beside the account card
    // (and announced by the live region) — never the raw code.
    const messages = await screen.findAllByText('Something went wrong on our side. Try again in a moment.');
    expect(messages.length).toBeGreaterThan(0);
    expect(screen.queryByText(/internal.error/i)).not.toBeInTheDocument();
    expect(messages.some((node) => node.closest('section')?.contains(screen.getByLabelText('Account default policy')))).toBe(true);
    // … and the epoch bump remounts the cap input back to the server value
    // instead of leaving the unsaved 25 on a safety dial.
    const remountedCap = screen.getByLabelText('Account default daily auto-post cap');
    expect(remountedCap).toHaveValue(null);
    expect(remountedCap).toHaveAttribute('placeholder', 'Default (10)');
  });

  it('surfaces a status-bearing fallback when a save failure is not JSON', async () => {
    const json = vi.fn();
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: new Headers({ 'Content-Type': 'text/html' }),
      json,
    } as unknown as Response);
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);
    await user.selectOptions(screen.getByLabelText('Account default policy'), '4');
    await user.click(await screen.findByRole('button', { name: 'Confirm auto-approval' }));

    expect((await screen.findAllByText('This change did not save (502). Try again.')).length).toBeGreaterThan(0);
    expect(json).not.toHaveBeenCalled();
  });

  it('daily cap expansion commits after blur confirmation with the exact PATCH body', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({
      ...baseState,
      accountDefault: { ...emptyPolicyState, policyId: 'policy-1', exists: true, dailyAutoPostCap: 25, effectiveDailyCap: 25 },
    }));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    await user.type(screen.getByLabelText('Account default daily auto-post cap'), '25');
    await user.tab();

    await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_account_daily_cap',
      cap: 25,
      confirmationLevel: 'standard',
    });
  });

  it('daily cap clamps to 1..50 before submitting', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(baseState));
    const user = userEvent.setup();

    const first = render(<AutoApprovalClient initialState={baseState} />);
    const highInput = screen.getByLabelText('Account default daily auto-post cap');
    await user.type(highInput, '99');
    await user.tab();
    await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock, 0)).toEqual({
      operation: 'set_account_daily_cap',
      cap: 50,
      confirmationLevel: 'standard',
    });
    first.unmount();

    render(<AutoApprovalClient initialState={baseState} />);
    const lowInput = screen.getByLabelText('Account default daily auto-post cap');
    await user.type(lowInput, '0');
    await user.tab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(patchBody(fetchMock, 1)).toEqual({ operation: 'set_account_daily_cap', cap: 1 });
  });

  it('clearing the daily cap confirms the expansion, submits null, and restores the default', async () => {
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

    await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_account_daily_cap',
      cap: null,
      confirmationLevel: 'standard',
    });
    expect(screen.getByLabelText('Account default daily auto-post cap')).toHaveAttribute(
      'placeholder',
      'Default (10)',
    );
  });

  it.each([
    ['raising', '6'],
    ['removing', ''],
  ])('blocked account cap %s snaps back without confirmation or PATCH', async (_label, next) => {
    const state: AutoApprovalSettingsResponse = {
      ...baseState,
      accountDefault: {
        ...emptyPolicyState,
        policyId: 'policy-account',
        exists: true,
        threshold: 5,
        dailyAutoPostCap: 5,
        effectiveDailyCap: 5,
      },
      readiness: {
        ...baseState.readiness,
        canExpand: false,
        blockReasons: ['autopilot_unavailable'],
      },
    };
    const fetchMock = vi.spyOn(global, 'fetch');
    const user = userEvent.setup();
    render(<AutoApprovalClient initialState={state} />);

    const input = screen.getByLabelText('Account default daily auto-post cap');
    await user.clear(input);
    if (next) await user.type(input, next);
    await user.tab();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Account default daily auto-post cap')).toHaveValue(5);
  });

  it('blocked account cap contraction remains editable', async () => {
    const state: AutoApprovalSettingsResponse = {
      ...baseState,
      accountDefault: {
        ...emptyPolicyState,
        policyId: 'policy-account',
        exists: true,
        threshold: 5,
        dailyAutoPostCap: 5,
        effectiveDailyCap: 5,
      },
      readiness: {
        ...baseState.readiness,
        canExpand: false,
        blockReasons: ['autopilot_unavailable'],
      },
    };
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(state));
    const user = userEvent.setup();
    render(<AutoApprovalClient initialState={state} />);

    const input = screen.getByLabelText('Account default daily auto-post cap');
    await user.clear(input);
    await user.type(input, '4');
    await user.tab();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({ operation: 'set_account_daily_cap', cap: 4 });
  });

  it('location suspension blocks cap expansion but keeps cap contraction editable', async () => {
    const location = overriddenLocation();
    location.override = {
      ...location.override,
      dailyAutoPostCap: 5,
      effectiveDailyCap: 5,
      suspended: true,
      suspendedReason: 'governor_negative_feedback',
    };
    location.effective = {
      ...location.effective,
      dailyAutoPostCap: 5,
      effectiveDailyCap: 5,
      suspended: true,
    };
    const state = { ...baseState, locations: [location] };
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(state));
    const user = userEvent.setup();
    render(<AutoApprovalClient initialState={state} />);

    const expansion = screen.getByLabelText('Daily auto-post cap for Main Cafe');
    await user.clear(expansion);
    await user.type(expansion, '6');
    await user.tab();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Daily auto-post cap for Main Cafe')).toHaveValue(5);

    const contraction = screen.getByLabelText('Daily auto-post cap for Main Cafe');
    await user.clear(contraction);
    await user.type(contraction, '4');
    await user.tab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({
      operation: 'set_location_daily_cap',
      locationId: LOCATION_ID,
      cap: 4,
    });
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

  it("typing the override's stored cap on an overridden location still no-ops", async () => {
    // The commit baseline is the override's STORED value: retyping it must not
    // PATCH (only a genuinely different value does).
    const location = overriddenLocation();
    location.override = { ...location.override, dailyAutoPostCap: 5 };
    location.effective = { ...location.effective, dailyAutoPostCap: 5, effectiveDailyCap: 5 };
    const fetchMock = vi.spyOn(global, 'fetch');
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={{ ...baseState, locations: [location] }} />);

    const capInput = screen.getByLabelText('Daily auto-post cap for Main Cafe');
    expect(capInput).toHaveValue(5);
    await user.clear(capInput);
    await user.type(capInput, '5');
    await user.tab();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('badInput on blur never commits: no PATCH, and the field snaps back to the stored cap', async () => {
    // Finding 7: a number input holding unparsable text (stray 'e') reads as
    // '' — without the validity check that committed cap:null, silently
    // dropping an explicit strict cap. jsdom cannot produce a real badInput
    // ValidityState from typing, so the validity object is mocked on the
    // target node before blurring.
    const fetchMock = vi.spyOn(global, 'fetch');
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={{
      ...baseState,
      accountDefault: { ...emptyPolicyState, policyId: 'policy-1', exists: true, dailyAutoPostCap: 25, effectiveDailyCap: 25 },
    }} />);

    const capInput = screen.getByLabelText('Account default daily auto-post cap');
    expect(capInput).toHaveValue(25);
    // Simulate the browser's badInput read: value reads empty, validity flags it.
    await user.clear(capInput);
    Object.defineProperty(capInput, 'validity', {
      value: { badInput: true },
      configurable: true,
    });
    fireEvent.blur(capInput);

    expect(fetchMock).not.toHaveBeenCalled();
    // The epoch bump remounts the field back to the stored value.
    const remountedCap = screen.getByLabelText('Account default daily auto-post cap');
    expect(remountedCap).toHaveValue(25);
  });

  // S8: the cap says its limits inline and confirms a save where it happened.
  it('daily cap: shows the 1–50 range inline, notes a clamp, and marks the field Saved after commit', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({
      ...baseState,
      accountDefault: { ...emptyPolicyState, policyId: 'policy-1', exists: true, dailyAutoPostCap: 50, effectiveDailyCap: 50 },
    }));
    const user = userEvent.setup();

    render(<AutoApprovalClient initialState={baseState} />);

    expect(screen.getByText(/Most replies posted automatically per day, from 1 to 50\. Leave blank for the default \(10\)\./))
      .toBeInTheDocument();

    await user.type(screen.getByLabelText('Account default daily auto-post cap'), '100');
    await user.tab();

    // The clamp is stated before the owner confirms anything.
    expect(screen.getByText(/Capped at 50, the most that can post automatically in a day\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Account default daily auto-post cap')).toHaveValue(50);
    await screen.findByRole('dialog', { name: 'Confirm auto-approval change' });
    await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(patchBody(fetchMock)).toEqual({ operation: 'set_account_daily_cap', cap: 50, confirmationLevel: 'standard' });

    // The Saved mark lands on the cap field itself, not only in a toast.
    const capLabel = screen.getByText('Daily auto-post cap', { selector: '.field-label' });
    expect(await within(capLabel).findByText('Saved')).toBeInTheDocument();
  });

  it('a location save error renders inside that location row', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'location_inactive' }, false, 409));
    const user = userEvent.setup();
    render(<AutoApprovalClient initialState={{ ...baseState, locations: [overriddenLocation()] }} />);

    await user.selectOptions(screen.getByLabelText('Veto window for Main Cafe'), '30');

    const messages = await screen.findAllByText('This location is archived, so its auto-posting cannot be changed.');
    expect(messages.some((node) => node.closest('.auto-policy-location-row') !== null)).toBe(true);
  });

  // #631 D20: the Solicitation persona's opt-in card.
  describe('solicitation card', () => {
    const availableOff: AutoApprovalSettingsResponse = {
      ...baseState,
      solicitation: { available: true, enabled: false, dailySendCap: null, vetoWindowMinutes: null },
    };
    const availableOn: AutoApprovalSettingsResponse = {
      ...baseState,
      solicitation: { available: true, enabled: true, dailySendCap: 5, vetoWindowMinutes: 60 },
    };

    it('renders only when the server marks the lane available', () => {
      // Two mounts, not a rerender: initialState seeds the reducer once.
      const first = render(<AutoApprovalClient initialState={baseState} />);
      expect(screen.queryByLabelText('Auto-approve request batches')).not.toBeInTheDocument();
      first.unmount();

      render(<AutoApprovalClient initialState={availableOff} />);
      expect(screen.getByLabelText('Auto-approve request batches')).toBeInTheDocument();
    });

    it('enabling confirms first, then PATCHes the set operation with standard confirmation', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(availableOn));
      const user = userEvent.setup();
      render(<AutoApprovalClient initialState={availableOff} />);

      await user.click(screen.getByLabelText('Auto-approve request batches'));
      await screen.findByRole('dialog', { name: 'Confirm review request auto-approval' });
      expect(fetchMock).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Confirm auto-approval' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(patchBody(fetchMock)).toEqual({
        operation: 'set_solicitation_account_default',
        dailySendCap: null,
        vetoWindowMinutes: 60,
        confirmationLevel: 'standard',
      });
    });

    it('disabling sends the clear operation directly without confirmation', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(availableOff));
      const user = userEvent.setup();
      render(<AutoApprovalClient initialState={availableOn} />);

      await user.click(screen.getByLabelText('Auto-approve request batches'));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(patchBody(fetchMock)).toEqual({ operation: 'clear_solicitation_account_default' });
    });

    it('lengthening the veto window submits directly; shortening asks for confirmation', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(availableOn));
      const user = userEvent.setup();
      const { unmount } = render(<AutoApprovalClient initialState={{
        ...baseState,
        solicitation: { available: true, enabled: true, dailySendCap: 5, vetoWindowMinutes: 30 },
      }} />);

      await user.selectOptions(screen.getByLabelText('Review request veto window'), '60');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(patchBody(fetchMock)).toEqual({
        operation: 'set_solicitation_account_default',
        dailySendCap: 5,
        vetoWindowMinutes: 60,
      });
      unmount();

      render(<AutoApprovalClient initialState={availableOn} />);
      await user.selectOptions(screen.getByLabelText('Review request veto window'), '30');
      await screen.findByRole('dialog', { name: 'Confirm review request auto-approval' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('lowering the send cap submits directly with the current window preserved', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonResponse(availableOn));
      const user = userEvent.setup();
      render(<AutoApprovalClient initialState={availableOn} />);

      const capInput = screen.getByLabelText('Daily review request send cap');
      await user.clear(capInput);
      await user.type(capInput, '3');
      await user.tab();

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(patchBody(fetchMock)).toEqual({
        operation: 'set_solicitation_account_default',
        dailySendCap: 3,
        vetoWindowMinutes: 60,
      });
    });
  });
});
