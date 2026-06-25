import { describe, expect, it } from 'vitest';
import { fileReadsProcessEnv, isAllowlisted, evaluateFindings } from '../process-env-audit';

describe('process-env-audit (pure)', () => {
  it('detects a process.env read', () => {
    expect(fileReadsProcessEnv('const x = process.env.FOO;')).toBe(true);
  });

  it('detects a bracket process.env read', () => {
    expect(fileReadsProcessEnv("const x = process.env['FOO'];")).toBe(true);
  });

  it('ignores a comment that merely names process.env', () => {
    expect(fileReadsProcessEnv('// we used to read process.env.FOO here')).toBe(false);
  });

  it('allowlists the config home + worker/env.ts + startup-assert', () => {
    expect(isAllowlisted('src/lib/config/server.ts')).toBe(true);
    expect(isAllowlisted('worker/env.ts')).toBe(true);
    expect(isAllowlisted('worker/config/startup-assert.ts')).toBe(true);
    expect(isAllowlisted('src/lib/payments/stripe-client.ts')).toBe(false);
  });

  it('flags a NEW non-baseline file that reads process.env', () => {
    const findings = evaluateFindings({
      readingFiles: new Set(['src/lib/new-thing.ts']),
      baseline: new Set<string>(),
    });
    expect(findings.some((f) => f.includes('new-thing.ts'))).toBe(true);
  });

  it('flags a STALE baseline entry that no longer reads process.env', () => {
    const findings = evaluateFindings({
      readingFiles: new Set<string>(),
      baseline: new Set(['src/lib/old-thing.ts']),
    });
    expect(findings.some((f) => f.includes('old-thing.ts') && f.toLowerCase().includes('stale'))).toBe(true);
  });

  it('passes when a baseline file still reads process.env', () => {
    const findings = evaluateFindings({
      readingFiles: new Set(['src/lib/kept.ts']),
      baseline: new Set(['src/lib/kept.ts']),
    });
    expect(findings).toEqual([]);
  });

  it('ignores allowlisted files even if they read process.env', () => {
    const findings = evaluateFindings({
      readingFiles: new Set(['src/lib/config/server.ts']),
      baseline: new Set<string>(),
    });
    expect(findings).toEqual([]);
  });
});
