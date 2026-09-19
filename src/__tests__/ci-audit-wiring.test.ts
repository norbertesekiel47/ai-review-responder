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
  // (ci.yml's `fallow` job), which feeds fallow real coverage; running both
  // would double the suite per PR for a strictly weaker signal. Reading a local
  // `ci:fallow` pass as "the PR gate is green" is how §2's second instance
  // happened.
  'ci:fallow': "superseded as a gate by ci:fallow:coverage in ci.yml's fallow job",
};

/**
 * Scripts that run in ci.yml but are deliberately NOT mirrored in lefthook.yml.
 * Each needs a reason: lefthook's header promises every ci.yml audit runs
 * locally too, so an unmirrored one reads as drift unless it says why not.
 */
const CI_ONLY_BY_DESIGN: Record<string, string> = {
  // Its input is a full `vitest run --coverage` (the `test` job's artifact) —
  // minutes of work that has no place in a pre-push hook. Until the CI cost
  // pass this ran in its own workflow (fallow.yml) precisely to stay outside
  // this mirror rule; folding it into ci.yml removed a second suite run and a
  // second Postgres per PR. Faithful local reproduction is
  // `pnpm test:coverage && pnpm ci:fallow:coverage`.
  'ci:fallow:coverage': 'coverage-informed gate; input is a full coverage run',
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
  it('includes the generated Admin API contract in package, lint CI and local pre-push', () => {
    expect(declared).toContain('ci:admin-contract');
    expect(inCi.has('ci:admin-contract')).toBe(true);
    expect(inLefthook.has('ci:admin-contract')).toBe(true);
  });
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

  it.each([...inCi].filter((script) => !(script in CI_ONLY_BY_DESIGN)))(
    '%s also runs in lefthook.yml',
    (script) => {
      // lefthook.yml's own header: "Every command here mirrors a step in
      // .github/workflows/ci.yml so the local loop and CI never diverge."
      expect(inLefthook.has(script)).toBe(true);
    },
  );

  it.each(Object.keys(CI_ONLY_BY_DESIGN))(
    '%s is CI-only: runs in ci.yml, absent from lefthook.yml',
    (script) => {
      // The exemption is only meaningful while the script actually runs in
      // ci.yml — if it moves out, this entry is stale and goes with it. And if
      // someone mirrors it into lefthook after all, the exemption is moot.
      expect(inCi.has(script)).toBe(true);
      expect(inLefthook.has(script)).toBe(false);
    },
  );

  it.each([...new Set([...inCi, ...inLefthook, ...inAnyWorkflow])])(
    '%s is a real package.json script',
    (script) => {
      expect(declared).toContain(script);
    },
  );

  it('excuses only scripts that exist', () => {
    expect(declared).toEqual(expect.arrayContaining(Object.keys(UNGATED_BY_DESIGN)));
    expect(declared).toEqual(expect.arrayContaining(Object.keys(CI_ONLY_BY_DESIGN)));
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
    // `pnpm test:coverage` since the CI cost pass — the same whole-suite run
    // as `pnpm test` plus the v8 report the `fallow` job consumes. Either
    // spelling is the gate; a `--project`, a path filter, or `test:integration`
    // here is not.
    expect(testJob).toMatch(/^\s+run:\s*pnpm test(?::coverage)?\s*$/m);
  });

  it('pnpm test and pnpm test:coverage run every vitest project', () => {
    // Neither may narrow to one project: the integration suites live in their
    // own serialized `integration` project, and a `--project parallel` filter
    // here would drop the entire live-DB lane while staying green.
    // (`pnpm test:integration` is a developer fast-path that deliberately runs
    // ONE suite — it is not this gate, and must never be mistaken for it.)
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage');
  });
});

// ---------------------------------------------------------------------------
// Doc-reading src/__tests__ suites are wired into the docs-only lane (#1199).
//
// ci.yml's `test` job skips entirely on a docs-only PR. Its premise was "no
// unit test reads docs/** or *.md at run time" — true when that condition
// landed, false the day design-doc-token-pin.test.ts started reading three
// DESIGN.md files. #1199's fix named that suite plus reference-shape.test.ts
// and claude-md-shape.test.ts (which already read docs) and moved all three
// into ci.yml's `lint` job (which never skips) and a `doc-shape` row in
// scripts/verify-gate.sh's docs-only mode.
//
// A hardcoded list of three suites would repeat the exact failure this ticket
// is about: a claim about "every doc-reading test" going stale the next time
// one is added. So this DERIVES the candidate set — every src/__tests__ suite
// with a string literal naming a doc path — and forces each one to be either
// wired into BOTH docs-only lanes or excused with a reason, the same
// two-column idiom as UNGATED_BY_DESIGN / CI_ONLY_BY_DESIGN above.

const TESTS_DIR = join(ROOT, 'src', '__tests__');

/**
 * Every quoted string/template literal's content in `text`, with block and
 * line comments matched (and discarded) alongside them in the SAME
 * alternation. Two things break a naive "just match quotes" version:
 *
 *   - A single/double-quoted JS string can never contain a raw newline, so
 *     excluding \n from those two character classes stops an unescaped
 *     apostrophe in a comment ("doesn't", "the file's") from opening a
 *     "string" that swallows the rest of the source hunting its next quote.
 *   - A comment can quote a doc path in backticks as a markdown-style code
 *     span (this very docblock does, two paragraphs up) — indistinguishable
 *     from a real template literal unless comments are matched FIRST in the
 *     same left-to-right scan, so their contents are consumed as a comment
 *     and never separately offered to the template-literal alternative.
 */
function stringLiterals(text: string): string[] {
  const re =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const literal = match[1] ?? match[2] ?? match[3];
    if (literal !== undefined) out.push(literal);
  }
  return out;
}

/**
 * A literal that names a repo doc: a `docs/`/`.claude/` path, or a token
 * ending `.md` — wherever it sits inside the literal. A failure message
 * embeds the path mid-sentence rather than as the whole literal
 * (design-token-single-source.test.ts:217: "... (docs/brand-asset-library/
 * design-systems/README.md rule 2)."), so this looks for the token, not for
 * the literal itself being the path.
 */
function mentionsDocPath(literal: string): boolean {
  return /(^|[\s(])(docs\/|\.claude\/)/.test(literal) || /\.md(?:[\s).,:;]|$)/.test(literal);
}

/**
 * Every `src/__tests__/*.test.ts` file with a string literal naming a doc
 * path — the candidate set #1199's fix has to account for, one way or the
 * other. Repo-relative paths, sorted.
 */
function docReadingCandidates(): string[] {
  return readdirSync(TESTS_DIR)
    .filter((entry) => entry.endsWith('.test.ts'))
    // This file itself is the scanner, not a candidate — and scanning it is
    // actively wrong: `stringLiterals` is a regex-based scanner blind to JS
    // REGEX literals (`/pattern/flags`), and the quote characters inside this
    // very file's own `stringLiterals`/`mentionsDocPath` regex source
    // (`'`, `"`, `` ` ``) would otherwise be misread as opening real string
    // literals, corrupting the scan of everything after them.
    .filter((entry) => entry !== 'ci-audit-wiring.test.ts')
    .filter((entry) =>
      stringLiterals(readFileSync(join(TESTS_DIR, entry), 'utf-8')).some(mentionsDocPath),
    )
    .map((entry) => `src/__tests__/${entry}`)
    .sort();
}

/**
 * Candidates that mention a doc path but do not READ one at run time. Each
 * needs a reason: the default reading of an unexplained mention is "this
 * suite reads a doc and the docs-only lane must run it."
 */
const NOT_DOC_READING: Record<string, string> = {
  // Reads CSS only (globals.css, tokens.css, page CSS via helpers/css-tokens);
  // the docs path sits inside an `expect(actual, message)` failure string
  // pointing a future reader at the design-system README — never a
  // `readFileSync` argument.
  'src/__tests__/design-scope-purity.test.ts':
    'names a docs path inside a FAILURE MESSAGE, not a read',
  // Same shape: reads globals.css / tokens.css / theme.css / console.css and
  // friends; every docs/ mention here is quoted inside failure-message text.
  'src/__tests__/design-token-single-source.test.ts':
    'names a docs path inside a FAILURE MESSAGE, not a read',
};

/** Every `src/__tests__/*.test.ts` path literally named in `text`. */
function testPathsNamedIn(text: string): string[] {
  return [...new Set(text.match(/src\/__tests__\/[\w.-]+\.test\.ts/g) ?? [])].sort();
}

/**
 * `text` with whole-line `#` comments removed. Same reasoning as `jobBlock`
 * above: prose describing a suite must never satisfy a check for running it.
 */
function withoutHashComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const lintDocSuitePaths = testPathsNamedIn(jobBlock('lint'));
const verifyGateDocSuitePaths = testPathsNamedIn(
  withoutHashComments(readFileSync(join(ROOT, 'scripts', 'verify-gate.sh'), 'utf-8')),
);

describe('doc-reading src/__tests__ suites are wired into the docs-only lane (#1199)', () => {
  const candidates = docReadingCandidates();

  it('finds candidates to check — a suite mentioning docs/, .claude/, or *.md', () => {
    // A floor, not a count: if this collapsed to 0, every assertion below
    // would be vacuously true — the exact failure shape #1199 itself was.
    expect(candidates.length).toBeGreaterThanOrEqual(3);
  });

  it.each(candidates)(
    'every src test that reads a doc at run time runs in the docs-only lane',
    (file) => {
      const wired = lintDocSuitePaths.includes(file) && verifyGateDocSuitePaths.includes(file);
      const excused = file in NOT_DOC_READING;
      // A candidate in neither column is exactly #1199: a suite that reads a
      // doc at run time but that a docs-only PR never runs.
      expect({ file, wired, excused }).toEqual({ file, wired: !excused, excused });
    },
  );

  it('excuses only files that still mention a doc path in a string literal', () => {
    // Mirrors "excuses only scripts that exist" above: a NOT_DOC_READING entry
    // for a file that no longer mentions a doc path is a stale excuse.
    expect(candidates).toEqual(expect.arrayContaining(Object.keys(NOT_DOC_READING)));
  });

  it('the lint job runs the doc-reading suites, and the lint job never skips', () => {
    const lint = jobBlock('lint');
    expect(lint).toMatch(/run:\s*pnpm vitest run\b/);
    for (const file of candidates.filter((c) => !(c in NOT_DOC_READING))) {
      expect(lint).toContain(file);
    }
    // The draft-PR gate (next to `changes`) is the only condition `lint` may
    // carry — never a docs-only skip. That is the entire reason the
    // doc-reading suites run here instead of in `test`.
    expect(lint).not.toMatch(/needs\.changes\.outputs\.docs_only/);
  });

  it('verify-gate docs-only mode runs the same doc-reading suites as the lint job', () => {
    expect(lintDocSuitePaths.length).toBeGreaterThanOrEqual(3);
    // Equal, not "both non-empty": the two docs-only lanes must never drift.
    expect(verifyGateDocSuitePaths).toEqual(lintDocSuitePaths);
  });

  it('counts the design-system doc pin as a doc-reading suite', () => {
    // #1199 named reference-shape.test.ts and claude-md-shape.test.ts but
    // missed this one — a regression that drops it again must fail BY NAME,
    // not merely as a count mismatch elsewhere in this file.
    const file = 'src/__tests__/design-doc-token-pin.test.ts';
    expect(candidates).toContain(file);
    expect(NOT_DOC_READING[file]).toBeUndefined();
    expect(lintDocSuitePaths).toContain(file);
    expect(verifyGateDocSuitePaths).toContain(file);
  });
});
