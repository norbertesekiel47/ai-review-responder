import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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

  it('includes the secret scan in package, lint CI and local pre-push', () => {
    expect(declared).toContain('ci:secret-scan');
    expect(inCi.has('ci:secret-scan')).toBe(true);
    expect(inLefthook.has('ci:secret-scan')).toBe(true);
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
// That lane runs today: ci.yml's `test` job stands up a `postgres:17` service,
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
const E2E_YML = readFileSync(join(WORKFLOWS_DIR, 'e2e.yml'), 'utf-8');

/** The `postgres:<major>` value from a `services:` image line in workflow YAML. */
function postgresImageMajor(text: string): string | undefined {
  return text.match(/^\s+image:\s*postgres:(\d+)/m)?.[1];
}

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

  it('the test job and the e2e job pin the same postgres major', () => {
    // #1307 RT-4: migration 122's `MAINTAIN` grants are version-guarded to
    // PostgreSQL >= 17 inside a `DO` block, so a lane pinned below 17 never
    // executes them — CI would stay green while shipping an unexercised
    // branch. Two assertions, not one: pinning "both equal 17" alone would
    // miss the two files drifting apart to some OTHER shared major, and "the
    // two equal each other" alone would miss both regressing to 16 together.
    const ciMajor = postgresImageMajor(testJob);
    const e2eMajor = postgresImageMajor(E2E_YML);
    expect(ciMajor, 'ci.yml test job has no postgres image').toBeDefined();
    expect(e2eMajor, 'e2e.yml has no postgres image').toBeDefined();
    expect(ciMajor).toBe('17');
    expect(e2eMajor).toBe('17');
    expect(e2eMajor).toBe(ciMajor);
  });

  it('local E2E setup uses the same PostgreSQL 17 image as both CI database services', () => {
    const docPath = join(ROOT, 'docs', 'runbooks', 'e2e-local-setup.md');
    const doc = readFileSync(docPath, 'utf-8');
    const docMajor = doc.match(/postgres:(\d+)/)?.[1];
    expect(docMajor, 'e2e-local-setup.md has no postgres:<major> in its docker run recipe').toBeDefined();
    // Hardcode the target major, not just cross-file equality: the three
    // files happen to already agree with each other pre-#1307 (all pinned to
    // 16), so an equality-only check would pass vacuously without this line.
    expect(docMajor).toBe('17');
    expect(docMajor).toBe(postgresImageMajor(testJob));
    expect(docMajor).toBe(postgresImageMajor(E2E_YML));
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
// Doc-reading test suites are wired into the docs-only lane (#1199).
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
// one is added. So this DERIVES the candidate set and forces each member to be
// either wired into BOTH docs-only lanes or excused with a reason, the same
// two-column idiom as UNGATED_BY_DESIGN / CI_ONLY_BY_DESIGN above.
//
// The first cut of that derivation hardcoded the DIRECTORY instead — it read
// `src/__tests__` non-recursively — which is the same staleness one level up,
// and it was already live: `src/lib/legal/__tests__/content.test.ts` reads
// docs/legal/*.md and `scripts/ci/__tests__/rls-audit.test.ts` reads
// docs/security/rls-inventory.md, so a PR editing only docs/legal/terms.md
// classified docs_only and shipped a legal-content divergence green. The scan
// now walks every `*.test.ts(x)` under src/ AND scripts/ — the two roots whose
// suites run in the `test` job and nowhere else.
//
// It also hand-rolled a JS lexer (`stringLiterals`) to find doc paths inside
// string literals only. That lexer did not know about JS REGEX literals, so a
// quote-bearing regex — `/title:\s*['"]/`, the shape already live in
// page-metadata.test.ts — mis-paired the quotes and swallowed the rest of the
// line, hiding any doc path sharing it. A guard that under-approximates goes
// silently green, which is the exact failure #1199 exists to remove. The lexer
// is gone: a false positive costs one excuse entry with a reason, a false
// negative costs the whole lane, so this OVER-approximates on purpose.

/**
 * The test roots ci.yml's docs-only `test` skip silences. Every
 * `*.test.ts(x)` under these runs in the `test` job and nowhere else, so a
 * docs-only PR runs none of them unless it is wired into the `lint` job and
 * verify-gate.sh's `doc-shape` row.
 */
const TEST_ROOTS = ['src', 'scripts'] as const;

/**
 * This file. It is the scanner, and its own vocabulary — the doc-path tokens
 * it matches on, the suite names in its excuse table — makes it a permanent
 * self-candidate. It reads package.json, .github/workflows/*, lefthook.yml,
 * scripts/verify-gate.sh and test SOURCE files; none of those is a doc under
 * ci.yml's `docs_only` classifier (`^(docs/|\.claude/)` or `*.md`), so a
 * docs-only PR cannot change anything it reads.
 */
const SCANNER = 'src/__tests__/ci-audit-wiring.test.ts';

/** Every `*.test.ts` / `*.test.tsx` under TEST_ROOTS. Repo-relative, sorted. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.test\.tsx?$/.test(entry)) found.push(relative(ROOT, full).split(sep).join('/'));
    }
  };
  for (const root of TEST_ROOTS) walk(join(ROOT, root));
  return found.sort();
}

/**
 * `text` with WHOLE-LINE comments dropped — a line whose first non-space
 * characters are `//`, `/*` or `*`.
 *
 * This is the only comment-awareness that survives, and it survives because
 * it is line-BOUNDED: it decides one line at a time, pairs no delimiters, and
 * therefore cannot mis-read one construct into swallowing the next (the whole
 * defect in the lexer it replaces). Same reasoning as `jobBlock`: prose
 * describing a doc must not make a suite look like it reads one.
 *
 * Its one residual: a doc path that appears ONLY inside a whole-line comment
 * is not seen — which is correct, because a path in a comment is not read. A
 * trailing comment on a code line still counts, and is meant to: that is an
 * over-approximation, and over-approximating is the point.
 */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/**
 * Does `text` name a repo doc in code? "Doc" is ci.yml's `docs_only`
 * vocabulary exactly — a `docs/` or `.claude/` path, or a token ending `.md`
 * (which covers AGENTS.md, CONTEXT-MAP.md and .agents/**\/*.md too). The
 * token is looked for WHEREVER it sits: a failure message embeds the path
 * mid-sentence rather than as a whole literal
 * (design-token-single-source.test.ts: "... (docs/brand-asset-library/
 * design-systems/README.md rule 2)."), and a read composes it
 * (`resolve('docs/legal', file)`).
 *
 * Deliberately NOT parsed: no string-literal pairing, no regex-literal
 * handling, no read-call matching. Each of those narrows the scan, and every
 * narrowing is a way for a real doc-reading suite to escape unnoticed.
 */
function namesDocPath(text: string): boolean {
  const code = codeLines(text);
  return /(^|[\s('"`[])(docs\/|\.claude\/)/.test(code) || /\.md(?:[\s)'"`\],.:;]|$)/.test(code);
}

/**
 * Every test file under src/ and scripts/ that names a doc path in code — the
 * candidate set #1199's fix has to account for, one way or the other.
 * Repo-relative paths, sorted.
 */
function docReadingCandidates(): string[] {
  return testFiles()
    .filter((file) => file !== SCANNER)
    .filter((file) => namesDocPath(readFileSync(join(ROOT, file), 'utf-8')));
}

/**
 * Candidates that are NOT wired into the two docs-only lanes. Each needs a
 * reason, because the default reading of an unexplained mention is "this
 * suite reads a doc and the docs-only lane must run it."
 *
 * Two reason shapes live here, and they are not interchangeable:
 *   - "not a read" — the suite names a doc path in a failure message, a test
 *     fixture, or a pure-function argument, and touches no repo doc. Nothing
 *     is lost by not running it on a docs-only PR.
 *   - "deferred on COST" — the suite genuinely reads a repo doc, but is too
 *     slow to put on every PR's `lint` job. This is a real, named gap: a
 *     docs-only PR does not run it. It is recorded here rather than hidden so
 *     ci.yml's comment can stay true about what the skip does and does not
 *     cover.
 */
const NOT_DOC_READING: Record<string, string> = {
  // --- src/__tests__ -------------------------------------------------------
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
  // --- src/lib -------------------------------------------------------------
  // Names ADR 0022 inside an assertion message about the rate cap; reads no
  // file at all.
  'src/lib/solicitation/__tests__/dispatch-rate-bound.test.ts':
    'names an ADR inside a FAILURE MESSAGE, not a read',
  // --- scripts/ci ----------------------------------------------------------
  // `docs/admin-api/` is the delivery PREFIX asserted against in-memory
  // Buffers; the only file read is .github/workflows/admin-contract-delivery.yml.
  'scripts/ci/__tests__/admin-contract-delivery.test.ts':
    'docs/admin-api is a delivery prefix in fixtures; reads only a workflow file',
  // Every docs/reviews/** path is written into, then read back from, a
  // throwaway git repo under mkdtemp.
  'scripts/ci/__tests__/blast-radius.test.ts': 'docs paths are mkdtemp FIXTURES, not repo docs',
  // Drives .codex/hooks/* against a mkdtemp repo; the only repo file it copies
  // is .agents/skills/feature/scripts/gate-fingerprint.mjs — a .mjs, not a doc.
  'scripts/ci/__tests__/codex-hook-enforcement.test.ts':
    'reads .codex hooks and a .mjs script; every doc path is a mkdtemp fixture',
  // Parses registry markdown passed in as a string; `doc.md` is a label.
  'scripts/ci/__tests__/env-registry-audit.test.ts': 'parses markdown STRINGS; reads no file',
  // Feeds path lists to the surface matcher as plain arguments.
  'scripts/ci/__tests__/feature-surface-audit.test.ts':
    'doc paths are matcher ARGUMENTS; reads no file',
  // Runs scripts/feature-state.sh + scripts/gate-summary.sh against a mkdtemp
  // repo; `plan.md` and docs/reviews/feat-x.md are files it writes there.
  'scripts/ci/__tests__/gate-loop.test.ts': 'reads scripts/*.sh; doc paths are mkdtemp fixtures',
  // Runs scripts/gate-promised-tests.sh against mkdtemp fixture trees; the
  // `src/notes.md` it names is a sibling non-test file it writes there to
  // prove the title search never widens past *.test.ts(x).
  'scripts/ci/__tests__/gate-promised-tests.test.ts':
    'reads scripts/gate-promised-tests.sh; src/notes.md is a mkdtemp fixture',
  // Reads scripts/gate-rows.sh, scripts/verify-gate.sh and
  // scripts/gate-promised-tests.sh. The doc paths are row-name INPUTS to
  // row_slug/bucketOf, never opened.
  'scripts/ci/__tests__/gate-rows.test.ts':
    'reads scripts/*.sh only; doc paths are row-slug inputs',
  // `isProductionFile` / ledger classification over path STRINGS.
  'scripts/ci/__tests__/merge-ledger-audit.test.ts':
    'classifies path STRINGS; opens no doc',
  // Runs scripts/new-worktree.sh against a mkdtemp repo whose README.md it
  // writes itself.
  'scripts/ci/__tests__/new-worktree-env.test.ts':
    'reads scripts/new-worktree.sh; README.md is a mkdtemp fixture',
  // Copies .agents/skills/feature/scripts (a .mjs tree) into a mkdtemp repo;
  // the finding-checklists path is written and read back inside that repo.
  'scripts/ci/__tests__/review-log.test.ts':
    'reads .agents .mjs scripts; doc paths are mkdtemp fixtures',
  // Scans source STRINGS handed to scanFile; the doc names appear in the
  // findings' detail text.
  'scripts/ci/__tests__/static-policy-audit.test.ts':
    'scans source STRINGS; doc names sit in finding detail text',
  // Builds synthetic diffs and registry markdown in memory; the doc paths are
  // diff headers and the verifier-exceptions registry is passed in as a STRING
  // (only main() opens the real file).
  'scripts/ci/__tests__/weakened-checks-audit.test.ts':
    'doc paths are synthetic DIFF headers and registry STRINGS; reads no file',
  // --- deferred on COST (these DO read repo docs) --------------------------
  // Reads docs/reviews/red-team/**/findings.json fixtures committed in-repo
  // and .agents|.claude/skills/red-team/SKILL.md. Measured at 71s standalone —
  // the `lint` step runs on EVERY PR and the other 17 doc-reading suites
  // together cost ~7s, so this one would multiply that step's cost by ~10.
  // Gap, stated plainly: a docs-only PR that edits those fixtures or SKILL.md
  // does not run this suite; it goes red on the next non-docs PR instead.
  'scripts/ci/__tests__/red-team-status.test.ts':
    'READS repo docs — deferred on COST (71s standalone); docs-only PRs do not run it',
  // Same inputs, same gap, 122s standalone: it spawns vitest inside mkdtemp
  // repos for the mutation lane.
  'scripts/ci/__tests__/red-team-mutation-runner.test.ts':
    'READS repo docs — deferred on COST (122s standalone); docs-only PRs do not run it',
};

/** Every `src/**` or `scripts/**` test path literally named in `text`. */
function testPathsNamedIn(text: string): string[] {
  return [
    ...new Set(text.match(/(?:src|scripts)\/[\w./\-[\]()]*\.test\.tsx?/g) ?? []),
  ].sort();
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

describe('doc-reading test suites are wired into the docs-only lane (#1199)', () => {
  const candidates = docReadingCandidates();

  it('finds candidates to check — a suite mentioning docs/, .claude/, or *.md', () => {
    // A floor, not a count: if this collapsed to 0, every assertion below
    // would be vacuously true — the exact failure shape #1199 itself was.
    // Raised from 3 when the scan widened from `src/__tests__` alone to every
    // test file under src/ and scripts/ (35 candidates at the time).
    expect(candidates.length).toBeGreaterThanOrEqual(20);
  });

  it('scans both test roots, recursively, including .tsx', () => {
    // The first cut read `src/__tests__` non-recursively and only `.test.ts`.
    // These three are outside that shape and each names a doc path in code, so
    // a regression to a flat, single-root, single-extension scan fails here by
    // name rather than as a quiet shrink of the candidate list.
    expect(candidates).toContain('src/lib/legal/__tests__/content.test.ts');
    expect(candidates).toContain('scripts/ci/__tests__/rls-audit.test.ts');
    expect(testFiles().some((file) => file.endsWith('.test.tsx'))).toBe(true);
  });

  it('finds a doc path sharing a line with a quote-bearing regex literal', () => {
    // The lexer this scan replaced paired quotes without knowing about JS
    // REGEX literals: the `['"]` class below opened a "string" that ran to the
    // next quote, so the scan returned `]/); const DOC = ` and the doc path on
    // the same line vanished. A doc-reading suite that escapes the candidate
    // set makes the whole `it.each` above pass vacuously — a false green in
    // the lane #1199 exists to keep honest. The shape is live at
    // src/__tests__/page-metadata.test.ts (`/title:\s*['"]/`).
    const source = ["const RE = /title:\\s*['\"]/;", 'const DOC = "docs/context/thing.md";'].join(
      ' ',
    );
    expect(namesDocPath(source)).toBe(true);
    // The same line split across two, and the regex alone (no doc path).
    expect(namesDocPath("const RE = /title:\\s*['\"]/;\nconst DOC = 'docs/currents.md';")).toBe(
      true,
    );
    expect(namesDocPath("const RE = /title:\\s*['\"]/;\nconst X = 1;")).toBe(false);
  });

  it('ignores a doc path that appears only in a whole-line comment', () => {
    // The one comment-awareness kept, and the reason it is safe: the filter is
    // line-bounded, so it can never swallow the line after it.
    expect(namesDocPath('// see docs/currents.md\nconst X = 1;')).toBe(false);
    expect(namesDocPath(' * see docs/currents.md\nconst X = 1;')).toBe(false);
    // A trailing comment on a code line still counts — over-approximating is
    // the point, and the cost is one excuse entry.
    expect(namesDocPath('const X = 1; // see docs/currents.md')).toBe(true);
  });

  it.each(candidates)(
    'every test that reads a doc at run time is wired into the docs-only lane or excused with a reason',
    (file) => {
      const wired = lintDocSuitePaths.includes(file) && verifyGateDocSuitePaths.includes(file);
      const excused = file in NOT_DOC_READING;
      // A candidate in neither column is exactly #1199: a suite that reads a
      // doc at run time but that a docs-only PR never runs.
      expect({ file, wired, excused }).toEqual({ file, wired: !excused, excused });
    },
  );

  it('excuses only files the candidate scan still finds', () => {
    // Mirrors "excuses only scripts that exist" above: a NOT_DOC_READING entry
    // for a file that no longer names a doc path — or no longer exists — is a
    // stale excuse.
    expect(candidates).toEqual(expect.arrayContaining(Object.keys(NOT_DOC_READING)));
  });

  it('states for every cost-deferred excuse that a docs-only PR does not run it', () => {
    // A cost deferral is a REAL gap, not a "this reads no doc" dismissal. Its
    // reason has to say so, or ci.yml's comment starts claiming coverage the
    // lane does not have — the defect #1199 exists to remove.
    for (const [file, reason] of Object.entries(NOT_DOC_READING)) {
      if (!reason.includes('COST')) continue;
      expect(reason, `${file}: a cost deferral must name the gap`).toMatch(
        /docs-only PRs do not run it/,
      );
    }
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
    // Raised from 3 with the widened scan: 17 suites are wired today.
    expect(lintDocSuitePaths.length).toBeGreaterThanOrEqual(10);
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
