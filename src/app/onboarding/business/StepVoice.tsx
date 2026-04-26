'use client';

import type { WizardFormData } from './BusinessWizardClient';

interface StepVoiceProps {
  data: WizardFormData;
  update: (patch: Partial<WizardFormData>) => void;
  onBack: () => void;
  onSubmit: () => void;
  onSkip: () => void;
  submitting: boolean;
}

export function StepVoice({
  data,
  update,
  onBack,
  onSubmit,
  onSkip,
  submitting,
}: StepVoiceProps) {
  const inputClass =
    'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
  const textareaClass = `${inputClass} resize-y min-h-[60px]`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-gray-900">Voice & context</h2>
          <p className="text-sm text-gray-600">
            Help us write responses that sound like you. All optional — you can
            set this up later in Settings.
          </p>
        </div>
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="text-sm text-blue-600 hover:text-blue-800 underline whitespace-nowrap disabled:opacity-50"
        >
          Skip for now
        </button>
      </div>

      <div>
        <label
          htmlFor="biz-tone"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Tone
        </label>
        <input
          id="biz-tone"
          type="text"
          value={data.tone}
          onChange={(e) => update({ tone: e.target.value })}
          className={inputClass}
        />
      </div>

      <div>
        <label
          htmlFor="biz-products"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Products / services
        </label>
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
        <label
          htmlFor="biz-staff"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Staff names
        </label>
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
        <label
          htmlFor="biz-highlight"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Highlight facts
        </label>
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
        <label
          htmlFor="biz-avoid"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Avoid facts
        </label>
        <textarea
          id="biz-avoid"
          value={data.avoidFacts}
          onChange={(e) => update({ avoidFacts: e.target.value })}
          placeholder="Things responses should NOT mention"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label
          htmlFor="biz-samples"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Sample responses
        </label>
        <textarea
          id="biz-samples"
          value={data.sampleResponses}
          onChange={(e) => update({ sampleResponses: e.target.value })}
          placeholder="Paste 1-2 previous replies that sound like you (separate with a blank line)"
          rows={3}
          className={textareaClass}
        />
      </div>

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="text-gray-600 font-medium py-2 px-4 hover:text-gray-900 disabled:opacity-50"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="bg-blue-600 text-white font-medium py-2 px-6 rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Setting up…' : 'Finish setup'}
        </button>
      </div>
    </div>
  );
}
