'use client';

import { Icon } from '@/components/dashboard/Icon';
import { SettingsTabs, type SettingsTab } from '@/components/dashboard/SettingsTabs';

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
}

export function SettingsShell({ activeTab, children, saveBar, savedFlash }: Props) {
  return (
    <div className="settings-content">
      <SettingsTabs activeTab={activeTab} />
      {children}

      {saveBar && (
        <div className={`save-bar ${saveBar.visible ? 'visible' : ''}`}>
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

      <div className={`saved-toast ${savedFlash ? 'visible' : ''}`}>
        <Icon name="check" size={14} /> Settings saved
      </div>
    </div>
  );
}
