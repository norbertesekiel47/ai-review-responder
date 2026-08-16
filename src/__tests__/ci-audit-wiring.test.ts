import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #590. `package.json`, `.github/workflows/*`, and `lefthook.yml` each spell the
// set of `ci:*` audits by hand, and nothing forced the three to agree — so
// `ci:live-db-suites` shipped present in package.json and absent from every
// gate, while CLAUDE.md claimed CI enforced it. A green run could not see it:
// an audit wired into nothing simply never runs.
//
// This is a guard TEST rather than another `ci:*` script on purpose. An audit
// that checks whether audits are wired has to be wired itself, and removing its
// step would silence it — the exact failure it exists to catch. `pnpm test` is
// a required CI job and lefthook runs `src/__tests__` unconditionally, so there
// is no step to remove here.

const ROOT = resolve(process.cwd());
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

/**
 * Scripts that deliberately gate nothing. Each needs a reason, because the
 * default reading of an unwired audit is "someone forgot".
 */
const UNGATED_BY_DESIGN: Record<string, string> = {
  // The developer-facing sweep. Its PR gate is the sibling `ci:fallow:coverage`
  // (fallow.yml), which feeds fallow real coverage; running both would double
  // the suite per PR for a strictly weaker signal. Reading a local `ci:fallow`
  // pass as "the PR gate is green" is how §2's second instance happened.
  'ci:fallow': 'superseded as a gate by ci:fallow:coverage in fallow.yml',
};

/** Every `pnpm ci:<name>` invocation in a file, whatever the surrounding YAML. */
function ciScriptsInvokedIn(path: string): Set<string> {
  const text = readFileSync(path, 'utf-8');
  const invocations = text.matchAll(/\bpnpm\s+(?:-s\s+)?(ci:[a-z0-9:-]+)/g);
  return new Set([...invocations].map((match) => match[1]!));
}

function declaredCiScripts(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  return Object.keys(pkg.scripts).filter((name) => name.startsWith('ci:'));
}

const declared = declaredCiScripts();
const inCi = ciScriptsInvokedIn(join(WORKFLOWS_DIR, 'ci.yml'));
const inLefthook = ciScriptsInvokedIn(join(ROOT, 'lefthook.yml'));
const inAnyWorkflow = new Set(
  readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .flatMap((file) => [...ciScriptsInvokedIn(join(WORKFLOWS_DIR, file))]),
);

describe('ci:* audit wiring', () => {
  it('finds the audits it is meant to check', () => {
    expect(declared.length).toBeGreaterThan(10);
    expect(inCi.size).toBeGreaterThan(10);
  });

  it.each(declared)('%s runs in some workflow, or is ungated with a reason', (script) => {
    const wired = inAnyWorkflow.has(script);
    const excused = script in UNGATED_BY_DESIGN;
    // An audit in neither column gates nothing at all — add it to a workflow,
    // or record in UNGATED_BY_DESIGN why it is not a gate.
    expect({ script, wired, excused }).toEqual({ script, wired: !excused, excused });
  });

  it.each([...inCi])('%s also runs in lefthook.yml', (script) => {
    // lefthook.yml's own header: "Every command here mirrors a step in
    // .github/workflows/ci.yml so the local loop and CI never diverge."
    expect(inLefthook.has(script)).toBe(true);
  });

  it.each([...new Set([...inCi, ...inLefthook, ...inAnyWorkflow])])(
    '%s is a real package.json script',
    (script) => {
      expect(declared).toContain(script);
    },
  );

  it('excuses only scripts that exist', () => {
    expect(declared).toEqual(expect.arrayContaining(Object.keys(UNGATED_BY_DESIGN)));
  });
});

// ---------------------------------------------------------------------------
// The live-DB lane's CI wiring (Pathfinder 2026-08-15, handoff H6).
//
// The `*.integration.test.ts` family is the SOLE coverage of ~22 migrations'
// DDL and of pins no mock can reach — ON CONFLICT inference against a real
// partial index, DB CHECK constraints, `FOR UPDATE` serialization, and
// `ORDER BY` precedence resolved by Postgres rather than by JS. Mutation
// evidence: deleting `suppressionMatchSql`'s global-wins ordering or its
// account scoping (`src/lib/solicitation/suppression.ts`), or
// `import-offer-view`'s `ORDER BY jo.created_at DESC`, leaves the entire
// 862-file `parallel` project green. Only the live lane fails.
//
// That lane runs today: ci.yml's `test` job stands up a `postgres:16` service,
// sets `TEST_DATABASE_POOL_URL`, provisions the schema, and runs the whole
// suite — 91 of 92 integration suites execute per PR. But NOTHING pinned that,
// and every suite degrades to a SILENT SKIP rather than a failure when the
// database is absent (`describeWithDb`). Deleting four lines of YAML would
// therefore un-gate all 92 suites and leave CI green — the #520 failure mode,
// one config edit away.
//
// The cost of not pinning it is already measured: `vitest.config.ts` carried a
// comment asserting the opposite ("the integration suites self-skip there
// because TEST_DATABASE_POOL_URL is unset"). It was stale from the moment the
// service container landed, two reviews recorded it as stale without
// correcting it, and a later architecture pass trusted it and filed a
// finding — "correct tests that no gate runs" — that was false. A gate nobody
// can verify from the source is a gate the source will eventually misdescribe.
//
// Same reasoning as the block above: this is a guard TEST, not another `ci:*`
// script, because an audit that checks whether the DB lane is wired would have
// to be wired itself.

const CI_YML = readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf-8');

/**
 * One top-level job's YAML, comment-stripped.
 *
 * Comments are removed for the same reason `ci:admin-aal2` strips them: prose
 * describing a service container must never satisfy a check for one. The slice
 * runs to the next 2-space-indented key, which can trail the following job's
 * comment header — stripping makes that bleed inert instead of load-bearing.
 */
function jobBlock(job: string): string {
  const start = CI_YML.indexOf(`\n  ${job}:\n`);
  expect(start, `ci.yml has no top-level "${job}" job`).toBeGreaterThan(-1);
  const rest = CI_YML.slice(start + 1);
  const next = rest.search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  return (next === -1 ? rest : rest.slice(0, next + 1))
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Every `*.integration.test.ts` under src/ and worker/. */
function integrationSuites(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.integration.test.ts')) found.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'worker'));
  return found;
}

describe('live-DB lane is gated in CI', () => {
  const testJob = jobBlock('test');

  it('the lane it protects is non-empty', () => {
    // A floor, not a count: this fails if the suffix convention is renamed
    // wholesale (which would also silently empty vitest's `integration`
    // project, since that project selects on exactly this glob).
    expect(integrationSuites().length).toBeGreaterThan(50);
  });

  it('ci.yml test job runs a Postgres service container', () => {
    expect(testJob).toMatch(/^\s+image:\s*postgres:\d+/m);
  });

  it('ci.yml test job sets TEST_DATABASE_POOL_URL', () => {
    // The gate `describeWithDb` reads. Absent, all 92 suites skip silently.
    expect(testJob).toMatch(/^\s+TEST_DATABASE_POOL_URL:\s*\S+/m);
  });

  it('ci.yml test job provisions the schema before running tests', () => {
    // Live-DB suites ASSERT their schema (`assertSchemaReady`) instead of
    // applying migrations, so a job without this step fails loudly rather
    // than self-healing — but only if the step is here to begin with.
    expect(testJob).toMatch(/uses:\s*\.\/\.github\/actions\/test-db/);
  });

  it('ci.yml test job runs the whole suite, not a subset', () => {
    expect(testJob).toMatch(/^\s+run:\s*pnpm test\s*$/m);
  });

  it('pnpm test runs every vitest project', () => {
    // `pnpm test` must not narrow to one project: the integration suites live
    // in their own serialized `integration` project, and a `--project parallel`
    // filter here would drop the entire live-DB lane while staying green.
    // (`pnpm test:integration` is a developer fast-path that deliberately runs
    // ONE suite — it is not this gate, and must never be mistaken for it.)
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe('vitest run');
  });
});
