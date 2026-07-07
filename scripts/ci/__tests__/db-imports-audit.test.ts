import { describe, it, expect } from 'vitest';
import {
  fileImportsDbServer,
  evaluateFindings,
  isCompositionRoot,
  readRegisteredWorkerRoots,
} from '../db-imports-audit';

// Registration-derived worker-root fixture (F15): the set isCompositionRoot
// receives at runtime is built by readRegisteredWorkerRoots from
// worker/index.ts. Here we hand it the 12 top-level job handlers plus a sample
// poller + scheduler so the classification assertions are self-contained. A
// top-level helper beside the handlers (summary-report-helpers.ts) is
// deliberately ABSENT — it is not registered, so it must NOT be a root.
const REGISTERED_WORKER_ROOTS: ReadonlySet<string> = new Set([
  'worker/jobs/AdminExceptionWorker.ts',
  'worker/jobs/DemoGenerationWorker.ts',
  'worker/jobs/DrainOwnerConnectWorker.ts',
  'worker/jobs/EngagementAlertWorker.ts',
  'worker/jobs/MonthlyImpactWorker.ts',
  'worker/jobs/OnboardingDemoWorker.ts',
  'worker/jobs/OnboardingDripWorker.ts',
  'worker/jobs/OwnerEmailWorker.ts',
  'worker/jobs/PlaceIdValidationWorker.ts',
  'worker/jobs/RankingTrackingWorker.ts',
  'worker/jobs/ResponseGeneratorWorker.ts',
  'worker/jobs/WeeklySummaryWorker.ts',
  'worker/background/pollers/OutboxPoller.ts',
  'worker/background/schedulers/WeeklySummaryScheduler.ts',
]);

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

  describe('readRegisteredWorkerRoots (F15 — registration-derived roots)', () => {
    it('extracts top-level ./jobs + ./background/{pollers,schedulers} imports, excluding subfolders and non-worker imports', () => {
      const indexText = [
        `import { handleDemo } from './jobs/DemoGenerationWorker';`,
        `import { startOutboxPoller } from './background/pollers/OutboxPoller';`,
        `import { startWeeklySummaryScheduler } from './background/schedulers/WeeklySummaryScheduler';`,
        `import { handlePublish } from './jobs/publisher/ResponsePublisherWorker';`, // subfolder handler → NOT a top-level root
        `import { sql } from '../src/lib/db/server';`, // not a ./jobs|background specifier → excluded
        `import { QUEUE_NAMES } from './queues';`, // sibling entry file → excluded
      ].join('\n');
      const roots = readRegisteredWorkerRoots(indexText);
      expect(roots.has('worker/jobs/DemoGenerationWorker.ts')).toBe(true);
      expect(roots.has('worker/background/pollers/OutboxPoller.ts')).toBe(true);
      expect(roots.has('worker/background/schedulers/WeeklySummaryScheduler.ts')).toBe(true);
      expect(roots.has('worker/jobs/publisher/ResponsePublisherWorker.ts')).toBe(false); // subfolder excluded by [^/]+$ tail
      expect(roots.has('worker/queues.ts')).toBe(false);
      expect(roots.size).toBe(3);
    });
    it('parses via the AST — a matching specifier in a comment or string literal does not false-fire', () => {
      const indexText = [
        `// import { fake } from './jobs/CommentedOutWorker';`,
        `const s = "./jobs/StringLiteralWorker";`,
        `import { real } from './jobs/RealWorker';`,
      ].join('\n');
      const roots = readRegisteredWorkerRoots(indexText);
      expect(roots.has('worker/jobs/RealWorker.ts')).toBe(true);
      expect(roots.has('worker/jobs/CommentedOutWorker.ts')).toBe(false);
      expect(roots.has('worker/jobs/StringLiteralWorker.ts')).toBe(false);
      expect(roots.size).toBe(1);
    });
  });

  it('exempts composition roots (registration-derived worker roots)', () => {
    expect(isCompositionRoot('src/lib/db/server.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
    expect(isCompositionRoot('src/instrumentation.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
    expect(isCompositionRoot('src/lib/db/auth.ts', REGISTERED_WORKER_ROOTS)).toBe(true); // owner-decided 2i classification: db-layer auth gate + Supabase client factory + single identity SELECT
    expect(isCompositionRoot('src/lib/db/account-guard.ts', REGISTERED_WORKER_ROOTS)).toBe(false); // db-layer domain module — injected in 2i-T6, NOT classified as a root
    expect(isCompositionRoot('src/app/api/dashboard/kpis/route.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
    expect(isCompositionRoot('src/app/admin/jobs/page.tsx', REGISTERED_WORKER_ROOTS)).toBe(true);
    expect(isCompositionRoot('src/app/page.tsx', REGISTERED_WORKER_ROOTS)).toBe(true); // app-root page
    expect(isCompositionRoot('src/app/route.ts', REGISTERED_WORKER_ROOTS)).toBe(true); // app-root route handler
    expect(isCompositionRoot('src/app/(authenticated)/layout.tsx', REGISTERED_WORKER_ROOTS)).toBe(true); // Next.js invokes layouts — no injector exists
    expect(isCompositionRoot('worker/index.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
    expect(isCompositionRoot('worker/queues.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
    expect(isCompositionRoot('worker/jobs/OnboardingDemoWorker.ts', REGISTERED_WORKER_ROOTS)).toBe(true); // registered handler
    // F15: a top-level helper beside the handlers is NOT registered → NOT a root
    // (flips the pre-F15 positional-rule verdict from true to false).
    expect(isCompositionRoot('worker/jobs/summary-report-helpers.ts', REGISTERED_WORKER_ROOTS)).toBe(false);
    expect(isCompositionRoot('worker/jobs/publisher/post-reply.ts', REGISTERED_WORKER_ROOTS)).toBe(false); // subfolder helper ≠ root
    expect(isCompositionRoot('worker/background/pollers/OutboxPoller.ts', REGISTERED_WORKER_ROOTS)).toBe(true); // registered poller
    expect(isCompositionRoot('worker/background/schedulers/WeeklySummaryScheduler.ts', REGISTERED_WORKER_ROOTS)).toBe(true); // registered scheduler
    expect(isCompositionRoot('worker/background/pollers/health-alert/checks.ts', REGISTERED_WORKER_ROOTS)).toBe(false); // poller subfolder helper ≠ root
    expect(isCompositionRoot('worker/ingress/stripe.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
    expect(isCompositionRoot('src/lib/kpi/service.ts', REGISTERED_WORKER_ROOTS)).toBe(false);
    expect(isCompositionRoot('src/components/dashboard/kpi/ValueKpiGrid.tsx', REGISTERED_WORKER_ROOTS)).toBe(false);
  });

  it('classifies all 12 registered top-level job handlers as roots', () => {
    for (const handler of REGISTERED_WORKER_ROOTS) {
      if (!handler.startsWith('worker/jobs/')) continue;
      expect(isCompositionRoot(handler, REGISTERED_WORKER_ROOTS)).toBe(true);
    }
  });

  it('flags every non-composition-root importer (strict — no baseline)', () => {
    const findings = evaluateFindings({
      importingFiles: new Set(['src/lib/new-module.ts', 'src/lib/another.ts']),
    });
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.includes('src/lib/new-module.ts') && f.includes('not a composition root'))).toBe(true);
  });

  it('is quiet when nothing outside a composition root imports db/server', () => {
    expect(evaluateFindings({ importingFiles: new Set<string>() })).toEqual([]);
  });
});
