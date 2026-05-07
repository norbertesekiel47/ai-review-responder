'use client';

interface Props {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
}

export function ListEditor({ items, onChange, placeholder, addLabel }: Props) {
  const update = (i: number, v: string) => {
    const next = items.slice();
    next[i] = v;
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, '']);
  return (
    <div className="list-editor">
      {items.map((it, i) => (
        <div className="list-row" key={i}>
          <input
            className="input"
            value={it}
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
      <button type="button" className="list-add" onClick={add}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {addLabel}
      </button>
    </div>
  );
}
