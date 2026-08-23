// #890 — the mechanical tie between the named delivery-status owners and the
// SQL sites that deliberately keep LITERAL spellings (the status literals are
// parameters the query-shape pins assert by value; parameterizing the IN list
// would lose those pins for nothing). Before this suite, the coupling was
// prose on three sides and mechanical on none, so a ONE-SIDED widening passed
// every suite: widen the latch only, and the admin panel's cancel copy
// ("cancels the {cancellableCount} rendered and queued message(s) only")
// silently understated the consequence of the button beside it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANCELLABLE_DELIVERY_STATUSES,
  DISPATCHED_ARRIVAL_STATUSES,
  isCancellableDeliveryStatus,
  LIVE_DELIVERY_STATUSES,
  WITHDRAWABLE_BATCH_STATES,
} from '../delivery-status';

const renderInList = (statuses: readonly string[]): string =>
  `IN (${statuses.map((s) => `'${s}'`).join(', ')})`;

const sourceOf = (file: string): string =>
  readFileSync(join(__dirname, '..', file), 'utf8');

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe('the three delivery-status owners (#890)', () => {
  it('answers three DIFFERENT questions with three distinct sets', () => {
    expect(CANCELLABLE_DELIVERY_STATUSES).toEqual(['rendered', 'queued']);
    expect(LIVE_DELIVERY_STATUSES).toEqual(['rendered', 'queued', 'sending']);
    expect(DISPATCHED_ARRIVAL_STATUSES).toEqual(['queued', 'sending']);
    expect(WITHDRAWABLE_BATCH_STATES).toEqual(['veto_window', 'approved', 'sending']);
  });

  it('isCancellableDeliveryStatus answers ONLY the cancellable question', () => {
    expect(isCancellableDeliveryStatus('rendered')).toBe(true);
    expect(isCancellableDeliveryStatus('queued')).toBe(true);
    // `sending` is LIVE but past the point of no return — not cancellable.
    expect(isCancellableDeliveryStatus('sending')).toBe(false);
    expect(isCancellableDeliveryStatus('sent')).toBe(false);
  });

  it('every literal SQL spelling of the cancellable set matches the constant', () => {
    const cancellable = renderInList(CANCELLABLE_DELIVERY_STATUSES);

    // approval.ts: the Halt latch's outreach cancel + withdrawAsk's cancel.
    // Exactly two — a third literal spelling belongs behind the constant or in
    // this count, never unannounced.
    expect(countOf(sourceOf('approval.ts'), cancellable)).toBe(2);

    // batch-view.ts: the `cancellableCount` the admin panel's cancel copy
    // renders. Widening the latch without widening this count is the
    // one-sided drift this suite exists to catch.
    expect(countOf(sourceOf('batch-view.ts'), cancellable)).toBe(1);
  });

  it('the literal SQL spelling of the LIVE set matches the constant', () => {
    // approval.ts: withdrawAsk's remainingLive count — the settledness
    // question, not the cancellable one.
    expect(countOf(sourceOf('approval.ts'), renderInList(LIVE_DELIVERY_STATUSES))).toBe(1);
  });
});
