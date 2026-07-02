import { describe, it, expect } from 'vitest';
import { fileImportsDbServer, evaluateFindings, isCompositionRoot } from '../db-imports-audit';

describe('db-imports-audit', () => {
  it('detects alias and relative value imports of db/server', () => {
    expect(fileImportsDbServer(`import { sql } from '@/lib/db/server';`)).toBe(true);
    expect(fileImportsDbServer(`import { supabaseServer } from '../../db/server';`)).toBe(true);
    expect(fileImportsDbServer(`export { sql } from '@/lib/db/server';`)).toBe(true); // re-export counts
    expect(fileImportsDbServer(`import type { Sql } from '@/lib/db/server';`)).toBe(false); // type-only OK
    expect(fileImportsDbServer(`const x = "@/lib/db/server";`)).toBe(false); // string literal, not import
    expect(fileImportsDbServer(`import { db } from '@/lib/db/server-utils';`)).toBe(false); // no suffix match
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
});
