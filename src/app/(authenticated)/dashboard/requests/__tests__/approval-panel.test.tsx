// @vitest-environment jsdom
//
// The owner approval lane's panel (#629 Task 7): one case per row of the render
// table, plus the exclusion round-trip.
//
// The panel is rendered DIRECTLY rather than through RequestsClient: its whole
// contract is `sendLane` + `attempts` in, one POST out, and driving it through
// the fetch loop would test the loop instead.
//
// No fixture here carries a rendered subject or body, and none can: the panel
// never reads those fields (D6a), so a fixture that supplied them would only
// prove the test author's assumption. The redacted attempt below is the one
// that matters — it must contribute a COUNT and nothing else.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AskAttemptView, SendLaneView } from '@/lib/solicitation/batch-view';
import { ApprovalPanel } from '../ApprovalPanel';

// ── Fixtures ────────────────────────────────────────────────────────────────

const BATCH_ID = 'e0f4a2b1-0000-7000-8000-000000000001';
const SCOPE = 'loc-1';

function sendLane(overrides: Partial<SendLaneView> = {}): SendLaneView {
  return {
    batchState: 'built',
    ready: true,
    pendingRenders: 0,
    approvedAt: null,
    vetoDeadlineAt: null,
    haltedAt: null,
    haltReason: null,
    moderationWithheld: 0,
    ...overrides,
  };
}

/** A live, owner-readable attempt. `rendered` is the only status the approve
 *  route accepts an exclusion for, so it is the only one that gets a control. */
function rendered(suffix: string, contactName: string): AskAttemptView {
  return {
    outreachId: `a1b2c3d4-0000-7000-8000-00000000000${suffix}`,
    askId: `ask-${suffix}`,
    contactId: `contact-${suffix}`,
    contactName,
    attemptNo: 1,
    deliveryStatus: 'rendered',
    dispositionReason: null,
    renderedAt: '2026-08-16 11:00:00+00',
    redacted: false,
    subject: null,
    body: null,
    lintClasses: [],
    moderationStatus: 'clean',
    moderationDetail: {},
    interpolationInputs: null,
  };
}

/** The `moderation_high` arm: the read model already stripped the bytes, and
 *  the panel must not resurrect them from the reason either. */
function redactedAttempt(suffix: string, contactName: string): AskAttemptView {
  return {
    outreachId: `b1b2c3d4-0000-7000-8000-00000000000${suffix}`,
    askId: `ask-r${suffix}`,
    contactId: `contact-r${suffix}`,
    contactName,
    attemptNo: 1,
    deliveryStatus: 'withheld',
    dispositionReason: 'moderation_high',
    renderedAt: '2026-08-16 11:00:00+00',
    redacted: true,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function renderPanel(
  lane: SendLaneView,
  attempts: AskAttemptView[],
  onChanged = vi.fn(),
): { onChanged: ReturnType<typeof vi.fn> } {
  render(
    <ApprovalPanel
      batchId={BATCH_ID}
      sendLane={lane}
      attempts={attempts}
      scope={SCOPE}
      onChanged={onChanged}
    />,
  );
  return { onChanged };
}

/** Flushes the POST's promise chain without moving any clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const approveButton = () => screen.queryByRole('button', { name: /approve and send/i });
const stopButton = () => screen.queryByRole('button', { name: /stop this batch/i });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Contract tests ──────────────────────────────────────────────────────────

describe('ApprovalPanel', () => {
  // Retitled after round-1 plan review (finding 2): readiness means every ask
  // has a finished ATTEMPT, and a withheld attempt is finished.
  it('shows the approve control only when every ask has an attempt', () => {
    const { unmount } = render(
      <ApprovalPanel
        batchId={BATCH_ID}
        sendLane={sendLane({ ready: false, pendingRenders: 2 })}
        attempts={[rendered('1', 'Dana Reeve')]}
        scope={SCOPE}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText(/Still preparing 2 messages/i)).toBeInTheDocument();
    expect(approveButton()).toBeNull();
    // No exclude control either: deselecting a batch that is still growing
    // would be a choice made about an incomplete list.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    unmount();

    renderPanel(sendLane({ ready: true }), [rendered('1', 'Dana Reeve')]);
    expect(approveButton()).toBeInTheDocument();
    expect(screen.queryByText(/Still preparing/i)).toBeNull();
  });

  it('excludes an ask when its control is cleared and approves the rest', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          status: 'approved',
          approvedCount: 2,
          excludedCount: 1,
          vetoDeadlineAt: '2026-08-16 12:15:00+00',
          close: null,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { onChanged } = renderPanel(sendLane(), [
      rendered('1', 'Dana Reeve'),
      rendered('2', 'Sam Okafor'),
      rendered('3', 'Iris Lindqvist'),
    ]);

    // Every ask starts included — exclusion is an act, not a default.
    const sam = screen.getByRole('checkbox', { name: /Send to Sam Okafor/i });
    expect(sam).toBeChecked();
    fireEvent.click(sam);
    expect(sam).not.toBeChecked();

    // The label is the live count, so clearing one row moves it.
    expect(
      screen.getByRole('button', { name: 'Approve and send 2 messages' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /approve and send/i }));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/dashboard/solicitation/batch/approve?scope=${SCOPE}`);
    expect(init.method).toBe('POST');
    // EXACTLY the cleared row — not the included ones, not a superset.
    expect(JSON.parse(String(init.body))).toEqual({
      batchId: BATCH_ID,
      excludedOutreachIds: [rendered('2', 'Sam Okafor').outreachId],
    });

    // The panel never refetches itself: it hands the parent a sentence and the
    // parent owns the reload.
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(String(onChanged.mock.calls[0]?.[0])).toMatch(/2 messages will send/i);
  });

  it('shows the stop control while the batch is in its veto window', () => {
    renderPanel(
      sendLane({
        batchState: 'veto_window',
        approvedAt: '2026-08-16 12:00:00+00',
        vetoDeadlineAt: '2026-08-16 12:15:00+00',
      }),
      [rendered('1', 'Dana Reeve')],
    );

    expect(stopButton()).toBeInTheDocument();
    // Approved means the list is settled: read-only, no re-approval, and no
    // edit affordance anywhere (D22).
    expect(approveButton()).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText(/Dana Reeve/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit|regenerate|rewrite/i })).toBeNull();
  });

  // Not one of the plan's five titles. Added after `ci:fallow:coverage` reported
  // the `halt` callback at CRAP 30 / 0% tested: every other case asserts the
  // stop control RENDERS, and nothing clicked it. The gap matters beyond
  // coverage arithmetic — the body assertion below is the UI-layer half of the
  // rule that the halt reason is derived server-side, and it is the assertion
  // that fails if anyone ever "helpfully" adds a reason field to this POST.
  it('stops the batch and sends no reason of its own', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'halted', reason: 'owner_veto', cancelledCount: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    const { onChanged } = renderPanel(
      sendLane({
        batchState: 'veto_window',
        approvedAt: '2026-08-16 12:00:00+00',
        vetoDeadlineAt: '2026-08-16 12:15:00+00',
      }),
      [rendered('1', 'Dana Reeve'), rendered('2', 'Sam Okafor')],
    );

    fireEvent.click(stopButton()!);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/dashboard/solicitation/batch/halt?scope=${SCOPE}`);
    expect(init.method).toBe('POST');
    // EXACTLY one key. Not a reason, not an empty reason, not a null one — the
    // server derives it from Batch state so the audit trail cannot be dictated.
    expect(JSON.parse(String(init.body))).toEqual({ batchId: BATCH_ID });

    expect(onChanged).toHaveBeenCalledWith('Batch stopped. Nothing further will send.');
  });

  it('shows the expired state with no approve control', () => {
    renderPanel(sendLane({ batchState: 'expired', ready: true }), [
      rendered('1', 'Dana Reeve'),
    ]);

    expect(
      screen.getByText(/This batch expired before it was approved/i),
    ).toBeInTheDocument();
    expect(approveButton()).toBeNull();
    expect(stopButton()).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('shows a halted batch as read-only and states it cannot be resumed', () => {
    renderPanel(
      sendLane({
        batchState: 'halted',
        ready: false,
        haltedAt: '2026-08-16 12:05:00+00',
        haltReason: 'owner_veto',
        moderationWithheld: 2,
      }),
      [redactedAttempt('1', 'Priya Raman')],
    );

    expect(
      screen.getByText(/You stopped this batch\. It cannot be resumed\./i),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    // The redacted attempt contributes a reason and a count — and NOTHING else.
    // It is not in the list, and its contact is not named.
    expect(screen.getByText('moderation_high')).toBeInTheDocument();
    expect(screen.getByText(/2 messages held by the safety check/i)).toBeInTheDocument();
    expect(screen.queryByText(/Priya Raman/)).toBeNull();
  });
});
