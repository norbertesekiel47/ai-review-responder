'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ManualPostSection from './manual-post-section';

interface BusinessDetail {
  id: string;
  name: string;
  category: string | null;
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

interface DetailData {
  business: BusinessDetail;
  reviews: ReviewRow[];
}

function renderStars(rating: number): string {
  return '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
}

function ResponseBadge({ status }: { status: string | null }) {
  if (!status) return null;

  const colorMap: Record<string, string> = {
    pending_approval: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-blue-100 text-blue-800',
    edited: 'bg-blue-100 text-blue-800',
    awaiting_manual_post: 'bg-orange-100 text-orange-800',
    posted: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
  };

  const colorClass = colorMap[status] ?? 'bg-gray-100 text-gray-700';

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${colorClass}`}>
      {status.replace(/_/g, ' ')}
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
  const [tone, setTone] = useState(business.tone);
  const [productsServices, setProductsServices] = useState(business.productsServices ?? '');
  const [staffNames, setStaffNames] = useState(business.staffNames.join(', '));
  const [highlightFacts, setHighlightFacts] = useState(business.highlightFacts.join('\n'));
  const [avoidFacts, setAvoidFacts] = useState(business.avoidFacts.join('\n'));
  const [saveError, setSaveError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        category: category.trim() || null,
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
    setTone(business.tone);
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
          <label className="block text-sm font-medium text-gray-700">Tone</label>
          <input
            type="text"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
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

  const { business, reviews } = data;
  const awaitingPost = reviews.filter((r) => r.responseStatus === 'awaiting_manual_post');

  const mapsUrl = business.googlePlaceId
    ? `https://www.google.com/maps/place/?q=place_id:${business.googlePlaceId}`
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{business.name}</h1>
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
                    {review.responseStatus && (
                      <ResponseBadge status={review.responseStatus} />
                    )}
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
