// @vitest-environment jsdom
// The two card writes, against a mocked fetch. Every case asserts on what the
// SERVER said the row is, because a refusal repaints the card from the stored
// state rather than from the browser's reading of a status code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import { useProposalWrites } from '../useProposalWrites';
import { ROUTE_ERROR_WORDING, routeErrorSentence } from '../wording';

const SALON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TURN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROPOSAL = '99999999-9999-4999-8999-999999999999';

const VOICE_BEFORE = {
  tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
};

function proposal(overrides: Record<string, unknown> = {}): ProposalView {
  return {
    id: PROPOSAL,
    turnId: TURN,
    operation: 'set_tone',
    contractVersion: 1,
    labelKind: 'fact',
    locationId: SALON,
    status: 'pending',
    rationale: 'You asked for warmer replies.',
    input: { tone: 'warm and brief' },
    before: VOICE_BEFORE,
    after: { ...VOICE_BEFORE, tone: 'warm and brief' },
    describe: 'Set the reply tone to "warm and brief"',
    preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
    receipt: null,
    appliedAt: null,
    failureReason: null,
    requiresConfirmation: false,
    confirmationPhrase: null,
    readinessBlockReasons: [],
    postingBlockSentences: [],
    consequence: null,
    affectedLocationCount: null,
    ...overrides,
  } as ProposalView;
}

function harness() {
  const onDisabled = vi.fn();
  const patchProposal = vi.fn();
  const reloadTranscript = vi.fn();
  const rendered = renderHook(() =>
    useProposalWrites({ onDisabled, patchProposal, reloadTranscript }));
  return { ...rendered, onDisabled, patchProposal, reloadTranscript };
}

const postBodies = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      url: String(url),
      body: (init as RequestInit).body === undefined
        ? undefined
        : JSON.parse(String((init as RequestInit).body)),
    }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('useProposalWrites', () => {
  it('sends the typed phrase unchanged and explains a mismatch without losing the pending proposal', async () => {
    const row = proposal({ requiresConfirmation: true, confirmationPhrase: 'all locations', locationId: null,
      preparedVersionToken: { accountDefaultRow: { id: 'absent' } } });
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400,
      json: async () => ({ error: 'confirmation_mismatch', proposal: row }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const { result, patchProposal, reloadTranscript } = harness();
    await act(async () => { await result.current.write(row, 'apply', 'all locations '); });
    expect(postBodies(fetchMock)[0]!.body).toEqual({ expectedVersionToken: row.preparedVersionToken, confirmationLevel: 'all locations ' });
    expect(patchProposal).toHaveBeenCalledWith(row);
    expect(result.current.errors[row.id]).toMatch(/exactly/);
    expect(reloadTranscript).not.toHaveBeenCalled();
  });
  it('Apply posts the prepared version token and repaints the card from the returned row', async () => {
    const applied = proposal({ status: 'applied', appliedAt: '2026-09-12T10:00:00.000Z' });
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ proposal: applied }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const { result, patchProposal, reloadTranscript } = harness();
    await act(async () => { await result.current.write(proposal(), 'apply'); });

    const [posted] = postBodies(fetchMock as never);
    expect(posted!.url).toBe(`/api/operator/proposals/${PROPOSAL}/apply`);
    // THE TOKEN THE CARD WAS RENDERED FROM, verbatim: all three copies must
    // agree, and a browser one render behind is describing a different plan.
    expect(posted!.body).toEqual({
      expectedVersionToken: proposal().preparedVersionToken,
    });
    expect(patchProposal).toHaveBeenCalledWith(applied);
    // An Apply staled every sibling on this location (D11).
    expect(reloadTranscript).toHaveBeenCalledTimes(1);
    expect(result.current.busyId).toBeNull();
    expect(result.current.errors).toEqual({});
  });

  it('Not now posts no body and still refetches the transcript', async () => {
    const declined = proposal({ status: 'rejected', failureReason: null });
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ proposal: declined }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const { result, patchProposal, reloadTranscript } = harness();
    await act(async () => { await result.current.write(proposal(), 'decline'); });

    const [posted] = postBodies(fetchMock as never);
    expect(posted!.url).toBe(`/api/operator/proposals/${PROPOSAL}/decline`);
    expect(posted!.body).toBeUndefined();
    expect(patchProposal).toHaveBeenCalledWith(declined);
    expect(reloadTranscript).toHaveBeenCalledTimes(1);
  });

  it('a 409 repaints the card from the stored row AND names the refusal', async () => {
    // BOTH HALVES. The body of a refusal carries the row the server actually
    // has, so the card stops offering Apply; the code carries the sentence
    // that says why. Dropping either leaves the owner guessing.
    const stale = proposal({ status: 'stale', failureReason: 'version_mismatch' });
    const fetchMock = vi.fn(async () => ({
      ok: false, status: 409,
      json: async () => ({ error: 'proposal_stale', proposal: stale }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const { result, patchProposal, reloadTranscript } = harness();
    await act(async () => { await result.current.write(proposal(), 'apply'); });

    expect(patchProposal).toHaveBeenCalledWith(stale);
    expect(result.current.errors[PROPOSAL]).toBe(ROUTE_ERROR_WORDING.proposal_stale);
    // A refused write changed nothing, so nothing is stale but this card.
    expect(reloadTranscript).not.toHaveBeenCalled();
  });

  it('a write that never reaches the server says so on the card', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network error'); });
    vi.stubGlobal('fetch', fetchMock);

    const { result, patchProposal } = harness();
    await act(async () => { await result.current.write(proposal(), 'apply'); });

    // The fallback sentence, read from `wording.ts` rather than transcribed:
    // `ROUTE_ERROR_FALLBACK` itself is not exported, and `routeErrorSentence`
    // with no code IS its accessor.
    expect(result.current.errors[PROPOSAL]).toBe(routeErrorSentence(null));
    expect(patchProposal).not.toHaveBeenCalled();
  });

  it('a 404 operator_disabled ends the session rather than marking the card', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false, status: 404, json: async () => ({ error: 'operator_disabled' }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const { result, onDisabled } = harness();
    await act(async () => { await result.current.write(proposal(), 'apply'); });

    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(result.current.errors).toEqual({});
  });

  it('one write at a time: a second Apply while the first is in flight is ignored', async () => {
    // ONE WRITE AT A TIME. An Apply moves `businesses.updated_at`, so a second
    // write started beside it is deciding a plan the server is about to answer
    // differently.
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return { ok: true, status: 200, json: async () => ({ proposal: proposal() }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = harness();
    let first: Promise<void> | null = null;
    let second: Promise<void> | null = null;
    try {
      act(() => { first = result.current.write(proposal(), 'apply'); });
      await waitFor(() => expect(result.current.busyId).toBe(PROPOSAL));
      act(() => { second = result.current.write(proposal(), 'decline'); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      // Release both requests if the guard regresses, including assertion failure.
      await act(async () => {
        for (const release of releases) release();
        await Promise.allSettled([first, second]);
      });
    }
    await waitFor(() => expect(result.current.busyId).toBeNull());
  });
});
