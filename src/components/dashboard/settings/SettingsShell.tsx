'use client';

import { useEffect, useRef } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { useToast } from '@/components/dashboard/shell/toast/ToastProvider';

interface Props {
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
}

export function SettingsShell({ children, saveBar, savedFlash, saveError }: Props) {
  const { toast } = useToast();
  const wasFlashing = useRef(false);

  // Rising edge only: `savedFlash` stays true for the length of the flash
  // window, so a value read would re-raise on every unrelated re-render.
  useEffect(() => {
    const flashing = savedFlash === true;
    if (flashing && !wasFlashing.current) {
      toast({ tone: 'success', title: 'Settings saved' });
    }
    wasFlashing.current = flashing;
  }, [savedFlash, toast]);

  return (
    <div className="settings-content">
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
            </strong>
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

      {/* The save CONFIRMATION is announced by the toast above (role="status"),
          so a second live region here would read it twice. The save ERROR keeps
          its own assertive region: its visible copy is an inline paragraph in
          each settings client, which carries no live semantics of its own. */}
      <LiveRegion message={saveError ?? ''} level="assertive" />
    </div>
  );
}
