// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import type { Receipt } from '@/lib/agents/operator/schema';

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() }, params: new URLSearchParams() }));
const scope = vi.hoisted(() => ({ value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation.router, useSearchParams: () => navigation.params }));
vi.mock('@/contexts/LocationContext', () => ({ useLocationScope: () => ({
  currentScope: scope.value,
  locations: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Salon', displayLabel: null, isPrimary: true }],
  setLocationScope: vi.fn(),
}) }));

import { OperatorClient } from '../OperatorClient';
import { ProposalCard } from '../ProposalCard';

const LOCATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESTORE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TURN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONVERSATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TOKEN = { businessId: LOCATION, updatedAt: '2026-09-14 20:00:00.123456+00' };
const voice = { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] };
const receipt: Receipt = {
  version: 1, operation: 'set_tone', scope: { accountId: 'account-1', locationId: LOCATION },
  before: voice, after: { ...voice, tone: 'warm' }, differsFromPreview: false, effectiveNow: true,
  affects: 'future_drafts', remainingBlocked: [], appliedAt: '2026-09-14T20:00:00.000Z',
  actorUserId: 'owner-1', actorName: 'Owner', ownerText: 'Make replies warm.', turnId: TURN,
  versionToken: { before: TOKEN, after: TOKEN },
};
function proposal(overrides: Record<string, unknown> = {}): ProposalView {
  return {
    id: SOURCE, turnId: TURN, operation: 'set_tone', contractVersion: 1, labelKind: 'rule',
    locationId: LOCATION, status: 'applied', rationale: '', input: { tone: 'warm' },
    before: voice, after: { ...voice, tone: 'warm' }, describe: 'Use a warm tone',
    requiresConfirmation: false, confirmationPhrase: null, readinessBlockReasons: [],
    postingBlockSentences: [],
    consequence: null, affectedLocationCount: null, preparedVersionToken: TOKEN,
    receipt, appliedAt: receipt.appliedAt, failureReason: null, ...overrides,
  } as ProposalView;
}
const restored = () => proposal({
  id: RESTORE, restoreSourceProposalId: SOURCE, status: 'pending', describe: 'Restore: previous reply tone',
  before: { ...voice, tone: 'warm' }, after: voice, input: { restore: { sourceProposalId: SOURCE } },
  receipt: null, appliedAt: null,
});
function conversation(rows: ProposalView[]) {
  return { conversation: { id: CONVERSATION, lastTurnAt: receipt.appliedAt }, summary: null, turns: [{
    id: TURN, sequence: 1, status: 'completed', failureReason: null, locationId: LOCATION,
    ownerText: 'Make replies warm.', segments: [], proposals: rows, unsupported: [], refused: [],
  }] };
}
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
const posts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => { vi.clearAllMocks(); scope.value = LOCATION; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Operator Restore workflow', () => {
  it('refused cards and the operating rules timeline survive reload', async () => {
    const refused = {
      type: 'refusal', reason: 'invented_business_fact', subjectId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      text: 'RepWorth will not invent facts about your business.',
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/conversation')) {
        const stored = conversation([]);
        return response({ ...stored, turns: stored.turns.map((turn) => ({ ...turn, segments: [refused], refused: [refused] })) });
      }
      if (url.includes('/rules-timeline')) return response({ proposals: [proposal()], pendingRestores: [restored()], nextCursor: null });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    let mounted = render(<OperatorClient />);
    for (let pass = 0; pass < 2; pass += 1) {
      const refusal = await screen.findByRole('group', { name: 'Policy refused' });
      expect(within(refusal).getByText(refused.text)).toBeInTheDocument();
      expect(within(refusal).queryByRole('button')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Rules timeline' }));
      expect(await screen.findByRole('heading', { name: 'Restore: previous reply tone' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
      if (pass === 0) { mounted.unmount(); mounted = render(<OperatorClient />); }
    }
    expect(posts(fetcher)).toHaveLength(0);
  });

  it('prepares a pending card from a receipt, reloads it, and only then sends the ordinary Apply request', async () => {
    let prepared = false;
    let applied = false;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/conversation')) return response(conversation([
        proposal(), ...(prepared ? [restored()] : []),
      ].map((row) => applied && row.id === RESTORE ? { ...row, status: 'applied', receipt } : row)));
      if (url.endsWith(`/${SOURCE}/restore`)) { prepared = true; return response({ proposal: restored(), repeated: false }); }
      if (url.endsWith(`/${RESTORE}/apply`)) { applied = true; return response({ proposal: { ...restored(), status: 'applied', receipt } }); }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    const first = render(<OperatorClient />);
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    // The successful POST also reloads the transcript, replacing its DOM nodes.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Restore: previous reply tone' })).toBeInTheDocument());
    expect(posts(fetcher)).toHaveLength(1);
    expect(JSON.parse(posts(fetcher)[0]?.[1].body)).toEqual({});
    expect(applied).toBe(false);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.includes('/conversation')).length).toBeGreaterThan(1));
    first.unmount();
    render(<OperatorClient />);
    expect(await screen.findByRole('heading', { name: 'Restore: previous reply tone' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(applied).toBe(true));
    expect(posts(fetcher)).toHaveLength(2);
    expect(JSON.parse(posts(fetcher)[1]?.[1].body)).toEqual({ expectedVersionToken: TOKEN });
  });

  it.each(['prepared here', 'loaded after refresh'])('adopts a rejected timeline Apply and refreshes its Restore source: %s', async (mode) => {
    let prepared = mode === 'loaded after refresh';
    let stale = false;
    let refreshed = false;
    const fresh = () => ({ ...restored(), id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', describe: 'Restore: refreshed reply tone' });
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/conversation')) return response(conversation([]));
      if (url.includes('/rules-timeline')) return response({
        proposals: [proposal()], pendingRestores: prepared && !stale ? [refreshed ? fresh() : restored()] : [], nextCursor: null,
      });
      if (url.endsWith(`/${SOURCE}/restore`)) {
        refreshed = stale;
        prepared = true;
        stale = false;
        return response({ proposal: refreshed ? fresh() : restored(), repeated: false });
      }
      if (url.endsWith(`/${RESTORE}/apply`)) {
        stale = true;
        return response({ error: 'version_mismatch', proposal: { ...restored(), status: 'stale', failureReason: 'version_mismatch' } }, 409);
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<OperatorClient />);
    await user.click(screen.getByRole('button', { name: 'Rules timeline' }));
    if (!prepared) await user.click(await screen.findByRole('button', { name: 'Restore' }));
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const card = within(screen.getByRole('region', { name: 'Restore: previous reply tone' }));
      expect(card.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
      expect(card.getByRole('button', { name: 'Refresh plan' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(await screen.findByRole('heading', { name: 'Restore: refreshed reply tone' })).toBeInTheDocument();
    expect(posts(fetcher).at(-1)?.[0]).toBe(`/api/operator/proposals/${SOURCE}/restore`);
    expect(JSON.parse(posts(fetcher).at(-1)?.[1].body)).toEqual({});
    expect(refreshed).toBe(true);
  });

  it('keeps an out-of-window prepared restore actionable immediately and after loading persisted timeline history', async () => {
    let prepared = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/conversation')) return response(conversation([]));
      if (url.includes('/rules-timeline')) return response({ proposals: [proposal()], pendingRestores: prepared ? [restored()] : [], nextCursor: null });
      if (url.endsWith(`/${SOURCE}/restore`)) { prepared = true; return response({ proposal: restored(), repeated: false }); }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    const first = render(<OperatorClient />);
    await user.click(screen.getByRole('button', { name: 'Rules timeline' }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument();
    first.unmount();
    render(<OperatorClient />);
    await user.click(screen.getByRole('button', { name: 'Rules timeline' }));
    expect(await screen.findByRole('heading', { name: 'Restore: previous reply tone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(posts(fetcher)).toHaveLength(1);
  });

  it('pages independently of the transcript and sends the exact timestamp and current scope', async () => {
    const older = proposal({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', describe: 'Older saved tone' });
    const stamp = '2026-09-14 20:00:00.123456+00';
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/conversation')) return response(conversation([]));
      const query = new URL(url, 'http://localhost').searchParams;
      if (query.has('cursorId')) return response({ proposals: [older], pendingRestores: [], nextCursor: null });
      return response({ proposals: [proposal()], pendingRestores: [], nextCursor: { appliedAt: stamp, id: SOURCE } });
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<OperatorClient />);
    await user.click(screen.getByRole('button', { name: 'Rules timeline' }));
    await user.click(await screen.findByRole('button', { name: 'Load older changes' }));
    expect(await screen.findByRole('heading', { name: 'Older saved tone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Use a warm tone' })).toBeInTheDocument();
    const pageUrl = fetcher.mock.calls.map(([url]) => url).find((url) => url.includes('cursorId'))!;
    const query = new URL(pageUrl, 'http://localhost').searchParams;
    expect(query.get('cursorAppliedAt')).toBe(stamp);
    expect(query.get('cursorId')).toBe(SOURCE);
    expect(query.get('locationId')).toBe(LOCATION);
    expect(screen.queryByRole('button', { name: 'Load older changes' })).not.toBeInTheDocument();
  });

  it('shows preparation progress and a retryable error without creating an Apply button', async () => {
    let resolveRestore!: (value: Response) => void;
    const fetcher = vi.fn(async (url: string) => url.includes('/conversation')
      ? response(conversation([proposal()]))
      : new Promise<Response>((resolve) => { resolveRestore = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<OperatorClient />);
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(screen.getByRole('button', { name: 'Preparing restore…' })).toBeDisabled();
    await act(async () => { resolveRestore(response({ error: 'restore_failed' }, 500)); });
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not prepare this restore. Nothing was changed. Try again.');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('uses distinct accessible IDs when a persisted proposal is referenced in two places', () => {
    const props = { proposal: restored(), turnLocationId: LOCATION, locationLabel: () => 'Salon', scopeMoved: false,
      onApply: vi.fn(), onDecline: vi.fn(), onRefreshPlan: vi.fn(), busy: false, error: null };
    const { container } = render(<><ProposalCard {...props} /><ProposalCard {...props} /></>);
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const card of screen.getAllByRole('region', { name: 'Restore: previous reply tone' })) {
      expect(within(card).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    }
  });

  it('keeps Restore explicit on a policy card and explains a clear override in owner language', () => {
    const state = { domain: 'policy', threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2, effectiveDailyCap: 2, rowExists: true };
    const props = { turnLocationId: LOCATION, locationLabel: () => 'Salon', scopeMoved: false,
      onApply: vi.fn(), onDecline: vi.fn(), onRefreshPlan: vi.fn(), busy: false, error: null };
    const { rerender } = render(<ProposalCard {...props} proposal={proposal({
      ...restored(), operation: 'set_auto_reply_scope', before: state, after: state,
      describe: 'Restore: prior auto-reply settings',
    })} />);
    expect(screen.getByRole('heading', { name: 'Restore: prior auto-reply settings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Change auto-reply scope' })).not.toBeInTheDocument();
    rerender(<ProposalCard {...props} proposal={proposal({
      operation: 'clear_location_override', status: 'pending', before: state, after: { ...state, rowExists: false },
      receipt: null, describe: 'Clear override',
    })} />);
    expect(screen.getByRole('heading', { name: 'Use the account default for auto-reply' })).toBeInTheDocument();
  });

  it('discards a slow previous-scope timeline page after the owner changes location', async () => {
    let finishOldPage!: (value: Response) => void;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/conversation')) return response(conversation([]));
      if (url.includes(`locationId=${LOCATION}`)) return new Promise<Response>((resolve) => { finishOldPage = resolve; });
      return response({ proposals: [proposal({ describe: 'Current scope history' })], pendingRestores: [], nextCursor: null });
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    const { rerender } = render(<OperatorClient />);
    await user.click(screen.getByRole('button', { name: 'Rules timeline' }));
    await waitFor(() => expect(finishOldPage).toBeDefined());
    scope.value = 'all';
    rerender(<OperatorClient />);
    expect(await screen.findByRole('heading', { name: 'Current scope history' })).toBeInTheDocument();
    await act(async () => { finishOldPage(response({ proposals: [proposal()], pendingRestores: [], nextCursor: null })); });
    expect(screen.getByRole('heading', { name: 'Current scope history' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Use a warm tone' })).not.toBeInTheDocument();
  });

  it('retries a failed timeline read without treating it as empty history', async () => {
    let failed = true;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/conversation')) return response(conversation([]));
      return failed ? response({ error: 'rules_timeline_failed' }, 500)
        : response({ proposals: [proposal()], pendingRestores: [], nextCursor: null });
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<OperatorClient />);
    await user.click(screen.getByRole('button', { name: 'Rules timeline' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load your rules timeline. Try again.');
    expect(screen.queryByText('No applied changes in this scope yet.')).not.toBeInTheDocument();
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Refresh timeline' }));
    expect(await screen.findByRole('heading', { name: 'Use a warm tone' })).toBeInTheDocument();
  });
});
