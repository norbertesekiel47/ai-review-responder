// DB-gated describe. Runs the suite when TEST_DATABASE_POOL_URL is set;
// otherwise registers it as skipped AND warns once on stderr, so a keyless
// run can never silently pass as green integration coverage (audit Q2).
import { describe } from 'vitest';

const HAS_DB = Boolean(process.env.TEST_DATABASE_POOL_URL);
let warned = false;

export function describeWithDb(name: string, factory: () => void): void {
  if (HAS_DB) {
    describe(name, factory);
    return;
  }
  if (!warned) {
    warned = true;
    process.stderr.write(
      '[tests] TEST_DATABASE_POOL_URL unset — DB-gated integration suites SKIPPED\n',
    );
  }
  describe.skip(name, factory);
}
