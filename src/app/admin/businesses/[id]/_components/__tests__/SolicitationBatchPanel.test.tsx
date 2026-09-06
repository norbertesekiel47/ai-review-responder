// @vitest-environment jsdom
//
// The admin Halt latch surface on /admin/businesses/[id] (#865; plan §3.4).
//
// The component is loaded per case through `loadPanel()`, never imported at the
// top. Two details are deliberate, and both exist so a component that has not
// been written yet fails ONE case instead of the whole file:
//
//   - the specifier is a VARIABLE carrying `@vite-ignore`. A literal one —
//     static or dynamic — is resolved by `vite:import-analysis` at TRANSFORM
//     time, so a missing file fails collection and runs zero of the titles this
//     eval promises.
//   - the module's type comes from `typeof import(…)` in a TYPE position, which
//     is erased before transform. The props stay fully typed once Task 3 lands,
//     without handing import-analysis a specifier to resolve.
//
// Copy discipline (docs/context/solicitation-send-mode-approval-halt-lane.md **Halt latch**): "stop" is the ONE carved-out
// owner-facing synonym. `pause`, `resume` and `cancel batch` stay banned
// everywhere including copy, and every case asserts that.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminBatchSummary } from '@/lib/solicitation/batch-view';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const BUSINESS_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';

/** Erased before transform — see the header. */
type PanelModule = typeof import('../SolicitationBatchPanel');
const PANEL_MODULE = '../SolicitationBatchPanel';

async function loadPanel(): Promise<PanelModule> {
  return (await import(/* @vite-ignore */ PANEL_MODULE)) as PanelModule;
}

/**
 * The `AdminBatchSummary` the panel receives. Typed `Record<string, unknown>`
 * at Task 0 because the type did not exist yet; now it does, and the fixture
 * is bound to it so a field renamed on the projection fails HERE rather than
 * rendering an undefined into the panel. House shape: `Partial<T> => T`,
 * as in `ZernioConnectionPanel.test.tsx`.
 */
function summary(overrides: Partial<AdminBatchSummary> = {}): AdminBatchSummary {
  return {
    batchId: BATCH_ID,
    batchState: 'built',
    builtAt: '2026-08-17T10:00:00.000Z',
    approvedAt: null,
    haltedAt: null,
    haltReason: null,
    cancellableCount: 2,
    sendingCount: 0,
    sentCount: 0,
    ...overrides,
  };
}

/** The Avoid list is enforced on rendered COPY, not only on identifiers. */
function expectNoBannedVocabulary(text: string): void {
  expect(text).not.toMatch(/pause/i);
  expect(text).not.toMatch(/resume/i);
  expect(text).not.toMatch(/cancel batch/i);
}

/**
 * A wire discriminant is never operator copy. Round 1 found `json.status`
 * rendered verbatim — an operator on a stale page read `not_haltable` in the
 * red paragraph — so every error case asserts the whole vocabulary is absent
 * from what is on screen. The gate's and `internalError`'s bodies are in the
 * list too: they carry `error`, and it is a diagnostic, not a sentence.
 */
function expectNoRawDiscriminator(text: string): void {
  for (const token of [
    'not_haltable',
    'not_found',
    'already_halted',
    'mfa_required',
    'mfa_check_failed',
    'internal_error',
    'invalid_body',
  ]) {
    expect(text).not.toContain(token);
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Renders a haltable batch, answers its one POST with `response`, and waits for
 * whichever paragraph the panel settles on. Returning the ELEMENT rather than
 * the string is deliberate: a refusal that lands in the emerald paragraph would
 * pass a text-only assertion while telling the operator it succeeded.
 */
async function submitStop(response: Response): Promise<{
  settled: Element;
  rendered: string;
  onHalted: ReturnType<typeof vi.fn>;
}> {
  const { SolicitationBatchPanel } = await loadPanel();
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const onHalted = vi.fn();

  const { container } = render(
    <SolicitationBatchPanel
      accountId={ACCOUNT_ID}
      businessId={BUSINESS_ID}
      summary={summary()}
      onHalted={onHalted}
    />,
  );

  fireEvent.change(screen.getByLabelText(/note/i), {
    target: { value: 'Owner called support.' },
  });
  fireEvent.click(screen.getByRole('button', { name: /stop/i }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const settled = await waitFor(() => {
    const paragraph = container.querySelector('p.text-red-700, p.text-emerald-700');
    if (paragraph === null) throw new Error('the panel has not settled on a paragraph yet');
    return paragraph;
  });

  return { settled, rendered: container.textContent ?? '', onHalted };
}

describe('SolicitationBatchPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('the admin halt panel shows a stop control for a haltable batch and submits the required note', async () => {
    const { SolicitationBatchPanel } = await loadPanel();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'halted', cancelledCount: 2, closed: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const onHalted = vi.fn();

    const { container } = render(
      <SolicitationBatchPanel
        accountId={ACCOUNT_ID}
        businessId={BUSINESS_ID}
        summary={summary()}
        onHalted={onHalted}
      />,
    );

    const note = screen.getByLabelText(/note/i);
    fireEvent.change(note, { target: { value: 'Owner called support.' } });
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/admin/solicitation/batch/halt');
    expect(init.method).toBe('POST');
    // The body is exactly the route's strictObject — a fifth field would be a
    // 400, and no field of it may name the halt reason.
    expect(JSON.parse(String(init.body))).toEqual({
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
      batchId: BATCH_ID,
      note: 'Owner called support.',
    });
    await waitFor(() => expect(onHalted).toHaveBeenCalledTimes(1));
    expectNoBannedVocabulary(container.textContent ?? '');
  });

  it('the admin halt panel shows no stop control for a pending batch, a halted batch, a closed batch, or when there is no batch', async () => {
    const { SolicitationBatchPanel } = await loadPanel();
    // FOUR non-actionable states, not three. `pending` is D11: a batch with
    // built_at IS NULL is refused by adminHaltBatch, because latching it makes
    // batch-builder's later built_at stamp violate 091's halt-consistency
    // CHECK — so offering a stop control for it would promise a 409.
    const nonActionable = [
      summary({ batchState: 'pending', builtAt: null, cancellableCount: 0 }),
      summary({
        batchState: 'halted',
        haltedAt: '2026-08-17T11:00:00.000Z',
        haltReason: 'admin_halt',
        cancellableCount: 0,
      }),
      summary({ batchState: 'closed', cancellableCount: 0 }),
      null,
    ];

    for (const state of nonActionable) {
      const { container, unmount } = render(
        <SolicitationBatchPanel
          accountId={ACCOUNT_ID}
          businessId={BUSINESS_ID}
          summary={state}
          onHalted={() => {}}
        />,
      );

      expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
      expectNoBannedVocabulary(container.textContent ?? '');
      unmount();
    }
  });

  it('a halt reason from outside the union renders a stop, never the literal undefined', async () => {
    const { SolicitationBatchPanel } = await loadPanel();

    // The read model ASSERTS halt_reason against its CHECK rather than
    // re-validating it. The live trigger is a browser cached behind the deploy
    // that widened HaltReason to six members (platform_halt, #917): the server
    // sends a reason the bundle's label table has never heard of. Unguarded,
    // the sentence rendered "Stopped <date> — undefined".
    const { container } = render(
      <SolicitationBatchPanel
        accountId={ACCOUNT_ID}
        businessId={BUSINESS_ID}
        summary={summary({
          batchState: 'halted',
          haltedAt: '2026-08-17T11:00:00.000Z',
          haltReason: 'a_reason_this_bundle_has_never_heard_of' as AdminBatchSummary['haltReason'],
          cancellableCount: 0,
        })}
        onHalted={() => {}}
      />,
    );

    const rendered = container.textContent ?? '';
    expect(rendered).not.toContain('undefined');
    expect(rendered).toContain('reason not recognised by this page');
  });

  it('the admin halt panel distinguishes sending outreach from the rendered and queued outreach a stop will cancel', async () => {
    const { SolicitationBatchPanel } = await loadPanel();

    render(
      <SolicitationBatchPanel
        accountId={ACCOUNT_ID}
        businessId={BUSINESS_ID}
        summary={summary({
          batchState: 'sending',
          approvedAt: '2026-08-17T10:30:00.000Z',
          cancellableCount: 2,
          sendingCount: 1,
          sentCount: 5,
        })}
        onHalted={() => {}}
      />,
    );

    // THREE counts, rendered separately. The single folded "live outreach"
    // count this replaces (plan round 1, finding 8) was documented as "what a
    // stop would cancel" while including the one row a stop deliberately does
    // NOT touch — halt means "no further sends", not "undo".
    expect(screen.getByTestId('admin-batch-cancellable-count')).toHaveTextContent('2');
    expect(screen.getByTestId('admin-batch-sending-count')).toHaveTextContent('1');
    expect(screen.getByTestId('admin-batch-sent-count')).toHaveTextContent('5');
    // Not folded: 2 + 1 must never be presented as the stop's reach.
    expect(screen.getByTestId('admin-batch-cancellable-count')).not.toHaveTextContent('3');
  });

  // The error paths. All four were untested at round 1, which is how the raw
  // discriminators reached operator-facing copy in the first place.

  it('explains a 409 refusal from the batch state the server returned, never the discriminator', async () => {
    // The reachable path: the summary is server-rendered once, the batch
    // settles, and the operator clicks Stop against a state that no longer
    // exists. `state` is on the wire for exactly this arm.
    const { settled, rendered, onHalted } = await submitStop(
      jsonResponse({ status: 'not_haltable', state: 'closed' }, 409),
    );

    expect(settled.className).toContain('text-red-700');
    const text = settled.textContent ?? '';
    expect(text).toMatch(/closed/i);
    expect(text).toMatch(/nothing changed/i);
    expect(text).toMatch(/reload/i);
    expectNoRawDiscriminator(text);
    expectNoBannedVocabulary(rendered);
    // A refusal is not a stop. Re-reading the page here would present the
    // failure as if something had landed.
    expect(onHalted).not.toHaveBeenCalled();
  });

  it('says a pending batch is still building when the 409 names that state', async () => {
    const { settled } = await submitStop(
      jsonResponse({ status: 'not_haltable', state: 'pending' }, 409),
    );

    const text = settled.textContent ?? '';
    expect(text).toMatch(/still building/i);
    expectNoRawDiscriminator(text);
    expectNoBannedVocabulary(text);
  });

  it('tells the operator to reload when the batch is no longer reachable (404)', async () => {
    const { settled, rendered, onHalted } = await submitStop(
      jsonResponse({ status: 'not_found' }, 404),
    );

    expect(settled.className).toContain('text-red-700');
    const text = settled.textContent ?? '';
    expect(text).toMatch(/reload/i);
    expectNoRawDiscriminator(text);
    expectNoBannedVocabulary(rendered);
    expect(onHalted).not.toHaveBeenCalled();
  });

  it('never shows the admin gate diagnostic when the AAL2 step-up has lapsed', async () => {
    // 401/403 bodies carry `error`, not a `status` from the domain union: the
    // gate refused before the route reached the latch.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { settled, rendered } = await submitStop(
      jsonResponse({ error: 'mfa_required' }, 403),
    );

    const text = settled.textContent ?? '';
    expect(text).toMatch(/session/i);
    expectNoRawDiscriminator(text);
    expectNoBannedVocabulary(rendered);
    // The diagnostic belongs in devtools, not in the paragraph.
    expect(consoleError).toHaveBeenCalled();
  });

  it('does not narrate a stop for a 2xx whose status it cannot read', async () => {
    // The M2 defect made concrete: with an open `string` discriminant every
    // status but `already_halted` fell through to "Batch stopped. 0 queued
    // message(s) cancelled." — a stop announced for a call that stopped
    // nothing.
    const { settled, rendered, onHalted } = await submitStop(
      jsonResponse({ status: 'quiesced', cancelledCount: 0 }, 200),
    );

    const text = settled.textContent ?? '';
    expect(settled.className).toContain('text-red-700');
    expect(text).not.toMatch(/batch stopped/i);
    expect(text).not.toContain('quiesced');
    expect(text).toMatch(/reload/i);
    expectNoBannedVocabulary(rendered);
    // Still a 2xx: whatever the server did, this panel's data is stale.
    expect(onHalted).toHaveBeenCalledTimes(1);
  });

  it('announces an idempotent second stop as nothing having changed', async () => {
    const { settled, rendered, onHalted } = await submitStop(
      jsonResponse({ status: 'already_halted' }, 200),
    );

    expect(settled.className).toContain('text-emerald-700');
    const text = settled.textContent ?? '';
    expect(text).toMatch(/already stopped/i);
    expect(text).toMatch(/nothing changed/i);
    expectNoRawDiscriminator(text);
    expectNoBannedVocabulary(rendered);
    expect(onHalted).toHaveBeenCalledTimes(1);
  });
});
