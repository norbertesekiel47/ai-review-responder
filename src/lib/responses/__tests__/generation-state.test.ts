import { beforeEach, describe, expect, it } from 'vitest';
import { nextResponseVersion, pendingGenerateExists } from '../generation-state';

const rows: unknown[][] = [];
const calls: Array<{ text: string; values: unknown[] }> = [];
const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
  return Promise.resolve(rows.shift() ?? []);
}) as never;

describe('generation state', () => {
  beforeEach(() => {
    rows.length = 0;
    calls.length = 0;
  });

  it('detects only an in-flight generate_response row', async () => {
    rows.push([{ exists: 1 }], []);

    await expect(pendingGenerateExists(db, 'review-1')).resolves.toBe(true);
    await expect(pendingGenerateExists(db, 'review-2')).resolves.toBe(false);
    expect(calls[0]?.text).toContain("status IN ('pending', 'dispatching', 'dispatched')");
    expect(calls[0]?.values).toContain('generate_response');
  });

  it('allocates MAX(version)+1 for the review and falls back to one', async () => {
    rows.push([{ next_version: 7 }], []);

    await expect(nextResponseVersion(db, 'review-1')).resolves.toBe(7);
    await expect(nextResponseVersion(db, 'review-2')).resolves.toBe(1);
    expect(calls[0]?.text).toContain('SELECT COALESCE(MAX(version), 0) + 1 AS next_version');
    expect(calls[0]?.text).toContain('WHERE review_id = ?::uuid');
  });
});
