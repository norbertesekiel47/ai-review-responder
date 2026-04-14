'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { DemoListItem } from '@/lib/demos/types';
import { PlaceAutocomplete, type PlaceSelection } from '@/components/PlaceAutocomplete';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

export default function AdminDemosPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-8">
          Demo Generation
        </h1>
        <GenerateForm />
        <DemoList />
      </div>
    </div>
  );
}

// ── Generate Form ────────────────────────────────────────────────────

function GenerateForm() {
  const [url, setUrl] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [category, setCategory] = useState('');
  const [inputMode, setInputMode] = useState<'autocomplete' | 'url'>('autocomplete');
  const [placeSelection, setPlaceSelection] = useState<PlaceSelection | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const body = placeSelection
        ? {
            googlePlaceId: placeSelection.placeId,
            businessName,
            category: category || undefined,
          }
        : {
            googleMapsUrl: url,
            businessName,
            category: category || undefined,
          };

      const res = await fetch('/api/admin/demos/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to generate demo');
      }
      return res.json();
    },
    onSuccess: () => {
      setUrl('');
      setBusinessName('');
      setCategory('');
      setPlaceSelection(null);
      queryClient.invalidateQueries({ queryKey: ['demos'] });
    },
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-8">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Generate New Demo
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="space-y-4"
      >
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Business Location
          </label>
          {inputMode === 'autocomplete' ? (
            <PlaceAutocomplete
              onPlaceSelect={(sel) => setPlaceSelection(sel)}
              onClear={() => setPlaceSelection(null)}
              placeholder="Search for a business..."
            />
          ) : (
            <input
              id="url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.google.com/maps/place/..."
              required={inputMode === 'url'}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          )}
          <button
            type="button"
            onClick={() => {
              setInputMode(inputMode === 'autocomplete' ? 'url' : 'autocomplete');
              setPlaceSelection(null);
              setUrl('');
            }}
            className="mt-1 text-xs text-blue-600 hover:text-blue-800"
          >
            {inputMode === 'autocomplete'
              ? 'Or paste a Google Maps URL'
              : 'Use search instead'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="businessName"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Business Name
            </label>
            <input
              id="businessName"
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Bella Italia"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              htmlFor="category"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Category (optional)
            </label>
            <input
              id="category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Italian Restaurant"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {mutation.error && (
          <p className="text-sm text-red-600">
            {mutation.error.message}
          </p>
        )}

        <button
          type="submit"
          disabled={mutation.isPending}
          className="bg-blue-600 text-white font-medium px-4 py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {mutation.isPending ? 'Submitting...' : 'Generate Demo'}
        </button>
      </form>
    </div>
  );
}

// ── Demo List ────────────────────────────────────────────────────────

function DemoList() {
  const { data: demos, isLoading } = useQuery<DemoListItem[]>({
    queryKey: ['demos'],
    queryFn: async () => {
      const res = await fetch('/api/admin/demos');
      if (!res.ok) throw new Error('Failed to fetch demos');
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasActive = data.some(
        (d) =>
          d.generationStatus === 'queued' ||
          d.generationStatus === 'running',
      );
      return hasActive ? 5000 : false;
    },
  });

  if (isLoading) {
    return <p className="text-gray-500 text-sm">Loading demos...</p>;
  }

  if (!demos || demos.length === 0) {
    return (
      <p className="text-gray-500 text-sm">
        No demos generated yet. Use the form above to create one.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-900">Generated Demos</h2>
      {demos.map((demo) => (
        <DemoRow key={demo.id} demo={demo} />
      ))}
    </div>
  );
}

// ── Demo Row ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-700',
  running: 'bg-yellow-100 text-yellow-800 animate-pulse',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

function DemoRow({ demo }: { demo: DemoListItem }) {
  const [copied, setCopied] = useState(false);

  const demoUrl = `${window.location.origin}/demo/${demo.slug}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(demoUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 truncate">
          {demo.businessName}
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-gray-500">
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[demo.generationStatus] ?? ''}`}
          >
            {demo.generationStatus}
          </span>
          {demo.generationStatus === 'completed' && (
            <a
              href={`/demo/${demo.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              /demo/{demo.slug}
            </a>
          )}
          <span>{demo.viewCount} views</span>
          <span>
            {new Date(demo.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        </div>
        {demo.generationError && (
          <p className="text-xs text-red-600 mt-1 truncate">
            {demo.generationError}
          </p>
        )}
      </div>

      {demo.generationStatus === 'completed' && (
        <button
          onClick={handleCopy}
          className="shrink-0 text-sm font-medium px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
      )}
    </div>
  );
}
