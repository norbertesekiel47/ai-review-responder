'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { Icon } from '@/components/dashboard/shell/Icon';

// ── Props ───────────────────────────────────────────────────────────────────

interface LocationPickerProps {
  /** When true, render a compact variant for mobile TopBar. */
  compact?: boolean;
  /** Fallback label for single-location accounts (no switcher needed). */
  singleLocationLabel?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function LocationPicker({ compact, singleLocationLabel }: LocationPickerProps) {
  const { currentScope, locations, isMultiLocation, selectedLabel, setLocationScope } =
    useLocationScope();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  const handleSelect = useCallback(
    (scope: 'all' | LocationId) => {
      setLocationScope(scope);
      setOpen(false);
    },
    [setLocationScope],
  );

  // Single-location account: show static label, no dropdown
  if (!isMultiLocation) {
    return (
      <span className="brand-biz">{singleLocationLabel ?? selectedLabel}</span>
    );
  }

  return (
    <div ref={containerRef} className={`loc-picker ${compact ? 'loc-picker--compact' : ''}`}>
      <button
        type="button"
        className="loc-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="loc-picker-label">{selectedLabel}</span>
        <span className={`loc-picker-chevron ${open ? 'loc-picker-chevron--open' : ''}`}>
          <Icon name="chevron-down" size={compact ? 12 : 14} />
        </span>
      </button>

      {open && (
        <div className="loc-picker-dropdown" role="menu">
          {/* All Locations option */}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={currentScope === 'all'}
            className={`loc-picker-item ${currentScope === 'all' ? 'loc-picker-item--active' : ''}`}
            onClick={() => handleSelect('all')}
          >
            <span className="loc-picker-item-label">All Locations</span>
            {currentScope === 'all' && (
              <span className="loc-picker-item-check">
                <Icon name="check" size={14} />
              </span>
            )}
          </button>

          {/* Per-location options */}
          {locations.map((loc) => {
            const label = getDisplayLabel(loc);
            const isActive = currentScope === loc.id;
            return (
              <button
                key={loc.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={`loc-picker-item ${isActive ? 'loc-picker-item--active' : ''}`}
                onClick={() => handleSelect(loc.id)}
              >
                <span className="loc-picker-item-label">
                  {loc.isPrimary && <span className="loc-picker-primary-dot" />}
                  {label}
                </span>
                {isActive && (
                  <span className="loc-picker-item-check">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </button>
            );
          })}

          {/* Add location CTA */}
          <div className="loc-picker-divider" />
          <Link
            href="/dashboard/add-location"
            className="loc-picker-item loc-picker-item--cta"
            onClick={() => setOpen(false)}
          >
            <Icon name="plus" size={14} />
            <span className="loc-picker-item-label">Add location</span>
          </Link>
        </div>
      )}
    </div>
  );
}
