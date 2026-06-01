/**
 * Branded loading placeholder for settings panels. One owner of the settings
 * loading look — replaces the plain "Loading settings…" text across the
 * settings tabs (P2 #28). Announces busy state to assistive tech.
 */
export function SettingsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <output className="settings-skeleton" aria-busy="true">
      <span className="sr-only">Loading settings…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="settings-skeleton__row" aria-hidden="true">
          <div className="settings-skeleton__label" />
          <div className="settings-skeleton__field" />
        </div>
      ))}
    </output>
  );
}
