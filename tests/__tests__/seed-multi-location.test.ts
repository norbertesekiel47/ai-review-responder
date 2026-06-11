/**
 * Thin unit test asserting seedMultiLocationAccount and
 * cleanupMultiLocationAccount are exported as functions.
 *
 * Live DB exercise is covered by the manual validation run
 * and the full E2E kit (F2+).
 */
import { describe, expect, it } from 'vitest';
import {
  seedMultiLocationAccount,
  cleanupMultiLocationAccount,
} from '../../e2e/seed';

describe('e2e/seed — multi-location exports', () => {
  it('exports seedMultiLocationAccount as a function', () => {
    expect(typeof seedMultiLocationAccount).toBe('function');
  });

  it('exports cleanupMultiLocationAccount as a function', () => {
    expect(typeof cleanupMultiLocationAccount).toBe('function');
  });
});
