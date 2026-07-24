import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { getVoiceCorpusStatus, getApprovedResponsePairs } from '../voice-learning';
import { deriveVoiceReportCard } from '../voice-report-card';

interface CorpusRow { original_draft_text: string; edited_text: string; star_rating: number }

function fakeSql(rows: CorpusRow[]): Sql {
  return ((..._args: unknown[]) => Promise.resolve(rows)) as unknown as Sql;
}

function row(i: number, star = 5): CorpusRow {
  return { original_draft_text: `Dear customer, draft number ${i} thanks you kindly.`, edited_text: `Hi — thanks! (${i})`, star_rating: star };
}

const BUSINESS_ID = 'b0000000-0000-4000-8000-000000000001';

describe('getVoiceCorpusStatus', () => {
  it('returns no traits and editedCount below activation threshold', async () => {
    const status = await getVoiceCorpusStatus(fakeSql([row(1), row(2), row(3)]), BUSINESS_ID);
    expect(status.editedCount).toBe(3);
    expect(status.examples).toEqual([]);
    expect(deriveVoiceReportCard(status.examples)).toEqual({ traits: [], fallbackSnippet: null });
  });

  it('reports edited-reply count for the progress state', async () => {
    const status = await getVoiceCorpusStatus(fakeSql([row(1), row(2), row(3), row(4)]), BUSINESS_ID);
    expect(status.editedCount).toBe(4);
    expect(status.examples).toEqual([]);
  });

  it('returns exactly 5 most-recent examples once activated', async () => {
    const status = await getVoiceCorpusStatus(fakeSql([row(1), row(2), row(3), row(4), row(5), row(6), row(7)]), BUSINESS_ID);
    expect(status.editedCount).toBe(7);
    expect(status.examples).toHaveLength(5);
    expect(status.examples[0]).toEqual({ originalDraft: row(1).original_draft_text, editedVersion: row(1).edited_text, reviewStarRating: 5 });
  });

  it('getApprovedResponsePairs delegates to getVoiceCorpusStatus', async () => {
    const pairs = await getApprovedResponsePairs(fakeSql([row(1), row(2), row(3), row(4), row(5)]), BUSINESS_ID);
    expect(pairs).toHaveLength(5);
  });
});
