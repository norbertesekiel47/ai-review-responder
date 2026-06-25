// scripts/prebuild-assert-client-config.ts
//
// Runs assertClientConfig() before `next build` inlines NEXT_PUBLIC_*. A missing
// required public var would otherwise be silently inlined as `undefined`; this
// fails the build loudly instead. Wired as the `prebuild` npm script (pnpm runs
// `prebuild` automatically before `build`).
//
// Loads .env.local first so it validates the SAME env Next will inline: `next
// build` reads .env files, but a standalone tsx script does not, so without this
// the local prebuild would see only the raw shell env and false-fail. dotenv is a
// no-op when the file is missing (CI sets NEXT_PUBLIC_* directly in the job env).
import dotenv from 'dotenv';
import { assertClientConfig } from '../src/lib/config/client';

dotenv.config({ path: '.env.local' });

try {
  assertClientConfig();
  console.log('prebuild: client config OK');
} catch (err) {
  console.error(`prebuild: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
