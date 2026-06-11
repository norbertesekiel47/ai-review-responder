// CLI launcher for the Zernio fixture server — used by the multi-location
// full-loop runbook (docs/runbooks/multi-location-e2e-full-loop.md, step 4a).
// Committed instead of a /tmp throwaway because tsx resolves relative imports
// against the importing FILE's directory, so a copy under /tmp can't find
// './e2e/fixtures/...'.
//
//   pnpm exec tsx e2e/fixtures/serve.ts
//   → prints ZERNIO_API_BASE=http://127.0.0.1:<port>; Ctrl-C to stop.
//
// Reviews are seeded at runtime via POST /__control/reviews; recorded replies
// are readable via GET /__control/replies (and resettable via DELETE).
import { startZernioFixtureServer } from './zernio-fixture-server';

// Wrapped in an async IIFE rather than using top-level await: tsx transforms
// .ts to CJS in this repo (package.json has no "type":"module"), and top-level
// await is unsupported under CJS — `pnpm exec tsx e2e/fixtures/serve.ts` would
// fail to transform. The listening HTTP server keeps the process alive.
void (async () => {
  const server = await startZernioFixtureServer({
    accountId: process.env.FIXTURE_ACCOUNT_ID ?? 'fixture-account-1',
  });

  console.log(`ZERNIO_API_BASE=${server.url}`);
  console.log(`control: POST ${server.url}/__control/reviews · GET ${server.url}/__control/replies`);

  process.on('SIGINT', () => {
    void server.stop().then(() => process.exit(0));
  });
})();
