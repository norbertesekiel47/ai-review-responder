// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAdminActionForm } from '@/hooks/useAdminActionForm';

/**
 * The contract the five admin surfaces' hand-written reducers relied on (#880).
 *
 * The cases that matter are the ORDERING ones. Five copies agreed on what a
 * submit does; they disagreed on when the outcome is cleared and on what a
 * success carries, and getting either wrong is invisible until an operator
 * reads a stale sentence next to a fresh refusal.
 */

interface Fields {
  note: string;
  ticketId: string;
}

const INITIAL: Fields = { note: '', ticketId: '' };

/** Both success channels the five surfaces actually use, in one place. */
function renderMessageForm() {
  return renderHook(() => useAdminActionForm<Fields, string>(INITIAL));
}

describe('useAdminActionForm — fields', () => {
  it('starts with the given fields, idle and with both channels empty', () => {
    const { result } = renderMessageForm();
    expect(result.current.fields).toEqual(INITIAL);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.outcome).toBeNull();
  });

  it('accepts a FACTORY, so a field computed at mount is not captured at module load', () => {
    // ManualRankingSection's date field is `todayLocal()`. A value initializer
    // would freeze it at import time and the form would offer a stale date to
    // every later session in the same tab.
    let calls = 0;
    const { result } = renderHook(() =>
      useAdminActionForm<Fields>(() => {
        calls += 1;
        return { note: 'from factory', ticketId: '' };
      }),
    );
    expect(result.current.fields.note).toBe('from factory');
    expect(calls).toBe(1);
  });

  it('sets ONE field and leaves the others alone', () => {
    const { result } = renderMessageForm();
    act(() => result.current.set('note', 'why'));
    expect(result.current.fields).toEqual({ note: 'why', ticketId: '' });
  });

  it('patches several fields at once — the shape a success that clears some uses', () => {
    const { result } = renderMessageForm();
    act(() => result.current.set('note', 'why'));
    act(() => result.current.set('ticketId', 'T-1'));
    act(() => result.current.patch({ ticketId: '' }));
    expect(result.current.fields).toEqual({ note: 'why', ticketId: '' });
  });

  it('a field edit does NOT touch either outcome channel', () => {
    // Only ManualRankingSection clears on edit, and it composes `set` +
    // `clearOutcome` itself. Baking that in would silently wipe the other four
    // surfaces' messages as the operator types.
    const { result } = renderMessageForm();
    act(() => result.current.fail('nope'));
    act(() => result.current.set('note', 'typing'));
    expect(result.current.error).toBe('nope');
  });
});

describe('useAdminActionForm — the two outcome channels', () => {
  it('fail sets the refusal copy', () => {
    const { result } = renderMessageForm();
    act(() => result.current.fail('Use 1 to 7 days.'));
    expect(result.current.error).toBe('Use 1 to 7 days.');
  });

  it('succeed carries whatever this form\'s success means', () => {
    const { result } = renderMessageForm();
    act(() => result.current.succeed('Extension granted until Friday.'));
    expect(result.current.outcome).toBe('Extension granted until Friday.');
  });

  it('carries a whole OBJECT when that is what the success means', () => {
    // CsvImportClient's success is a report, not a sentence. Flattening every
    // success to `string | null` is the cheap unification this hook refuses.
    const { result } = renderHook(() =>
      useAdminActionForm<Fields, { created: number; failedCount: number }>(INITIAL),
    );
    act(() => result.current.succeed({ created: 3, failedCount: 1 }));
    expect(result.current.outcome).toEqual({ created: 3, failedCount: 1 });
  });

  it('clearOutcome empties BOTH channels', () => {
    const { result } = renderMessageForm();
    act(() => result.current.fail('bad'));
    act(() => result.current.succeed('good'));
    act(() => result.current.clearOutcome());
    expect(result.current.error).toBeNull();
    expect(result.current.outcome).toBeNull();
  });

  it('leaves outcome always null when the form declares no success channel', () => {
    // `TOutcome = never` makes `succeed` uncallable — the ImpersonationStartClient
    // shape, where the success is a navigation and there is nothing to announce.
    const { result } = renderHook(() => useAdminActionForm<Fields>(INITIAL));
    expect(result.current.outcome).toBeNull();
  });
});

describe('useAdminActionForm — run', () => {
  it('holds busy true for the duration and clears it afterwards', async () => {
    const { result } = renderMessageForm();
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    let finished: Promise<void>;
    await act(async () => {
      finished = result.current.run(() => pending);
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      release!();
      await finished!;
    });
    expect(result.current.busy).toBe(false);
  });

  it('clears BOTH channels at the start — a stale sentence never survives a resubmit', async () => {
    // Asserted as a POST-condition of a body that sets nothing, not by reading
    // state from inside the body: the body runs before React commits `start`,
    // so an in-body read would report the pre-submit values and prove nothing.
    const { result } = renderMessageForm();
    act(() => result.current.succeed('previous success'));
    act(() => result.current.fail('previous refusal'));

    await act(async () => {
      await result.current.run(async () => {});
    });

    expect(result.current.error).toBeNull();
    expect(result.current.outcome).toBeNull();
  });

  it('a fail raised INSIDE the body survives the finally', async () => {
    // The whole point of `stop` clearing only `busy`: every surface's
    // `submitDone` ran in a `finally` and had to leave the refusal standing.
    const { result } = renderMessageForm();
    await act(async () => {
      await result.current.run(async () => result.current.fail('HTTP 409'));
    });
    expect(result.current.error).toBe('HTTP 409');
    expect(result.current.busy).toBe(false);
  });

  it('a succeed raised INSIDE the body survives the finally', async () => {
    const { result } = renderMessageForm();
    await act(async () => {
      await result.current.run(async () => result.current.succeed('Batch stopped.'));
    });
    expect(result.current.outcome).toBe('Batch stopped.');
    expect(result.current.busy).toBe(false);
  });

  it('clears busy even when the body THROWS, and lets the throw through', async () => {
    const { result } = renderMessageForm();
    let thrown: unknown = null;
    await act(async () => {
      await result.current.run(async () => {
        throw new Error('network down');
      }).catch((err: unknown) => {
        thrown = err;
      });
    });
    expect((thrown as Error).message).toBe('network down');
    expect(result.current.busy).toBe(false);
  });

  it('a validation refusal raised BEFORE run leaves busy false — the button must not announce work that is not happening', async () => {
    // PastDueExtensionPanel and SolicitationBatchPanel both clear, then
    // validate, then return without calling `run`. Their buttons must still
    // read "Grant extension" / "Stop this batch" while the refusal shows.
    const { result } = renderMessageForm();
    act(() => {
      result.current.clearOutcome();
      result.current.fail('Say why you are stopping this batch.');
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe('Say why you are stopping this batch.');
  });
});
