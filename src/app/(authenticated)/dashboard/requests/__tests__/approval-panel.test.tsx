// @vitest-environment jsdom
//
// The owner approval lane's panel (#629 Task 7): one case per row of the render
// table, plus the exclusion round-trip.
//
// The panel is rendered DIRECTLY rather than through RequestsClient: its whole
// contract is `sendLane` + `attempts` in, one POST out, and driving it through
// the fetch loop would test the loop instead.
//
// The D6a rule is CONDITIONAL and both halves are asserted here, because a
// suite that only proves absence is what let a panel ship that showed the owner
// a name and a status and then asked them to approve three messages they had
// never read:
//   · an owner-readable attempt MUST render its subject and body;
//   · a `moderation_high` attempt must contribute a count and a reason and
//     nothing else — asserted against a fixture that carries bytes it should
//     not have, so the assertion tests the projection rather than the type.

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type {
  AskAttemptView,
  HaltReason,
  SendLaneView,
} from '@/lib/solicitation/batch-view';
import {
  ApprovalPanel,
  excludedOutreachIds,
  type ApprovalPanelProps,
  type LaneWriteOutcome,
} from '../ApprovalPanel';

// ── Fixtures ────────────────────────────────────────────────────────────────

const BATCH_ID = 'e0f4a2b1-0000-7000-8000-000000000001';
const SCOPE = 'loc-1';

/** Bytes no assertion may ever find on screen. Distinctive enough that a
 *  substring search over the whole document is a meaningful check. */
const FLAGGED_SUBJECT = 'FLAGGED-SUBJECT-must-never-render';
const FLAGGED_BODY = 'FLAGGED-BODY-must-never-render';

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
    regeneratingAskId: null,
    regenBudgets: {},
    ...overrides,
  };
}

function subjectFor(contactName: string): string {
  return `Quick favour, ${contactName}?`;
}

function bodyFor(contactName: string): string {
  return `Hi ${contactName}, thanks for coming in on Tuesday — would you leave us a review?`;
}

/** The unredacted arm, named so the fixtures below can be spread and narrowed
 *  without collapsing back into the union. */
type ReadableAttempt = Extract<AskAttemptView, { redacted: false }>;

/** A live, owner-readable attempt. `rendered` is the only status the approve
 *  route accepts an exclusion for, so it is the only one that gets a control.
 *  It carries real copy: this is the message the owner is being asked to read. */
function rendered(suffix: string, contactName: string): ReadableAttempt {
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
    subject: subjectFor(contactName),
    body: bodyFor(contactName),
    lintClasses: [],
    moderationStatus: 'clean',
    moderationDetail: {},
    interpolationInputs: null,
  };
}

/** A finished attempt that will never send. Owner-readable on purpose — a lint
 *  block teaches the owner (SPEC §5.2) — so its copy is shown, and it satisfies
 *  readiness while contributing nothing to send. */
function heldByLint(suffix: string, contactName: string): ReadableAttempt {
  return {
    ...rendered(suffix, contactName),
    deliveryStatus: 'withheld',
    dispositionReason: 'lint_failed',
    lintClasses: ['incentive_language'],
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

/**
 * A redacted attempt that ALSO carries its bytes — a shape `AskAttemptView`'s
 * redacted arm forbids and the read model cannot produce. The cast is the
 * point: it proves the PROJECTION drops held content, rather than proving that
 * the type made the fixture impossible to write. If `toRows` ever stops
 * filtering on `redacted`, this fixture is what fails.
 */
function leakyRedactedAttempt(suffix: string, contactName: string): AskAttemptView {
  return {
    ...redactedAttempt(suffix, contactName),
    subject: FLAGGED_SUBJECT,
    body: FLAGGED_BODY,
  } as unknown as AskAttemptView;
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

/**
 * The full prop set, so a test that has to `rerender` — the shape a refetch
 * takes — states only what it is varying. `onChanged` must be passed in
 * explicitly whenever a test rerenders and then asserts on it: a fresh `vi.fn()`
 * per call would both lose the earlier calls and change an effect dependency.
 */
function props(
  overrides: {
    sendLane?: SendLaneView;
    attempts?: AskAttemptView[];
    onChanged?: (message: string, outcome: LaneWriteOutcome) => void;
  } = {},
): ApprovalPanelProps {
  return {
    batchId: BATCH_ID,
    sendLane: overrides.sendLane ?? sendLane(),
    attempts: overrides.attempts ?? [],
    scope: SCOPE,
    onChanged: overrides.onChanged ?? vi.fn(),
  };
}

/** Every regenerate control on screen, found the way a screen reader would. */
const regenControls = () =>
  screen.queryAllByRole('button', { name: /ask for a new version/i });

/** The ONE regenerate control on a single-ask fixture — a `get` query, so an
 *  absent control fails as a missing element rather than an undefined index. */
const regenControl = () => screen.getByRole('button', { name: /ask for a new version/i });

/** Flushes the POST's promise chain without moving any clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const approveButton = () => screen.queryByRole('button', { name: /approve and send/i });
const haltButton = () => screen.queryByRole('button', { name: /stop this batch/i });

/** Everything the browser could reach: markup, attribute values and keys all
 *  end up here, so a substring miss is a real absence rather than a missing
 *  query. */
const documentHtml = () => document.body.innerHTML;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── What the owner reads ────────────────────────────────────────────────────

describe('ApprovalPanel — the messages themselves', () => {
  it('renders the subject and body of every approvable message, and neither for a held one', () => {
    renderPanel(sendLane({ moderationWithheld: 1 }), [
      rendered('1', 'Dana Reeve'),
      rendered('2', 'Sam Okafor'),
      leakyRedactedAttempt('3', 'Priya Raman'),
    ]);

    // HALF ONE — the required behaviour. The owner approves what they have
    // read, which is the stated basis for a 15-minute veto window that is an
    // undo rather than a review window.
    expect(screen.getByText('Quick favour, Dana Reeve?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Hi Dana Reeve, thanks for coming in on Tuesday — would you leave us a review?',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Quick favour, Sam Okafor?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Hi Sam Okafor, thanks for coming in on Tuesday — would you leave us a review?',
      ),
    ).toBeInTheDocument();

    // HALF TWO — the redacted arm still holds. Not in markup, not in a title,
    // aria-label or data attribute, not in a React key.
    expect(documentHtml()).not.toContain(FLAGGED_SUBJECT);
    expect(documentHtml()).not.toContain(FLAGGED_BODY);
    expect(screen.queryByText(/Priya Raman/)).toBeNull();
    expect(documentHtml()).not.toContain(redactedAttempt('3', 'Priya Raman').outreachId);

    // …and it is not simply dropped on the floor: the owner learns a count and
    // the reason, which is exactly what D6a allows them to learn.
    expect(screen.getByText('moderation_high')).toBeInTheDocument();
    expect(screen.getByText(/1 message held by the safety check/i)).toBeInTheDocument();

    // The redacted row contributes no sendable ask either.
    expect(
      screen.getByRole('button', { name: 'Approve and send 2 messages' }),
    ).toBeInTheDocument();
  });

  it('shows the approved copy on a settled batch and still hides a held message', () => {
    renderPanel(
      sendLane({
        batchState: 'veto_window',
        approvedAt: '2026-08-16 12:00:00+00',
        vetoDeadlineAt: '2026-08-16 12:15:00+00',
        moderationWithheld: 1,
      }),
      [rendered('1', 'Dana Reeve'), leakyRedactedAttempt('2', 'Priya Raman')],
    );

    // The read-only list carries the copy too: "what was approved" has to stay
    // legible after the fact, not only before it.
    expect(screen.getByText('Quick favour, Dana Reeve?')).toBeInTheDocument();
    expect(documentHtml()).not.toContain(FLAGGED_SUBJECT);
    expect(documentHtml()).not.toContain(FLAGGED_BODY);
  });

  it('says so plainly when an attempt has no copy, instead of rendering an empty message', () => {
    renderPanel(sendLane(), [
      { ...rendered('1', 'Dana Reeve'), subject: null, body: null },
    ]);

    expect(screen.getByText('No message was written for this contact.')).toBeInTheDocument();
    // "nothing was written" and "we hid it from you" must not read alike.
    expect(screen.queryByText(/safety check/i)).toBeNull();
  });
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

  // edge_cases[9]. Readiness is satisfied VACUOUSLY here — every ask has a
  // finished attempt, and every one of them was withheld — so a panel that
  // gates on `ready` alone offers to "Approve and send 0 messages" over an
  // empty list.
  it('offers no approve control when a ready batch has nothing to send', () => {
    renderPanel(sendLane({ ready: true, moderationWithheld: 1 }), [
      heldByLint('1', 'Dana Reeve'),
      redactedAttempt('2', 'Priya Raman'),
    ]);

    expect(screen.getByText(/Nothing to send in this batch/i)).toBeInTheDocument();
    expect(approveButton()).toBeNull();
    expect(haltButton()).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // The batch is not pretended away: the held attempt is still listed with
    // its reason-bearing status, and the report below carries the rest.
    expect(screen.getByText('Held back')).toBeInTheDocument();
  });

  it('offers no approve control when a ready batch produced no attempts at all', () => {
    renderPanel(sendLane({ ready: true }), []);

    expect(screen.getByText(/Nothing to send in this batch/i)).toBeInTheDocument();
    expect(approveButton()).toBeNull();
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
    expect(onChanged.mock.calls[0]?.[1]).toBe('settled');
  });

  // Excluding everyone is a legitimate act (edge_cases[0]) — the approve
  // control gates on rows that EXIST, never on rows still selected.
  it('keeps the approve control after the owner deselects every ask', () => {
    renderPanel(sendLane(), [rendered('1', 'Dana Reeve')]);

    fireEvent.click(screen.getByRole('checkbox', { name: /Send to Dana Reeve/i }));
    expect(
      screen.getByRole('button', { name: 'Approve and send 0 messages' }),
    ).toBeInTheDocument();
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

    expect(haltButton()).toBeInTheDocument();
    // Approved means the list is settled: read-only, no re-approval, and no
    // edit affordance anywhere (D22).
    expect(approveButton()).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // Exact, not a substring: the copy below the name mentions her too.
    expect(screen.getByText('Dana Reeve')).toBeInTheDocument();
    expect(screen.getByText('Quick favour, Dana Reeve?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit|regenerate|rewrite/i })).toBeNull();
  });

  // The haltable arm is one mode over three Batch states, and each has to say
  // what has and has not left. `sending` is the one that used to inherit
  // "nothing has left yet" if anything else was ever routed here.
  it('tells the owner what has already left, per haltable state', () => {
    const cases: Array<[SendLaneView['batchState'], RegExp]> = [
      ['veto_window', /Nothing has left yet/i],
      ['approved', /waiting to go out/i],
      ['sending', /going out now/i],
    ];

    for (const [batchState, copy] of cases) {
      const { unmount } = render(
        <ApprovalPanel
          batchId={BATCH_ID}
          sendLane={sendLane({ batchState, approvedAt: '2026-08-16 12:00:00+00' })}
          attempts={[rendered('1', 'Dana Reeve')]}
          scope={SCOPE}
          onChanged={vi.fn()}
        />,
      );
      expect(screen.getByText(copy)).toBeInTheDocument();
      expect(haltButton()).toBeInTheDocument();
      unmount();
    }
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

    fireEvent.click(haltButton()!);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/dashboard/solicitation/batch/halt?scope=${SCOPE}`);
    expect(init.method).toBe('POST');
    // EXACTLY one key. Not a reason, not an empty reason, not a null one — the
    // server derives it from Batch state so the audit trail cannot be dictated.
    expect(JSON.parse(String(init.body))).toEqual({ batchId: BATCH_ID });

    expect(onChanged).toHaveBeenCalledWith(
      'Batch stopped. Nothing further will send.',
      'settled',
    );
  });

  it('shows the expired state with no approve control', () => {
    renderPanel(sendLane({ batchState: 'expired', ready: true }), [
      rendered('1', 'Dana Reeve'),
    ]);

    expect(
      screen.getByText(/This batch expired before it was approved/i),
    ).toBeInTheDocument();
    expect(approveButton()).toBeNull();
    expect(haltButton()).toBeNull();
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
      [leakyRedactedAttempt('1', 'Priya Raman')],
    );

    expect(
      screen.getByText(/You stopped this batch before anything left\. It cannot be resumed\./i),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    // The redacted attempt contributes a reason and a count — and NOTHING else.
    // It is not in the list, its contact is not named, and its bytes are absent
    // even though this fixture carries them.
    expect(screen.getByText('moderation_high')).toBeInTheDocument();
    expect(screen.getByText(/2 messages held by the safety check/i)).toBeInTheDocument();
    expect(screen.queryByText(/Priya Raman/)).toBeNull();
    expect(documentHtml()).not.toContain(FLAGGED_SUBJECT);
    expect(documentHtml()).not.toContain(FLAGGED_BODY);
  });

  // One latch, five reasons, and only two of them are the owner's. #630 writes
  // `send_window_elapsed` through this same latch, so copy that says "you" for
  // all five starts lying the moment it lands.
  it('names who stopped the batch, and says "you" only when the owner did', () => {
    const cases: Array<[HaltReason, RegExp]> = [
      ['owner_veto', /You stopped this batch before anything left/i],
      ['owner_halt', /You stopped this batch while it was sending/i],
      ['admin_halt', /RepWorth support stopped this batch/i],
      ['send_window_elapsed', /ran out of time before everything went out/i],
      ['batch_expired', /expired before it was approved/i],
    ];

    for (const [haltReason, copy] of cases) {
      const { unmount } = render(
        <ApprovalPanel
          batchId={BATCH_ID}
          sendLane={sendLane({
            batchState: 'halted',
            haltedAt: '2026-08-16 12:05:00+00',
            haltReason,
          })}
          attempts={[rendered('1', 'Dana Reeve')]}
          scope={SCOPE}
          onChanged={vi.fn()}
        />,
      );

      expect(screen.getByText(copy)).toBeInTheDocument();
      if (!haltReason.startsWith('owner_')) {
        expect(screen.queryByText(/You stopped/i)).toBeNull();
      }
      unmount();
    }
  });
});

// ── When the write does not settle ──────────────────────────────────────────

describe('ApprovalPanel — failure honesty', () => {
  it('repeats a refusal the server actually gave, and claims nothing changed only then', async () => {
    // A 409 is a validated refusal: `approveBatch` checks readiness and the
    // exclusion list BEFORE it writes anything, so "nothing was approved" is
    // the truth here rather than a guess.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(409, { status: 'not_ready', missingRenders: 1 })),
    );

    const { onChanged } = renderPanel(sendLane(), [rendered('1', 'Dana Reeve')]);
    fireEvent.click(approveButton()!);
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent(
      /Some messages are still being prepared\. Nothing was approved/i,
    );
    // A refusal is settled: the panel keeps the screen and does not refetch.
    expect(onChanged).not.toHaveBeenCalled();
    expect(approveButton()).toBeEnabled();
  });

  it('never claims nothing changed when the request could not reach the server', async () => {
    // The transaction may already have committed: the batch could be approved
    // with its 15-minute veto clock running while this owner is told the
    // opposite.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const { onChanged } = renderPanel(sendLane(), [rendered('1', 'Dana Reeve')]);
    fireEvent.click(approveButton()!);
    await flush();

    expect(screen.queryByText(/Nothing changed/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Handed up as an admission, not a report — the parent refetches and shows
    // whatever the server actually did.
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(String(onChanged.mock.calls[0]?.[0])).toMatch(/could not confirm/i);
    expect(onChanged.mock.calls[0]?.[1]).toBe('unconfirmed');
  });

  it('treats a 500 the same way, and leaves the retry available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    const { onChanged } = renderPanel(
      sendLane({
        batchState: 'veto_window',
        approvedAt: '2026-08-16 12:00:00+00',
        vetoDeadlineAt: '2026-08-16 12:15:00+00',
      }),
      [rendered('1', 'Dana Reeve')],
    );
    fireEvent.click(haltButton()!);
    await flush();

    expect(screen.queryByText(/Nothing changed/i)).toBeNull();
    expect(onChanged).toHaveBeenCalledWith(expect.stringMatching(/could not confirm/i), 'unconfirmed');
    // Retrying is safe: the Halt latch is monotone and approval is CAS'd.
    expect(haltButton()).toBeEnabled();
  });
});

describe('regenerate control', () => {
  it('offers a regenerate control on every rendered ask while the batch is approvable', () => {
    render(
      <ApprovalPanel {...props({ attempts: [rendered('1', 'Ana'), rendered('2', 'Bo')] })} />,
    );

    // One per rendered ask, not one per batch: "regenerate all" cannot exist,
    // because the outbox dedup is keyed (topic, aggregate_id = batchId).
    expect(regenControls()).toHaveLength(2);
    // …and D22 still holds beside it — asking is offered, writing is not.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers no regenerate control on a withheld ask', () => {
    render(
      <ApprovalPanel
        {...props({ attempts: [rendered('1', 'Ana'), heldByLint('2', 'Bo')] })}
      />,
    );

    // §8.2 r6: blocked is terminal. The control's absence is the UI half of the
    // rule the worker enforces — re-rolling a withheld row would launder the
    // fail-closed lint.
    const controls = regenControls();
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAccessibleName(/Ana/);
    // Bo carries no ROW control at all in approvable mode — the selectable list
    // is `sendable` only, so a withheld ask cannot acquire one by accident. His
    // reason is reported below the panel, in BatchReport.
    expect(screen.queryByText(/Send to Bo/)).toBeNull();
  });

  it('offers no regenerate control once the batch is approved', () => {
    render(
      <ApprovalPanel
        {...props({
          sendLane: sendLane({
            batchState: 'approved',
            approvedAt: '2026-08-17 10:00:00+00',
          }),
          attempts: [rendered('1', 'Ana')],
        })}
      />,
    );

    // ADR 0020 on screen: approved bytes cannot be replaced, so the affordance
    // is gone rather than present-and-failing.
    expect(regenControls()).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('disables the regenerate control on an ask the owner has deselected', () => {
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana')] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Send to Ana/ }));

    // Regenerating a deselected ask mints a new outreachId. The exclusion is
    // keyed on the ask so it survives that, but offering a control that
    // reshuffles the row a deselection is about is worse than not offering it.
    expect(regenControl()).toBeDisabled();
    // Disabled, not absent: the owner can re-select and use it.
    expect(regenControls()).toHaveLength(1);
  });

  it('renders the per-ask regenerate counter and disables the control once the budget is spent', () => {
    render(
      <ApprovalPanel
        {...props({
          sendLane: sendLane({
            regenBudgets: { 'ask-1': { used: 3, limit: 3, remaining: 0 } },
          }),
          attempts: [rendered('1', 'Ana')],
        })}
      />,
    );

    expect(screen.getByText('3 of 3 today')).toBeInTheDocument();
    expect(regenControl()).toBeDisabled();
  });

  it('renders no regenerate counter when the budget is unknown', () => {
    const { unmount } = render(
      <ApprovalPanel {...props({ attempts: [rendered('1', 'Ana')] })} />,
    );

    // An ABSENT entry is UNKNOWN (Redis down), never "0 remaining": no counter,
    // control enabled. Inverting this disables every control during an outage,
    // and the worker's Lua INCR is the authoritative gate regardless.
    expect(screen.queryByText(/today$/)).toBeNull();
    expect(regenControl()).toBeEnabled();
    unmount();

    // The other half of the same rule, asserted here because the two are only
    // meaningful against each other: a PRESENT entry with `used: 0` is a KNOWN
    // zero, so it does render a counter — absent and zero must not look alike.
    render(
      <ApprovalPanel
        {...props({
          sendLane: sendLane({
            regenBudgets: { 'ask-1': { used: 0, limit: 3, remaining: 3 } },
          }),
          attempts: [rendered('1', 'Ana')],
        })}
      />,
    );

    expect(screen.getByText('0 of 3 today')).toBeInTheDocument();
    expect(regenControl()).toBeEnabled();
  });

  it('disables approve and every regenerate control while a regeneration is in flight', () => {
    render(
      <ApprovalPanel
        {...props({
          sendLane: sendLane({ regeneratingAskId: 'ask-1' }),
          attempts: [rendered('1', 'Ana'), rendered('2', 'Bo')],
        })}
      />,
    );

    // Disabled, but still LABELLED as approve: nothing is being approved, and a
    // button that said "Approving…" here would name the wrong act.
    expect(screen.getByRole('button', { name: /Approve and send/ })).toBeDisabled();
    // BOTH — the dedup is per batch, so a second request would 409 anyway.
    for (const control of regenControls()) expect(control).toBeDisabled();
    expect(screen.getByRole('button', { name: /Ana/ })).toHaveTextContent(
      'Writing a new version…',
    );
  });

  it('reports that nothing changed when a regeneration settles without a new attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(202, { status: 'accepted' })),
    );
    const onChanged = vi.fn();
    const ana = rendered('1', 'Ana');

    const { rerender, unmount } = render(
      <ApprovalPanel {...props({ attempts: [ana], onChanged })} />,
    );
    fireEvent.click(regenControl());
    await flush();
    // The 202's own sentence: accepted, not done.
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(String(onChanged.mock.calls[0]?.[0])).toMatch(/writing a new version/i);

    // The refetch: the flight is over and the ask still carries attempt 1. The
    // worker refused (budget race, lapsed subscription, a swap that lost its
    // re-check) and left the copy alone — the spinner stopping over unchanged
    // words reads as "nothing happened", so the panel says it.
    rerender(<ApprovalPanel {...props({ attempts: [{ ...ana }], onChanged })} />);

    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(String(onChanged.mock.calls[1]?.[0])).toMatch(
      /could not write a new version.*unchanged/i,
    );
    expect(onChanged.mock.calls[1]?.[1]).toBe('settled');
    unmount();

    // …and the SAME settlement carrying a new attempt says nothing of the kind.
    const landed = vi.fn();
    const { rerender: rerenderLanded } = render(
      <ApprovalPanel {...props({ attempts: [ana], onChanged: landed })} />,
    );
    fireEvent.click(regenControl());
    await flush();
    rerenderLanded(
      <ApprovalPanel
        {...props({
          attempts: [{ ...ana, outreachId: 'replacement-1', attemptNo: 2 }],
          onChanged: landed,
        })}
      />,
    );

    expect(landed).toHaveBeenCalledTimes(1);
    expect(String(landed.mock.calls[0]?.[0])).not.toMatch(/could not write/i);
  });

  it('keeps an ask excluded when a regeneration replaces its outreach id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: 'approved',
        approvedCount: 1,
        excludedCount: 1,
        vetoDeadlineAt: '2026-08-17 12:15:00+00',
        close: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();

    const { rerender } = render(
      <ApprovalPanel
        {...props({ attempts: [rendered('1', 'Ana'), rendered('2', 'Bo')], onChanged })}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Send to Ana/ }));
    expect(
      screen.getByRole('button', { name: 'Approve and send 1 message' }),
    ).toBeInTheDocument();

    // The refetch after a regeneration (this tab's or another's): Ana's ask now
    // carries attempt 2 under a NEW outreachId. Keying the exclusion on askId
    // is what keeps her deselected — the round-1 pruning approach dropped the
    // stale id and silently re-selected her, which would have SENT a message
    // the owner explicitly deselected.
    const regenerated = { ...rendered('9', 'Ana'), askId: 'ask-1', attemptNo: 2 };
    rerender(
      <ApprovalPanel
        {...props({ attempts: [regenerated, rendered('2', 'Bo')], onChanged })}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Approve and send 1 message' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Send to Ana/ })).not.toBeChecked();

    // And the payload carries her NEW outreach id, not the superseded one —
    // otherwise `approveBatch` refuses the whole approval `unknown_exclusion`.
    fireEvent.click(screen.getByRole('button', { name: /Approve and send/ }));
    await flush();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      batchId: BATCH_ID,
      excludedOutreachIds: [regenerated.outreachId],
    });
    expect(regenerated.outreachId).not.toBe(rendered('1', 'Ana').outreachId);
  });

  it('shows the daily rewrite limit when a regenerate POST is refused 429', async () => {
    // The server's own sentence, verbatim from `askRegenLimitResponse`. The 429
    // body carries no `status`, so without Step 4c this fell through to
    // `unconfirmed` — the one outcome it definitely is not.
    const limitMessage =
      'Daily rewrite limit reached for this message — you can try again tomorrow.';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(429, {
          error: 'regen_limit_reached',
          message: limitMessage,
          remaining: 0,
          limit: 3,
        }),
      ),
    );

    const onChanged = vi.fn();
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana')], onChanged })} />);
    fireEvent.click(regenControl());
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent(limitMessage);
    // A DEFINITE refusal: the panel keeps the screen and claims no uncertainty.
    expect(screen.queryByText(/could not confirm/i)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reports a settled regeneration that completed before the first refetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(202, { status: 'accepted' })),
    );
    const onChanged = vi.fn();
    const ana = rendered('1', 'Ana');

    const { rerender } = render(
      <ApprovalPanel {...props({ attempts: [ana], onChanged })} />,
    );
    fireEvent.click(regenControl());
    await flush();

    // The worker finished between the 202 and the first poll, so
    // `regeneratingAskId` was NEVER observed non-null. Outcome reporting must
    // not depend on having caught the in-flight state (round 1, finding 10).
    rerender(
      <ApprovalPanel
        {...props({
          attempts: [
            {
              ...ana,
              outreachId: 'replacement-1',
              attemptNo: 2,
              subject: 'A second draft for Ana',
              body: 'A completely different way of asking.',
            },
          ],
          onChanged,
        })}
      />,
    );

    // The new copy is what the owner reads, and nothing claims it failed.
    expect(screen.getByText('A second draft for Ana')).toBeInTheDocument();
    for (const call of onChanged.mock.calls) {
      expect(String(call[0])).not.toMatch(/could not write a new version/i);
    }
  });

  it('says the owner may ask for a new version but may not write one', () => {
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana')] })} />);

    // D22 survives #860 and the panel has to keep saying so.
    expect(
      screen.getByText(
        /ask for a new version of any message, but you cannot write one yourself/i,
      ),
    ).toBeInTheDocument();
  });

  describe('invariants', () => {
    it('property: every excluded ask resolves to a live outreach id or drops out of the payload', () => {
      fc.assert(
        fc.property(
          fc.array(fc.uuid()),
          fc.array(fc.tuple(fc.uuid(), fc.uuid())),
          (excludedAskIds, livePairs) => {
            const rows = livePairs.map(([askId, outreachId]) => ({
              ...rendered('1', 'Ana'),
              askId,
              outreachId,
            }));
            const payload = excludedOutreachIds(rows, new Set(excludedAskIds));

            // Every id in the payload is a LIVE outreach id — this is the half
            // that keeps `approveBatch` from refusing the whole approval
            // `unknown_exclusion`.
            const liveOutreachIds = rows.map((row) => row.outreachId);
            for (const id of payload) expect(liveOutreachIds).toContain(id);

            // And every deselected ask that still HAS a live row is in the
            // payload — the half pruning got wrong: an ask must never be
            // silently re-selected just because its row was replaced.
            for (const row of rows) {
              if (excludedAskIds.includes(row.askId)) {
                expect(payload).toContain(row.outreachId);
              }
            }
          },
        ),
      );
    });
  });
});
