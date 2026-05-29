interface LiveRegionProps {
  /** Current announcement. Empty string announces nothing. */
  message: string;
  /** 'polite' (default) → role=status; 'assertive' → role=alert (errors). */
  level?: 'polite' | 'assertive';
}

/**
 * Visually-hidden ARIA live region. Render it unconditionally and update
 * `message` — screen readers only announce changes to a region that already
 * exists in the DOM. Owns all role/aria-live mechanics so callers pass a
 * string and nothing else.
 */
export function LiveRegion({ message, level = 'polite' }: LiveRegionProps) {
  return (
    <div
      role={level === 'assertive' ? 'alert' : 'status'}
      aria-live={level}
      className="sr-only"
    >
      {message}
    </div>
  );
}
