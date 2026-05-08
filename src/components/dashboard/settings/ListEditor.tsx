'use client';

interface Props {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
  /** Server-enforced ceiling — disables Add when reached. */
  maxItems?: number;
  /** Server-enforced ceiling on each item's character length. */
  maxLength?: number;
}

export function ListEditor({ items, onChange, placeholder, addLabel, maxItems, maxLength }: Props) {
  const update = (i: number, v: string) => {
    const next = items.slice();
    // Defensive trim so a paste that exceeds the cap still saves cleanly;
    // the input's `maxLength` attribute already prevents typing past it.
    next[i] = maxLength != null ? v.slice(0, maxLength) : v;
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, '']);

  const atItemLimit = maxItems != null && items.length >= maxItems;
  const itemCounter = maxItems != null ? `${items.length}/${maxItems}` : null;

  return (
    <div className="list-editor">
      {items.map((it, i) => (
        <div className="list-row" key={i}>
          <input
            className="input"
            value={it}
            maxLength={maxLength}
            onChange={(e) => update(i, e.target.value)}
            placeholder={placeholder}
          />
          <button type="button" className="list-row-x" onClick={() => remove(i)} aria-label="Remove">
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
