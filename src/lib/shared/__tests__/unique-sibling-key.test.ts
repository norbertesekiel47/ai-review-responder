import { describe, expect, it } from 'vitest';
import { uniqueSiblingKey } from '../unique-sibling-key';

describe('uniqueSiblingKey', () => {
  it('prefixes duplicate occurrences from the same base', () => {
    const seen = new Map<string, number>();

    expect(uniqueSiblingKey(seen, 'same')).toBe('0:same');
    expect(uniqueSiblingKey(seen, 'same')).toBe('1:same');
    expect(uniqueSiblingKey(seen, 'other')).toBe('0:other');
  });
});
