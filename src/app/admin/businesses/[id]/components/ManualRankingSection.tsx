'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RankingSnapshot } from '../types';

interface ManualRankingSectionProps {
  businessId: string;
  snapshots: RankingSnapshot[];
}

/**
 * Returns today's calendar date in the admin's local timezone as YYYY-MM-DD.
 * `new Date().toISOString().slice(0,10)` would emit the UTC date, which
 * lands on the wrong day for admins west of UTC after their local 4-7pm.
 */
function todayLocal(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function ManualRankingSection({ businessId, snapshots }: ManualRankingSectionProps) {
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [rankPosition, setRankPosition] = useState('');
  const [date, setDate] = useState(() => todayLocal());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) return;

    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/ranking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: trimmedKeyword,
          rankPosition: rankPosition.trim() ? Number(rankPosition) : null,
          date,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setKeyword('');
      setRankPosition('');
      setDate(todayLocal());
      setSuccess(true);
      void queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const recent = snapshots.slice(0, 10);

  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">Ranking</h2>

      {recent.length > 0 && (
        <div className="mb-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="pb-2 font-medium">Date</th>
                <th className="pb-2 font-medium">Keyword</th>
                <th className="pb-2 font-medium">Rank</th>
                <th className="pb-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((snap, idx) => (
                <tr key={`${snap.keyword}-${snap.snapshotDate}-${idx}`} className="border-b border-gray-100">
                  <td className="py-2 text-gray-700">{snap.snapshotDate}</td>
                  <td className="py-2 text-gray-700">{snap.keyword}</td>
                  <td className="py-2 text-gray-700">
                    {snap.rankPosition !== null ? `#${snap.rankPosition}` : 'Not found'}
                  </td>
                  <td className="py-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      snap.source === 'serpapi' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {snap.source}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {recent.length === 0 && (
        <p className="mb-6 text-sm text-gray-400">No ranking data yet.</p>
      )}

      <h3 className="text-sm font-medium text-gray-700 mb-3">Manual Entry</h3>
      <form onSubmit={submit} className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[160px]">
          <label className="block text-xs text-gray-500 mb-1" htmlFor="manual-ranking-keyword">Keyword</label>
          <input
            id="manual-ranking-keyword"
            type="text"
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setError(null); setSuccess(false); }}
            placeholder="e.g. plumber downtown"
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={saving}
            required
          />
        </div>
        <div className="w-24">
          <label className="block text-xs text-gray-500 mb-1" htmlFor="manual-ranking-rank">Rank</label>
          <input
            id="manual-ranking-rank"
            type="number"
            value={rankPosition}
            onChange={(e) => { setRankPosition(e.target.value); setError(null); setSuccess(false); }}
            placeholder="e.g. 3"
            min={1}
            max={100}
            step={1}
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={saving}
          />
        </div>
        <div className="w-40">
          <label className="block text-xs text-gray-500 mb-1" htmlFor="manual-ranking-date">Date</label>
          <input
            id="manual-ranking-date"
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); setError(null); setSuccess(false); }}
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={saving}
            required
          />
        </div>
        <button
          type="submit"
          disabled={saving || !keyword.trim()}
          className="rounded bg-gray-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {success && <p className="mt-2 text-sm text-green-600">Ranking saved</p>}
    </section>
  );
}
