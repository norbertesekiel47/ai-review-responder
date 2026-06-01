'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface TrackedKeywordsSectionProps {
  businessId: string;
  keywords: string[];
}

export function TrackedKeywordsSection({ businessId, keywords: initialKeywords }: TrackedKeywordsSectionProps) {
  const queryClient = useQueryClient();
  const [keywords, setKeywords] = useState<string[]>(initialKeywords);
  const [newKeyword, setNewKeyword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (updated: string[]) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/keywords`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: updated }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setKeywords(updated);
      void queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addKeyword = () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed) return;
    if (keywords.includes(trimmed)) {
      setError('Keyword already exists');
      return;
    }
    if (keywords.length >= 5) {
      setError('Maximum 5 keywords allowed');
      return;
    }
    setNewKeyword('');
    void save([...keywords, trimmed]);
  };

  const removeKeyword = (kw: string) => {
    void save(keywords.filter((k) => k !== kw));
  };

  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">Tracked Keywords</h2>
      <p className="text-sm text-gray-500 mb-4">
        Keywords used for local ranking checks. Maximum 5.
      </p>
      <div className="flex flex-wrap gap-2 mb-4">
        {keywords.map((kw) => (
          <span key={kw} className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm">
            {kw}
            <button
              type="button"
              onClick={() => removeKeyword(kw)}
              disabled={saving}
              className="ml-1 text-blue-500 hover:text-blue-700 disabled:opacity-50"
              aria-label={`Remove ${kw}`}
            >
              &times;
            </button>
          </span>
        ))}
        {keywords.length === 0 && (
          <span className="text-sm text-gray-400">No keywords tracked yet.</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          aria-label="New tracked keyword"
          type="text"
          value={newKeyword}
          onChange={(e) => { setNewKeyword(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
          placeholder="e.g. best tacos near me"
          className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={saving}
        />
        <button
          type="button"
          onClick={addKeyword}
          disabled={saving || !newKeyword.trim()}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
