// scripts/agent-rules.ts
//
// Resolves which path-scoped rules (`.claude/rules/*.md`) govern a set of
// files. Claude Code loads a rule on its own when it reads a file matching the
// rule's `paths:` frontmatter; Codex does not (nested instruction files load
// only along the root→cwd path, and a root launch loads none), so AGENTS.md
// tells Codex to run this before editing and read every file it lists.
//
//   pnpm agent:rules <path> [<path>…]
//
// Prints the matching rule files (repo-relative, one per line, deduped) or the
// single word `none`. Rules are ordered by the first input path they govern —
// the rules for the file you named first come first — and alphabetically
// within one path. Paths may be absolute or repo-relative;
// both are normalised against the git root. `scripts/ci/agent-config-audit.ts`
// imports the same matcher to validate the rules directory, so the CLI and the
// CI gate cannot disagree about what a glob means.
//
// Glob semantics (deliberately NOT the edit-surface guards' bash `[[ == ]]`
// reading, where `*` crosses `/` — a rule glob like
// `worker/jobs/solicitation-*/**` must NOT match `worker/jobs/solicitation-send.ts`):
//   `**`   any depth, including `/` (`**/` also matches zero directories)
//   `*`    within one path segment
//   `?`    one character, never `/`
//   `{a,b}` alternation (an unmatched `{` is literal, never a RegExp error)
//   `[` `]` literal, so a Next.js dynamic segment (`[id]`) is written plainly
//   everything else literal — `(public)` route groups need no escaping
// Patterns are anchored to the whole repo-relative path.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RULES_DIR = '.claude/rules';

export interface RuleFrontmatter {
  paths: string[];
}

export interface Rule {
  /** Repo-relative rule file path, e.g. `.claude/rules/solicitation.md`. */
  file: string;
  /** `null` when the file has no `---` frontmatter block at all. */
  frontmatter: RuleFrontmatter | null;
  body: string;
}

const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const LIST_ITEM = /^\s*-\s*(.+?)\s*$/;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/;

function unquote(value: string): string {
  const match = value.match(/^(["'])(.*)\1$/);
  return match?.[2] ?? value;
}

/**
 * Reads the `paths:` list out of a rule file's YAML frontmatter. Only the
 * fixed shape from the rules contract is understood (a `paths:` key followed
 * by `- "glob"` items); anything else in the block is ignored. Returns `null`
 * when there is no frontmatter block, and `{ paths: [] }` when the block has
 * no `paths:` key or an empty list — the audit treats both as failures.
 */
export function parseRuleFrontmatter(text: string): RuleFrontmatter | null {
  const match = text.replace(/\r\n/g, '\n').match(FRONTMATTER_BLOCK);
  if (!match) return null;
  const lines = (match[1] ?? '').split('\n');
  const start = lines.findIndex((line) => /^paths:\s*$/.test(line));
  if (start === -1) return { paths: [] };
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(LIST_ITEM);
    if (!item) break;
    const value = unquote(item[1] ?? '');
    if (value.length > 0) paths.push(value);
  }
  return { paths };
}

function escapeLiteral(char: string): string {
  return REGEXP_SPECIAL.test(char) ? `\\${char}` : char;
}

/** Compiles one rule glob to an anchored RegExp (semantics in the header). */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? '';
    if (char === '*' && glob[i + 1] === '*') {
      const trailingSlash = glob[i + 2] === '/';
      pattern += trailingSlash ? '(?:.*/)?' : '.*';
      i += trailingSlash ? 2 : 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char === '{' && glob.indexOf('}', i) !== -1) {
      braceDepth += 1;
      pattern += '(?:';
    } else if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      pattern += ')';
    } else if (char === ',' && braceDepth > 0) {
      pattern += '|';
    } else {
      pattern += escapeLiteral(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/**
 * Loads every `*.md` under `rulesDir` (absolute, or relative to `repoRoot`),
 * sorted by name. Rule `file` paths come back repo-relative so the CLI and the
 * audit print the same spelling regardless of how the directory was named.
 */
export function loadRules(rulesDir: string, repoRoot: string): Rule[] {
  const absoluteDir = resolve(repoRoot, rulesDir);
  return readdirSync(absoluteDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const absolute = resolve(absoluteDir, name);
      const body = readFileSync(absolute, 'utf8');
      return {
        file: toPosix(relative(repoRoot, absolute)),
        frontmatter: parseRuleFrontmatter(body),
        body,
      };
    });
}

/**
 * Maps each rule that governs at least one of `files` (repo-relative) to the
 * files it matched. Keys are in rule-file name order; rules matching nothing
 * are absent, so `size === 0` is the CLI's `none`.
 */
export function matchRules(
  rulesDir: string,
  files: string[],
  repoRoot: string,
): Map<string, string[]> {
  const matches = new Map<string, string[]>();
  for (const rule of loadRules(rulesDir, repoRoot)) {
    const patterns = (rule.frontmatter?.paths ?? []).map(globToRegExp);
    const matched = files.filter((file) => patterns.some((pattern) => pattern.test(file)));
    if (matched.length > 0) matches.set(rule.file, matched);
  }
  return matches;
}

function gitRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Outside a checkout (or git missing): the script's own location is the
    // repo root, exactly as the ci/*-audit scripts derive it.
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
  }
}

/** Absolute → repo-relative; repo-relative → cleaned (`./a//b` → `a/b`). */
export function normaliseInputPath(input: string, repoRoot: string): string {
  const absolute = isAbsolute(input) ? input : resolve(repoRoot, input);
  return toPosix(relative(repoRoot, absolute));
}

/** Rule files ordered by the first of `files` each governs, deduped. */
export function orderByFirstInput(matched: Map<string, string[]>, files: string[]): string[] {
  const ordered: string[] = [];
  for (const file of files) {
    for (const [rule, ruleFiles] of matched) {
      if (ruleFiles.includes(file) && !ordered.includes(rule)) ordered.push(rule);
    }
  }
  return ordered;
}

function main(argv: string[]): number {
  if (argv.length === 0) {
    console.error('usage: pnpm agent:rules <path> [<path>…]');
    return 2;
  }
  const root = gitRoot();
  const files = [...new Set(argv.map((path) => normaliseInputPath(path, root)))];
  const ordered = orderByFirstInput(matchRules(RULES_DIR, files, root), files);
  console.log(ordered.length === 0 ? 'none' : ordered.join('\n'));
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
