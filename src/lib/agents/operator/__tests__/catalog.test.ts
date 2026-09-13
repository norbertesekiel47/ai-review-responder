import { describe, it, expect } from 'vitest';
import type { VoiceConfig } from '@/lib/responses/voice-settings';
import { CATALOG, modelVisibleOperations, proposableOperation } from '../catalog';

/** A valid input for each proposable operation, used by title 35's describer sweep. */
const SAMPLE_INPUT: Record<string, Record<string, unknown>> = {
  set_tone: { tone: 'warm and brief' },
  set_products_services: { productsServices: 'espresso, pastries' },
  set_avoid_facts: { avoidFacts: ['never mention the old owner'] },
  set_highlight_facts: { highlightFacts: ['award-winning espresso'] },
};

/**
 * The voice column(s) each operation — and ONLY that operation — may write.
 * Spelled OUT here rather than derived from `writerFields` itself: a test that
 * asked the implementation what it writes and then asserted it writes that
 * would pass for every implementation, including one that writes all five.
 */
const OWN_FIELDS: Record<string, readonly (keyof VoiceConfig)[]> = {
  set_tone: ['tone'],
  set_products_services: ['productsServices'],
  set_avoid_facts: ['avoidFacts'],
  set_highlight_facts: ['highlightFacts'],
};

/** A non-empty state for every voice field, so an overwrite is visible. */
const VOICE: VoiceConfig = {
  tone: 'formal',
  productsServices: 'haircuts',
  avoidFacts: ['parking'],
  highlightFacts: ['late opening'],
  sampleResponses: ['Thanks for visiting!'],
};

describe('operator catalog', () => {
  it('catalog separates read, proposable, and capture kinds by type and exposes only model-visible operations to the prompt', () => {
    // Three kinds, and the discriminant is what separates them: only a
    // `proposable` carries the write-shaped members, so a read or a capture
    // cannot be registered as immediately executable.
    expect(new Set(Object.values(CATALOG).map((op) => op.kind)))
      .toEqual(new Set(['read', 'proposable', 'capture']));
    for (const op of Object.values(CATALOG)) {
      if (op.kind === 'proposable') {
        expect(typeof op.parseInput).toBe('function');
        expect(typeof op.preview).toBe('function');
        expect(op.scopeRule).toBe('location');
      } else {
        // Narrowing proves the absence: a read/capture has no such members.
        expect('parseInput' in op).toBe(false);
        expect('preview' in op).toBe(false);
        expect(typeof op.describe).toBe('string');
      }
    }
    // `proposableOperation` is the only door to the write-shaped members, and
    // it refuses a read, a capture and an unregistered id alike.
    expect(proposableOperation('set_tone')).not.toBeNull();
    expect(proposableOperation('read_pending_work')).toBeNull();
    expect(proposableOperation('record_unsupported_request')).toBeNull();
    expect(proposableOperation('set_daily_cap')).toBeNull();
    expect(proposableOperation('apply_proposal')).toBeNull();

    const visible = modelVisibleOperations('copilot').map((op) => op.id).sort();
    expect(visible).toEqual([
      'read_operating_rules',
      'read_pending_work',
      'read_recent_completed',
      'record_unsupported_request',
      'set_avoid_facts',
      'set_highlight_facts',
      'set_products_services',
      'set_tone',
    ]);
    // Run B's operations and the two commands are not registered at all, so
    // the prompt cannot name an operation whose executor does not exist.
    for (const absent of ['set_auto_reply_scope', 'set_veto_window', 'set_daily_cap', 'apply_proposal', 'decline_proposal']) {
      expect(visible).not.toContain(absent);
    }
    // Every visible entry carries the sentence the prompt reads, and it is the
    // input-free `summary`, never a describer that would need an input.
    for (const op of modelVisibleOperations('copilot')) {
      expect(op.describe.length).toBeGreaterThan(0);
    }
    // T8 (2026-09-13): the model learns each proposable's `input` keys FROM
    // the projection, never from the prompt (which must not carry a second
    // list of ids). The shape's keys must be exactly the keys the STRICT zod
    // schema accepts — SAMPLE_INPUT is that key set, proven by the parse in
    // the describer sweep below — and an extra key must still be refused, so
    // the shape cannot drift wider than the contract.
    for (const op of modelVisibleOperations('copilot')) {
      if (op.kind !== 'proposable') {
        expect(op.input).toBeUndefined();
        continue;
      }
      expect(op.input).toBeDefined();
      const shapeKeys = [...op.input!.matchAll(/"([A-Za-z]+)"\s*:/g)].map((m) => m[1]).sort();
      expect(shapeKeys).toEqual(Object.keys(SAMPLE_INPUT[op.id]!).sort());
      expect(proposableOperation(op.id)!.parseInput({ ...SAMPLE_INPUT[op.id], extra: 1 }).ok).toBe(false);
    }
  });

  it('invariants: every catalog operation declares a contract version and a describer', () => {
    const proposables = Object.values(CATALOG).filter((op) => op.kind === 'proposable');
    expect(proposables.length).toBe(4);
    for (const op of proposables) {
      expect(op.contractVersion).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(op.contractVersion)).toBe(true);
      expect(['rule', 'fact']).toContain(op.labelKind);
      expect(typeof op.summary).toBe('string');
      expect(op.summary.length).toBeGreaterThan(0);

      // The describer must actually produce a sentence from a real input —
      // asserting `typeof op.describe === 'function'` would pass for a stub.
      const sample = SAMPLE_INPUT[op.id];
      expect(sample, `${op.id} needs a sample input`).toBeDefined();
      const parsed = op.parseInput(sample!);
      expect(parsed.ok, `${op.id} must accept its own sample input`).toBe(true);
      if (!parsed.ok) continue;
      const described = op.describe(parsed.input);
      expect(described.length, `${op.id} describer`).toBeGreaterThan(0);
      expect(described).not.toContain('undefined');
      expect(described).not.toContain('[object Object]');
    }
  });

  it('every proposable writes exactly the field its operation names, and its preview is that write laid over the current state', async () => {
    // RT-05 / F1. Two facts, for EVERY proposable rather than for `set_tone`
    // alone:
    //
    //  1. `writerFields` names this operation's own column(s) and no others.
    //     A widened bag is how an Apply silently reverts a concurrent edit to
    //     a field the owner never agreed to change (D10) — and the **Version
    //     token** cannot catch it, because it proves the ROW did not move, not
    //     that the write was narrow.
    //  2. `preview().after` IS the full state with that bag laid over it. The
    //     two used to be written twice per operation (an `apply` function and
    //     a `writerFields` function), so a card could promise a state the
    //     executor would not produce.
    const proposables = Object.values(CATALOG).filter((op) => op.kind === 'proposable');
    expect(proposables.length).toBe(4);

    for (const op of proposables) {
      const own = OWN_FIELDS[op.id];
      expect(own, `${op.id} needs its own-field list`).toBeDefined();
      const parsed = op.parseInput(SAMPLE_INPUT[op.id]!);
      expect(parsed.ok, `${op.id} must accept its own sample input`).toBe(true);
      if (!parsed.ok) continue;

      const fields = op.writerFields(parsed.input);
      expect(Object.keys(fields).sort(), `${op.id} writerFields`).toEqual([...own!].sort());
      // …and the value is the INPUT's, not a constant the sample happens to match.
      for (const field of own!) {
        expect(fields[field]).toEqual(SAMPLE_INPUT[op.id]![field]);
      }

      const preview = op.preview(VOICE, parsed.input);
      // `before` is the state handed in, untouched — the card shows the real
      // current state, not a reconstruction.
      expect(preview.before).toEqual(VOICE);
      expect(preview.after).toEqual({ ...VOICE, ...fields });
      // Every OTHER field survives the preview unchanged, which is the half an
      // `after`-shaped writer would break.
      for (const key of Object.keys(VOICE) as (keyof VoiceConfig)[]) {
        if (own!.includes(key)) continue;
        expect(preview.after[key], `${op.id} must not touch ${key}`).toEqual(VOICE[key]);
      }
      // The change really happened: the named field is the input's value and
      // differs from where it started, so an identity `writerFields` fails.
      for (const field of own!) {
        expect(preview.after[field]).toEqual(fields[field]);
        expect(preview.after[field]).not.toEqual(VOICE[field]);
      }
    }
  });
});
