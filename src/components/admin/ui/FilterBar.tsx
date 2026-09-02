'use client';

import type { ReactNode } from 'react';

export interface FilterChip {
  id: string;
  label: string;
  onRemove: () => void;
}

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  rowCount: number;
  /** Noun for the count — `41 rows` by default, `41 businesses` on a list of businesses. */
  rowNoun?: string;
  chips?: FilterChip[];
  searchPlaceholder?: string;
  /** Accessible name for the search box; the placeholder is not a label. */
  searchLabel?: string;
  /**
   * Filter controls (selects, toggles) that sit between the search box and the
   * chips. The chips ECHO the active filters with a remove affordance; the
   * controls are how they are set. Both live here so a list page has one
   * filter row, not a toolbar plus a chip row.
   */
  controls?: ReactNode;
}

export function FilterBar({
  search,
  onSearchChange,
  rowCount,
  rowNoun = 'rows',
  chips = [],
  searchPlaceholder = 'Filter…',
  searchLabel = 'Filter',
  controls,
}: FilterBarProps) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <input
        type="search"
        aria-label={searchLabel}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder={searchPlaceholder}
        className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
      />
      {controls}
      {chips.map((chip) => (
        <span key={chip.id} className="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-900">
          {chip.label}
          <button type="button" onClick={chip.onRemove} aria-label={`Remove filter ${chip.label}`} className="hover:text-gray-600">
            <svg viewBox="0 0 20 20" fill="currentColor" className="size-3" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </span>
      ))}
      <span className="ml-auto text-xs text-gray-500">{`${rowCount} ${rowNoun}`}</span>
    </div>
  );
}

/** The `<select>` recipe for a FilterBar control — one spelling, so the two selects on a page match. */
export const FILTER_SELECT_CLASS =
  'rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900';
