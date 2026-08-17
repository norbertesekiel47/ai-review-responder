import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// CLAUDE.md is loaded on every turn of every agent session (Codex too —
// AGENTS.md defers to it). By 2026-08-16 it had grown to 7,114 words because
// two sections turned into mini-specs: five "Where things live" rows were
// 158–398 words each, and eight "Non-obvious gotchas" were 75–288 words. The
// trim that day moved the WHY out — file-adjacent rules to a blockquote in
// docs/directory.md § <folder>, LOCKED-term meanings to CONTEXT.md, gotcha
// mechanics to .claude/reference/lab-notes.md — and kept, per row, WHERE to
// read plus at most three one-clause traps; per gotcha, symptom → rule →
// pointer.
//
// This test keeps that shape. It is a guard TEST rather than a `ci:*` script
// on purpose (same reasoning as ci-audit-wiring.test.ts): removing it would be
// a visible deletion, not a silently unwired audit. Caps are structural, not
// aesthetic — a row over the cap is almost always the WHY creeping back in.
//
// Escape hatch, per row or bullet, when a rule genuinely needs more words:
//   <!-- claude-md-cap-ignore: <reason> -->
// placed on the same line. Same pattern as `-- outbox-seam-ignore`.

const ROOT = resolve(process.cwd());
const CLAUDE_MD = readFileSync(join(ROOT, '.claude', 'CLAUDE.md'), 'utf-8');

/** Structural caps agreed 2026-08-16 (grilling session, "Medium" trim). */
export const ROUTING_ROW_READ_CELL_MAX_WORDS = 80;
export const GOTCHA_BULLET_MAX_WORDS = 60;
/** Soft ceiling — ~7% above the 5,601 words the trim landed at; flags a trend, not an edit. */
export const TOTAL_MAX_WORDS = 6000;

const IGNORE = /<!--\s*claude-md-cap-ignore:\s*(?!-->)\S/;
const HOMES =
  'move the WHY out: file-adjacent rules → a blockquote in docs/directory.md § <folder>; ' +
  'LOCKED-term meanings → CONTEXT.md; mechanics → .claude/reference/lab-notes.md. ' +
  'Keep WHERE to read + ≤3 one-clause traps + the pointer. Escape hatch: <!-- claude-md-cap-ignore: reason -->';

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Lines of one `## ` section (heading excluded), or [] if absent. */
function section(title: string): string[] {
  const lines = CLAUDE_MD.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${title}`));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The "Read" cell (third cell) of every routing-table data row. */
function routingRows(): Array<{ label: string; readCell: string; ignored: boolean }> {
  return section('Where things live')
    .filter((line) => line.startsWith('| ') && !/^\|\s*-+\s*\|/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && cells[1] !== 'Before you…')
    .map((cells) => ({ label: cells[1]!.slice(0, 60), readCell: cells[2]!, ignored: IGNORE.test(cells[2]!) }));
}

/** Every top-level gotcha bullet with its continuation lines folded in. */
function gotchaBullets(): Array<{ label: string; text: string; ignored: boolean }> {
  const bullets: string[] = [];
  for (const line of section('Non-obvious gotchas')) {
    if (line.startsWith('- ')) bullets.push(line);
    else if (bullets.length > 0 && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  return bullets.map((text) => ({ label: text.slice(2, 62), text, ignored: IGNORE.test(text) }));
}

describe('CLAUDE.md shape (2026-08-16 trim)', () => {
  it('finds the two sections it guards', () => {
    expect(routingRows().length).toBeGreaterThan(15);
    expect(gotchaBullets().length).toBeGreaterThan(15);
  });

  it.each(routingRows())(
    `"Where things live" row is ≤ ${ROUTING_ROW_READ_CELL_MAX_WORDS} words in its Read cell — %s`,
    (row) => {
      if (row.ignored) return;
      const n = words(row.readCell);
      expect(n, `${n} words > ${ROUTING_ROW_READ_CELL_MAX_WORDS} — ${HOMES}`).toBeLessThanOrEqual(
        ROUTING_ROW_READ_CELL_MAX_WORDS,
      );
    },
  );

  it.each(gotchaBullets())(`gotcha bullet is ≤ ${GOTCHA_BULLET_MAX_WORDS} words — %s`, (bullet) => {
    if (bullet.ignored) return;
    const n = words(bullet.text);
    expect(n, `${n} words > ${GOTCHA_BULLET_MAX_WORDS} — ${HOMES}`).toBeLessThanOrEqual(GOTCHA_BULLET_MAX_WORDS);
  });

  it(`total is ≤ ${TOTAL_MAX_WORDS} words`, () => {
    const n = words(CLAUDE_MD);
    expect(n, `CLAUDE.md is ${n} words — ${HOMES}`).toBeLessThanOrEqual(TOTAL_MAX_WORDS);
  });

  it('honours the per-line escape hatch and ignores nothing without a reason', () => {
    expect(IGNORE.test('… <!-- claude-md-cap-ignore: migration exception is deliberately verbose -->')).toBe(true);
    expect(IGNORE.test('… <!-- claude-md-cap-ignore: -->')).toBe(false);
    expect(IGNORE.test('… <!-- claude-md-cap-ignore -->')).toBe(false);
  });
});
