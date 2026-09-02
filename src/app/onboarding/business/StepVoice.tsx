'use client';

import type { WizardFormData } from './BusinessWizardClient';
import { StepHeading } from './StepHeading';
import { LazyMotion, m, domAnimation } from 'motion/react';
import {
  fieldClass,
  textareaClass,
  labelClass,
  primaryButtonClass,
  ghostButtonClass,
  buttonMotion,
} from '../_shared/field-styles';

interface StepVoiceProps {
  stepLabel: string;
  data: WizardFormData;
  update: (patch: Partial<WizardFormData>) => void;
  onBack: () => void;
  onSubmit: () => void;
  onSkip: () => void;
  submitting: boolean;
  /**
   * Primary label, owned by the flow: "Finish setup" when Voice is the last
   * step (legacy), "Continue →" when Connect follows (demo flow). The button
   * must never promise to finish when it only advances (A11).
   */
  submitLabel: string;
}

export function StepVoice({
  stepLabel,
  data,
  update,
  onBack,
  onSubmit,
  onSkip,
  submitting,
  submitLabel,
}: StepVoiceProps) {
  return (
    <LazyMotion features={domAnimation}>
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <StepHeading stepLabel={stepLabel}>Voice &amp; context</StepHeading>
          <p className="text-sm text-rw-ink-soft">
            Help us write replies that sound like you. All optional, you can
            set this up later in Settings.
          </p>
        </div>
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="text-sm text-rw-teal-strong hover:text-rw-teal-strong-hover underline whitespace-nowrap disabled:opacity-50"
        >
          Skip for now
        </button>
      </div>

      <div>
        <label htmlFor="biz-tone" className={labelClass}>Tone</label>
        <input
          id="biz-tone"
          type="text"
          value={data.tone}
          onChange={(e) => update({ tone: e.target.value })}
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="biz-products" className={labelClass}>Products / services</label>
        <textarea
          id="biz-products"
          value={data.productsServices}
          onChange={(e) => update({ productsServices: e.target.value })}
          placeholder="Pizza, pasta, weekend brunch…"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-staff" className={labelClass}>Staff names</label>
        <textarea
          id="biz-staff"
          value={data.staffNames}
          onChange={(e) => update({ staffNames: e.target.value })}
          placeholder="One per line, or comma-separated"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-highlight" className={labelClass}>Highlight facts</label>
        <textarea
          id="biz-highlight"
          value={data.highlightFacts}
          onChange={(e) => update({ highlightFacts: e.target.value })}
          placeholder="e.g. opened 2010, family-owned, locally-sourced"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-avoid" className={labelClass}>Avoid facts</label>
        <textarea
          id="biz-avoid"
          value={data.avoidFacts}
          onChange={(e) => update({ avoidFacts: e.target.value })}
          placeholder="Things replies should NOT mention"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-samples" className={labelClass}>Sample replies</label>
        <textarea
          id="biz-samples"
          value={data.sampleResponses}
          onChange={(e) => update({ sampleResponses: e.target.value })}
          placeholder="Paste 1-2 previous replies that sound like you (separate with a blank line)"
          rows={3}
          className={textareaClass}
        />
      </div>

      <div className="flex justify-between items-center pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className={ghostButtonClass}
        >
          ← Back
        </button>
        <m.button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          {submitting ? 'Setting up…' : submitLabel}
        </m.button>
      </div>
    </div>
    </LazyMotion>
  );
}
