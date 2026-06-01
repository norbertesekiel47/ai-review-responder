'use client';

import { useRef } from 'react';

interface Props {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
  /** Server-enforced ceiling — disables Add when reached. */
  maxItems?: number;
  /** Server-enforced ceiling on each item's character length. */
  maxLength?: number;
  /** Human-readable item name used for screen reader labels. */
  itemLabel?: string;
}

export function ListEditor({ items, onChange, placeholder, addLabel, maxItems, maxLength, itemLabel = 'item' }: Props) {
  const nextKeyRef = useRef(0);
  const itemKeysRef = useRef<string[]>([]);

  while (itemKeysRef.current.length < items.length) {
    itemKeysRef.current.push(`list-editor-item-${nextKeyRef.current}`);
    nextKeyRef.current += 1;
  }

  if (itemKeysRef.current.length > items.length) {
    itemKeysRef.current = itemKeysRef.current.slice(0, items.length);
  }

  const rows = items.map((it, i) => ({
    key: itemKeysRef.current[i]!,
    value: it,
    index: i,
  }));

  const update = (i: number, v: string) => {
    const next = items.slice();
    // Defensive trim so a paste that exceeds the cap still saves cleanly;
    // the input's `maxLength` attribute already prevents typing past it.
    next[i] = maxLength != null ? v.slice(0, maxLength) : v;
    onChange(next);
  };
  const remove = (i: number) => {
    itemKeysRef.current = itemKeysRef.current.filter((_, idx) => idx !== i);
    onChange(items.filter((_, idx) => idx !== i));
  };
  const add = () => {
    itemKeysRef.current.push(`list-editor-item-${nextKeyRef.current}`);
    nextKeyRef.current += 1;
    onChange([...items, '']);
  };

  const atItemLimit = maxItems != null && items.length >= maxItems;
  const itemCounter = maxItems != null ? `${items.length}/${maxItems}` : null;

  return (
    <div className="list-editor">
      {rows.map((row) => (
        <div className="list-row" key={row.key}>
          <input
            aria-label={`Edit ${itemLabel} ${row.index + 1}`}
            className="input"
            value={row.value}
            maxLength={maxLength}
            onChange={(e) => update(row.index, e.target.value)}
            placeholder={placeholder}
          />
          <button type="button" className="list-row-x" onClick={() => remove(row.index)} aria-label={`Remove ${itemLabel} ${row.index + 1}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          className="list-add"
          onClick={add}
          disabled={atItemLimit}
          aria-disabled={atItemLimit}
          style={atItemLimit ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {atItemLimit ? `Maximum ${maxItems} reached` : addLabel}
        </button>
        {itemCounter && <div className="field-counter">{itemCounter}</div>}
      </div>
    </div>
  );
}
