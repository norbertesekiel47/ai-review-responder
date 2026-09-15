import { describe, it, expect } from 'vitest';
import type { VoiceConfig } from '@/lib/responses/voice-settings';
import {
  CATALOG,
  modelVisibleOperations,
  proposableOperation,
  previewPolicyRestore,
  describePolicyRestore,
  type PolicyProposableOperation,
  type PolicyScopeState,
  type PolicyTarget,
  type VoiceProposableOperation,
} from '../catalog';
import { OPERATION_INPUT_SCHEMAS, type ProposableOperationId } from '../operation-inputs';
import type { PolicyState } from '../schema';

const LOCATION = '00000000-0000-7000-8000-00000000b101';
const ACCOUNT_TARGET: PolicyTarget = { scope: 'account' };
const LOCATION_TARGET: PolicyTarget = { scope: 'location', locationId: LOCATION };

/** A valid input for each proposable operation, used by the describer sweep. */
const SAMPLE_INPUT: Record<ProposableOperationId, Record<string, unknown>> = {
  set_tone: { tone: 'warm and brief' },
  set_products_services: { productsServices: 'espresso, pastries' },
  set_avoid_facts: { avoidFacts: ['never mention the old owner'] },
  set_highlight_facts: { highlightFacts: ['award-winning espresso'] },
  set_auto_reply_scope: { threshold: 4 },
  set_veto_window: { minutes: 30 },
  set_daily_cap: { cap: 5 },
  clear_location_override: {},
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

/**
 * A hand-written policy state. `effectiveDailyCap` is SPELLED, never computed
 * with `resolveDailyCap`: a fixture derived by the code under test agrees with
 * any implementation of it.
 */
function state(
  threshold: 4 | 5 | null,
  vetoWindowMinutes: 15 | 30,
  dailyAutoPostCap: number | null,
  effectiveDailyCap: number,
  rowExists: boolean,
): PolicyState {
  return { domain: 'policy', threshold, vetoWindowMinutes, dailyAutoPostCap, effectiveDailyCap, rowExists };
}

function policyOp(id: string): PolicyProposableOperation {
  const op = proposableOperation(id);
  if (!op || op.domain !== 'policy') throw new Error(`${id} is not a policy operation`);
  return op;
}

function voiceOps(): VoiceProposableOperation[] {
  return Object.values(CATALOG).filter(
    (op): op is VoiceProposableOperation => op.kind === 'proposable' && op.domain === 'voice',
  );
}

function parsedInput(op: PolicyProposableOperation, value: unknown): Record<string, unknown> {
  const parsed = op.parseInput(value);
  if (!parsed.ok) throw new Error(`${op.id} rejected ${JSON.stringify(value)}`);
  return parsed.input;
}

describe('operator catalog', () => {
  it('restore preview recreates custom dials and returns to inherited absence without clearing a suspension', () => {
    const accountDefault = state(4, 15, null, 10, true);
    const cleared = { ...accountDefault, rowExists: false };
    const restored = previewPolicyRestore({ accountDefault, location: cleared, targetRowSuspended: false }, LOCATION_TARGET, {
      operation: 'restore_reply_policy', locationId: LOCATION,
      state: { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 },
    });
    expect(restored).toEqual({ before: cleared, after: state(5, 30, 2, 2, true) });
    const patch = { operation: 'delete_location_override', locationId: LOCATION } as const;
    const scope = { accountDefault, location: restored.after, targetRowSuspended: false };
    const undone = previewPolicyRestore(scope, LOCATION_TARGET, patch);
    expect(undone.after).toEqual(cleared);
    expect(policyOp('clear_location_override').exposure(undone, LOCATION_TARGET)).toBe('expansion');
    expect(describePolicyRestore(undone, LOCATION_TARGET)).toContain('Restore:');
    expect(describePolicyRestore(undone, LOCATION_TARGET)).toContain('uses the account default');
    expect(previewPolicyRestore({ ...scope, targetRowSuspended: true }, LOCATION_TARGET, patch).after)
      .toEqual(state(null, 30, 2, 2, true));
  });

  it('restore preview changes only its historical dial and resets absent account defaults to platform values', () => {
    const accountDefault = state(5, 30, 7, 7, true);
    const scope = { accountDefault, location: null, targetRowSuspended: false };
    expect(previewPolicyRestore(scope, ACCOUNT_TARGET, { operation: 'set_account_veto_window', minutes: 15 }).after)
      .toEqual(state(5, 15, 7, 7, true));
    expect(previewPolicyRestore(scope, ACCOUNT_TARGET, { operation: 'clear_account_default' }).after)
      .toEqual(state(null, 15, null, 10, false));
    expect(previewPolicyRestore({ ...scope, targetRowSuspended: true }, ACCOUNT_TARGET, { operation: 'clear_account_default' }).after)
      .toEqual(state(null, 30, 7, 7, true));
  });

  it('restore inputs reverse each voice field, including nullable tone, without reverting other fields', () => {
    const original = { ...VOICE, tone: null };
    for (const op of voiceOps()) {
      const changed = op.preview(original, SAMPLE_INPUT[op.id]).after;
      const current = { ...changed, sampleResponses: ['A newer unrelated sample'] };
      const restored = op.preview(current, op.restoreInputFromState(original)).after;
      expect(restored).toEqual({ ...original, sampleResponses: current.sampleResponses });
    }
    expect(proposableOperation('set_tone')!.parseInput({ tone: null }).ok).toBe(false);
  });

  it('policy restore inputs preserve row absence and restore every dial after a deleted override', () => {
    const target = { scope: 'location', locationId: '019f43d0-0000-7000-8000-000000000011' } as const;
    const before = state(5, 30, 2, 2, true);
    const after = state(4, 15, null, 10, true);
    expect(policyOp('set_auto_reply_scope').restoreInputFromState(before, after, target))
      .toEqual({ operation: 'set_location_override', threshold: 5, locationId: target.locationId });
    expect(policyOp('set_veto_window').restoreInputFromState(before, after, target))
      .toEqual({ operation: 'set_location_veto_window', minutes: 30, locationId: target.locationId });
    expect(policyOp('set_daily_cap').restoreInputFromState(before, after, target))
      .toEqual({ operation: 'set_location_daily_cap', cap: 2, locationId: target.locationId });
    for (const op of ['set_auto_reply_scope', 'set_veto_window', 'set_daily_cap', 'clear_location_override']) {
      expect(policyOp(op).restoreInputFromState({ ...before, rowExists: false }, after, target))
        .toEqual({ operation: 'delete_location_override', locationId: target.locationId });
      expect(policyOp(op).restoreInputFromState(before, { ...after, rowExists: false }, target))
        .toEqual({ operation: 'restore_reply_policy', locationId: target.locationId,
          state: { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 } });
    }
    expect(policyOp('set_daily_cap').restoreInputFromState({ ...before, rowExists: false }, after, { scope: 'account' }))
      .toEqual({ operation: 'clear_account_default' });
  });

  it('clear location override inherits the account policy without erasing suspension', () => {
    const clear = policyOp('clear_location_override');
    const accountDefault = state(4, 15, 20, 20, true);
    const location = state(5, 30, 2, 2, true);
    const target = { scope: 'location', locationId: '019f43d0-0000-7000-8000-000000000011' } as const;
    const input = parsedInput(clear, {});
    const preview = clear.preview({ accountDefault, location, targetRowSuspended: false }, target, input);
    expect(preview).toEqual({ before: location, after: { ...accountDefault, rowExists: false } });
    expect(clear.writerPatch(input, target)).toEqual({ operation: 'delete_location_override', locationId: target.locationId });
    expect(clear.exposure(preview, target)).toBe('expansion');
    expect(clear.confirmationPhrase(preview.after, target)).toBe('4 and 5 star');
    expect(clear.scopeRule).toBe('location');
    expect(clear.parseInput({ threshold: 5 }).ok).toBe(false);
    expect(() => clear.writerPatch(input, { scope: 'account' })).toThrow();
    const suspended = clear.preview({ accountDefault, location, targetRowSuspended: true }, target, input);
    expect(suspended.after).toEqual({ ...location, threshold: null });
    expect(clear.exposure(suspended, target)).toBe('contraction');
    expect(clear.describeChange(input, suspended, target)).toContain('suspension');
  });

  it('catalog separates read, proposable, and capture kinds by type and exposes only model-visible operations to the prompt', () => {
    // Three kinds, and the discriminant is what separates them: only a
    // `proposable` carries the write-shaped members, so a read or a capture
    // cannot be registered as immediately executable.
    expect(new Set(Object.values(CATALOG).map((op) => op.kind)))
      .toEqual(new Set(['read', 'proposable', 'capture', 'prepare']));
    for (const op of Object.values(CATALOG)) {
      if (op.kind === 'proposable') {
        expect(typeof op.parseInput).toBe('function');
        expect(typeof op.preview).toBe('function');
        expect(op.scopeRule).toBe(op.domain === 'voice' || op.id === 'clear_location_override' ? 'location' : 'account_or_location');
      } else {
        // Narrowing proves the absence: a read/capture has no such members.
        expect('parseInput' in op).toBe(false);
        expect('preview' in op).toBe(false);
        expect(typeof op.describe).toBe('string');
      }
    }
    // `proposableOperation` is the only door to the write-shaped members, and
    // it refuses a read, a capture and an unregistered id alike.
    expect(proposableOperation('set_tone')?.domain).toBe('voice');
    expect(proposableOperation('set_daily_cap')?.domain).toBe('policy');
    expect(proposableOperation('read_pending_work')).toBeNull();
    expect(proposableOperation('record_unsupported_request')).toBeNull();
    expect(proposableOperation('restore_last')).toBeNull();
    expect(proposableOperation('apply_proposal')).toBeNull();
    expect(proposableOperation('clear_location_override')?.domain).toBe('policy');

    const blocked = modelVisibleOperations({ blockReasons: ['autopilot_unavailable'] });
    expect(blocked.map((op) => op.id).sort()).toEqual([
      'clear_location_override',
      'read_operating_rules',
      'read_pending_work',
      'read_recent_completed',
      'record_unsupported_request',
      'restore_last',
      'set_auto_reply_scope',
      'set_avoid_facts',
      'set_daily_cap',
      'set_highlight_facts',
      'set_products_services',
      'set_tone',
      'set_veto_window',
    ]);
    // The two commands are routes, never catalog entries.
    for (const absent of ['apply_proposal', 'decline_proposal']) {
      expect(blocked.map((op) => op.id)).not.toContain(absent);
    }

    for (const op of blocked) {
      // Every visible entry carries the input-free `summary` the prompt reads.
      expect(op.describe.length).toBeGreaterThan(0);
      if (op.kind === 'prepare') {
        expect(op).toMatchObject({ id: 'restore_last', input: '{}', scopeRule: 'account_or_location' });
        expect(op).not.toHaveProperty('expansionBlockedBy');
        continue;
      }
      if (op.kind !== 'proposable') {
        expect(op.input).toBeUndefined();
        expect(op).not.toHaveProperty('scopeRule');
        expect(op).not.toHaveProperty('expansionBlockedBy');
        continue;
      }
      // T8: the model learns each proposable's `input` keys FROM the
      // projection. The shape's keys must be exactly the keys the STRICT zod
      // schema accepts, read from the schema itself, and an extra key must be
      // refused, so the shape cannot drift wider than the contract.
      const id = op.id as ProposableOperationId;
      const shapeKeys = [...op.input!.matchAll(/"([A-Za-z]+)"\s*:/g)].map((m) => m[1]).sort();
      expect(shapeKeys, id).toEqual(Object.keys(OPERATION_INPUT_SCHEMAS[id].shape).sort());
      expect(proposableOperation(id)!.parseInput({ ...SAMPLE_INPUT[id], extra: 1 }).ok).toBe(false);

      const operation = proposableOperation(id)!;
      expect(op.scopeRule, id).toBe(operation.scopeRule);
      if (operation.domain === 'policy') {
        // Readiness is ATTACHED, not a filter: Copilot still sees the three
        // policy operations, because readiness blocks expansions only.
        expect(op.expansionBlockedBy, id).toEqual(['autopilot_unavailable']);
      } else {
        expect(op, id).not.toHaveProperty('expansionBlockedBy');
      }
    }

    const ready = modelVisibleOperations({ blockReasons: [] });
    expect(ready.find((op) => op.id === 'set_veto_window')?.expansionBlockedBy).toEqual([]);
  });

  it('invariants: every catalog operation declares a contract version, a label, an effect and a describer', () => {
    const proposables = Object.values(CATALOG).filter((op) => op.kind === 'proposable');
    expect(proposables.length).toBe(8);
    for (const op of proposables) {
      expect(op.contractVersion).toBe(1);
      expect(op.labelKind).toBe(op.domain === 'voice' ? 'fact' : 'rule');
      expect(op.affects).toBe(op.domain === 'voice' ? 'future_drafts' : 'future_eligible_reviews');
      expect(op.summary.length).toBeGreaterThan(0);

      // The describer must produce a sentence from a real input — asserting
      // `typeof op.describe === 'function'` would pass for a stub.
      const parsed = op.parseInput(SAMPLE_INPUT[op.id]);
      expect(parsed.ok, `${op.id} must accept its own sample input`).toBe(true);
      if (!parsed.ok) continue;
      const described = op.describe(parsed.input);
      expect(described.length, `${op.id} describer`).toBeGreaterThan(0);
      expect(described).not.toContain('undefined');
      expect(described).not.toContain('[object Object]');
      expect(described).not.toContain('would have posted');
    }

    // An explicit null is a real input with its own words, not a missing one.
    const scope = policyOp('set_auto_reply_scope');
    expect(scope.describe(parsedInput(scope, { threshold: null }))).toContain('off');
    const cap = policyOp('set_daily_cap');
    expect(cap.describe(parsedInput(cap, { cap: null }))).toContain('platform');
  });

  it('policy inputs enforce their domains and refuse keys they do not own', () => {
    const scope = policyOp('set_auto_reply_scope');
    for (const threshold of [4, 5, null]) expect(scope.parseInput({ threshold }).ok, String(threshold)).toBe(true);
    for (const threshold of [3, 1, '4', undefined]) expect(scope.parseInput({ threshold }).ok, String(threshold)).toBe(false);
    expect(scope.parseInput({}).ok).toBe(false);
    expect(scope.parseInput({ threshold: 4, locationId: LOCATION }).ok).toBe(false);

    const veto = policyOp('set_veto_window');
    for (const minutes of [15, 30]) expect(veto.parseInput({ minutes }).ok, String(minutes)).toBe(true);
    for (const minutes of [0, 10, 20, 45, 60, '15', null]) expect(veto.parseInput({ minutes }).ok, String(minutes)).toBe(false);

    const cap = policyOp('set_daily_cap');
    for (const value of [1, 10, 50, null]) expect(cap.parseInput({ cap: value }).ok, String(value)).toBe(true);
    for (const value of [0, 51, -1, 1.5, '10']) expect(cap.parseInput({ cap: value }).ok, String(value)).toBe(false);
    expect(cap.parseInput({ cap: 5, minutes: 15 }).ok).toBe(false);
  });

  it('a dial change on a location with no row previews the CREATED manual override, seeded from the account default', () => {
    const inheriting: PolicyScopeState = {
      targetRowSuspended: false, accountDefault: state(4, 30, 20, 20, true),
      location: state(4, 30, 20, 20, false),
    };

    const veto = policyOp('set_veto_window');
    const vetoInput = parsedInput(veto, { minutes: 15 });
    const vetoPreview = veto.preview(inheriting, LOCATION_TARGET, vetoInput);
    expect(vetoPreview.before).toEqual(inheriting.location);
    // Threshold starts manual (never inherited); the other dial is the account's.
    expect(vetoPreview.after).toEqual(state(null, 15, 20, 20, true));
    // 30 → 15 widens on its own, but the created manual override is the whole
    // operation, and it is a contraction (settings.ts isCompleteDisable).
    expect(veto.exposure(vetoPreview, LOCATION_TARGET)).toBe('contraction');
    expect(veto.confirmationPhrase(vetoPreview.after, LOCATION_TARGET)).toBe('off');
    expect(veto.writerPatch(vetoInput, LOCATION_TARGET))
      .toEqual({ operation: 'set_location_veto_window', locationId: LOCATION, minutes: 15 });

    const cap = policyOp('set_daily_cap');
    const capInput = parsedInput(cap, { cap: null });
    const capPreview = cap.preview(inheriting, LOCATION_TARGET, capInput);
    expect(capPreview.after).toEqual(state(null, 30, null, 10, true));
    expect(cap.exposure(capPreview, LOCATION_TARGET)).toBe('contraction');
    expect(cap.writerPatch(capInput, LOCATION_TARGET))
      .toEqual({ operation: 'set_location_daily_cap', locationId: LOCATION, cap: null });

    // Under a manual account default the created row changes no exposure.
    const manualAccount: PolicyScopeState = {
      targetRowSuspended: false, accountDefault: state(null, 30, 20, 20, true),
      location: state(null, 30, 20, 20, false),
    };
    expect(cap.exposure(cap.preview(manualAccount, LOCATION_TARGET, capInput), LOCATION_TARGET)).toBe('no_change');
  });

  it('a scope change on a location with no row keeps the account dials and classifies by the new threshold', () => {
    const fiveStarAccount: PolicyScopeState = {
      targetRowSuspended: false, accountDefault: state(5, 30, 20, 20, true),
      location: state(5, 30, 20, 20, false),
    };
    const scope = policyOp('set_auto_reply_scope');

    const widen = parsedInput(scope, { threshold: 4 });
    const widened = scope.preview(fiveStarAccount, LOCATION_TARGET, widen);
    expect(widened.after).toEqual(state(4, 30, 20, 20, true));
    expect(scope.exposure(widened, LOCATION_TARGET)).toBe('expansion');
    expect(scope.confirmationPhrase(widened.after, LOCATION_TARGET)).toBe('4 and 5 star');
    expect(scope.writerPatch(widen, LOCATION_TARGET))
      .toEqual({ operation: 'set_location_override', locationId: LOCATION, threshold: 4 });

    const same = scope.preview(fiveStarAccount, LOCATION_TARGET, parsedInput(scope, { threshold: 5 }));
    expect(scope.exposure(same, LOCATION_TARGET)).toBe('no_change');
    expect(scope.confirmationPhrase(same.after, LOCATION_TARGET)).toBe('5 star only');

    const off = parsedInput(scope, { threshold: null });
    const offPreview = scope.preview(fiveStarAccount, LOCATION_TARGET, off);
    expect(offPreview.after).toEqual(state(null, 30, 20, 20, true));
    expect(scope.exposure(offPreview, LOCATION_TARGET)).toBe('contraction');
    expect(scope.writerPatch(off, LOCATION_TARGET)).toEqual({ operation: 'set_location_manual', locationId: LOCATION });
  });

  it('an existing location row changes only the named dial, and any widening dimension wins', () => {
    const own: PolicyScopeState = {
      targetRowSuspended: false, accountDefault: state(4, 15, 40, 40, true),
      location: state(5, 30, 10, 10, true),
    };
    const veto = policyOp('set_veto_window');
    const cap = policyOp('set_daily_cap');
    const scope = policyOp('set_auto_reply_scope');

    const shorter = veto.preview(own, LOCATION_TARGET, parsedInput(veto, { minutes: 15 }));
    // The account default's 15 and 40 never leak into an existing row.
    expect(shorter.after).toEqual(state(5, 15, 10, 10, true));
    expect(veto.exposure(shorter, LOCATION_TARGET)).toBe('expansion');
    expect(veto.confirmationPhrase(shorter.after, LOCATION_TARGET)).toBe('5 star only');
    expect(veto.exposure(veto.preview(own, LOCATION_TARGET, parsedInput(veto, { minutes: 30 })), LOCATION_TARGET))
      .toBe('no_change');

    const removed = cap.preview(own, LOCATION_TARGET, parsedInput(cap, { cap: null }));
    expect(removed.after).toEqual(state(5, 30, null, 10, true));
    expect(cap.exposure(removed, LOCATION_TARGET)).toBe('expansion');
    const lower = cap.preview(own, LOCATION_TARGET, parsedInput(cap, { cap: 5 }));
    expect(lower.after).toEqual(state(5, 30, 5, 5, true));
    expect(cap.exposure(lower, LOCATION_TARGET)).toBe('contraction');

    const wider = scope.preview(own, LOCATION_TARGET, parsedInput(scope, { threshold: 4 }));
    expect(wider.after).toEqual(state(4, 30, 10, 10, true));
    expect(scope.exposure(wider, LOCATION_TARGET)).toBe('expansion');
    const off = scope.preview(own, LOCATION_TARGET, parsedInput(scope, { threshold: null }));
    expect(off.after).toEqual(state(null, 30, 10, 10, true));
    expect(scope.exposure(off, LOCATION_TARGET)).toBe('contraction');

    // A dial change on an ALREADY-manual row is not a complete disable.
    const manualRow: PolicyScopeState = { ...own, location: state(null, 30, 10, 10, true) };
    const manualShorter = veto.preview(manualRow, LOCATION_TARGET, parsedInput(veto, { minutes: 15 }));
    expect(manualShorter.after).toEqual(state(null, 15, 10, 10, true));
    expect(veto.exposure(manualShorter, LOCATION_TARGET)).toBe('expansion');
  });

  it('account scope previews the account default row, names all locations, and maps to the account writer operations', () => {
    const scope = policyOp('set_auto_reply_scope');
    const veto = policyOp('set_veto_window');
    const cap = policyOp('set_daily_cap');

    const accountRow: PolicyScopeState = { targetRowSuspended: false, accountDefault: state(5, 30, 10, 10, true), location: null };
    const widen = parsedInput(scope, { threshold: 4 });
    const widened = scope.preview(accountRow, ACCOUNT_TARGET, widen);
    expect(widened.after).toEqual(state(4, 30, 10, 10, true));
    expect(scope.exposure(widened, ACCOUNT_TARGET)).toBe('expansion');
    expect(scope.confirmationPhrase(widened.after, ACCOUNT_TARGET)).toBe('all locations');
    expect(scope.writerPatch(widen, ACCOUNT_TARGET)).toEqual({ operation: 'set_account_default', threshold: 4 });

    const off = parsedInput(scope, { threshold: null });
    const offPreview = scope.preview(accountRow, ACCOUNT_TARGET, off);
    expect(scope.exposure(offPreview, ACCOUNT_TARGET)).toBe('contraction');
    expect(scope.confirmationPhrase(offPreview.after, ACCOUNT_TARGET)).toBe('all locations');
    expect(scope.writerPatch(off, ACCOUNT_TARGET)).toEqual({ operation: 'set_account_manual' });

    // No account row: the created row takes the schema defaults, not a parent.
    const noRow: PolicyScopeState = { targetRowSuspended: false, accountDefault: state(null, 15, null, 10, false), location: null };
    const longer = parsedInput(veto, { minutes: 30 });
    const longerPreview = veto.preview(noRow, ACCOUNT_TARGET, longer);
    expect(longerPreview.after).toEqual(state(null, 30, null, 10, true));
    expect(veto.exposure(longerPreview, ACCOUNT_TARGET)).toBe('contraction');
    expect(veto.writerPatch(longer, ACCOUNT_TARGET)).toEqual({ operation: 'set_account_veto_window', minutes: 30 });

    const raised = parsedInput(cap, { cap: 50 });
    const raisedPreview = cap.preview(noRow, ACCOUNT_TARGET, raised);
    expect(raisedPreview.after).toEqual(state(null, 15, 50, 50, true));
    expect(cap.exposure(raisedPreview, ACCOUNT_TARGET)).toBe('expansion');
    expect(cap.writerPatch(raised, ACCOUNT_TARGET)).toEqual({ operation: 'set_account_daily_cap', cap: 50 });

    // A location preview without the location's state is a caller bug, not a guess.
    expect(() => veto.preview(noRow, LOCATION_TARGET, longer)).toThrow(/location state/);
  });

  it('policy describeChange renders the full before and after, and explains a created row with its inherited values', () => {
    const inheriting: PolicyScopeState = {
      targetRowSuspended: false, accountDefault: state(4, 30, 20, 20, true),
      location: state(4, 30, 20, 20, false),
    };
    const veto = policyOp('set_veto_window');
    const vetoInput = parsedInput(veto, { minutes: 15 });
    const vetoText = veto.describeChange(vetoInput, veto.preview(inheriting, LOCATION_TARGET, vetoInput), LOCATION_TARGET);
    expect(vetoText).toContain('This location now: replies to 4 and 5 star reviews can auto-post, a 30-minute veto window, a daily cap of 20.');
    expect(vetoText).toContain('After Apply: every reply waits for you, a 15-minute veto window, a daily cap of 20.');
    expect(vetoText).toContain("This gives this location its own settings. Auto-posting starts off. It keeps the account default's daily cap of 20.");

    const scope = policyOp('set_auto_reply_scope');
    const scopeInput = parsedInput(scope, { threshold: 5 });
    const scopeText = scope.describeChange(scopeInput, scope.preview(inheriting, LOCATION_TARGET, scopeInput), LOCATION_TARGET);
    expect(scopeText).toContain("It keeps the account default's 30-minute veto window and daily cap of 20.");
    expect(scopeText).not.toContain('starts off');

    const existing: PolicyScopeState = { ...inheriting, location: state(5, 30, null, 10, true) };
    const capOp = policyOp('set_daily_cap');
    const capInput = parsedInput(capOp, { cap: 5 });
    const capText = capOp.describeChange(capInput, capOp.preview(existing, LOCATION_TARGET, capInput), LOCATION_TARGET);
    expect(capText).toContain('a daily cap of 10 (the platform default).');
    expect(capText).toContain('After Apply: only replies to 5 star reviews can auto-post, a 30-minute veto window, a daily cap of 5.');
    expect(capText).not.toContain('its own settings');

    const noRow: PolicyScopeState = { targetRowSuspended: false, accountDefault: state(null, 15, null, 10, false), location: null };
    const accountText = veto.describeChange(vetoInput, veto.preview(noRow, ACCOUNT_TARGET, vetoInput), ACCOUNT_TARGET);
    expect(accountText).toContain('Account default now:');
    expect(accountText).toContain('This creates the account default. Auto-posting starts off.');
    for (const text of [vetoText, scopeText, capText, accountText]) {
      expect(text).not.toContain('would have posted');
      expect(text).not.toContain('undefined');
    }
  });

  it('every voice proposable writes exactly the field its operation names, and its preview is that write laid over the current state', async () => {
    // RT-05 / F1. Two facts, for EVERY voice proposable rather than for
    // `set_tone` alone:
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
    const proposables = voiceOps();
    expect(proposables.length).toBe(4);

    for (const op of proposables) {
      const own = OWN_FIELDS[op.id];
      expect(own, `${op.id} needs its own-field list`).toBeDefined();
      const parsed = op.parseInput(SAMPLE_INPUT[op.id]);
      expect(parsed.ok, `${op.id} must accept its own sample input`).toBe(true);
      if (!parsed.ok) continue;

      const fields = op.writerFields(parsed.input);
      expect(Object.keys(fields).sort(), `${op.id} writerFields`).toEqual([...own!].sort());
      // …and the value is the INPUT's, not a constant the sample happens to match.
      for (const field of own!) {
        expect(fields[field]).toEqual(SAMPLE_INPUT[op.id][field]);
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

  it('every policy writerPatch carries one writer operation, the stored target and only its own dial', () => {
    // Spelled out, not read back from the implementation (see OWN_FIELDS).
    const expected: Record<string, { account: string[]; location: string[] }> = {
      set_auto_reply_scope: { account: ['operation', 'threshold'], location: ['locationId', 'operation', 'threshold'] },
      set_veto_window: { account: ['minutes', 'operation'], location: ['locationId', 'minutes', 'operation'] },
      set_daily_cap: { account: ['cap', 'operation'], location: ['cap', 'locationId', 'operation'] },
    };
    for (const [id, keys] of Object.entries(expected)) {
      const op = policyOp(id);
      const input = parsedInput(op, SAMPLE_INPUT[op.id]);
      expect(Object.keys(op.writerPatch(input, ACCOUNT_TARGET)).sort(), `${id} account`).toEqual(keys.account);
      expect(Object.keys(op.writerPatch(input, LOCATION_TARGET)).sort(), `${id} location`).toEqual(keys.location);
      expect(op.writerPatch(input, LOCATION_TARGET)).not.toHaveProperty('confirmationLevel');
    }
  });
});
