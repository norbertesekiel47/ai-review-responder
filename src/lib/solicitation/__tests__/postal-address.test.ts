import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintPostalAddress } from '../postal-address';

// #656 — the Attested postal address module's PURE surface, plus this branch's
// own gate-integrity guard.
//
// Two unrelated subjects share one file on purpose. `scripts/verify-gate.sh`
// matches `.feature/intake.json`'s `tests_to_add` titles VERBATIM against the
// test sources — and a title satisfies that grep whether it belongs to a real
// assertion or to a pending placeholder. So the gate can report 47 green rows
// with the feature entirely absent. The guard below is the only thing standing
// between those two states, and it lives beside the first real assertions this
// branch writes.
//
// The guard is EXPECTED TO FAIL from T1 until T11. That is its purpose: each
// task converts its own placeholders, and T11 proves none survived. Do not
// weaken it to make it pass.

/**
 * Every test file #656 promises a title in — the eleven from the plan's file
 * table (five Creates, six Extends). Kept as an explicit list rather than a
 * glob: a promised title that quietly moved to some other file is exactly the
 * drift this guard exists to catch, and a directory walk would absorb it.
 */
const PROMISED_TEST_FILES = [
  'src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts',
  'src/lib/solicitation/__tests__/postal-address.test.ts',
  'src/lib/solicitation/__tests__/postal-address.integration.test.ts',
  'src/app/api/settings/postal-address/__tests__/route.test.ts',
  'src/components/dashboard/settings/__tests__/solicitation-address-panel.test.tsx',
  'src/app/(authenticated)/settings/profile/__tests__/ProfileClient.test.tsx',
  'src/lib/solicitation/__tests__/batch-builder.integration.test.ts',
  'src/lib/solicitation/__tests__/batch-builder.test.ts',
  'worker/jobs/solicitation-batch/__tests__/index.test.ts',
  'src/lib/solicitation/__tests__/ask-generation.integration.test.ts',
  'worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts',
] as const;

/**
 * The four vitest pending forms, ASSEMBLED rather than written out. This file
 * is itself one of the eleven, so a literal marker anywhere in its own source —
 * including in a comment explaining the marker — would make the guard fail
 * forever on itself and prove nothing about the other ten.
 */
const PENDING_MARKERS: readonly string[] = ['it', 'describe'].flatMap((fn) =>
  ['todo', 'skip'].map((modifier) => `${fn}.${modifier}(`),
);

describe('#656 promised-test integrity', () => {
  it('every #656 promised test is executable with zero pending cases', () => {
    const offenders: string[] = [];

    for (const file of PROMISED_TEST_FILES) {
      const absolute = resolve(process.cwd(), file);
      if (!existsSync(absolute)) {
        // A promised file that vanished is worse than a pending case: the gate
        // would then find its titles nowhere at all, and this guard would have
        // silently stopped covering them.
        offenders.push(`${file} → missing`);
        continue;
      }
      const source = readFileSync(absolute, 'utf-8');
      for (const marker of PENDING_MARKERS) {
        if (source.includes(marker)) offenders.push(`${file} → ${marker}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('lintPostalAddress', () => {
  it('lintPostalAddress rejects a blank or whitespace-only address', () => {
    expect(lintPostalAddress('   \n  ')).toEqual({ ok: false, reason: 'empty' });
    expect(lintPostalAddress('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('lintPostalAddress requires two non-empty lines', () => {
    // The service-area trap from spec §7.5: Google returns "Austin, TX, USA" for
    // a mobile locksmith. One line, no postal code — never a valid sender address.
    expect(lintPostalAddress('Austin, TX, USA')).toEqual({ ok: false, reason: 'single_line' });
    // Two lines, one of them blank, is ONE line. A \n is not a second line.
    expect(lintPostalAddress('123 Main St\n   \n')).toEqual({ ok: false, reason: 'single_line' });
  });

  it('lintPostalAddress rejects an address with no postal code', () => {
    expect(lintPostalAddress("Joe's Diner\nAustin, TX")).toEqual({
      ok: false,
      reason: 'no_postal_code',
    });
  });

  it('lintPostalAddress does not treat a five-digit street number as the postal code', () => {
    // "12345 Elm St" is a street number, not a ZIP. The postal-code probe must
    // look at the LAST non-empty line, not anywhere in the blob.
    expect(lintPostalAddress('12345 Elm St\nAustin, TX')).toEqual({
      ok: false,
      reason: 'no_postal_code',
    });
  });

  it('lintPostalAddress accepts a two-line US address with a ZIP code', () => {
    const result = lintPostalAddress('  123 Main St  \r\n  Austin, TX 78701  ');
    expect(result).toEqual({ ok: true, normalized: '123 Main St\nAustin, TX 78701' });
  });
});
