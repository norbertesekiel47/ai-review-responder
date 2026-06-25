import { describe, expect, it } from 'vitest';
import { auditConfigCoverage } from '../config-coverage-audit';
import { REQUIRED_VAR_DECLARATIONS } from '../config-coverage-baseline';

describe('config-coverage-audit', () => {
  it('passes for the real declarations + real lane lists', () => {
    expect(auditConfigCoverage()).toEqual([]);
  });

  it('flags a declared required var that no lane asserts', () => {
    const findings = auditConfigCoverage({
      declarations: [...REQUIRED_VAR_DECLARATIONS, { var: 'GHOST_VAR', lanes: ['worker'] }],
      baseline: REQUIRED_VAR_DECLARATIONS.length + 1,
    });
    expect(findings.some((f) => f.includes('GHOST_VAR'))).toBe(true);
  });

  it('flags a var asserted by a lane it is not declared for', () => {
    const findings = auditConfigCoverage({
      workerRequired: [
        'DATABASE_POOL_URL',
        'SUPABASE_URL',
        'SUPABASE_SERVICE_KEY',
        'REDIS_QUEUE_URL',
        'STRAY_VAR',
      ],
    });
    expect(findings.some((f) => f.includes('STRAY_VAR'))).toBe(true);
  });

  it('flags a baseline count mismatch', () => {
    const findings = auditConfigCoverage({ baseline: 999 });
    expect(findings.some((f) => f.includes('CONFIG_COVERAGE_BASELINE'))).toBe(true);
  });
});
