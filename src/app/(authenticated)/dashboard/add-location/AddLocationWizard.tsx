'use client';

// src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx
//
// 4-step Add-location wizard — composing shell. State + side effects live in
// wizard/useAddLocationWizard; each step is a presentational component under
// wizard/steps/. The shell renders the step indicator, the active step, and
// the bottom Back/Continue navigation.
//
// Steps:
//   1. Place autocomplete + display_label input
//   2. Google Business info (informational only, connect later from Settings)
//   3. Voice config (ToneChipPicker + ListEditor + copy-from-existing shortcut)
//   4. Confirm-and-pay with proration preview
//
// Validation contract: VAL-LOC-073 (wizard completes when Zernio skipped),
// VAL-SETTINGS-043 (display_label validation), VAL-SETTINGS-044 (duplicate
// Place ID rejected).

import { Icon } from '@/components/dashboard/Icon';
import { TopBar } from '@/components/dashboard/TopBar';
import { useAddLocationWizard } from './wizard/useAddLocationWizard';
import type { Props, WizardStep } from './wizard/types';
import { Step1Location } from './wizard/steps/Step1Location';
import { Step2GoogleBusiness } from './wizard/steps/Step2GoogleBusiness';
import { Step3Voice } from './wizard/steps/Step3Voice';
import { Step4Confirm } from './wizard/steps/Step4Confirm';

export function AddLocationWizard(props: Props) {
  const wiz = useAddLocationWizard(props);

  return (
    <>
      <TopBar
        title={wiz.stepInfo.title}
        subtitle={wiz.stepInfo.subtitle}
        rightLink={{ href: '/dashboard', label: 'Cancel' }}
      />
      <div className="wizard-container">
        {/* Step indicator */}
        <div className="wizard-steps">
          {([1, 2, 3, 4] as WizardStep[]).map((s) => (
            <div
              key={s}
              className={`wizard-step-dot ${s === wiz.step ? 'active' : ''} ${s < wiz.step ? 'done' : ''}`}
            >
              <span className="wizard-step-num">{s}</span>
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {wiz.step === 1 && (
            <Step1Location
              displayLabel={wiz.displayLabel}
              displayLabelError={wiz.displayLabelError}
              inputMode={wiz.inputMode}
              googleMapsUrl={wiz.googleMapsUrl}
              placeIdDuplicateError={wiz.placeIdDuplicateError}
              onDisplayLabelChange={wiz.setDisplayLabel}
              onSelectPlace={wiz.selectPlace}
              onClearPlace={wiz.clearPlace}
              onMapsUrlChange={wiz.setMapsUrl}
              onToggleInputMode={wiz.toggleInputMode}
            />
          )}

          {wiz.step === 2 && <Step2GoogleBusiness onNext={wiz.goNext} />}

          {wiz.step === 3 && (
            <Step3Voice
              voiceForm={wiz.voiceForm}
              existingLocations={wiz.existingLocations}
              copyFromLocationId={wiz.copyFromLocationId}
              voiceLoading={wiz.voiceLoading}
              onCopyFromExisting={wiz.copyFromExisting}
              onVoiceFieldChange={wiz.setVoiceField}
              onNext={wiz.goNext}
            />
          )}

          {wiz.step === 4 && (
            <Step4Confirm
              displayLabel={wiz.displayLabel}
              placeSelection={wiz.placeSelection}
              inputMode={wiz.inputMode}
              googleMapsUrl={wiz.googleMapsUrl}
              copyFromLocationId={wiz.copyFromLocationId}
              existingLocations={wiz.existingLocations}
              billingSnapshot={props.billingSnapshot}
              billingPreview={wiz.billingPreview}
              proration={wiz.proration}
              newMonthlyTotalCents={wiz.newMonthlyTotalCents}
              submitting={wiz.submitting}
              submitError={wiz.submitError}
              onSubmit={wiz.handleSubmit}
            />
          )}
        </div>

        {/* Step navigation */}
        <div className="wizard-nav">
          {wiz.step > 1 && (
            <button type="button" className="btn btn-secondary" onClick={wiz.goBack}>
              <Icon name="chevron-down" size={14} style={{ transform: 'rotate(90deg)' }} /> Back
            </button>
          )}
          <div className="wizard-nav-spacer" />
          {wiz.step < 4 && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={wiz.goNext}
              disabled={wiz.step === 1 && !wiz.step1HasLocationDetails}
            >
              Continue <Icon name="chevron-down" size={14} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
