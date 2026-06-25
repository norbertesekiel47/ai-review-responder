import { describe, expect, it } from 'vitest';
import { fileReadsProcessEnv, isAllowlisted, evaluateFindings } from '../process-env-audit';

describe('process-env-audit (pure)', () => {
  it('detects a process.env read', () => {
    expect(fileReadsProcessEnv('const x = process.env.FOO;')).toBe(true);
  });

  it('detects a bracket process.env read', () => {
    expect(fileReadsProcessEnv("const x = process.env['FOO'];")).toBe(true);
  });

  it('detects a destructured process.env read', () => {
    expect(fileReadsProcessEnv('const { FOO } = process.env;')).toBe(true);
  });

  it('detects an aliased process.env read', () => {
    expect(fileReadsProcessEnv('const e = process.env;')).toBe(true);
  });

  it('ignores a comment that merely names process.env', () => {
    expect(fileReadsProcessEnv('// we used to read process.env.FOO here')).toBe(false);
  });

  it('ignores a string literal that contains process.env.X', () => {
    expect(fileReadsProcessEnv('const s = "reads process.env.FOO";')).toBe(false);
  });

  it('ignores a template literal that contains process.env.X', () => {
    expect(fileReadsProcessEnv('const s = `see process.env.FOO`;')).toBe(false);
  });

  // ── env-indicator exemption (Stage-3 convention #2) ──
  // NODE_ENV / MOCK_EXTERNAL_APIS / VERCEL_* are environment INDICATORS, not
  // config — they stay direct process.env reads and the audit must not count
  // them, so a file reading ONLY these drops out of the migration baseline.

  it('does NOT count a sole process.env.NODE_ENV read (exempt indicator)', () => {
    expect(fileReadsProcessEnv("const p = process.env.NODE_ENV === 'production';")).toBe(false);
  });

  it('does NOT count a sole process.env.MOCK_EXTERNAL_APIS read (exempt indicator)', () => {
    expect(fileReadsProcessEnv("const m = process.env.MOCK_EXTERNAL_APIS === 'true';")).toBe(false);
  });

  it('does NOT count process.env.VERCEL_* reads (exempt indicator prefix)', () => {
    expect(fileReadsProcessEnv('const e = process.env.VERCEL_ENV;')).toBe(false);
    expect(fileReadsProcessEnv('const t = process.env.VERCEL_TARGET_ENV;')).toBe(false);
  });

  it('does NOT count a bracket access of an exempt indicator', () => {
    expect(fileReadsProcessEnv("const m = process.env['MOCK_EXTERNAL_APIS'];")).toBe(false);
  });

  it('STILL counts a non-exempt read even when an exempt read is also present', () => {
    expect(
      fileReadsProcessEnv(
        "const prod = process.env.NODE_ENV === 'production';\nconst key = process.env.RESEND_API_KEY;",
      ),
    ).toBe(true);
  });

  it('counts a non-exempt var that merely shares a non-VERCEL prefix shape', () => {
    // NODE_ENV_OVERRIDE is NOT NODE_ENV — must still count.
    expect(fileReadsProcessEnv('const x = process.env.NODE_ENV_OVERRIDE;')).toBe(true);
  });

  it('conservatively COUNTS a destructure of process.env (property name unknown)', () => {
    // `const { NODE_ENV } = process.env` reads the whole env object via a node
    // whose accessed property isn't knowable from the env node alone — counted.
    expect(fileReadsProcessEnv('const { NODE_ENV } = process.env;')).toBe(true);
  });

  it('conservatively COUNTS an alias of process.env (could read any var)', () => {
    expect(fileReadsProcessEnv('const e = process.env;')).toBe(true);
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
