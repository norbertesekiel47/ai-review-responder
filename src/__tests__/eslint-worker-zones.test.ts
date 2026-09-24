// Regression guard for the two worker/** ESLint zones added by #1372 and
// #1366 (eslint.config.mjs).
//
// Unlike eslint-boundaries.test.ts's virtual (lintText, non-existent path)
// fixtures, every fixture here is a REAL file written to disk: the
// no-floating-promises zone below sets `parserOptions.projectService` for
// ALL of worker/**/*.ts (ingress included, since it is a subset), and the TS
// project service refuses to parse a path that doesn't exist on disk and
// isn't covered by tsconfig.json's include — so a virtual worker/**.ts path
// fails with a fatal parse error instead of running the rule under test
// (proven empirically: a virtual-path version of these fixtures reported 0
// no-console messages for the WRONG reason — a fatal parse error, not honest
// scoping). Real files avoid that trap; virtual `__tests__`/`*.test.ts`
// paths still work below because ONLY those are excluded from the
// project-service zone by its own `ignores`.
//
// Fixtures live under worker/{ingress,jobs}/__fixtures__/run-*/: `__fixtures__` is
// in DEFAULT_SKIP_DIRS (scripts/ci/lib/ratchet-harness.ts), so even a
// leftover from a crashed run stays invisible to ci:directory-map — but it
// must NOT collide with either zone's OWN `ignores` (`**/__tests__/**`,
// `**/*.test.ts`), or the zone under test would skip it and the assertion
// would pass for the wrong reason all over again.
//
// Both fixture directories are ALSO gitignored (.gitignore), so a plain
// `eslint .` (pnpm lint / the lefthook `lint` row) skips them entirely —
// otherwise a local `verify-gate.sh`/lefthook run, which lints and tests the
// same working directory in parallel, can catch this suite's fixture mid-
// write/delete and crash on ENOENT (impossible in CI's separate lint/test
// jobs; see the #1372/#1366 lab-notes entry). `lintFiles` below therefore
// runs on a SEPARATE `ESLint({ ignore: false })` instance: the constructor
// flag bypasses global ignore patterns (gitignore-derived and otherwise)
// WITHOUT touching each zone's own `files`/`ignores` rule-scoping — the
// `__tests__`-exemption cases below still exercise the real, ignore-honoring
// instance.
import { ESLint } from 'eslint';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Type-aware linting (no-floating-promises' projectService) pays a real cold
// start on top of lintText's — see eslint-boundaries.test.ts's identical note.
// 120s, not 60s: matches the #1462 precedent (lab-notes/history/2026-09-19-to-30.md)
// for a suite that idles at single-digit seconds but stretches well past 60s
// under this machine's own documented load-average-~50 contention.
vi.setConfig({ testTimeout: 120_000 });

let eslint: ESLint;
let eslintIgnoringNothing: ESLint;

const ingressFixtureRoot = path.join(process.cwd(), 'worker/ingress/__fixtures__');
const jobsFixtureRoot = path.join(process.cwd(), 'worker/jobs/__fixtures__');

// Each run writes into its OWN mkdtemp subdirectory and removes only that.
// lefthook's pre-push runs `test:changed` and `vitest run src/__tests__` in
// parallel, so this file can run twice at once in one working directory; a
// shared fixture dir let one run's rmSync delete the other's fixtures.
let ingressFixtureDir: string;
let jobsFixtureDir: string;
let ingressConsolePath: string;
let ingressConsoleMultiPath: string;
let jobsConsolePath: string;
let unawaitedPromisePath: string;
let awaitedPromisePath: string;

const unawaitedPromiseCode = [
  'async function doSomethingAsync(): Promise<void> {',
  '  return Promise.resolve();',
  '}',
  '',
  'export function triggerFloating(): void {',
  '  doSomethingAsync();',
  '}',
  '',
].join('\n');

const awaitedPromiseCode = unawaitedPromiseCode
  .replace('export function triggerFloating(): void {', 'export async function triggerFloating(): Promise<void> {')
  .replace('doSomethingAsync();', 'await doSomethingAsync();');

beforeAll(() => {
  eslint = new ESLint();
  eslintIgnoringNothing = new ESLint({ ignore: false });

  mkdirSync(ingressFixtureRoot, { recursive: true });
  mkdirSync(jobsFixtureRoot, { recursive: true });
  ingressFixtureDir = mkdtempSync(path.join(ingressFixtureRoot, 'run-'));
  jobsFixtureDir = mkdtempSync(path.join(jobsFixtureRoot, 'run-'));
  ingressConsolePath = path.join(ingressFixtureDir, 'eslint-console-fixture.ts');
  ingressConsoleMultiPath = path.join(ingressFixtureDir, 'eslint-console-multi-fixture.ts');
  jobsConsolePath = path.join(jobsFixtureDir, 'eslint-console-fixture.ts');
  unawaitedPromisePath = path.join(jobsFixtureDir, 'eslint-floating-promise-unawaited.ts');
  awaitedPromisePath = path.join(jobsFixtureDir, 'eslint-floating-promise-awaited.ts');

  writeFileSync(ingressConsolePath, "console.log('leak');\nexport function handler(): void {}\n");
  writeFileSync(
    ingressConsoleMultiPath,
    "console.warn('leak');\nconsole.error('leak');\nexport function handler(): void {}\n",
  );
  writeFileSync(jobsConsolePath, "console.log('leak');\nexport function handler(): void {}\n");
  writeFileSync(unawaitedPromisePath, unawaitedPromiseCode);
  writeFileSync(awaitedPromisePath, awaitedPromiseCode);
});

afterAll(() => {
  rmSync(ingressFixtureDir, { recursive: true, force: true });
  rmSync(jobsFixtureDir, { recursive: true, force: true });
});

async function ruleMessages(filePath: string, ruleId: string) {
  const results = await eslintIgnoringNothing.lintFiles([filePath]);
  const result = results[0];
  if (!result) throw new Error(`ESLint returned no result for ${filePath}`);
  // Fail fast on a fatal parse error (e.g. the type-aware zone's project
  // service rejecting a path it can't find) rather than let a `toHaveLength(0)`
  // "not flagged" assertion pass for the wrong reason — a fatal message means
  // NO rule ran for this file, not that the rule under test found nothing.
  const fatalErrors = result.messages.filter((m) => m.fatal || m.ruleId === null);
  expect(fatalErrors, JSON.stringify(fatalErrors)).toHaveLength(0);
  return result.messages.filter((m) => m.ruleId === ruleId);
}

// The closed inventory of deliberate bare-console worker files — must match
// the no-console zone's `ignores` in eslint.config.mjs.
const CONSOLE_EXEMPT_FILES = [
  'worker/index.ts',
  'worker/config/startup-assert.ts',
  'worker/config/startup-side-effect-guard.ts',
  'worker/jobs/csv-ingest/failed-hook.ts',
  'worker/jobs/publisher/failed-hook.ts',
  'worker/jobs/zernio/ingest-failed-hook.ts',
];

describe('#1372 — no-console covers all of worker/**, minus a closed exemption list', () => {
  it('a worker/ingress handler using console.log errors', async () => {
    expect((await ruleMessages(ingressConsolePath, 'no-console')).length).toBeGreaterThan(0);
  });

  it('a worker/ingress handler using console.warn + console.error errors twice', async () => {
    expect(await ruleMessages(ingressConsoleMultiPath, 'no-console')).toHaveLength(2);
  });

  it('a NON-ingress worker file using console.log also errors (the count cannot grow anywhere in worker/**)', async () => {
    expect((await ruleMessages(jobsConsolePath, 'no-console')).length).toBeGreaterThan(0);
  });

  it.each(CONSOLE_EXEMPT_FILES)('the deliberate bare-console file %s stays exempt', async (file) => {
    expect(await ruleMessages(path.join(process.cwd(), file), 'no-console')).toHaveLength(0);
  });

  it('a worker/ingress TEST file using console.log does NOT error (tests spy on console.* deliberately)', async () => {
    const results = await eslint.lintText("console.log('leak');\nit('x', () => {});\n", {
      filePath: path.join(process.cwd(), 'worker/ingress/__tests__/handler.test.ts'),
      warnIgnored: false,
    });
    const result = results[0];
    if (!result) throw new Error('ESLint returned no result for the test-file fixture');
    const fatalErrors = result.messages.filter((m) => m.fatal || m.ruleId === null);
    expect(fatalErrors, JSON.stringify(fatalErrors)).toHaveLength(0);
    expect(result.messages.filter((m) => m.ruleId === 'no-console')).toHaveLength(0);
  });
});

describe('#1366 — @typescript-eslint/no-floating-promises is a type-aware worker/** zone', () => {
  it('an un-awaited promise in worker/ fails lint', async () => {
    expect(
      (await ruleMessages(unawaitedPromisePath, '@typescript-eslint/no-floating-promises')).length,
    ).toBeGreaterThan(0);
  });

  it('the same call, awaited, does NOT fail lint (no false positive)', async () => {
    expect(
      await ruleMessages(awaitedPromisePath, '@typescript-eslint/no-floating-promises'),
    ).toHaveLength(0);
  });
});
