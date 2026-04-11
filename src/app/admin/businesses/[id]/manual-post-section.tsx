'use client';

import { useState, useCallback } from 'react';

interface Props {
  responseId: string;
  businessId: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  approvedText: string;
}

function renderStars(rating: number): string {
  return '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
}

export default function ManualPostSection({
  responseId,
  businessId,
  reviewerName,
  starRating,
  reviewText,
  approvedText,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [posted, setPosted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(approvedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Failed to copy');
    }
  }, [approvedText]);

  const handleMarkPosted = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/businesses/${businessId}/mark-posted`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ responseId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setPosted(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to mark as posted',
      );
    } finally {
      setLoading(false);
    }
  }, [businessId, responseId]);

  if (posted) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">
        Marked as posted
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-yellow-500">{renderStars(starRating)}</span>
        <span className="font-medium text-gray-700">{reviewerName}</span>
      </div>
      {reviewText && (
        <p className="mt-1 text-sm text-gray-500 line-clamp-2">{reviewText}</p>
      )}
      <div className="mt-3 rounded bg-blue-50 p-3">
        <p className="text-sm leading-relaxed text-gray-800">{approvedText}</p>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          onClick={handleCopy}
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          {copied ? 'Copied!' : 'Copy to Clipboard'}
        </button>
        <button
          onClick={handleMarkPosted}
          disabled={loading}
          className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {loading ? 'Marking...' : 'Mark as Posted'}
        </button>
      </div>
    </div>
  );
}
