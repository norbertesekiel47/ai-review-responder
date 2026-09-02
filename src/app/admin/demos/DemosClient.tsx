'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required); the
// server page additionally gates with requireAdminPage.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { DemoListItem } from '@/lib/demos/types';
import { PlaceAutocomplete, type PlaceSelection } from '@/components/places/PlaceAutocomplete';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { ADMIN_TIME_ZONE_LABEL, formatAdminDate } from '@/components/admin/ui/format';

/** What the generate form posts — carried through the mutation so success can name the demo. */
interface GenerateInput {
  businessName: string;
  category: string | undefined;
  place: { googlePlaceId: string } | { googleMapsUrl: string };
}

export const PICK_A_PLACE_COPY = 'Pick a business from the search results first, or paste a Google Maps URL.';

export function DemosClient({ initialData }: { initialData: DemoListItem[] }) {
  return (
    <>
      <GenerateForm />
      <DemoList initialData={initialData} />
    </>
  );
}

// ── Generate Form ────────────────────────────────────────────────────

function GenerateForm() {
  const [url, setUrl] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [category, setCategory] = useState('');
  const [inputMode, setInputMode] = useState<'autocomplete' | 'url'>('autocomplete');
  const [placeSelection, setPlaceSelection] = useState<PlaceSelection | null>(null);
  // The one validation the browser cannot do: the autocomplete has no `required`.
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [queuedName, setQueuedName] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: GenerateInput) => {
      const res = await fetch('/api/admin/demos/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input.place, businessName: input.businessName, category: input.category }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Failed to generate demo');
      }
      return res.json() as Promise<unknown>;
    },
    onSuccess: (_data, input) => {
      setQueuedName(input.businessName);
      setUrl('');
      setBusinessName('');
      setCategory('');
      setPlaceSelection(null);
      void queryClient.invalidateQueries({ queryKey: ['demos'] });
    },
  });

  // A real <form> (X23): `required` fires, Enter submits, and the submit is the
  // one place the request is built — the button no longer carries an onClick.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQueuedName(null);
    if (inputMode === 'autocomplete' && !placeSelection) {
      setPlaceError(PICK_A_PLACE_COPY);
      return;
    }
    setPlaceError(null);
    mutation.mutate({
      businessName,
      category: category || undefined,
      place: placeSelection ? { googlePlaceId: placeSelection.placeId } : { googleMapsUrl: url },
    });
  }

  return (
    // CF-5, the mixed form+list case: measure the FORM at max-w-2xl (its inputs
    // are unfillable stretched to the max-w-7xl page width) and leave DemoList
    // full width below. See the content-measure rule on <AdminPage>.
    <form onSubmit={handleSubmit} className="mb-8 max-w-2xl rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Generate New Demo
      </h2>
      <div className="space-y-4">
        <div>
          <label htmlFor={inputMode === 'url' ? 'url' : undefined} className="block text-sm font-medium text-gray-700 mb-1">
            Business Location
          </label>
          {inputMode === 'autocomplete' ? (
            <PlaceAutocomplete
              onPlaceSelect={(sel) => {
                setPlaceSelection(sel);
                setPlaceError(null);
              }}
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
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
            />
          )}
          <button
            type="button"
            onClick={() => {
              setInputMode(inputMode === 'autocomplete' ? 'url' : 'autocomplete');
              setPlaceSelection(null);
              setPlaceError(null);
              setUrl('');
            }}
            className="mt-1 text-xs text-gray-600 underline hover:text-gray-900"
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
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
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
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
            />
          </div>
        </div>

        {(placeError || mutation.error) && (
          <p role="alert" className="text-sm text-red-600">
            {placeError ?? mutation.error?.message}
          </p>
        )}
        {queuedName && !mutation.isPending && (
          <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            Demo queued for {queuedName}. It appears in the list below and refreshes every few seconds
            while it generates.
          </p>
        )}

        <button
          type="submit"
          disabled={mutation.isPending}
          className="bg-gray-900 text-white font-medium px-4 py-2 rounded-md text-sm hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {mutation.isPending ? 'Submitting...' : 'Generate Demo'}
        </button>
      </div>
    </form>
  );
}

// ── Demo List ────────────────────────────────────────────────────────

function DemoList({ initialData }: { initialData: DemoListItem[] }) {
  const { data: demos, isLoading, isError, refetch } = useQuery<DemoListItem[]>({
    queryKey: ['demos'],
    queryFn: async () => {
      const res = await fetch('/api/admin/demos');
      if (!res.ok) throw new Error('Failed to fetch demos');
      return res.json();
    },
    // Poll at 5s ONLY while something is generating, then stop. Deliberately not
    // a fixed interval — a completed list is static until the form posts again.
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
    staleTime: 30_000,
    initialData,
  });

  if (isLoading && !demos) return <TableSkeleton />;
  if (isError && !demos) {
    return (
      <ErrorState
        title="Couldn't load demos"
        detail="GET /api/admin/demos failed"
        onRetry={() => void refetch()}
      />
    );
  }
  if (!demos) return null;

  return (
    <>
      {isError && (
        <div className="mb-4">
          <ErrorState
            title="Last refresh failed"
            detail="GET /api/admin/demos failed — showing the last loaded data."
            onRetry={() => void refetch()}
          />
        </div>
      )}
      {demos.length === 0 ? (
        <EmptyState
          title="No demos generated yet"
          detail="Use the form above to create one."
        />
      ) : (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900">Generated Demos</h2>
          {demos.map((demo) => (
            <DemoRow key={demo.id} demo={demo} />
          ))}
        </div>
      )}
    </>
  );
}

// ── Demo Row ─────────────────────────────────────────────────────────

function DemoRow({ demo }: { demo: DemoListItem }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    // `window` is read at click time, never during render: this tree renders on
    // the server now, so touching it in the component body would throw on the
    // RSC pass.
    await navigator.clipboard.writeText(`${window.location.origin}/demo/${demo.slug}`);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 truncate">
          {demo.businessName}
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-gray-500">
          {/* The `demo` vocabulary of the shared badge (X9) — `running` pulses there. */}
          <StatusBadge vocab="demo" value={demo.generationStatus} />
          {demo.generationStatus === 'completed' && (
            <a
              href={`/demo/${demo.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-700 hover:underline"
            >
              /demo/{demo.slug}
            </a>
          )}
          <span>{demo.viewCount} views</span>
          {/* Inline date with no column header to carry the zone, so the label
              rides along (see src/components/admin/ui/format.ts). */}
          <span>
            {formatAdminDate(demo.createdAt)} {ADMIN_TIME_ZONE_LABEL}
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
