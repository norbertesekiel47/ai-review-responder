// tests/llm-eval/__tests__/run-moderation-corpus-cli.test.ts
//
// Red-team RT-06. The `--with-safety-review` wiring inside
// `runModerationCorpusMain` had no covering test: the safety-mode entry point
// was reachable only through the command an operator actually runs, so the
// deviation-D3 ordering guard, the corpus composition and the report printing
// were all unpinned. `run.test.ts` covers the argument parsers around it and
// never this function.
//
// The keyed dependencies load through dynamic `import()` inside the function,
// so every one is mocked here and no provider is ever reached.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadModerationCorpus = vi.fn(() => [{ id: 'base-1' }]);
const loadSafetyCorpus = vi.fn(() => [{ id: 'injection-1' }, { id: 'injection-2' }]);
const moderateResponse = vi.fn();
const runModerationCorpus = vi.fn();
const assertSafetyModeEnvironment = vi.fn();
const makeCorpusSafetyReview = vi.fn(() => 'safety-review-fn');
const summariseSafetyProviders = vi.fn(() => 'openai x1');

vi.mock('../moderation-corpus-load', () => ({ loadModerationCorpus, loadSafetyCorpus }));
vi.mock('../../../src/lib/moderation/moderate', () => ({ moderateResponse }));
vi.mock('../moderation-runner', () => ({
  runModerationCorpus,
  assertSafetyModeEnvironment,
  makeCorpusSafetyReview,
  summariseSafetyProviders,
}));

const REPORT = {
  startedAt: '2026-09-18T00:00:00.000Z',
  environment: 'staging',
  verdict: 'PASS',
  failed: 0,
  results: [],
  violations: [],
  total: 1,
  truePositives: 1,
  falseNegatives: 0,
  falsePositives: 0,
  providerMisses: 0,
  safetyErrors: 0,
  falsePositiveRate: 0,
};

let outDir: string;
let outPath: string;
const originalExitCode = process.exitCode;

function argv(...extra: string[]): string[] {
  return ['node', 'run.ts', '--live', '--moderation-corpus', '--env', 'staging', '--out', outPath, ...extra];
}

beforeEach(() => {
  vi.clearAllMocks();
  runModerationCorpus.mockResolvedValue(REPORT);
  outDir = mkdtempSync(join(tmpdir(), 'rt06-'));
  outPath = join(outDir, 'evidence.json');
  process.env.OPENAI_MODERATION_ENABLED = 'true';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(outDir, { recursive: true, force: true });
  delete process.env.OPENAI_MODERATION_ENABLED;
  process.exitCode = originalExitCode;
});

describe('runModerationCorpusMain — safety-mode wiring', () => {
  it('calls assertSafetyModeEnvironment BEFORE the corpus run when --with-safety-review is present', async () => {
    // Deviation D3. `reviewSafety` short-circuits to a mock CLEARANCE under
    // MOCK_EXTERNAL_APIS, so a run that checked the environment afterwards
    // would still burn budget and still leave a transcript that looks real.
    // ORDER is the whole assertion; presence alone would pass either way.
    const { runModerationCorpusMain } = await import('../run');

    await runModerationCorpusMain(argv('--with-safety-review'));

    expect(assertSafetyModeEnvironment).toHaveBeenCalledTimes(1);
    expect(assertSafetyModeEnvironment.mock.invocationCallOrder[0]!).toBeLessThan(
      runModerationCorpus.mock.invocationCallOrder[0]!,
    );
  });

  it('never calls assertSafetyModeEnvironment without the flag', async () => {
    const { runModerationCorpusMain } = await import('../run');

    await runModerationCorpusMain(argv());

    expect(assertSafetyModeEnvironment).not.toHaveBeenCalled();
  });

  it('appends the safety corpus rows only under --with-safety-review', async () => {
    // Round-2 NEW A: the injection rows live in their own file precisely so
    // the DEFAULT command keeps scoring the 53 rows the recorded evidence
    // names. A regression that merged them would silently change what every
    // past run means.
    const { runModerationCorpusMain } = await import('../run');

    await runModerationCorpusMain(argv());
    expect(runModerationCorpus.mock.calls[0]![0]).toEqual([{ id: 'base-1' }]);
    expect(loadSafetyCorpus).not.toHaveBeenCalled();

    await runModerationCorpusMain(argv('--with-safety-review'));
    expect(runModerationCorpus.mock.calls[1]![0]).toEqual([
      { id: 'base-1' },
      { id: 'injection-1' },
      { id: 'injection-2' },
    ]);
  });

  it('passes the safety reviewer to the runner only under the flag', async () => {
    const { runModerationCorpusMain } = await import('../run');

    await runModerationCorpusMain(argv());
    expect(runModerationCorpus.mock.calls[0]![3]).toEqual({});

    await runModerationCorpusMain(argv('--with-safety-review'));
    expect(runModerationCorpus.mock.calls[1]![3]).toEqual({ safetyReview: 'safety-review-fn' });
  });

  it('prints the provider split (D5) and writes the evidence to --out', async () => {
    // D5: the evidence doc must state which provider answered each row, and
    // the run prints it. `summariseSafetyProviders` is the only source of that
    // line, so a report printed without it is evidence missing a required fact.
    const { runModerationCorpusMain } = await import('../run');

    await runModerationCorpusMain(argv('--with-safety-review'));

    expect(summariseSafetyProviders).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({ verdict: 'PASS' });
  });

  it('refuses to run when OPENAI_MODERATION_ENABLED is not true', async () => {
    // With the flag off, moderateResponse never reaches the provider and every
    // row looks clean — a clean-looking run that tested nothing.
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    const { runModerationCorpusMain } = await import('../run');

    await expect(runModerationCorpusMain(argv('--with-safety-review'))).rejects.toThrow(
      /OPENAI_MODERATION_ENABLED/,
    );
    expect(runModerationCorpus).not.toHaveBeenCalled();
  });

  it('refuses to run without --env, so evidence always names the environment it proves', async () => {
    const { runModerationCorpusMain } = await import('../run');

    await expect(
      runModerationCorpusMain(['node', 'run.ts', '--live', '--moderation-corpus']),
    ).rejects.toThrow(/--env/);
    expect(runModerationCorpus).not.toHaveBeenCalled();
  });
});
