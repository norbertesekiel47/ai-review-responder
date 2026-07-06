// DB-gated describe. Runs the suite when TEST_DATABASE_POOL_URL is set —
// read at CALL time, not import time, so files that hydrate .env.local in
// their module body are gated correctly. Otherwise registers the suite as
// skipped AND warns once per test file on stderr (vitest isolates module
// state per file, so the latch resets per file), so a keyless run can never
// silently pass as green integration coverage (audit Q2).
//
// The 3-arg overload is for a file that has ALREADY primed/parsed .env.local in
// a `vi.hoisted()` block (to point DATABASE_POOL_URL at the test DB before the
// static `sql` import). Such a file already knows the gate, so it passes its own
// `enabled` decision INSTEAD OF this helper re-reading process.env — letting it
// drop a hand-rolled `RUN ? describe : describe.skip` ternary while keeping the
// same warn-once-on-skip behavior. `timeout` is forwarded to vitest as
// suite-level TestOptions (a slow real-DB suite that needs more than vitest's
// default per-test timeout).
import { describe } from 'vitest';

export interface DescribeWithDbOptions {
  /**
   * Caller-precomputed gate. When set, it is used INSTEAD OF reading
   * `process.env.TEST_DATABASE_POOL_URL` — for files that hydrate .env.local in
   * a `vi.hoisted()` block and already know whether the test DB is reachable.
   */
  enabled?: boolean;
  /** Forwarded to vitest's describe/describe.skip as suite-level TestOptions. */
  timeout?: number;
}

let warned = false;

export function describeWithDb(name: string, factory: () => void): void;
export function describeWithDb(
  name: string,
  options: DescribeWithDbOptions,
  factory: () => void,
): void;
export function describeWithDb(
  name: string,
  optionsOrFactory: DescribeWithDbOptions | (() => void),
  maybeFactory?: () => void,
): void {
  const options = typeof optionsOrFactory === 'function' ? undefined : optionsOrFactory;
  const factory = typeof optionsOrFactory === 'function' ? optionsOrFactory : maybeFactory;
  if (!factory) {
    throw new Error('describeWithDb: a factory function is required');
  }

  const enabled = options?.enabled ?? Boolean(process.env.TEST_DATABASE_POOL_URL);

  if (!enabled && !warned) {
    warned = true;
    process.stderr.write(
      '[tests] TEST_DATABASE_POOL_URL unset — DB-gated integration suites SKIPPED\n',
    );
  }

  const register = enabled ? describe : describe.skip;
  if (options?.timeout !== undefined) {
    register(name, { timeout: options.timeout }, factory);
    return;
  }
  register(name, factory);
}
