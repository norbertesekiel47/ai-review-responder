import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * #679 T5 — the admin runbook's A5 scenario ("My reviews aren't being picked
 * up") is the ops-facing half of the fail-closed Import consent gate.
 *
 * Today A5 tells ops to re-enqueue a `zernio_initial_backfill` outbox row
 * whenever the first-connect backfill never completed. Once the worker gate
 * ships, that instruction is wrong for every business whose Import consent is
 * not `accepted`: the hand-inserted row no-op-completes, ops sees nothing
 * happen, and the only signal is a log line they were never told to look for.
 * Worse, it reads as a way around a customer's declined decision.
 *
 * Asserted as source text, beside the page, following
 * `src/app/admin/__tests__/page-chrome.test.ts`: the scenario table is static
 * prose data with no behaviour to exercise, so the file IS the artifact under
 * test.
 */
const RUNBOOK_PAGE = 'src/app/admin/runbook/page.tsx';

/**
 * The `SCENARIOS` array literal, and nothing else in the file.
 *
 * The outer bound is the whole point (round-1 review). A5 is the LAST entry, so
 * a slice that ran "to the next scenario, else to the end" ran to the end of the
 * FILE — every assertion below was then a whole-file-tail scan that would have
 * survived A5's text being deleted outright, as long as the same strings turned
 * up anywhere in the page component beneath it.
 */
function scenariosArray(source: string): string {
  const open = source.indexOf('const SCENARIOS: Scenario[] = [');
  expect(open, `SCENARIOS is missing from ${RUNBOOK_PAGE}`).toBeGreaterThan(-1);
  const close = source.indexOf('\n];', open);
  expect(close, `SCENARIOS is unterminated in ${RUNBOOK_PAGE}`).toBeGreaterThan(open);
  return source.slice(open, close);
}

/**
 * The one scenario object, from its `id:` to the next scenario's — or, for the
 * last entry, to the end of the SCENARIOS array (never the end of the file).
 */
function scenarioBlock(source: string, id: string): string {
  const scenarios = scenariosArray(source);
  const start = scenarios.indexOf(`id: '${id}'`);
  expect(start, `scenario ${id} is missing from ${RUNBOOK_PAGE}`).toBeGreaterThan(-1);
  const rest = scenarios.slice(start + `id: '${id}'`.length);
  const next = rest.search(/id: 'A\d+'/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The `fix:` half of a scenario — the instruction ops actually follows. */
function fixText(block: string): string {
  const start = block.indexOf('fix:');
  expect(start, 'scenario has no fix: entry').toBeGreaterThan(-1);
  return block.slice(start);
}

describe('admin runbook A5 reflects the Import consent gate', () => {
  it('runbook A5 conditions the backfill re-enqueue instruction on accepted import consent', () => {
    const block = scenarioBlock(readFileSync(RUNBOOK_PAGE, 'utf8'), 'A5');

    // firstCheck must let ops tell a consent block from an outage. Without the
    // two consent columns, "the import never ran" and "the worker is down" look
    // identical from the admin surface.
    expect(block).toContain('import_decision');
    expect(block).toContain('import_offer_expires_at');

    const fix = fixText(block);
    // The instruction survives — it is still the right move for an accepted
    // business whose run never completed (spec §5.1 keeps that retryable).
    expect(fix).toContain('re-enqueue');
    expect(fix).toContain('zernio_initial_backfill');
    // …but it is now CONDITIONAL on both halves.
    expect(fix).toContain('import_decision');
    expect(fix).toContain("'accepted'");
    expect(fix).toContain('completed_at');
    // And D8's permanence is stated, admin path included: a declined or expired
    // decision is not something the admin re-enqueue can route around.
    const lowered = fix.toLowerCase();
    expect(lowered).toContain('declined');
    expect(lowered).toContain('expired');
    expect(lowered).toContain('permanent');
    expect(lowered).toContain('admin');
  });
});
