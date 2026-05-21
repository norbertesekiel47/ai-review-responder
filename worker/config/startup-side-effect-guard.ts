import { assertWorkerStartupEnv } from './startup-assert';

try {
  assertWorkerStartupEnv();
} catch (err) {
  console.error(`[worker] Startup assertion failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
