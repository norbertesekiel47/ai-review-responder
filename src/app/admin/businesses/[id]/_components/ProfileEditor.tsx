'use client';

import { useEffect, useReducer } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BusinessDetail } from '../types';
import { formatAdminDateTime } from '@/components/admin/ui/format';

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

interface FormFields {
  name: string;
  category: string;
  website: string;
  tone: string;
  ownerEmail: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
}

interface FormState extends FormFields {
  editing: boolean;
  saveError: string | null;
}

function fieldsFromBusiness(business: BusinessDetail): FormFields {
  return {
    name: business.name,
    category: business.category ?? '',
    website: business.website ?? '',
    tone: business.tone,
    ownerEmail: business.ownerEmail,
    productsServices: business.productsServices ?? '',
    staffNames: business.staffNames.join(', '),
    highlightFacts: business.highlightFacts.join('\n'),
    avoidFacts: business.avoidFacts.join('\n'),
  };
}

function initFormState(business: BusinessDetail): FormState {
  return { ...fieldsFromBusiness(business), editing: false, saveError: null };
}

type FormAction =
  | { type: 'startEditing' }
  | { type: 'setField'; field: keyof FormFields; value: string }
  | { type: 'syncFromBusiness'; business: BusinessDetail }
  | { type: 'cancel'; business: BusinessDetail }
  | { type: 'saveError'; message: string }
  | { type: 'saved' };

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'startEditing':
      return { ...state, editing: true };
    case 'setField':
      return { ...state, [action.field]: action.value };
    case 'syncFromBusiness':
      // Refresh fields from fresh props (single update, replaces nine setters).
      return { ...state, ...fieldsFromBusiness(action.business) };
    case 'cancel':
      return { ...fieldsFromBusiness(action.business), editing: false, saveError: null };
    case 'saveError':
      return { ...state, saveError: action.message };
    case 'saved':
      return { ...state, editing: false, saveError: null };
  }
}

export function ProfileEditor({ business, businessId, onSaved }: ProfileEditorProps) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(formReducer, business, initFormState);
  const {
    editing,
    name,
    category,
    website,
    tone,
    ownerEmail,
    productsServices,
    staffNames,
    highlightFacts,
    avoidFacts,
    saveError,
  } = state;

  // Refresh local form state when the parent provides updated business data
  // — but ONLY while the user isn't actively editing. Without this guard,
  // a successful save (which triggers `onSaved` → query invalidate → fresh
  // business prop) would land mid-edit and clobber the user's in-progress
  // typing. While `editing` is true we deliberately keep local state stable.
  useEffect(() => {
    if (editing) return;
    dispatch({ type: 'syncFromBusiness', business });
  }, [business, editing]);

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
          .flatMap((s) => {
            const trimmed = s.trim();
            return trimmed ? [trimmed] : [];
          }),
        highlightFacts: highlightFacts
          .split('\n')
          .flatMap((s) => {
            const trimmed = s.trim();
            return trimmed ? [trimmed] : [];
          }),
        avoidFacts: avoidFacts
          .split('\n')
          .flatMap((s) => {
            const trimmed = s.trim();
            return trimmed ? [trimmed] : [];
          }),
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
      dispatch({ type: 'saved' });
      void queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] });
      onSaved();
    },
    onError: (err) => {
      dispatch({ type: 'saveError', message: err instanceof Error ? err.message : 'Save failed' });
    },
  });

  const handleCancel = () => {
    dispatch({ type: 'cancel', business });
  };

  if (!editing) {
    return (
      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Business Profile</h2>
          <button
            type="button"
            onClick={() => dispatch({ type: 'startEditing' })}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Edit
          </button>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 text-sm">
          <div>
            <dt className="font-medium text-gray-500">Owner</dt>
            <dd className="text-gray-900">{business.ownerName} · {business.ownerEmail}</dd>
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
              {formatAdminDateTime(business.lastSyncAt, 'Never')}
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
          <label htmlFor="business-name" className="block text-sm font-medium text-gray-700">Name</label>
          <input
            id="business-name"
            type="text"
            value={name}
            onChange={(e) => dispatch({ type: 'setField', field: 'name', value: e.target.value })}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="business-category" className="block text-sm font-medium text-gray-700">Category</label>
          <input
            id="business-category"
            type="text"
            value={category}
            onChange={(e) => dispatch({ type: 'setField', field: 'category', value: e.target.value })}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="business-website" className="block text-sm font-medium text-gray-700">Website</label>
          <input
            id="business-website"
            type="url"
            value={website}
            onChange={(e) => dispatch({ type: 'setField', field: 'website', value: e.target.value })}
            placeholder="https://example.com"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="business-tone" className="block text-sm font-medium text-gray-700">Tone</label>
          <input
            id="business-tone"
            type="text"
            value={tone}
            onChange={(e) => dispatch({ type: 'setField', field: 'tone', value: e.target.value })}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="business-owner-email" className="block text-sm font-medium text-gray-700">Owner Email</label>
          <input
            id="business-owner-email"
            type="email"
            value={ownerEmail}
            onChange={(e) => dispatch({ type: 'setField', field: 'ownerEmail', value: e.target.value })}
            placeholder="owner@example.com"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Updating this address does not clear a hard-bounce flag. Use the banner above to clear it after verifying.
          </p>
        </div>
        <div>
          <label htmlFor="business-products-services" className="block text-sm font-medium text-gray-700">Products / Services</label>
          <textarea
            id="business-products-services"
            value={productsServices}
            onChange={(e) => dispatch({ type: 'setField', field: 'productsServices', value: e.target.value })}
            rows={3}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="business-staff-names" className="block text-sm font-medium text-gray-700">
            Staff Names <span className="text-gray-400 font-normal">(comma-separated)</span>
          </label>
          <input
            id="business-staff-names"
            type="text"
            value={staffNames}
            onChange={(e) => dispatch({ type: 'setField', field: 'staffNames', value: e.target.value })}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="business-highlight-facts" className="block text-sm font-medium text-gray-700">
            Highlight Facts <span className="text-gray-400 font-normal">(one per line)</span>
          </label>
          <textarea
            id="business-highlight-facts"
            value={highlightFacts}
            onChange={(e) => dispatch({ type: 'setField', field: 'highlightFacts', value: e.target.value })}
            rows={4}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="business-avoid-facts" className="block text-sm font-medium text-gray-700">
            Avoid Facts <span className="text-gray-400 font-normal">(one per line)</span>
          </label>
          <textarea
            id="business-avoid-facts"
            value={avoidFacts}
            onChange={(e) => dispatch({ type: 'setField', field: 'avoidFacts', value: e.target.value })}
            rows={4}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {saveError && <p className="text-sm text-red-600">{saveError}</p>}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
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
