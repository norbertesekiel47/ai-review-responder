import { describe, expect, it } from 'vitest';
import {
  baseRefFor,
  classifyDiff,
  evaluateFinding,
  GOVERNANCE_PATHS,
  isGovernanceFile,
  isProductionFile,
  isTestFile,
  LEDGER_PATH,
  parseAddedLines,
  passReport,
  unresolvedBaseReport,
  violationReport,
} from '../merge-ledger-audit';

// #896 part 1. The audit itself is `git diff` plus these pure functions, so
// every rule that decides PASS or FAIL is tested here and `main()` is left as
// the thin shell that reads git.

describe('the test lane, which the arch log s rule excludes', () => {
  it.each([
    'src/lib/solicitation/__tests__/dispatch.integration.test.ts',
    'worker/jobs/publisher/__tests__/helpers.ts',
    'src/lib/reviews/sentiment.test.ts',
    'src/components/Panel.test.tsx',
    'e2e/approve.spec.ts',
    'tests/llm-eval/harness.ts',
  ])('%s is a test file', (path) => {
    expect(isTestFile(path)).toBe(true);
    expect(isProductionFile(path)).toBe(false);
  });

  it.each([
    'src/lib/solicitation/dispatch.ts',
    'worker/index.ts',
    'supabase/migrations/112_something.sql',
    // "test" inside a NAME is not the test lane — a production module about
    // testing is still production.
    'src/lib/config/test-mode.ts',
  ])('%s is production', (path) => {
    expect(isProductionFile(path)).toBe(true);
  });

  it('leaves everything outside the three roots alone', () => {
    expect(isProductionFile('docs/directory.md')).toBe(false);
    expect(isProductionFile('CLAUDE.md')).toBe(false);
    expect(isProductionFile('.claude/reference/lab-notes.md')).toBe(false);
  });
});

describe('the governance surface', () => {
  it.each([
    '.agents/skills/feature/SKILL.md',
    '.claude/skills/new-migration/SKILL.md',
    '.claude/hooks/typecheck-on-stop.sh',
    '.codex/hooks/typecheck-on-stop.sh',
    '.github/workflows/ci.yml',
    'scripts/ci/merge-ledger-audit.ts',
    'scripts/verify-gate.sh',
    'scripts/arm-check.sh',
    'lefthook.yml',
    'package.json',
  ])('%s is governance', (path) => {
    expect(isGovernanceFile(path)).toBe(true);
  });

  // The one glob, and the reason it is one: these scripts are added and
  // renamed as the /feature workflow changes shape.
  it.each([
    'scripts/feature-setup.sh',
    'scripts/feature-cleanup.sh',
    'scripts/feature-surface-check.sh',
    'scripts/feature-a-brand-new-one.sh',
  ])('%s matches the feature-script glob', (path) => {
    expect(isGovernanceFile(path)).toBe(true);
  });

  it.each([
    'scripts/new-worktree.sh',
    'scripts/features.ts',
    'scripts/feature-setup.ts',
    'package-lock.json',
    'src/lib/solicitation/dispatch.ts',
  ])('%s is not governance', (path) => {
    expect(isGovernanceFile(path)).toBe(false);
  });

  // A prefix entry must cover the subtree, not merely the folder name.
  it('treats a trailing slash as a subtree prefix', () => {
    expect(isGovernanceFile('.claude/hooks/nested/deep/thing.sh')).toBe(true);
    expect(isGovernanceFile('.claude/hooksomething.sh')).toBe(false);
  });

  it('names every path the issue listed', () => {
    expect([...GOVERNANCE_PATHS]).toEqual([
      '.agents/skills/',
      '.claude/skills/',
      '.claude/hooks/',
      '.codex/hooks/',
      '.github/workflows/',
      'scripts/ci/',
      'scripts/verify-gate.sh',
      'scripts/arm-check.sh',
      'lefthook.yml',
      'package.json',
    ]);
  });
});

describe('the finding', () => {
  it('passes a docs-only diff with no ledger line', () => {
    expect(evaluateFinding({
      changed: ['docs/directory.md', 'CLAUDE.md'],
      ledgerLinesAdded: 0,
    })).toBeNull();
  });

  it('passes a test-only diff with no ledger line', () => {
    expect(evaluateFinding({
      changed: ['src/lib/solicitation/__tests__/dispatch.integration.test.ts'],
      ledgerLinesAdded: 0,
    })).toBeNull();
  });

  it('fails a production diff with no ledger line', () => {
    const finding = evaluateFinding({
      changed: ['src/lib/solicitation/dispatch.ts'],
      ledgerLinesAdded: 0,
    });
    expect(finding).toContain('1 production file(s)');
    expect(finding).toContain(LEDGER_PATH);
  });

  // #803's class: no production line at all, and the enforcement surface
  // rewritten. This trigger is the whole reason the path set exists.
  it('fails a governance-only diff with no ledger line', () => {
    const finding = evaluateFinding({
      changed: ['.agents/skills/feature/SKILL.md', '.github/workflows/ci.yml'],
      ledgerLinesAdded: 0,
    });
    expect(finding).toContain('2 governance file(s)');
    expect(finding).not.toContain('production file');
  });

  it('passes either trigger once the ledger gains a line', () => {
    expect(evaluateFinding({
      changed: ['src/lib/solicitation/dispatch.ts', 'lefthook.yml'],
      ledgerLinesAdded: 1,
    })).toBeNull();
  });

  it('names both triggers when both fire', () => {
    const finding = evaluateFinding({
      changed: ['worker/index.ts', 'package.json'],
      ledgerLinesAdded: 0,
    });
    expect(finding).toContain('production file(s)');
    expect(finding).toContain('governance file(s)');
  });

  it('caps the sample so the message stays readable', () => {
    const finding = evaluateFinding({
      changed: ['a', 'b', 'c', 'd', 'e'].map((n) => `src/lib/${n}.ts`),
      ledgerLinesAdded: 0,
    });
    expect(finding).toContain('(+2 more)');
  });

  // Touching the ledger is not the same as recording in it: a diff that only
  // DELETES from the log has left no trace of this merge.
  it('does not accept a deletion-only ledger diff', () => {
    expect(evaluateFinding({
      changed: ['src/lib/solicitation/dispatch.ts', LEDGER_PATH],
      ledgerLinesAdded: 0,
    })).not.toBeNull();
  });
});

describe('git plumbing', () => {
  it('reads the added count from numstat', () => {
    expect(parseAddedLines('12\t3\t.claude/reference/arch-review-log.md')).toBe(12);
    expect(parseAddedLines('')).toBe(0);
  });

  // git writes `-` for a binary file. NaN must never read as "a line was added".
  it('reads a binary marker as zero', () => {
    expect(parseAddedLines('-\t-\tsome.png')).toBe(0);
  });

  it('resolves the base ref from the PR base branch', () => {
    expect(baseRefFor('main')).toBe('origin/main');
    expect(baseRefFor('staging')).toBe('origin/staging');
    expect(baseRefFor(undefined)).toBe('origin/main');
  });
});

describe('classifyDiff', () => {
  it('reports a path that is both production and governance in both sets', () => {
    // `scripts/ci/**` is governance; it is not under a production root, so the
    // two sets are disjoint here — but the classifier must never drop a path.
    const { production, governance } = classifyDiff([
      'src/lib/a.ts',
      'scripts/ci/b.ts',
      'docs/c.md',
    ]);
    expect(production).toEqual(['src/lib/a.ts']);
    expect(governance).toEqual(['scripts/ci/b.ts']);
  });
});

// `main()` is a straight line through these four: resolve, read, judge, report.
// Every branch that decides an exit code lives here, so the git shell carries
// none of them.
describe('the reports', () => {
  // A gate that cannot see the diff must never pass QUIETLY in CI — that is the
  // "it did not run" shape this whole audit exists to end.
  it('fails an unresolvable base ref in CI and names the checkout fix', () => {
    const report = unresolvedBaseReport('origin/main', true);
    expect(report.exitCode).toBe(1);
    expect(report.text).toContain('cannot resolve origin/main');
    expect(report.text).toContain('fetch-depth: 0');
  });

  // Locally the same state is a fresh clone, not a violation.
  it('skips an unresolvable base ref outside CI', () => {
    const report = unresolvedBaseReport('origin/main', false);
    expect(report.exitCode).toBe(0);
    expect(report.text).toContain('skipped');
    expect(report.text).toContain('git fetch origin');
  });

  it('reports a violation with the finding, the remedy and the reason', () => {
    const report = violationReport('this PR changes 1 production file(s): src/a.ts, and adds no line');
    expect(report.exitCode).toBe(1);
    expect(report.text).toContain('merge-ledger-audit: failed');
    expect(report.text).toContain('src/a.ts');
    expect(report.text).toContain(`Add one line to ${LEDGER_PATH}`);
    // The counter is the pass's judgement, never this audit's.
    expect(report.text).toContain("counter number is NOT this audit's business");
  });

  it('names the untriggered arm when neither trigger fired', () => {
    const report = passReport({
      changedCount: 2,
      classification: { production: [], governance: [] },
      ledgerLinesAdded: 0,
    });
    expect(report.exitCode).toBe(0);
    expect(report.text).toContain('2 changed file(s)');
    expect(report.text).toContain('no production or governance trigger');
  });

  it('names both counts and the ledger lines when a trigger fired', () => {
    const report = passReport({
      changedCount: 3,
      classification: { production: ['src/a.ts'], governance: ['lefthook.yml'] },
      ledgerLinesAdded: 4,
    });
    expect(report.exitCode).toBe(0);
    expect(report.text).toContain('1 production + 1 governance file(s)');
    expect(report.text).toContain('4 line(s) added');
  });
});
