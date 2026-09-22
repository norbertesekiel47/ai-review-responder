import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The reference layer is split so that every page a CLAUDE.md pointer lands
// on fits in one read (2026-09-05 restructure, docs/agents/context-layout.md).
// Before the split the files were 40k–140k tokens each (lab-notes 579 KB,
// directory.md 417 KB, CONTEXT.md 155 KB) and an agent told to "read the
// matching file" read a slice and missed the entry it needed.
//
// This test keeps that shape. Two kinds of guard:
//   1. word caps per set — the table in context-layout.md § "Size caps",
//      counted the way `wc -w` counts (ASCII whitespace), so the number here
//      is the number the gate tooling prints;
//   2. structure — a rule file starts with `paths:` frontmatter (or Claude
//      never loads it), a bold term is defined in exactly one context file
//      (one owner per fact), and every index links every page it indexes
//      (an unlinked page is unreachable from the routing table).
//
// A guard TEST rather than a `ci:*` script for the same reason as
// claude-md-shape.test.ts: removing it is a visible deletion, not a silently
// unwired audit. Every glob is asserted non-empty first — a glob that matches
// zero files would make its cap test vacuously green.

const ROOT = resolve(process.cwd());

/** Word count as `wc -w` counts it — ASCII whitespace only, matching the gate tooling. */
function words(text: string): number {
  return text.split(/[ \t\n\r\f\v]+/).filter(Boolean).length;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

/** Every `*.md` directly inside `dir`, as repo-relative paths, sorted. */
function mdFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** Lines of one `## ` section of `text` (heading excluded), or [] if absent. */
function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${title}`));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

const LAB_NOTES = '.claude/reference/lab-notes';
const LAB_NOTES_HISTORY = `${LAB_NOTES}/history`;
const RULES = '.claude/rules';
const CONTEXT = 'docs/context';
const DIRECTORY = 'docs/directory';
const CONTEXT_MAP = 'CONTEXT-MAP.md';
const DIRECTORY_INDEX = 'docs/directory.md';
const LAB_NOTES_README = `${LAB_NOTES}/README.md`;
const LAYOUT = 'docs/agents/context-layout.md';

const labNoteTopics = mdFiles(LAB_NOTES).filter((file) => file !== LAB_NOTES_README);
const labNoteHistory = mdFiles(LAB_NOTES_HISTORY);
const ruleFiles = mdFiles(RULES);
const contextFiles = mdFiles(CONTEXT);
const directoryPages = mdFiles(DIRECTORY);

interface CapSet {
  readonly set: string;
  readonly cap: number;
  readonly files: readonly string[];
  /** Where the overflow goes — named in the failure so the fix is not a rewrite. */
  readonly home: string;
}

/** Size caps agreed in the 2026-09-05 restructure (context-layout.md § "Size caps"). */
const CAP_SETS: readonly CapSet[] = [
  {
    set: '.claude/reference/lab-notes/*.md (topic pages + README)',
    cap: 3000,
    files: [...labNoteTopics, LAB_NOTES_README],
    home: 'split the page, or move dated entries verbatim to lab-notes/history/<range>.md and leave a History pointer',
  },
  {
    set: '.claude/reference/lab-notes/history/*.md',
    cap: 15000,
    files: labNoteHistory,
    home: 'start a new history file named by date range and add its row to lab-notes/README.md',
  },
  {
    set: 'docs/directory.md + docs/directory/*.md',
    cap: 3000,
    files: [DIRECTORY_INDEX, ...directoryPages],
    home: 'split the page at a table boundary and record the move in the docs/directory.md Pages table',
  },
  {
    set: 'CONTEXT-MAP.md',
    cap: 1500,
    files: [CONTEXT_MAP],
    home: 'the map lists contexts and term names only — move any definition to its docs/context/<context>.md',
  },
  {
    set: 'docs/context/*.md',
    cap: 3000,
    files: contextFiles,
    home: 'split the context into parts (one file each) and add the rows to CONTEXT-MAP.md',
  },
  {
    set: 'docs/currents.md',
    cap: 12000,
    files: ['docs/currents.md'],
    home: 'archive the oldest sections verbatim to a new docs/progress-archive/ file and list it in the header',
  },
  {
    set: 'docs/progresstracking.md',
    cap: 12000,
    files: ['docs/progresstracking.md'],
    home: 'archive the oldest sections verbatim to a new docs/progress-archive/ file and list it in the header',
  },
  {
    set: '.claude/rules/*.md',
    cap: 800,
    files: ruleFiles,
    home: 'keep Read first + Traps + Rules; move the WHY to the referenced page',
  },
  {
    set: 'docs/agents/context-layout.md',
    cap: 1200,
    files: [LAYOUT],
    home: 'trim; the WHY belongs on the page the layer points at',
  },
];

/** Tuples rather than objects so `%s` prints the full path in the test title. */
const capSetRows = CAP_SETS.map((set) => [set.set, set.files] as const);
const cappedFiles = CAP_SETS.flatMap(({ cap, files, home }) => files.map((file) => [file, cap, home] as const));

describe('reference-layer shape (2026-09-05 restructure)', () => {
  describe('word caps', () => {
    it.each(capSetRows)('set "%s" matches at least one file that exists', (_set, files) => {
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(existsSync(join(ROOT, file)), `${file} is missing`).toBe(true);
    });

    it.each(cappedFiles)('%s is ≤ %i words', (file, cap, home) => {
      const n = words(read(file));
      expect(n, `${file} is ${n} words > ${cap} — ${home}`).toBeLessThanOrEqual(cap);
    });
  });

  describe('path-scoped rules', () => {
    it.each(ruleFiles)('%s starts with `---\\npaths:` frontmatter and closes it', (file) => {
      const lines = read(file).split('\n');
      expect(lines[0], `${file} must start with a frontmatter fence`).toBe('---');
      expect(lines[1], `${file} frontmatter must start with paths:`).toBe('paths:');
      expect(
        lines.slice(2).some((line) => line === '---'),
        `${file} frontmatter has no closing --- fence`,
      ).toBe(true);
    });
  });

  describe('domain glossary', () => {
    const TERM_LINE = /^- \*\*([^*]+)\*\*/;
    const ownersByTerm = new Map<string, string[]>();
    for (const file of contextFiles) {
      for (const line of read(file).split('\n')) {
        const term = TERM_LINE.exec(line)?.[1]?.trim();
        if (!term) continue;
        ownersByTerm.set(term, [...(ownersByTerm.get(term) ?? []), file]);
      }
    }

    it('finds bold term definitions', () => {
      expect(ownersByTerm.size).toBeGreaterThan(50);
    });

    it.each(contextFiles)('every `- **Term**` in %s is unique across docs/context/', (file) => {
      const shared = [...ownersByTerm.entries()]
        .filter(([, owners]) => owners.includes(file) && new Set(owners).size > 1)
        .map(([term, owners]) => `**${term}** also in ${owners.filter((owner) => owner !== file).join(', ')}`);
      expect(shared, `${file} defines a term another context file also defines — one owner per fact`).toEqual([]);
    });

    it.each(contextFiles)('CONTEXT-MAP.md links %s', (file) => {
      expect(read(CONTEXT_MAP), `${CONTEXT_MAP} does not link ${file}`).toContain(`${CONTEXT}/${basename(file)}`);
    });
  });

  describe('directory map', () => {
    it.each(directoryPages)('the docs/directory.md Pages table links %s', (file) => {
      const pages = section(read(DIRECTORY_INDEX), 'Pages').join('\n');
      expect(pages.length, `${DIRECTORY_INDEX} has no "## Pages" section`).toBeGreaterThan(0);
      expect(pages, `${DIRECTORY_INDEX} § Pages does not link ${file}`).toContain(`directory/${basename(file)}`);
    });
  });

  describe('lab notes', () => {
    it.each(labNoteTopics)('lab-notes/README.md links topic page %s', (file) => {
      expect(read(LAB_NOTES_README), `${LAB_NOTES_README} does not link ${file}`).toContain(`](${basename(file)})`);
    });

    it.each(labNoteHistory)('lab-notes/README.md links history file %s', (file) => {
      expect(read(LAB_NOTES_README), `${LAB_NOTES_README} does not link ${file}`).toContain(
        `](history/${basename(file)})`,
      );
    });
  });
  // `.claude/reference/arch-review-log.md` is the governance record that
  // `ci:merge-ledger` asks every triggering merge to add a row to. That audit
  // checks a line was ADDED, not that it renders: ten rows (2026-08-30 to
  // 2026-09-19) carried an unescaped `|` inside a code span, or had only three
  // cells, and a Markdown renderer dropped everything past the fourth cell —
  // invisible to CI and to anyone reading the rendered view (#1408). GFM splits
  // a row on every unescaped pipe, code spans included, so a pipe in a cell's
  // prose is written `\|`. Leading and trailing pipes are the file's convention.
  describe('arch review log', () => {
    const ARCH_LOG = '.claude/reference/arch-review-log.md';
    const UNESCAPED_PIPE = /(?<!\\)\|/;
    const DELIMITER_ROW = /^\|\s*:?-+/;

    /** Cells in a `| a | b |` row, splitting on unescaped pipes only. */
    function cellCount(row: string): number {
      return row.split(UNESCAPED_PIPE).length - 2;
    }

    interface Table {
      readonly headerLine: number;
      readonly columns: number;
      readonly rows: readonly (readonly [line: number, row: string])[];
    }

    /** Every GFM table in `text`: a header row, a delimiter row, then contiguous `|` rows. */
    function tables(text: string): Table[] {
      const lines = text.split('\n');
      const found: Table[] = [];
      for (let i = 0; i + 1 < lines.length; i += 1) {
        const header = lines[i] ?? '';
        if (!header.startsWith('|') || !DELIMITER_ROW.test(lines[i + 1] ?? '')) continue;
        const rows: (readonly [number, string])[] = [];
        let j = i + 2;
        for (; j < lines.length; j += 1) {
          const row = lines[j] ?? '';
          if (!row.startsWith('|')) break;
          rows.push([j + 1, row]);
        }
        found.push({ headerLine: i + 1, columns: cellCount(header), rows });
        i = j - 1;
      }
      return found;
    }

    const archTables = tables(read(ARCH_LOG)).map((table) => [table.headerLine, table] as const);

    it('finds at least one table with rows', () => {
      expect(archTables.length).toBeGreaterThan(0);
      expect(archTables.some(([, table]) => table.rows.length > 0)).toBe(true);
    });

    it.each(archTables)('every row of the table headed at line %i has the header\'s cell count', (_line, table) => {
      const misfits = table.rows
        .filter(([, row]) => cellCount(row) !== table.columns)
        .map(([line, row]) => `line ${line}: ${cellCount(row)} cells, header has ${table.columns} — a pipe in prose is written \\|, and every row fills every column`);
      expect(misfits).toEqual([]);
    });
  });
});
