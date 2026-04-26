'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { BusinessDetail } from '../types';

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

interface ProfileEditorProps {
  business: BusinessDetail;
  businessId: string;
  onSaved: () => void;
}

export function ProfileEditor({ business, businessId, onSaved }: ProfileEditorProps) {
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
