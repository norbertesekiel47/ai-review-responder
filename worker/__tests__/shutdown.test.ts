import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKER_INDEX = resolve(process.cwd(), 'worker/index.ts');

describe('worker graceful shutdown', () => {
  it('flushes analytics after workers stop and before closing the database', () => {
    const source = readFileSync(WORKER_INDEX, 'utf-8');

    const workersClose = source.indexOf('await Promise.all(workers.map((w) => w.close()))');
    const queuesClose = source.indexOf('await Promise.all(Object.values(queues).map((q) => q.close()))');
    const appClose = source.indexOf('await app.close()');
    const analyticsImport = source.indexOf("await import('../src/lib/analytics/posthog')");
    const analyticsShutdown = source.indexOf('await shutdownAnalytics()');
    const dbEnd = source.indexOf('await sql.end()');

    expect(workersClose).toBeGreaterThan(-1);
    expect(queuesClose).toBeGreaterThan(workersClose);
    expect(appClose).toBeGreaterThan(queuesClose);
    expect(analyticsImport).toBeGreaterThan(appClose);
    expect(analyticsShutdown).toBeGreaterThan(analyticsImport);
    expect(dbEnd).toBeGreaterThan(analyticsShutdown);
  });
});
