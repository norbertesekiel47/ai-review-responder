'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpenRef = useRef<'first' | 'last' | 'selected'>('selected');
  const pickerId = useId().replace(/:/g, '');
  const triggerId = `location-picker-trigger-${pickerId}`;
  const menuId = `location-picker-menu-${pickerId}`;

  const getMenuItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const openMenu = useCallback((focus: 'first' | 'last' | 'selected' = 'selected') => {
    focusOnOpenRef.current = focus;
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = getMenuItems();
      const selected = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      const target =
        focusOnOpenRef.current === 'first'
          ? items[0]
          : focusOnOpenRef.current === 'last'
            ? items.at(-1)
            : selected ?? items[0];
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [getMenuItems, open]);

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

  const handleSelect = useCallback(
    (scope: 'all' | LocationId) => {
      setLocationScope(scope);
      closeAndRestoreFocus();
    },
    [closeAndRestoreFocus, setLocationScope],
  );

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    event.preventDefault();
    const items = getMenuItems();
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  // Single-location account: show static label, no dropdown
  if (!isMultiLocation) {
    return (
      <span className="brand-biz">{singleLocationLabel ?? selectedLabel}</span>
    );
  }

  return (
    <div ref={containerRef} className={`loc-picker ${compact ? 'loc-picker--compact' : ''}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="loc-picker-trigger"
        onClick={() => (open ? closeAndRestoreFocus() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
      >
        <span className="loc-picker-label">{selectedLabel}</span>
        <span className={`loc-picker-chevron ${open ? 'loc-picker-chevron--open' : ''}`}>
          <Icon name="chevron-down" size={compact ? 12 : 14} />
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="loc-picker-dropdown"
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
        >
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
            role="menuitem"
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
