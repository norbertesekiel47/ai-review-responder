'use client';

// Step 3 — Voice config (ToneChipPicker + ListEditor + copy-from-existing).

import { ToneChipPicker } from '@/components/dashboard/settings/ToneChipPicker';
import { ListEditor } from '@/components/dashboard/settings/ListEditor';
import { Icon } from '@/components/dashboard/Icon';
import type { ExistingLocationVoice, VoiceFormState } from '../types';

interface Step3VoiceProps {
  voiceForm: VoiceFormState;
  existingLocations: ExistingLocationVoice[];
  copyFromLocationId: string;
  voiceLoading: boolean;
  onCopyFromExisting: (locationId: string) => void;
  onVoiceFieldChange: <K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => void;
  onNext: () => void;
}

export function Step3Voice({
  voiceForm,
  existingLocations,
  copyFromLocationId,
  voiceLoading,
  onCopyFromExisting,
  onVoiceFieldChange,
  onNext,
}: Step3VoiceProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Configure your voice</h2>
      <p className="wizard-desc">
        Set how RepWorth writes replies for this location. You can copy
        settings from an existing location or customize from scratch.
      </p>

      {existingLocations.length > 0 && (
        <div className="field" style={{ marginTop: 16, marginBottom: 20 }}>
          <label className="field-label" htmlFor="copy-from">
            Copy from existing location
          </label>
          <select
            id="copy-from"
            className="select"
            value={copyFromLocationId}
            onChange={(e) => onCopyFromExisting(e.target.value)}
          >
            <option value="">Customize manually</option>
            {existingLocations.map((loc) => (
              <option key={loc.locationId} value={loc.locationId}>
                {loc.displayName}
              </option>
            ))}
          </select>
        </div>
      )}

      {voiceLoading ? (
        <p style={{ color: '#6B7280' }}>Loading voice settings…</p>
      ) : (
        <>
          <div className="set-section" style={{ marginBottom: 20 }}>
            <ToneChipPicker
              tone={voiceForm.tone}
              onChange={(v) => onVoiceFieldChange('tone', v)}
            />
          </div>

          <div className="set-section" style={{ marginBottom: 20 }}>
            <div className="set-section-head">
              <div className="set-section-icon sage">
                <Icon name="lightbulb" size={18} />
              </div>
              <div>
                <div className="set-section-title">Products &amp; services</div>
                <div className="set-section-sub">
                  A short description so we know what to highlight.
                </div>
              </div>
            </div>
            <div className="field">
              <textarea
                className="textarea textarea-tall"
                maxLength={2000}
                value={voiceForm.productsServices}
                onChange={(e) => onVoiceFieldChange('productsServices', e.target.value)}
              />
              <div className="field-counter">
                {voiceForm.productsServices.length}/2000
              </div>
            </div>
          </div>

          <div className="set-section" style={{ marginBottom: 20 }}>
            <div className="set-section-head">
              <div className="set-section-icon rose">
                <Icon name="alert" size={18} />
              </div>
              <div>
                <div className="set-section-title">Things to avoid</div>
                <div className="set-section-sub">
                  Topics or claims we shouldn&apos;t mention in replies.
                </div>
              </div>
            </div>
            <ListEditor
              items={voiceForm.avoidFacts}
              onChange={(v) => onVoiceFieldChange('avoidFacts', v)}
              placeholder="e.g. We never discount on weekends"
              addLabel="Add another"
              maxItems={20}
              maxLength={500}
            />
          </div>

          <div className="set-section">
            <div className="set-section-head">
              <div className="set-section-icon amber">
                <Icon name="edit" size={18} />
              </div>
              <div>
                <div className="set-section-title">Sample replies</div>
                <div className="set-section-sub">
                  Your own past replies — the more we have, the more
                  &quot;you&quot; we sound.
                </div>
              </div>
            </div>
            <ListEditor
              items={voiceForm.sampleResponses}
              onChange={(v) => onVoiceFieldChange('sampleResponses', v)}
              placeholder="Paste a reply you're proud of"
              addLabel="Add another"
              maxItems={10}
              maxLength={2000}
            />
          </div>
        </>
      )}

      <button
        type="button"
        className="btn btn-secondary wizard-skip-btn"
        onClick={onNext}
        style={{ marginTop: 20, width: '100%' }}
      >
        Use defaults and continue
      </button>
    </div>
  );
}
