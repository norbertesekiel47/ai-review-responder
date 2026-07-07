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

  it('does NOT count a sole process.env.MOCK_ZERNIO_LOCATION_COUNT read (mock-fixture knob, exempt)', () => {
    // A mock-mode fixture dial read only inside the Zernio transport's
    // mockLocations() (reachable only when MOCK_EXTERNAL_APIS==='true'); never
    // production config — exempt by EXACT name (Stage-3 zernio-transport batch).
    expect(fileReadsProcessEnv('const raw = Number(process.env.MOCK_ZERNIO_LOCATION_COUNT ?? 1);')).toBe(
      false,
    );
  });

  it('STILL counts a different MOCK_* var (exemption is exact-name, not a MOCK_ prefix)', () => {
    expect(fileReadsProcessEnv('const x = process.env.MOCK_OTHER_THING;')).toBe(true);
  });

  // ── NEXT_PUBLIC_* exemption (PR3-T2) ──
  // NEXT_PUBLIC_* is build-time-inlined PUBLIC client config that can never route
  // through the server-only config accessor, so it is exempt everywhere. Matters
  // now that the scan covers src/app + src/components where these reads are common.

  it('does NOT count a sole process.env.NEXT_PUBLIC_* read (exempt prefix)', () => {
    expect(fileReadsProcessEnv("const u = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';")).toBe(false);
    expect(fileReadsProcessEnv("const a = process.env.NEXT_PUBLIC_APP_URL ?? '';")).toBe(false);
  });

  it('does NOT count a bracket access of a NEXT_PUBLIC_* var', () => {
    expect(fileReadsProcessEnv("const k = process.env['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'];")).toBe(false);
  });

  it('STILL counts a non-NEXT_PUBLIC read even when a NEXT_PUBLIC_* read is also present', () => {
    expect(
      fileReadsProcessEnv(
        "const pub = process.env.NEXT_PUBLIC_APP_URL;\nconst secret = process.env.RESEND_API_KEY;",
      ),
    ).toBe(true);
  });

  // ── src/app admin env-readiness reads are GENUINE (counted) ──
  // The admin channel _shared.ts files test required-secret presence via a
  // COMPUTED key (process.env[k], k a loop variable). staticallyAccessedVarName
  // can't resolve a computed key to a name, so it is conservatively counted — this
  // is the genuine src/app read PR3-T2 grandfathers into the baseline.

  it('counts the admin env-readiness computed-key pattern (src/app genuine read)', () => {
    expect(
      fileReadsProcessEnv("const missing = required.filter((k) => !process.env[k]);"),
    ).toBe(true);
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

  it('flags a NEW non-baseline src/app file that reads process.env (widened scan)', () => {
    const findings = evaluateFindings({
      readingFiles: new Set(['src/app/api/admin/channels/telegram/_shared.ts']),
      baseline: new Set<string>(),
    });
    expect(findings.some((f) => f.includes('src/app/api/admin/channels/telegram/_shared.ts'))).toBe(true);
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
