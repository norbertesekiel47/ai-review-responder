// Unit tests for scripts/ci/env-registry-audit.ts (#918). Every lane is
// exercised through inline fixtures, including the bypass shapes the
// adversarial review demanded: aliased/namespace/indirect flag references,
// unregistered schema spreads, mixed (partially-unresolvable) inventory
// arrays, free-form generic-reader callers, dynamic env reads outside the
// registered modules, and registry rows that only MENTION a var in prose.
import { describe, expect, it } from 'vitest';
import {
  checkGenericReaderCallers,
  extractFlagCalls,
  extractLiteralArrayInventories,
  extractRawEnvReads,
  extractSchemaVars,
  parseRegistryNames,
} from '../env-registry-audit';

const STRIPE = new Set(['STRIPE_PRICE_FAKE_A', 'STRIPE_PRICE_FAKE_B']);

describe('lane A — schema extraction', () => {
  it('collects property names and resolves the registered spread', () => {
    const out = extractSchemaVars(
      `const stripePriceShape = {};
       const schema = z.object({ MY_VAR: opt, OTHER_VAR: rawOpt, ...stripePriceShape });`,
      'src/lib/config/worker.ts',
      STRIPE,
    );
    expect(out.failures).toEqual([]);
    expect([...out.names].sort()).toEqual([
      'MY_VAR',
      'OTHER_VAR',
      'STRIPE_PRICE_FAKE_A',
      'STRIPE_PRICE_FAKE_B',
    ]);
  });

  it('FAILS on an unregistered spread instead of silently skipping it', () => {
    const out = extractSchemaVars(
      `const schema = z.object({ MY_VAR: opt, ...mysteryShape });`,
      'src/lib/config/worker.ts',
      STRIPE,
    );
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('mysteryShape');
  });
});

describe('lane B — flag call sites through import bindings', () => {
  const IMPORT = `import { readFlag, readFlagEnabledByDefault } from '@/lib/config/flags';\n`;

  it('resolves literal and same-file-const arguments', () => {
    const out = extractFlagCalls(
      IMPORT +
        `const NAME = 'CONST_FLAG_ENABLED';
         export const a = readFlag('LITERAL_FLAG_ENABLED');
         export const b = readFlagEnabledByDefault(NAME);`,
      'src/lib/x.ts',
    );
    expect(out.failures).toEqual([]);
    expect([...out.names].sort()).toEqual(['CONST_FLAG_ENABLED', 'LITERAL_FLAG_ENABLED']);
  });

  it('resolves an ALIASED import (bypass fixture)', () => {
    const out = extractFlagCalls(
      `import { readFlag as rf } from '@/lib/config/flags';
       export const a = rf('ALIASED_FLAG_ENABLED');`,
      'src/lib/x.ts',
    );
    expect(out.failures).toEqual([]);
    expect([...out.names]).toEqual(['ALIASED_FLAG_ENABLED']);
  });

  it('resolves a NAMESPACE import (bypass fixture)', () => {
    const out = extractFlagCalls(
      `import * as flags from '@/lib/config/flags';
       export const a = flags.readFlag('NS_FLAG_ENABLED');`,
      'src/lib/x.ts',
    );
    expect(out.failures).toEqual([]);
    expect([...out.names]).toEqual(['NS_FLAG_ENABLED']);
  });

  it('FAILS an indirect reference — assignment to a variable (bypass fixture)', () => {
    const out = extractFlagCalls(
      IMPORT + `const indirect = readFlag;\nexport const a = indirect('HIDDEN_ENABLED');`,
      'src/lib/x.ts',
    );
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('non-call reference');
    expect(out.names.has('HIDDEN_ENABLED')).toBe(false);
  });

  it('FAILS an argument it cannot resolve statically', () => {
    const out = extractFlagCalls(
      IMPORT + `export const a = (name: string) => readFlag(name);`,
      'src/lib/x.ts',
    );
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('cannot register');
  });

  it('ignores other exports from the flags module', () => {
    const out = extractFlagCalls(
      `import { isPreviewEnvironment } from '@/lib/config/flags';
       export const a = isPreviewEnvironment();`,
      'src/lib/x.ts',
    );
    expect(out.failures).toEqual([]);
    expect(out.names.size).toBe(0);
  });
});

describe('lane C — raw process.env reads', () => {
  it('collects literal property and element reads', () => {
    const out = extractRawEnvReads(
      `const a = process.env.MY_RAW_VAR;\nconst b = process.env['BRACKET_VAR'];`,
      'worker/x.ts',
      { dynamicReadsRegistered: false },
    );
    expect(out.failures).toEqual([]);
    expect([...out.names].sort()).toEqual(['BRACKET_VAR', 'MY_RAW_VAR']);
  });

  it('resolves the missing-env probe shape: local literal array + .filter callback', () => {
    const out = extractRawEnvReads(
      `const REQUIRED = ['PROBE_VAR_ONE', 'PROBE_VAR_TWO'] as const;
       export const missing = REQUIRED.filter((k) => !process.env[k]);`,
      'src/lib/x.ts',
      { dynamicReadsRegistered: false },
    );
    expect(out.failures).toEqual([]);
    expect([...out.names].sort()).toEqual(['PROBE_VAR_ONE', 'PROBE_VAR_TWO']);
  });

  it('resolves iteration over a REGISTERED imported inventory', () => {
    const out = extractRawEnvReads(
      `import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
       export const missing = STRIPE_PRICE_ENV_VARS.filter((name) => !process.env[name]);`,
      'src/instrumentation.ts',
      {
        dynamicReadsRegistered: false,
        importedInventories: new Map([['STRIPE_PRICE_ENV_VARS', STRIPE]]),
      },
    );
    expect(out.failures).toEqual([]);
    expect([...out.names].sort()).toEqual(['STRIPE_PRICE_FAKE_A', 'STRIPE_PRICE_FAKE_B']);
  });

  it('FAILS a genuinely dynamic read in an unregistered module', () => {
    const out = extractRawEnvReads(
      `export function read(key: string) { return process.env[key]; }`,
      'src/lib/x.ts',
      { dynamicReadsRegistered: false },
    );
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('unregistered module');
  });

  it('allows the same dynamic read in a REGISTERED module', () => {
    const out = extractRawEnvReads(
      `export function read(key: string) { return process.env[key]; }`,
      'worker/config/startup-assert.ts',
      { dynamicReadsRegistered: true },
    );
    expect(out.failures).toEqual([]);
  });
});

describe('fail-closed inventory extraction', () => {
  it('extracts string[] and { key } object arrays', () => {
    const out = extractLiteralArrayInventories(
      `const A = ['INV_VAR_ONE', 'INV_VAR_TWO'];
       const B = [{ key: 'INV_VAR_THREE', message: 'x' }];`,
      'worker/config/startup-assert.ts',
    );
    expect(out.failures).toEqual([]);
    expect([...out.names].sort()).toEqual(['INV_VAR_ONE', 'INV_VAR_TWO', 'INV_VAR_THREE'].sort());
  });

  it('resolves a spread of a registered inventory inside an array', () => {
    const out = extractLiteralArrayInventories(
      `const A = ['INV_VAR_ONE', ...STRIPE_PRICE_ENV_VARS];`,
      'worker/config/startup-assert.ts',
      new Map([['STRIPE_PRICE_ENV_VARS', STRIPE]]),
    );
    expect(out.failures).toEqual([]);
    expect(out.names.has('STRIPE_PRICE_FAKE_A')).toBe(true);
  });

  it('FAILS a mixed valid/invalid array instead of half-passing (round-7 fixture)', () => {
    const out = extractLiteralArrayInventories(
      `const A = ['INV_VAR_ONE', computedName()];`,
      'worker/config/startup-assert.ts',
    );
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('fail-closed');
    expect(out.names.size).toBe(0);
  });

  it('ignores arrays that carry no var-shaped element at all', () => {
    const out = extractLiteralArrayInventories(
      `const MESSAGES = ['lowercase', 'not vars'];`,
      'worker/config/startup-assert.ts',
    );
    expect(out.failures).toEqual([]);
    expect(out.names.size).toBe(0);
  });
});

describe('generic-reader caller check (round-6 fixture)', () => {
  it('accepts callers passing a known array or inline literal', () => {
    const failures = checkGenericReaderCallers(
      `const KNOWN = ['V_ONE'];
       missingEnvVars(KNOWN);
       missingEnvVars(['V_TWO']);`,
      'worker/config/startup-assert.ts',
      new Set(),
    );
    expect(failures).toEqual([]);
  });

  it('FAILS a new caller with an unregistered array', () => {
    const failures = checkGenericReaderCallers(
      `declare const fromSomewhere: string[];
       missingEnvVars(fromSomewhere);`,
      'worker/config/startup-assert.ts',
      new Set(),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('cannot resolve');
  });
});

describe('registry parsing — name-cell-only', () => {
  it('accepts table rows and dedicated headings; rejects prose-only mentions', () => {
    const out = parseRegistryNames(
      [
        '| Var | Notes |',
        '|---|---|',
        '| `ROW_VAR` | see also `PROSE_ONLY_VAR` for the sibling behavior |',
        '',
        '### `HEADING_VAR`',
        'Prose about `ANOTHER_PROSE_VAR`.',
      ].join('\n'),
      'doc.md',
    );
    expect(out.failures).toEqual([]);
    expect(out.names.has('ROW_VAR')).toBe(true);
    expect(out.names.has('HEADING_VAR')).toBe(true);
    expect(out.names.has('PROSE_ONLY_VAR')).toBe(false);
    expect(out.names.has('ANOTHER_PROSE_VAR')).toBe(false);
  });

  it('FAILS a slash-separated multi-var name cell (format guard)', () => {
    const out = parseRegistryNames('| `VAR_A` / `VAR_B` | ✅ | |', 'doc.md');
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('slash-separated');
  });

  it('FAILS the old inline code-span list shape (format guard)', () => {
    const out = parseRegistryNames('`VAR_A` ✅ · `VAR_B` 🟢 (note)', 'doc.md');
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('inline code-span');
  });

  it('does NOT flag wrapped prose that merely starts with a backticked var', () => {
    const out = parseRegistryNames(
      '`VAR_A`, `VAR_B` and their siblings are retained only through the window.',
      'doc.md',
    );
    expect(out.failures).toEqual([]);
  });
});
