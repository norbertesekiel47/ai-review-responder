import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  globToRegExp,
  loadRules,
  matchRules,
  normaliseInputPath,
  orderByFirstInput,
  parseRuleFrontmatter,
  RULES_DIR,
} from '../../agent-rules';

// The rule-glob semantics are deliberately NOT the edit-surface guards' bash
// `[[ == ]]` reading (where `*` crosses `/`): `worker/jobs/solicitation-*/**`
// must govern `worker/jobs/solicitation-batch/x.ts` and NOT
// `worker/jobs/solicitation-send.ts`, which has its own explicit entry. This
// table is the contract `pnpm agent:rules` and `ci:agent-config` share.

const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

describe('globToRegExp', () => {
  it('`**` matches any depth including `/`, and `**/` also matches zero directories', () => {
    expect(matches('worker/**', 'worker/jobs/judge/failed-hook.ts')).toBe(true);
    expect(matches('worker/**', 'worker/index.ts')).toBe(true);
    expect(matches('**/*.integration.test.ts', 'a.integration.test.ts')).toBe(true);
    expect(
      matches('**/*.integration.test.ts', 'worker/jobs/publisher/__tests__/x.integration.test.ts'),
    ).toBe(true);
    expect(matches('**/*.integration.test.ts', 'worker/jobs/publisher/__tests__/x.test.ts')).toBe(
      false,
    );
  });

  it('`*` stays within one path segment', () => {
    expect(matches('worker/jobs/solicitation-*/**', 'worker/jobs/solicitation-batch/x.ts')).toBe(
      true,
    );
    expect(matches('worker/jobs/solicitation-*/**', 'worker/jobs/solicitation-send.ts')).toBe(false);
    expect(matches('src/instrumentation*.ts', 'src/instrumentation.ts')).toBe(true);
    expect(matches('src/instrumentation*.ts', 'src/instrumentation-client.ts')).toBe(true);
    expect(matches('src/instrumentation*.ts', 'src/lib/instrumentation.ts')).toBe(false);
    expect(matches('vitest.config.*', 'vitest.config.ts')).toBe(true);
  });

  it('`?` matches exactly one character and never `/`', () => {
    expect(matches('worker/env?.ts', 'worker/env2.ts')).toBe(true);
    expect(matches('worker/env?.ts', 'worker/env.ts')).toBe(false);
    expect(matches('worker/env?.ts', 'worker/env/.ts')).toBe(false);
  });

  it('`{a,b}` is alternation', () => {
    expect(matches('worker/ingress/{stripe,resend}.ts', 'worker/ingress/stripe.ts')).toBe(true);
    expect(matches('worker/ingress/{stripe,resend}.ts', 'worker/ingress/resend.ts')).toBe(true);
    expect(matches('worker/ingress/{stripe,resend}.ts', 'worker/ingress/shared.ts')).toBe(false);
    expect(matches('src/lib/{a,b}/**', 'src/lib/b/deep/x.ts')).toBe(true);
    expect(matches('src/lib/{a/**', 'src/lib/{a/x.ts')).toBe(true);
  });

  it('`[` and `]` are literal so a Next.js dynamic segment is written plainly', () => {
    expect(matches('src/app/api/u/[token]/route.ts', 'src/app/api/u/[token]/route.ts')).toBe(true);
    expect(matches('src/app/api/u/[token]/route.ts', 'src/app/api/u/t/route.ts')).toBe(false);
    expect(matches('src/app/api/u/**', 'src/app/api/u/[token]/route.ts')).toBe(true);
  });

  it('parentheses and dots are literal (route groups, extensions)', () => {
    expect(matches('src/app/(public)/**', 'src/app/(public)/login/page.tsx')).toBe(true);
    expect(matches('src/app/(public)/**', 'src/app/public/login/page.tsx')).toBe(false);
    expect(matches('lefthook.yml', 'lefthook.yml')).toBe(true);
    expect(matches('lefthook.yml', 'lefthookxyml')).toBe(false);
  });

  it('is anchored to the whole repo-relative path', () => {
    expect(matches('src/lib/admin/**', 'x/src/lib/admin/a.ts')).toBe(false);
    expect(matches('worker/**', 'worker.ts')).toBe(false);
    expect(matches('package.json', 'e2e/package.json')).toBe(false);
    expect(matches('package.json', 'package.json.bak')).toBe(false);
  });
});

describe('parseRuleFrontmatter', () => {
  it('reads quoted and bare list items from the paths: key', () => {
    expect(
      parseRuleFrontmatter('---\npaths:\n  - "src/lib/x/**"\n  - worker/y.ts\n---\n# Rule\n'),
    ).toEqual({ paths: ['src/lib/x/**', 'worker/y.ts'] });
  });

  it('returns null without a frontmatter block and [] without a paths key', () => {
    expect(parseRuleFrontmatter('# Rule\nno frontmatter\n')).toBeNull();
    expect(parseRuleFrontmatter('paths:\n  - "x"\n')).toBeNull();
    expect(parseRuleFrontmatter('---\nname: x\n---\n# Rule\n')).toEqual({ paths: [] });
    expect(parseRuleFrontmatter('---\npaths:\n---\n# Rule\n')).toEqual({ paths: [] });
  });

  it('stops the list at the first non-item line and tolerates CRLF', () => {
    expect(
      parseRuleFrontmatter('---\r\npaths:\r\n  - "a/**"\r\nother: 1\r\n  - "b/**"\r\n---\r\n'),
    ).toEqual({ paths: ['a/**'] });
  });
});

describe('matchRules / loadRules', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-rules-'));
  const rulesDir = join(root, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, 'b-worker.md'), '---\npaths:\n  - "worker/**"\n---\n# Worker\n');
  writeFileSync(
    join(rulesDir, 'a-solicitation.md'),
    '---\npaths:\n  - "src/lib/solicitation/**"\n  - "worker/jobs/solicitation-*/**"\n---\n# S\n',
  );
  writeFileSync(join(rulesDir, 'c-broken.md'), '# no frontmatter\n');
  writeFileSync(join(rulesDir, 'notes.txt'), 'ignored: not a rule\n');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('loads only *.md, sorted, with repo-relative file paths and null for missing frontmatter', () => {
    const rules = loadRules('.claude/rules', root);
    expect(rules.map((rule) => rule.file)).toEqual([
      '.claude/rules/a-solicitation.md',
      '.claude/rules/b-worker.md',
      '.claude/rules/c-broken.md',
    ]);
    expect(rules[2]?.frontmatter).toBeNull();
  });

  it('maps each governing rule to the files it matched and omits non-matching rules', () => {
    const matched = matchRules('.claude/rules', ['worker/jobs/solicitation-batch/x.ts', 'README.md'], root);
    expect([...matched.entries()]).toEqual([
      ['.claude/rules/a-solicitation.md', ['worker/jobs/solicitation-batch/x.ts']],
      ['.claude/rules/b-worker.md', ['worker/jobs/solicitation-batch/x.ts']],
    ]);
    expect(matchRules('.claude/rules', ['README.md'], root).size).toBe(0);
  });

  it('orders CLI output by the first input path each rule governs, deduped', () => {
    const files = ['src/lib/solicitation/a.ts', 'worker/jobs/judge/x.ts'];
    const matched = new Map([
      ['.claude/rules/agentic.md', ['worker/jobs/judge/x.ts']],
      ['.claude/rules/solicitation.md', ['src/lib/solicitation/a.ts']],
      ['.claude/rules/worker.md', ['src/lib/solicitation/a.ts', 'worker/jobs/judge/x.ts']],
    ]);
    expect(orderByFirstInput(matched, files)).toEqual([
      '.claude/rules/solicitation.md',
      '.claude/rules/worker.md',
      '.claude/rules/agentic.md',
    ]);
    expect(orderByFirstInput(new Map(), files)).toEqual([]);
  });

  it('normalises absolute and repo-relative inputs to one repo-relative spelling', () => {
    expect(normaliseInputPath(join(root, 'src', 'lib', 'x.ts'), root)).toBe('src/lib/x.ts');
    expect(normaliseInputPath('./src//lib/x.ts', root)).toBe('src/lib/x.ts');
  });
});

describe('the real .claude/rules/ directory', () => {
  it('every rule declares at least one paths: glob', () => {
    const rules = loadRules(RULES_DIR, resolve(process.cwd()));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.frontmatter?.paths.length ?? 0, `${rule.file} has no paths`).toBeGreaterThan(0);
    }
  });
});
