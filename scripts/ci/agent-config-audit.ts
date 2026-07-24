import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT_SKILLS = [
  'approval-security',
  'cost-guard',
  'doctor-explain',
  'document-feature',
  'feature',
  'feature-resume',
  'flag-flip',
  'new-migration',
  'onboarding-demo-cost-guard',
  'outbox-pattern',
  'react-doctor',
  'repworth-brand-design',
  'runbook',
  'verify-spec',
] as const;
const HOOK_SCRIPTS = [
  'bash-write-guard.sh',
  'edit-surface-guard.sh',
  'migration-immutability-guard.sh',
  'stop-gate.sh',
  'typecheck-on-stop.sh',
] as const;
const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description']);
const failures: string[] = [];

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function fail(message: string): void {
  failures.push(message);
}

function assertCodexConfig(): void {
  const config = read('.codex/config.toml');
  if (!/^\s*hooks\s*=\s*true\s*$/m.test(config)) {
    fail('.codex/config.toml must enable hooks.');
  }
  if (/^\s*approval_policy\s*=\s*["']never["']\s*$/m.test(config)) {
    fail('.codex/config.toml must not disable approval requests.');
  }
}

function extractHookCommands(value: unknown): string[] {
  const commands: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) commands.push(...extractHookCommands(item));
    return commands;
  }
  if (typeof value !== 'object' || value === null) return commands;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'command' && typeof child === 'string') commands.push(child);
    commands.push(...extractHookCommands(child));
  }
  return commands;
}

function assertHooks(): void {
  const hooks = JSON.parse(read('.codex/hooks.json')) as unknown;
  const commands = extractHookCommands(hooks);

  for (const script of HOOK_SCRIPTS) {
    const path = `.codex/hooks/${script}`;
    if (!existsSync(resolve(REPO_ROOT, path))) {
      fail(`Missing Codex hook: ${path}`);
      continue;
    }
    if (!commands.some((command) => command.includes(`/.codex/hooks/${script}`))) {
      fail(`${path} is not registered in .codex/hooks.json.`);
    }
    const syntax = spawnSync('bash', ['-n', path], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (syntax.status !== 0) {
      fail(`${path} has invalid Bash syntax: ${syntax.stderr.trim()}`);
    }
  }
}

function frontmatterFor(skillPath: string): string {
  const source = read(skillPath);
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    fail(`${skillPath} is missing YAML frontmatter.`);
    return '';
  }
  return match[1] ?? '';
}

function valueFor(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

function assertSkill(skill: string): void {
  const skillPath = `.agents/skills/${skill}/SKILL.md`;
  if (!existsSync(resolve(REPO_ROOT, skillPath))) {
    fail(`Missing project skill: ${skillPath}`);
    return;
  }

  const ignored = spawnSync('git', ['check-ignore', '-q', skillPath], {
    cwd: REPO_ROOT,
  });
  if (ignored.status === 0) {
    fail(`${skillPath} is ignored and would disappear from a clean checkout.`);
  }

  const source = read(skillPath);
  if (source.split('\n').length - 1 > 500) {
    fail(`${skillPath} exceeds the 500-line skill-authoring guideline.`);
  }
  if (source.includes('.codex/reference/')) {
    fail(`${skillPath} references the removed .codex/reference tree.`);
  }

  const frontmatter = frontmatterFor(skillPath);
  const keys = [...frontmatter.matchAll(/^([A-Za-z][A-Za-z0-9_-]*):/gm)].map(
    (match) => match[1] ?? '',
  );
  for (const key of keys) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      fail(`${skillPath} has unsupported frontmatter key '${key}'.`);
    }
  }
  if (valueFor(frontmatter, 'name')?.replace(/^["']|["']$/g, '') !== skill) {
    fail(`${skillPath} frontmatter name must be '${skill}'.`);
  }
  const description = valueFor(frontmatter, 'description');
  if (!description) {
    fail(`${skillPath} must have a non-empty description.`);
  } else if (description.length > 1_024) {
    fail(`${skillPath} description exceeds 1,024 characters.`);
  }

  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const target = (match[1] ?? '').split('#')[0] ?? '';
    if (!target || target.startsWith('http://') || target.startsWith('https://')) {
      continue;
    }
    const resolvedTarget = resolve(REPO_ROOT, dirname(skillPath), target);
    if (!existsSync(resolvedTarget)) {
      fail(`${skillPath} has a broken relative link: ${target}`);
    }
  }
}

function assertCanonicalReferences(): void {
  const staleReferenceDir = resolve(REPO_ROOT, '.codex/reference');
  if (existsSync(staleReferenceDir) && readdirSync(staleReferenceDir).length > 0) {
    fail('.codex/reference must not contain shadow copies of .claude/reference.');
  }
  const agents = read('AGENTS.md');
  if (agents.includes('no executable hook or MCP configuration was activated')) {
    fail('AGENTS.md still claims that Codex hooks are inactive.');
  }
  if (!agents.includes('.codex/HOOKS.md')) {
    fail('AGENTS.md must point to .codex/HOOKS.md.');
  }
  const ignored = spawnSync('git', ['check-ignore', '-q', 'AGENTS.md'], {
    cwd: REPO_ROOT,
  });
  if (ignored.status === 0) {
    fail('AGENTS.md is ignored and would disappear from a clean checkout.');
  }
}

function assertSkillLock(): void {
  const parsed = JSON.parse(read('skills-lock.json')) as {
    skills?: Record<string, unknown>;
  };
  const unexpected = Object.keys(parsed.skills ?? {}).filter(
    (name) => name !== 'supabase-postgres-best-practices',
  );
  if (unexpected.length > 0) {
    fail(`skills-lock.json contains unrelated project skills: ${unexpected.join(', ')}`);
  }
}

function main(): void {
  assertCodexConfig();
  assertHooks();
  for (const skill of PROJECT_SKILLS) assertSkill(skill);
  assertCanonicalReferences();
  assertSkillLock();

  if (failures.length > 0) {
    console.error(`agent-config-audit: FAILED (${failures.length} issue(s))`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `agent-config-audit: passed (${PROJECT_SKILLS.length} skills, ${HOOK_SCRIPTS.length} hooks).`,
  );
}

main();
