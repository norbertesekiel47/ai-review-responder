'use client';

import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

/**
 * Two or more views of the same card, switched in place.
 *
 * These are real tabs, not toggle buttons: the control swaps a panel without
 * leaving the page, so it carries `role="tablist"` / `role="tab"` /
 * `role="tabpanel"`, `aria-selected`, and roving tab focus with arrow keys. The
 * aggregate velocity and ranking cards previously announced as a pair of
 * independent `aria-pressed` buttons — which says "two toggles", not "one of
 * these two" — and each re-implemented the pill container in inline styles.
 *
 * Route-level switches are NOT this component. `ReviewsTabs` navigates between
 * pages, so it stays a `<nav>` with `aria-current`.
 */
export interface CardViewTabOption<Value extends string> {
  value: Value;
  label: string;
}

export function CardViewTabs<Value extends string>({
  label,
  value,
  options,
  onChange,
  children,
}: {
  /** Names the tablist for assistive tech, e.g. "Review velocity view". */
  label: string;
  value: Value;
  options: ReadonlyArray<CardViewTabOption<Value>>;
  onChange: (next: Value) => void;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const rawId = useId().replace(/:/g, '');
  const tabId = (option: Value) => `card-view-tab-${rawId}-${option}`;
  const panelId = `card-view-panel-${rawId}`;

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const current = options.findIndex((option) => option.value === value);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : event.key === 'ArrowRight'
            ? (current + 1) % options.length
            : (current - 1 + options.length) % options.length;

    const target = options[next];
    if (!target) return;
    onChange(target.value);
    // Selection follows focus, so move focus to the tab that just became
    // selected rather than leaving it on the old one.
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(target.value))}`)
        ?.focus();
    });
  }

  return (
    <>
      <div
        ref={listRef}
        className="card-view-tabs"
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              id={tabId(option.value)}
              type="button"
              role="tab"
              className={`tab ${selected ? 'active' : ''}`}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(value)}>
        {children}
      </div>
    </>
  );
}
