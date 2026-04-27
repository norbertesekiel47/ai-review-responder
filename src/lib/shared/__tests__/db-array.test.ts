import { describe, it, expect } from 'vitest';
import { parseDbArray } from '../db-array';

describe('parseDbArray', () => {
  it('returns arrays unchanged', () => {
    expect(parseDbArray(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('parses JSON-encoded array strings (PgBouncer path)', () => {
    expect(parseDbArray('["x","y"]')).toEqual(['x', 'y']);
  });
  it('returns empty array for null', () => {
    expect(parseDbArray(null)).toEqual([]);
  });
  it('returns empty array for undefined', () => {
    expect(parseDbArray(undefined)).toEqual([]);
  });
  it('returns empty array for invalid JSON string', () => {
    expect(parseDbArray('not-json')).toEqual([]);
  });
  it('returns empty array for JSON that decodes to non-array', () => {
    expect(parseDbArray('{"x":1}')).toEqual([]);
  });
  it('returns empty array for unexpected types', () => {
    expect(parseDbArray(42)).toEqual([]);
  });
  it('filters non-string elements from a mixed array (enforces string[] contract)', () => {
    expect(parseDbArray(['a', 1, 'b', null, true, 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('filters non-string elements from a JSON-encoded mixed array', () => {
    expect(parseDbArray('["a",1,"b",null,true,"c"]')).toEqual(['a', 'b', 'c']);
  });
});
