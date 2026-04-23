'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ManualPostSection from './manual-post-section';
import { SmsEnrollmentWidget } from '@/components/admin/SmsEnrollmentWidget';
import { TelegramEnrollmentWidget } from '@/components/admin/TelegramEnrollmentWidget';
import { WhatsAppEnrollmentWidget } from '@/components/admin/WhatsAppEnrollmentWidget';

interface BusinessDetail {
  id: string;
  name: string;
  category: string | null;
  website: string | null;
  googlePlaceId: string | null;
  tone: string;
  productsServices: string | null;
  staffNames: string[];
  highlightFacts: string[];
  avoidFacts: string[];
  sampleResponses: string[];
  subscriptionStatus: string;
  subscriptionTier: string;
  ownerName: string;
  ownerEmail: string;
  lastSyncAt: string | null;
  trackedKeywords: string[];
  googlePlaceLat: number | null;
  googlePlaceLng: number | null;
  rankingSearchLocation: string | null;
  googlePlaceAddress: string | null;
  ownerEmailBounced: boolean;
  smsEnabled: boolean;
  telegramEnabled: boolean;
  whatsappEnabled: boolean;
  churnScore?: {
    score: number;
    level: 'healthy' | 'watch' | 'at_risk';
    breakdown: Array<{ signal: string; value: string; contribution: number }>;
  };
}

interface ReviewRow {
  id: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string | null;
  detectedLanguage: string | null;
  detectedAt: string;
  responseId: string | null;
  responseStatus: string | null;
  responseText: string | null;
  approvedText: string | null;
  responseVersion: number | null;
}

interface RankingSnapshot {
  keyword: string;
  rankPosition: number | null;
  snapshotDate: string;
  source: string;
}

interface DetailData {
  business: BusinessDetail;
  reviews: ReviewRow[];
  rankingSnapshots: RankingSnapshot[];
}

interface ChannelEnrollmentRow {
  channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
  handle: string;
  status: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed';
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  last_activity_at: string | null;
}

function StatusBadge({ status }: { status: ChannelEnrollmentRow['status'] }) {
  const styles: Record<ChannelEnrollmentRow['status'], string> = {
    verified: 'bg-green-100 text-green-800',
    pending_verification: 'bg-yellow-100 text-yellow-800',
    disabled: 'bg-gray-100 text-gray-800',
    unsubscribed: 'bg-red-100 text-red-800',
  };
  return <span className={`px-2 py-0.5 rounded text-xs ${styles[status]}`}>{status}</span>;
}

function renderStars(rating: number): string {
  return '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
}

/**
 * Defensive anchor href sanitizer. The schema validator rejects non-http(s)
 * schemes at write time, but existing DB rows or manual SQL inserts could
 * still contain unsafe URLs. Any anchor rendered with an external href must
 * go through this function — returns null for schemes other than http/https.
 */
function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function HealthBadge({ level, score }: { level: string; score: number }) {
  const styles: Record<string, string> = {
    healthy: 'bg-green-100 text-green-800',
    watch: 'bg-amber-100 text-amber-800',
    at_risk: 'bg-red-100 text-red-800',
  };
  const labels: Record<string, string> = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At Risk' };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${styles[level] ?? styles.healthy}`}>
      {labels[level] ?? level} <span className="opacity-60">{score}</span>
    </span>
  );
}

function ResponseBadge({ status }: { status: string | null }) {
  const displayStatus = status ?? 'new';

  const colorMap: Record<string, string> = {
    new: 'bg-gray-100 text-gray-600',
    pending_approval: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-blue-100 text-blue-800',
    edited: 'bg-blue-100 text-blue-800',
    awaiting_manual_post: 'bg-orange-100 text-orange-800',
    posted: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
  };

  const colorClass = colorMap[displayStatus] ?? 'bg-gray-100 text-gray-700';

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${colorClass}`}>
      {displayStatus.replace(/_/g, ' ')}
    </span>
  );
}

interface ProfileEditorProps {
  business: BusinessDetail;
  businessId: string;
  onSaved: () => void;
}

function ProfileEditor({ business, businessId, onSaved }: ProfileEditorProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(business.name);
  const [category, setCategory] = useState(business.category ?? '');
  const [website, setWebsite] = useState(business.website ?? '');
  const [tone, setTone] = useState(business.tone);
  const [ownerEmail, setOwnerEmail] = useState(business.ownerEmail);
  const [productsServices, setProductsServices] = useState(business.productsServices ?? '');
  const [staffNames, setStaffNames] = useState(business.staffNames.join(', '));
  const [highlightFacts, setHighlightFacts] = useState(business.highlightFacts.join('\n'));
  const [avoidFacts, setAvoidFacts] = useState(business.avoidFacts.join('\n'));
  const [saveError, setSaveError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmedEmail = ownerEmail.trim();
      const body: Record<string, unknown> = {
        name: name.trim(),
        category: category.trim() || null,
        website: website.trim() || null,
        tone: tone.trim(),
        productsServices: productsServices.trim() || null,
        staffNames: staffNames
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        highlightFacts: highlightFacts
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        avoidFacts: avoidFacts
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      // Only send ownerEmail if it actually changed — UpdateBusinessSchema
      // rejects empty strings, and sending an unchanged value is wasted work.
      if (trimmedEmail && trimmedEmail !== business.ownerEmail) {
        body.ownerEmail = trimmedEmail;
      }
      const res = await fetch(`/api/admin/businesses/${businessId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setSaveError(null);
      setEditing(false);
      onSaved();
    },
    onError: (err) => {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    },
  });

  const handleCancel = () => {
    setName(business.name);
    setCategory(business.category ?? '');
    setWebsite(business.website ?? '');
    setTone(business.tone);
    setOwnerEmail(business.ownerEmail);
    setProductsServices(business.productsServices ?? '');
    setStaffNames(business.staffNames.join(', '));
    setHighlightFacts(business.highlightFacts.join('\n'));
    setAvoidFacts(business.avoidFacts.join('\n'));
    setSaveError(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Business Profile</h2>
          <button
            onClick={() => setEditing(true)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Edit
          </button>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 text-sm">
          <div>
            <dt className="font-medium text-gray-500">Owner</dt>
            <dd className="text-gray-900">{business.ownerName} — {business.ownerEmail}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Tier</dt>
            <dd className="text-gray-900">{business.subscriptionTier}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Category</dt>
            <dd className="text-gray-900">{business.category ?? '—'}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Website</dt>
            <dd className="text-gray-900">
              {(() => {
                const safeHref = safeHttpUrl(business.website);
                if (safeHref) {
                  return (
                    <a href={safeHref} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">
                      {business.website}
                    </a>
                  );
                }
                // Display raw value as plain text if it failed the safety check,
                // so the admin can see + fix it without it being clickable.
                return business.website ?? '—';
              })()}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Tone</dt>
            <dd className="text-gray-900">{business.tone}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-medium text-gray-500">Products / Services</dt>
            <dd className="text-gray-900 whitespace-pre-wrap">{business.productsServices ?? '—'}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Staff Names</dt>
            <dd className="text-gray-900">{business.staffNames.join(', ') || '—'}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Last Sync</dt>
            <dd className="text-gray-900">
              {business.lastSyncAt ? new Date(business.lastSyncAt).toLocaleString() : 'Never'}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-medium text-gray-500">Highlight Facts</dt>
            <dd className="text-gray-900 whitespace-pre-wrap">{business.highlightFacts.join('\n') || '—'}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-medium text-gray-500">Avoid Facts</dt>
            <dd className="text-gray-900 whitespace-pre-wrap">{business.avoidFacts.join('\n') || '—'}</dd>
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-lg border border-blue-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-800">Edit Profile</h2>
      <div className="mt-4 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Category</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Website</label>
          <input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://example.com"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Tone</label>
          <input
            type="text"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Owner Email</label>
          <input
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            placeholder="owner@example.com"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Updating this address does not clear a hard-bounce flag — use the banner above to clear it after verifying.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Products / Services</label>
          <textarea
            value={productsServices}
            onChange={(e) => setProductsServices(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Staff Names <span className="text-gray-400 font-normal">(comma-separated)</span>
          </label>
          <input
            type="text"
            value={staffNames}
            onChange={(e) => setStaffNames(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Highlight Facts <span className="text-gray-400 font-normal">(one per line)</span>
          </label>
          <textarea
            value={highlightFacts}
            onChange={(e) => setHighlightFacts(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Avoid Facts <span className="text-gray-400 font-normal">(one per line)</span>
          </label>
          <textarea
            value={avoidFacts}
            onChange={(e) => setAvoidFacts(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {saveError && <p className="text-sm text-red-600">{saveError}</p>}
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleCancel}
            disabled={mutation.isPending}
            className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function TrackedKeywordsSection({ businessId, keywords: initialKeywords }: { businessId: string; keywords: string[] }) {
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
          type="text"
          value={newKeyword}
          onChange={(e) => { setNewKeyword(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
          placeholder="e.g. best tacos near me"
          className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={saving}
        />
        <button
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

function ManualRankingSection({ businessId, snapshots }: { businessId: string; snapshots: RankingSnapshot[] }) {
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [rankPosition, setRankPosition] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
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
      setDate(new Date().toISOString().slice(0, 10));
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
          <label className="block text-xs text-gray-500 mb-1">Keyword</label>
          <input
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
          <label className="block text-xs text-gray-500 mb-1">Rank</label>
          <input
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
          <label className="block text-xs text-gray-500 mb-1">Date</label>
          <input
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

export default function BusinessDetailPage() {
  const { id: businessId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<DetailData>({
    queryKey: ['admin-business', businessId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/businesses/${businessId}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<DetailData>;
    },
  });

  const { data: channelsData } = useQuery<{ enrollments: ChannelEnrollmentRow[] }>({
    queryKey: ['admin-business-channels', businessId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/businesses/${businessId}/channels`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ enrollments: ChannelEnrollmentRow[] }>;
    },
  });
  const enrollments = channelsData?.enrollments ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
    // Owner-email edits upsert channel_enrollments inside the PATCH txn; the
    // Channels table must refresh to show the new handle.
    void queryClient.invalidateQueries({ queryKey: ['admin-business-channels', businessId] });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-red-600 text-sm">
        {error instanceof Error ? error.message : 'Failed to load business'}
      </div>
    );
  }

  const { business, reviews, rankingSnapshots } = data;
  const awaitingPost = reviews.filter((r) => r.responseStatus === 'awaiting_manual_post');

  const mapsUrl = business.googlePlaceId
    ? `https://www.google.com/maps/place/?q=place_id:${business.googlePlaceId}`
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">

        {/* Back + Header */}
        <Link
          href="/admin/overview"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to Overview
        </Link>
        <div className="mt-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{business.name}</h1>
            {business.churnScore && (
              <HealthBadge level={business.churnScore.level} score={business.churnScore.score} />
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-sm text-gray-500 items-center">
            <span className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700">
              {business.subscriptionStatus.replace(/_/g, ' ')}
            </span>
            <span className="rounded bg-indigo-100 px-2 py-0.5 font-medium text-indigo-700">
              {business.subscriptionTier}
            </span>
            {business.category && <span>{business.category}</span>}
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Google Maps
              </a>
            )}
          </div>
        </div>

        {business.ownerEmailBounced && (
          <div className="mt-4 mb-4 rounded-lg border border-red-300 bg-red-50 p-4">
            <p className="text-sm font-semibold text-red-800">
              ⚠ Owner email is bouncing
            </p>
            <p className="mt-1 text-sm text-red-700">
              Approval emails, weekly reports, monthly impact, drip emails, and owner nudges
              are skipped for <code className="rounded bg-red-100 px-1">{business.ownerEmail}</code>.
              Partner/admin alerts still send.
            </p>
            <p className="mt-2 text-sm text-red-700">
              Verify the email address with the owner. If it changed, update it in the
              Business Profile section below (Edit → Owner Email), then clear the flag with
              the button below. See <code>docs/email-deliverability.md</code> for the full runbook.
            </p>
            <button
              type="button"
              onClick={async () => {
                if (!confirm('Clear the bounce flag? Only do this after verifying the address is valid.')) return;
                const res = await fetch(`/api/admin/businesses/${business.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ownerEmailBounced: false }),
                });
                if (res.ok) {
                  queryClient.invalidateQueries({ queryKey: ['admin-business', business.id] });
                } else {
                  alert('Failed to clear flag. See console.');
                }
              }}
              className="mt-3 rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
            >
              Clear bounce flag (after verifying address)
            </button>
          </div>
        )}

        {/* Profile editor */}
        <ProfileEditor
          business={business}
          businessId={businessId}
          onSaved={invalidate}
        />

        {/* Review list */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-gray-800">
            Reviews ({reviews.length})
          </h2>
          {reviews.length === 0 ? (
            <p className="mt-2 text-sm text-gray-400">No reviews found.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {reviews.map((review) => (
                <div
                  key={review.id}
                  className="rounded-lg border border-gray-200 bg-white p-4"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-yellow-500">{renderStars(review.starRating)}</span>
                    <span className="font-medium text-gray-700">{review.reviewerName}</span>
                    {review.reviewDate && (
                      <span className="text-gray-400">
                        {new Date(review.reviewDate).toLocaleDateString()}
                      </span>
                    )}
                    {review.detectedLanguage && (
                      <span className="text-gray-400 uppercase text-xs">
                        [{review.detectedLanguage}]
                      </span>
                    )}
                    <ResponseBadge status={review.responseStatus} />
                  </div>
                  {review.reviewText && (
                    <p className="mt-1 text-sm text-gray-600 line-clamp-3">
                      {review.reviewText}
                    </p>
                  )}
                  {review.approvedText && (
                    <div className="mt-2 rounded bg-blue-50 px-3 py-2 text-sm text-gray-800">
                      <span className="font-medium text-gray-500">Response: </span>
                      {review.approvedText}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Engagement / churn risk */}
        {business.churnScore && (
          <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Engagement</h2>
              <HealthBadge level={business.churnScore.level} score={business.churnScore.score} />
            </div>
            <div className="space-y-3">
              {business.churnScore.breakdown.map((item) => (
                <div key={item.signal} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium text-gray-700">{item.signal}:</span>{' '}
                    <span className="text-gray-500">{item.value}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-24 rounded bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full rounded ${
                          item.contribution > 15 ? 'bg-red-400' :
                          item.contribution > 5 ? 'bg-amber-400' : 'bg-green-400'
                        }`}
                        style={{ width: `${Math.min(item.contribution * 3, 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 w-8 text-right">{item.contribution}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Tracked Keywords */}
        <TrackedKeywordsSection businessId={businessId} keywords={business.trackedKeywords} />

        {/* Ranking */}
        <ManualRankingSection businessId={businessId} snapshots={rankingSnapshots ?? []} />

        {/* Channels */}
        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Channels</h2>
          {enrollments.length === 0 ? (
            <p className="text-sm text-gray-500">
              No channel enrollments — business cannot receive approval notifications.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="pb-2 font-medium">Channel</th>
                    <th className="pb-2 font-medium">Handle</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {enrollments.map((e) => (
                    <tr key={e.channel} className="border-b border-gray-100">
                      <td className="py-2 text-gray-700">{e.channel}</td>
                      <td className="py-2 font-mono text-gray-700">{e.handle}</td>
                      <td className="py-2"><StatusBadge status={e.status} /></td>
                      <td className="py-2 text-gray-700">
                        {e.last_activity_at ? new Date(e.last_activity_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* SMS enrollment (flag-gated) */}
        {business.smsEnabled && (
          <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-3">SMS enrollment</h2>
            {business.subscriptionStatus !== 'active' ? (
              <p className="text-sm text-gray-500">
                Complete payment first — SMS enrollment unlocks once the business&apos;s subscription transitions to active.
              </p>
            ) : (
              <SmsEnrollmentWidget businessId={businessId} />
            )}
          </section>
        )}

        {/* Telegram enrollment (flag-gated) */}
        {business.telegramEnabled && (
          <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-3">Telegram enrollment</h2>
            {business.subscriptionStatus !== 'active' ? (
              <p className="text-sm text-gray-500">
                Complete payment first — Telegram enrollment unlocks once the business&apos;s subscription transitions to active.
              </p>
            ) : (
              <TelegramEnrollmentWidget businessId={businessId} />
            )}
          </section>
        )}

        {/* WhatsApp enrollment (flag-gated) */}
        {business.whatsappEnabled && (
          <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-3">WhatsApp enrollment</h2>
            {business.subscriptionStatus !== 'active' ? (
              <p className="text-sm text-gray-500">
                Complete payment first — WhatsApp enrollment unlocks once the business&apos;s subscription transitions to active.
              </p>
            ) : (
              <WhatsAppEnrollmentWidget businessId={businessId} />
            )}
          </section>
        )}

        {/* Awaiting Manual Post */}
        {awaitingPost.length > 0 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold text-gray-800">
              Awaiting Manual Post ({awaitingPost.length})
            </h2>
            <div className="mt-4 space-y-4">
              {awaitingPost.map((r) => (
                <ManualPostSection
                  key={r.responseId}
                  responseId={r.responseId!}
                  businessId={businessId}
                  reviewerName={r.reviewerName}
                  starRating={r.starRating}
                  reviewText={r.reviewText}
                  approvedText={r.approvedText!}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
