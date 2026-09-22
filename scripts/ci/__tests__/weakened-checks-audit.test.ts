import { describe, expect, it } from 'vitest';

import {
  branchFor,
  evaluateDiff,
  exceptionKey,
  formatReport,
  isQualityConfig,
  parseRegistryKeys,
  REGISTRY_PATH,
  registryGaps,
  parseUnifiedDiff,
} from '../weakened-checks-audit';

// The audit reads THIS file's diff too, so a fixture must never spell a
// prohibited call literally — it would fail the PR that adds it. Every one is
// assembled here instead.
const call = (receiver: string, member: string): string => `${receiver}.${member}('case', () => {});`;
const ONLY = call('it', 'only');
const SKIP = call('describe', 'skip');
const TODO = call('test', 'todo');
const XIT = `${'x'}it('case', () => {});`;
const EXPECT = `${'exp'}ect(value).toBe(1);`;

const TEST_FILE = 'src/lib/billing/__tests__/quota.test.ts';

function diffFor(file: string, removed: string[], added: string[], deleted = false): string {
  return [
    `diff --git a/${file} b/${file}`,
    ...(deleted ? ['deleted file mode 100644'] : []),
    `--- a/${file}`,
    `+++ ${deleted ? '/dev/null' : `b/${file}`}`,
    '@@ -1,1 +1,1 @@',
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

const findingsFor = (diff: string) => evaluateDiff(parseUnifiedDiff(diff));

describe('parseUnifiedDiff', () => {
  it('attributes added and removed lines to their file', () => {
    const parsed = parseUnifiedDiff(diffFor(TEST_FILE, ['old'], ['new']));
    expect(parsed.added).toEqual([{ file: TEST_FILE, text: 'new' }]);
    expect(parsed.removed).toEqual([{ file: TEST_FILE, text: 'old' }]);
  });

  it('reads an added line that starts with ++ as content, not a header', () => {
    const parsed = parseUnifiedDiff(diffFor(TEST_FILE, [], ['++counter;']));
    expect(parsed.added).toEqual([{ file: TEST_FILE, text: '++counter;' }]);
  });

  it('records a deleted file', () => {
    expect(parseUnifiedDiff(diffFor(TEST_FILE, ['x'], [], true)).deletedFiles).toEqual([TEST_FILE]);
  });
});

describe('FAIL tier — prohibited relaxations', () => {
  it.each([
    ['focused-test', ONLY],
    ['disabled-test', SKIP],
    ['disabled-test', TODO],
    ['disabled-test', XIT],
  ])('fails %s', (rule, line) => {
    const [finding] = findingsFor(diffFor(TEST_FILE, [], [line]));
    expect(finding).toMatchObject({ tier: 'FAIL', rule, file: TEST_FILE });
    expect(formatReport([finding!]).exitCode).toBe(1);
  });

  it('does not fail a conditional skip, which is how live-DB suites gate', () => {
    expect(findingsFor(diffFor(TEST_FILE, [], ["describe.skipIf(!dbUrl)('suite', () => {});"]))).toEqual([]);
  });

  it('ignores the same text outside a test file', () => {
    expect(findingsFor(diffFor('src/lib/billing/quota.ts', [], [ONLY]))).toEqual([]);
  });

  it('ignores a REMOVED disabled test — that is the fix, not the offence', () => {
    expect(findingsFor(diffFor(TEST_FILE, [SKIP], ["it('case', () => {});"]))).toEqual([]);
  });

  it('turns a waived line into a REVIEW row that carries the reason', () => {
    const [finding] = findingsFor(diffFor(TEST_FILE, [], [`${SKIP} // weakened-check-ok: flaky upstream, #1400`]));
    expect(finding).toMatchObject({ tier: 'REVIEW', rule: 'disabled-test-waived', detail: 'flaky upstream, #1400' });
    expect(formatReport([finding!]).exitCode).toBe(0);
  });

  it('fails a lowered changed-line coverage floor', () => {
    const findings = findingsFor(diffFor(
      'scripts/diff-coverage.ts',
      ["const min = Number(process.env.DIFF_COVERAGE_MIN ?? '80');"],
      ["const min = Number(process.env.DIFF_COVERAGE_MIN ?? '60');"],
    ));
    expect(findings[0]).toMatchObject({ tier: 'FAIL', rule: 'coverage-floor-lowered', detail: '80 → 60' });
  });

  it('fails a new override below the default floor', () => {
    const findings = findingsFor(diffFor('lefthook.yml', [], ['      run: DIFF_COVERAGE_MIN=50 pnpm gate']));
    expect(findings[0]).toMatchObject({ tier: 'FAIL', rule: 'coverage-floor-lowered', detail: '80 → 50' });
  });

  it('reads a shell default as a floor', () => {
    const findings = findingsFor(diffFor('scripts/verify-gate.sh', [], ['MIN="${DIFF_COVERAGE_MIN:-70}"']));
    expect(findings[0]).toMatchObject({ tier: 'FAIL', rule: 'coverage-floor-lowered', detail: '80 → 70' });
  });

  it('does not read a bare mention, or a fixture in a test file, as a floor', () => {
    const mention = findingsFor(diffFor('scripts/diff-coverage.ts', [], ['// default $DIFF_COVERAGE_MIN or 80; was 60']));
    const fixture = findingsFor(diffFor(TEST_FILE, [], ["const line = 'DIFF_COVERAGE_MIN=10';"]));
    expect([...mention, ...fixture].filter((finding) => finding.tier === 'FAIL')).toEqual([]);
  });

  it('passes a RAISED floor', () => {
    const findings = findingsFor(diffFor(
      'scripts/diff-coverage.ts',
      ["const min = Number(process.env.DIFF_COVERAGE_MIN ?? '80');"],
      ["const min = Number(process.env.DIFF_COVERAGE_MIN ?? '85');"],
    ));
    expect(findings.filter((finding) => finding.tier === 'FAIL')).toEqual([]);
  });
});

describe('REVIEW tier — reported, never failed', () => {
  it('reports a test file that lost more assertions than it gained', () => {
    const findings = findingsFor(diffFor(TEST_FILE, [EXPECT, EXPECT], [EXPECT]));
    expect(findings).toEqual([
      { tier: 'REVIEW', rule: 'assertions-removed', file: TEST_FILE, detail: '-2 / +1 expect(' },
    ]);
    expect(formatReport(findings).exitCode).toBe(0);
  });

  it('stays silent when assertions are replaced one for one', () => {
    expect(findingsFor(diffFor(TEST_FILE, [EXPECT], [EXPECT]))).toEqual([]);
  });

  it('reports a deleted test file once, not also as lost assertions', () => {
    const findings = findingsFor(diffFor(TEST_FILE, [EXPECT], [], true));
    expect(findings.map((finding) => finding.rule)).toEqual(['test-file-deleted']);
  });

  it('reports a new suppression', () => {
    const line = `// ${'eslint'}-disable-next-line no-console`;
    const [finding] = findingsFor(diffFor('src/lib/billing/quota.ts', [], [line]));
    expect(finding).toMatchObject({ tier: 'REVIEW', rule: 'suppression-added' });
  });

  it.each([
    ["throw new Error('Not implemented');"],
    [`// ${'TO'}DO: handle the past_due grace window`],
    ['} catch (error) {}'],
  ])('reports unfinished work in production code: %s', (line) => {
    const [finding] = findingsFor(diffFor('src/lib/billing/quota.ts', [], [line]));
    expect(finding).toMatchObject({ tier: 'REVIEW', rule: 'unfinished-work' });
  });

  it('does not read a disabled-test call or a todo identifier as unfinished work', () => {
    const findings = findingsFor(diffFor('src/lib/billing/quota.ts', [], ['const todoList = items.filter(isOpen);']));
    expect(findings).toEqual([]);
  });

  it('does not read a suppression quoted in a skill or a doc as a suppression', () => {
    const line = `A new \`${'eslint'}-disable\` comment deserves suspicion.`;
    expect(findingsFor(diffFor('.claude/skills/x/SKILL.md', [], [line]))).toEqual([]);
  });

  it('does not read a note in a doc as unfinished work', () => {
    expect(findingsFor(diffFor('docs/roadmap/plan.md', [], [`- ${'TO'}DO: decide the tier`]))).toEqual([]);
  });

  it('reports a change to the quality configuration', () => {
    const [finding] = findingsFor(diffFor('.fallowrc.jsonc', ['"a": 1'], ['"a": 2']));
    expect(finding).toMatchObject({ tier: 'REVIEW', rule: 'quality-config-changed' });
  });

  it('treats every ci audit script as quality configuration', () => {
    expect(isQualityConfig('scripts/ci/tenant-scope-audit.ts')).toBe(true);
    expect(isQualityConfig('scripts/ci/__tests__/tenant-scope-audit.test.ts')).toBe(false);
    expect(isQualityConfig('src/lib/billing/quota.ts')).toBe(false);
  });
});

describe('formatReport', () => {
  it('lists FAIL rows before REVIEW rows', () => {
    const findings = findingsFor([
      diffFor('.fallowrc.jsonc', ['"a": 1'], ['"a": 2']),
      diffFor(TEST_FILE, [], [ONLY]),
    ].join('\n'));
    expect(findings.map((finding) => finding.tier)).toEqual(['FAIL', 'REVIEW']);
    expect(formatReport(findings).text).toContain('failed (1 prohibited relaxation(s))');
  });

  it('passes an empty diff', () => {
    expect(formatReport([])).toEqual({ text: 'weakened-checks-audit: passed (no finding)', exitCode: 0 });
  });
});

// #1386. The audit detected the reduction and assigned the explanation to a
// human; the explanation then landed in a per-branch review file nothing read.
// A REVIEW row now needs a row in the append-only registry carrying the same
// key, the way `ci:merge-ledger` needs a line in the arch log.
//
// Every fixture is registry markdown passed in as a STRING — this suite reads
// no repo document, which is what its entry in ci-audit-wiring.test.ts says.
describe('registry key (#1386)', () => {
  const BRANCH = 'fix/1386-verifier-exceptions-registry';
  const SLUG = 'fix-1386-verifier-exceptions-registry';

  it('replaces every / in the branch, so the key is one word in a Markdown cell', () => {
    expect(exceptionKey(BRANCH, 'quality-config-changed')).toBe(`${SLUG}::quality-config-changed`);
    expect(exceptionKey('codex/owner/operator-run-e', 'D11')).toBe('codex-owner-operator-run-e::D11');
  });

  it('leaves a branch that is already a slug alone', () => {
    expect(exceptionKey('feat-899-solicitation-send-worker', 'D10'))
      .toBe('feat-899-solicitation-send-worker::D10');
  });

  describe('branchFor', () => {
    it('prefers GITHUB_HEAD_REF — CI checks a PR out detached', () => {
      expect(branchFor(BRANCH, 'HEAD')).toBe(BRANCH);
    });

    it('falls back to the local branch', () => {
      expect(branchFor(undefined, `${BRANCH}\n`)).toBe(BRANCH);
      expect(branchFor('', BRANCH)).toBe(BRANCH);
    });

    it('returns null when neither names a branch', () => {
      expect(branchFor(undefined, 'HEAD')).toBeNull();
      expect(branchFor(undefined, '')).toBeNull();
      expect(branchFor('  ', '  ')).toBeNull();
    });
  });

  describe('parseRegistryKeys', () => {
    const REGISTRY = [
      '# Verifier exceptions registry',
      '',
      '| Cell | What goes in it |',
      '|---|---|',
      '| **Key** | `<branch>::<check>`, the branch with every / replaced by - |',
      '',
      '| Key | Date | PR | Check | Reason | Live? |',
      '|---|---|---|---|---|---|',
      `| \`${SLUG}::quality-config-changed\` | 2026-09-22 | #1386 | the audit itself | nothing relaxed | no |`,
      '| `refactor-616-fallow-complexity::D11` | 2026-09-19 | #1340 | reviewed transition | #1342 / #1343 | yes |',
    ].join('\n');

    it('reads the backticked first cell of every register row', () => {
      expect([...parseRegistryKeys(REGISTRY)].sort()).toEqual([
        `${SLUG}::quality-config-changed`,
        'refactor-616-fallow-complexity::D11',
      ]);
    });

    it('ignores the format table and prose — their first cells are not a backtick', () => {
      expect(parseRegistryKeys(REGISTRY).has('<branch>::<check>')).toBe(false);
      expect(parseRegistryKeys('A key looks like `feat-1::D1` in prose.').size).toBe(0);
    });

    it('reads a missing registry as no keys at all', () => {
      expect(parseRegistryKeys('').size).toBe(0);
    });
  });

  describe('registryGaps', () => {
    const reviewFindings = findingsFor(diffFor('.fallowrc.jsonc', ['"a": 1'], ['"a": 2']));

    it('finds no gap when the registry carries the key — this direction PASSES', () => {
      const keys = new Set([`${SLUG}::quality-config-changed`]);
      const gaps = registryGaps(reviewFindings, BRANCH, keys);
      expect(gaps).toEqual([]);
      expect(formatReport(reviewFindings, gaps).exitCode).toBe(0);
    });

    it('fails a REVIEW row the registry does not carry — this direction FAILS', () => {
      const gaps = registryGaps(reviewFindings, BRANCH, new Set());
      expect(gaps).toEqual([
        { key: `${SLUG}::quality-config-changed`, rule: 'quality-config-changed', files: ['.fallowrc.jsonc'] },
      ]);
      const report = formatReport(reviewFindings, gaps);
      expect(report.exitCode).toBe(1);
      expect(report.text).toContain('failed (1 REVIEW rule(s) with no registry entry)');
      expect(report.text).toContain(REGISTRY_PATH);
      expect(report.text).toContain(`${SLUG}::quality-config-changed`);
    });

    it('does not match a key minted for a different branch', () => {
      const keys = new Set(['feat-1-other::quality-config-changed']);
      expect(registryGaps(reviewFindings, BRANCH, keys)).toHaveLength(1);
    });

    it('a branch with no REVIEW rows passes unchanged', () => {
      expect(registryGaps([], BRANCH, new Set())).toEqual([]);
      expect(formatReport([], [])).toEqual({
        text: 'weakened-checks-audit: passed (no finding)',
        exitCode: 0,
      });
    });

    it('groups one rule across files into ONE key, listing each file once', () => {
      const findings = findingsFor([
        diffFor('.fallowrc.jsonc', ['"a": 1'], ['"a": 2']),
        diffFor('vitest.config.ts', ['const a = 1;'], ['const a = 2;']),
      ].join('\n'));
      const gaps = registryGaps(findings, BRANCH, new Set());
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ files: ['.fallowrc.jsonc', 'vitest.config.ts'] });
    });

    it('needs a key for a WAIVED fail too — a waiver is the thing most worth registering', () => {
      const findings = findingsFor(diffFor(TEST_FILE, [], [`${SKIP} // weakened-check-ok: flaky upstream, #1400`]));
      const gaps = registryGaps(findings, BRANCH, new Set());
      expect(gaps.map((gap) => gap.key)).toEqual([`${SLUG}::disabled-test-waived`]);
      expect(formatReport(findings, gaps).exitCode).toBe(1);
    });

    it('never asks a registry row for a FAIL — that is a revert, not an exception', () => {
      const findings = findingsFor(diffFor(TEST_FILE, [], [ONLY]));
      expect(registryGaps(findings, BRANCH, new Set())).toEqual([]);
    });

    it('keeps the prohibited-relaxation headline when a FAIL and a gap coincide', () => {
      const findings = findingsFor([
        diffFor('.fallowrc.jsonc', ['"a": 1'], ['"a": 2']),
        diffFor(TEST_FILE, [], [ONLY]),
      ].join('\n'));
      const report = formatReport(findings, registryGaps(findings, BRANCH, new Set()));
      expect(report.text).toContain('failed (1 prohibited relaxation(s))');
      expect(report.text).toContain('Fix the code, not the check.');
      expect(report.exitCode).toBe(1);
    });
  });
});
