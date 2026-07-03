import { describe, it, expect } from 'vitest';
import {
  fileImportsDbServer,
  evaluateFindings,
  isCompositionRoot,
  renderBaselineModule,
} from '../db-imports-audit';

describe('db-imports-audit', () => {
  it('detects alias and relative value imports of db/server', () => {
    expect(fileImportsDbServer(`import { sql } from '@/lib/db/server';`)).toBe(true);
    expect(fileImportsDbServer(`import { supabaseServer } from '../../db/server';`)).toBe(true);
    expect(fileImportsDbServer(`export { sql } from '@/lib/db/server';`)).toBe(true); // re-export counts
    expect(fileImportsDbServer(`import type { Sql } from '@/lib/db/server';`)).toBe(false); // type-only OK
    expect(fileImportsDbServer(`const x = "@/lib/db/server";`)).toBe(false); // string literal, not import
    expect(fileImportsDbServer(`import { db } from '@/lib/db/server-utils';`)).toBe(false); // no suffix match
  });
  it('detects extension-qualified specifiers of db/server', () => {
    expect(fileImportsDbServer(`import { sql } from '@/lib/db/server.js';`)).toBe(true);
    expect(fileImportsDbServer(`import { sql } from '../../db/server.ts';`)).toBe(true);
    expect(fileImportsDbServer(`import { db } from '@/lib/db/server-utils.js';`)).toBe(false);
  });
  it('detects literal dynamic imports of db/server (computed specifiers out of scope)', () => {
    expect(fileImportsDbServer(`const m = await import('@/lib/db/server');`)).toBe(true);
    expect(fileImportsDbServer(`const m = await import(someVar);`)).toBe(false);
    expect(fileImportsDbServer(`const m = await import('@/lib/other');`)).toBe(false);
    expect(fileImportsDbServer(`const m = await import('@/lib/db/server', {});`)).toBe(true); // two-arg (import attributes)
    expect(fileImportsDbServer(`const m = await import(someVar, {});`)).toBe(false); // computed stays out of scope
  });
  it('counts empty-brace imports/re-exports (module still evaluated at runtime)', () => {
    expect(fileImportsDbServer(`import {} from '@/lib/db/server';`)).toBe(true);
    expect(fileImportsDbServer(`export {} from '@/lib/db/server';`)).toBe(true);
  });
  it('excludes inline-type-only specifiers but counts any runtime binding', () => {
    expect(fileImportsDbServer(`import { type Sql } from '@/lib/db/server';`)).toBe(false); // runtime-free
    expect(fileImportsDbServer(`import { type Sql, sql } from '@/lib/db/server';`)).toBe(true); // mixed → counts
    expect(fileImportsDbServer(`export { type Sql } from '@/lib/db/server';`)).toBe(false); // runtime-free re-export
    expect(fileImportsDbServer(`import db from '@/lib/db/server';`)).toBe(true); // default binding
    expect(fileImportsDbServer(`import * as db from '@/lib/db/server';`)).toBe(true); // namespace binding
  });
  it('exempts composition roots', () => {
    expect(isCompositionRoot('src/lib/db/server.ts')).toBe(true);
    expect(isCompositionRoot('src/instrumentation.ts')).toBe(true);
    expect(isCompositionRoot('src/app/api/dashboard/kpis/route.ts')).toBe(true);
    expect(isCompositionRoot('src/app/admin/jobs/page.tsx')).toBe(true);
    expect(isCompositionRoot('src/app/page.tsx')).toBe(true); // app-root page
    expect(isCompositionRoot('src/app/route.ts')).toBe(true); // app-root route handler
    expect(isCompositionRoot('src/app/(authenticated)/layout.tsx')).toBe(true); // Next.js invokes layouts — no injector exists
    expect(isCompositionRoot('worker/index.ts')).toBe(true);
    expect(isCompositionRoot('worker/jobs/OnboardingDemoWorker.ts')).toBe(true);
    expect(isCompositionRoot('worker/jobs/summary-report-helpers.ts')).toBe(false); // named exception: top-level helper, not a handler
    expect(isCompositionRoot('worker/jobs/publisher/post-reply.ts')).toBe(false); // subfolder helper ≠ root
    expect(isCompositionRoot('worker/background/pollers/OutboxPoller.ts')).toBe(true);
    expect(isCompositionRoot('worker/background/pollers/health-alert/checks.ts')).toBe(false); // poller subfolder helper ≠ root
    expect(isCompositionRoot('worker/ingress/stripe.ts')).toBe(true);
    expect(isCompositionRoot('src/lib/kpi/service.ts')).toBe(false);
    expect(isCompositionRoot('src/components/dashboard/kpi/ValueKpiGrid.tsx')).toBe(false);
  });
  it('flags new importers and stale baseline entries', () => {
    const findings = evaluateFindings({
      importingFiles: new Set(['src/lib/new-module.ts']),
      baseline: new Set(['src/lib/gone.ts']),
    });
    expect(findings).toHaveLength(2);
  });
  describe('renderBaselineModule', () => {
    it('renders a header comment followed by sorted, quoted entries', () => {
      const source = renderBaselineModule(['src/lib/z.ts', 'src/lib/a.ts', 'src/lib/m.ts']);
      expect(source).toContain('// scripts/ci/db-imports-baseline.ts');
      expect(source).toContain('pnpm tsx scripts/ci/db-imports-audit.ts --emit-baseline');
      expect(source).toContain('export const DB_IMPORTS_BASELINE: ReadonlySet<string> = new Set([');
      const aIndex = source.indexOf("'src/lib/a.ts'");
      const mIndex = source.indexOf("'src/lib/m.ts'");
      const zIndex = source.indexOf("'src/lib/z.ts'");
      expect(aIndex).toBeGreaterThan(-1);
      expect(aIndex).toBeLessThan(mIndex);
      expect(mIndex).toBeLessThan(zIndex);
      expect(source.endsWith(']);\n\n')).toBe(true);
    });
    it('renders an empty Set literal for no importers', () => {
      const source = renderBaselineModule([]);
      expect(source).toContain('export const DB_IMPORTS_BASELINE: ReadonlySet<string> = new Set([\n]);');
    });
  });
});
