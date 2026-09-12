// Mocked-tx unit proof for the shared voice writer. The tx double mirrors the
// settings route suite's dispatch (src/app/api/settings/__tests__/route.test.ts:22-27):
// a tagged-template call records (strings, ...values); a helper call
// (identifier string or column-value object) returns a { __helper } marker, so
// the test asserts bound values and column maps rather than assembled SQL.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readVoiceConfig, updateVoiceConfig } from '../voice-settings';

type Call = { text: string; values: unknown[] };

function makeTx(results: unknown[][]) {
  const calls: Call[] = [];
  let index = 0;
  const tx = (...args: unknown[]) => {
    const [first] = args;
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      const strings = first as unknown as TemplateStringsArray;
      calls.push({ text: strings.join(' ? '), values: args.slice(1) });
      return Promise.resolve(results[index++] ?? []);
    }
    return { __helper: first };
  };
  return { tx, calls };
}

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';

describe('voice writer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('voice writer updates highlight_facts under a businesses row lock and rejects a location outside the account', async () => {
    const ok = makeTx([[{ id: LOCATION }], [{ updated_at: new Date('2026-09-11T10:00:00.000Z') }]]);
    const result = await updateVoiceConfig(ok.tx as never, {
      accountId: ACCOUNT,
      locationId: LOCATION,
      fields: { highlightFacts: ['award-winning espresso'], tone: 'warm' },
    });

    expect(result).toEqual({ ok: true, updatedAt: '2026-09-11T10:00:00.000Z' });
    // 1. the lock comes first, and it is account-scoped and active-only.
    expect(ok.calls[0]!.text).toContain('FOR UPDATE');
    expect(ok.calls[0]!.text).toContain('FROM businesses');
    expect(ok.calls[0]!.text).toContain('archived_at IS NULL');
    expect(ok.calls[0]!.values).toEqual([LOCATION, ACCOUNT]);
    // 2. then the UPDATE, carrying highlight_facts in the column map.
    expect(ok.calls[1]!.text).toContain('UPDATE businesses');
    expect((ok.calls[1]!.values[0] as { __helper: Record<string, unknown> }).__helper).toEqual({
      highlight_facts: ['award-winning espresso'],
      tone: 'warm',
    });
    expect(ok.calls[1]!.values.slice(1)).toEqual([LOCATION, ACCOUNT]);

    // A location outside the account never reaches the UPDATE.
    const foreign = makeTx([[]]);
    const rejected = await updateVoiceConfig(foreign.tx as never, {
      accountId: ACCOUNT,
      locationId: LOCATION,
      fields: { tone: 'warm' },
    });
    expect(rejected).toEqual({ ok: false, reason: 'location_not_found' });
    expect(foreign.calls).toHaveLength(1);

    // No fields is a caller bug, not a silent no-op UPDATE.
    const empty = makeTx([[{ id: LOCATION }]]);
    expect(await updateVoiceConfig(empty.tx as never, {
      accountId: ACCOUNT, locationId: LOCATION, fields: {},
    })).toEqual({ ok: false, reason: 'no_fields' });

    // The read is account-scoped too, and carries updatedAt for the Version token.
    const read = makeTx([[{
      tone: 'warm', products_services: null, avoid_facts: null,
      highlight_facts: ['espresso'], sample_responses: ['Thanks for visiting!'],
      updated_at: new Date('2026-09-11T10:00:00.000Z'),
    }]]);
    expect(await readVoiceConfig(read.tx as never, { accountId: ACCOUNT, locationId: LOCATION })).toEqual({
      tone: 'warm',
      productsServices: null,
      avoidFacts: [],
      highlightFacts: ['espresso'],
      sampleResponses: ['Thanks for visiting!'],
      updatedAt: '2026-09-11T10:00:00.000Z',
    });
    expect(read.calls[0]!.values).toEqual([LOCATION, ACCOUNT]);
  });
});
