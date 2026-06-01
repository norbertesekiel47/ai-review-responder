'use client';

import { Icon } from '@/components/dashboard/Icon';
import { ToneChipPicker } from './ToneChipPicker';
import { ListEditor } from './ListEditor';

// Voice form fields shared by both SettingsForm (single-location) and
// VoiceFormState (per-location). BrandVoicePanel only needs the voice-
// specific fields, not the full settings form.
interface VoiceFormFields {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

/**
 * Props for BrandVoicePanel.
 * Uses a simple setter signature compatible with both useSettingsForm.set
 * and useLocationVoiceForm.set, regardless of the parent form's exact type.
 */
interface Props {
  form: VoiceFormFields;
  set: (key: 'tone' | 'productsServices' | 'avoidFacts' | 'sampleResponses', value: string | string[]) => void;
}

export function BrandVoicePanel({ form, set }: Props) {
  return (
    <>
      <div className="set-section" id="brand-voice">
        <div className="set-section-head">
          <div className="set-section-icon violet">
            <Icon name="sparkle" size={18} />
          </div>
          <div>
            <div className="set-section-title">Response tone</div>
            <div className="set-section-sub">
              Pick a tone or describe your own. We&apos;ll match your replies to this voice.
            </div>
          </div>
        </div>

        <ToneChipPicker tone={form.tone} onChange={(v) => set('tone', v)} />
      </div>

      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage">
            <Icon name="lightbulb" size={18} />
          </div>
          <div>
            <label className="set-section-title" htmlFor="brand-products-services">
              Products &amp; services
            </label>
            <div className="set-section-sub">
              A short description so we know what to highlight when replies call for it.
            </div>
          </div>
        </div>
        <div className="field">
          <textarea
            id="brand-products-services"
            className="textarea textarea-tall"
            maxLength={2000}
            value={form.productsServices}
            onChange={(e) => set('productsServices', e.target.value)}
          />
          <div className="field-counter">{form.productsServices.length}/2000</div>
        </div>
      </div>

      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon rose">
            <Icon name="alert" size={18} />
          </div>
          <div>
            <div className="set-section-title">Things to avoid</div>
            <div className="set-section-sub">
              Topics or claims we shouldn&apos;t mention in replies. One per line.
            </div>
          </div>
        </div>
        <ListEditor
          items={form.avoidFacts}
          onChange={(v) => set('avoidFacts', v)}
          placeholder="e.g. We never discount on weekends"
          addLabel="Add another"
          itemLabel="thing to avoid"
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
              Your own past replies — the more we have, the more &quot;you&quot; we sound.
            </div>
          </div>
        </div>
        <ListEditor
          items={form.sampleResponses}
          onChange={(v) => set('sampleResponses', v)}
          placeholder="Paste a reply you're proud of"
          addLabel="Add another"
          itemLabel="sample reply"
          maxItems={10}
          maxLength={2000}
        />
      </div>
    </>
  );
}
