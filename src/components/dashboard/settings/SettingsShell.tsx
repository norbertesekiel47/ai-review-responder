'use client';

import { Icon } from '@/components/dashboard/Icon';
import { SettingsTabs, type SettingsTab } from '@/components/dashboard/SettingsTabs';
import { LiveRegion } from '@/components/ui/LiveRegion';

interface Props {
  activeTab: SettingsTab;
  children: React.ReactNode;
  saveBar?: {
    visible: boolean;
    dirtyCount: number;
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
  };
  savedFlash?: boolean;
  /** Latest save-error message; announced assertively to screen readers. */
  saveError?: string;
  /** When true, exposes the Locations tab without switching to true multi-location content mode. */
  locationsSettingsEnabled?: boolean;
  /** When true, shows 4-tab layout (Account, Locations, Voice, Notifications). */
  multiLocationEnabled?: boolean;
}

export function SettingsShell({
  activeTab,
  children,
  saveBar,
  savedFlash,
  saveError,
  locationsSettingsEnabled,
  multiLocationEnabled,
}: Props) {
  return (
    <div className="settings-content">
      <SettingsTabs
        activeTab={activeTab}
        locationsSettingsEnabled={locationsSettingsEnabled}
        multiLocationEnabled={multiLocationEnabled}
      />
      {children}

      {/* Conditional render rather than CSS-toggle — keeps a clean DOM
          (no "0 unsaved changes" lurking when there's nothing to save) and
          still plays the slide-up animation on mount. The slide-down on
          discard is dropped intentionally; the bar simply unmounts. */}
      {saveBar?.visible && (
        <div className="save-bar visible">
          <span className="save-bar-text">
            <strong>
              {saveBar.dirtyCount} unsaved {saveBar.dirtyCount === 1 ? 'change' : 'changes'}
            </strong>{' '}
            · Discard or save below
          </span>
          <div className="save-bar-spacer" />
          <button type="button" className="btn btn-secondary" onClick={saveBar.onDiscard} disabled={saveBar.saving}>
            Discard
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={saveBar.onSave}
            disabled={saveBar.saving}
            style={{ background: 'var(--rw-blue-600)' }}
          >
            {saveBar.saving ? (
              'Saving…'
            ) : (
              <>
                <Icon name="check" size={14} /> Save changes
              </>
            )}
          </button>
        </div>
      )}

      <LiveRegion message={savedFlash ? 'Settings saved' : ''} />
      <LiveRegion message={saveError ?? ''} level="assertive" />
      <div className={`saved-toast ${savedFlash ? 'visible' : ''}`}>
        <Icon name="check" size={14} /> Settings saved
      </div>
    </div>
  );
}
