// src/lib/config/dotenv-load.ts
//
// Idempotent .env.local loader for the worker config lane. worker/env.ts already
// loads dotenv at worker boot, but a worker config module imported OUTSIDE
// worker/index.ts (a unit test, a one-off script) would otherwise parse an empty
// env. Calling this from config/worker.ts before the first parse closes that
// ordering hole. dotenv.config is itself idempotent and a no-op when the file is
// missing (production), so repeated calls are safe.
import dotenv from 'dotenv';

let loaded = false;

export function ensureWorkerDotenvLoaded(): void {
  if (loaded) return;
  loaded = true;
  dotenv.config({ path: '.env.local' });
}
