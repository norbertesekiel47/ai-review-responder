// DB-gated describe. Runs the suite when TEST_DATABASE_POOL_URL is set —
// read at CALL time, not import time, so files that hydrate .env.local in
// their module body are gated correctly. Otherwise registers the suite as
// skipped AND warns once per test file on stderr (vitest isolates module
// state per file, so the latch resets per file), so a keyless run can never
// silently pass as green integration coverage (audit Q2).
import { describe } from 'vitest';

let warned = false;

export function describeWithDb(name: string, factory: () => void): void {
  if (process.env.TEST_DATABASE_POOL_URL) {
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
