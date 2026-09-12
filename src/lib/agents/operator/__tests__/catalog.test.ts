import { describe, it, expect } from 'vitest';
import { CATALOG, modelVisibleOperations, proposableOperation } from '../catalog';

/** A valid input for each proposable operation, used by title 35's describer sweep. */
const SAMPLE_INPUT: Record<string, Record<string, unknown>> = {
  set_tone: { tone: 'warm and brief' },
  set_products_services: { productsServices: 'espresso, pastries' },
  set_avoid_facts: { avoidFacts: ['never mention the old owner'] },
  set_highlight_facts: { highlightFacts: ['award-winning espresso'] },
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
});
