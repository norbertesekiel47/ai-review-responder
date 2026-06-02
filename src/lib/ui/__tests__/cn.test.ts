import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/ui/cn';

describe('cn', () => {
  it('joins truthy class values with a single space', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });
  it('drops falsy values (false, null, undefined, empty string, 0)', () => {
    expect(cn('a', false, null, undefined, '', 0 as unknown as string, 'b')).toBe('a b');
  });
  it('supports conditional ternary composition', () => {
    const active = true;
    expect(cn('base', active && 'on', !active && 'off')).toBe('base on');
  });
  it('returns empty string when nothing is truthy', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});
