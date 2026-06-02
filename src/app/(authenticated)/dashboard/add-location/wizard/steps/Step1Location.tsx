'use client';

// Step 1 — Place autocomplete + display_label input.

import { PlaceAutocomplete, type PlaceSelection } from '@/components/places/PlaceAutocomplete';
import type { LocationInputMode } from '../types';

interface Step1LocationProps {
  displayLabel: string;
  displayLabelError: string | null;
  inputMode: LocationInputMode;
  googleMapsUrl: string;
  placeIdDuplicateError: string | null;
  onDisplayLabelChange: (value: string) => void;
  onSelectPlace: (selection: PlaceSelection) => void;
  onClearPlace: () => void;
  onMapsUrlChange: (value: string) => void;
  onToggleInputMode: () => void;
}

export function Step1Location({
  displayLabel,
  displayLabelError,
  inputMode,
  googleMapsUrl,
  placeIdDuplicateError,
  onDisplayLabelChange,
  onSelectPlace,
  onClearPlace,
  onMapsUrlChange,
  onToggleInputMode,
}: Step1LocationProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Select your business location</h2>
      <p className="wizard-desc">
        Search for your business on Google. We&apos;ll use this to connect
        your Google Business Profile and import reviews.
      </p>

      <div className="field" style={{ marginTop: 20 }}>
        <label className="field-label" htmlFor="display-label">
          Location name
        </label>
        <input
          id="display-label"
          className={`input ${displayLabelError ? 'input-error' : ''}`}
          value={displayLabel}
          onChange={(e) => onDisplayLabelChange(e.target.value)}
          placeholder="e.g. Downtown Cafe"
          maxLength={255}
        />
        {displayLabelError && <p className="field-error">{displayLabelError}</p>}
        <div className="field-counter">{displayLabel.length}/255</div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <div className="field-label" id="add-location-address-label">Business address</div>
        {inputMode === 'autocomplete' ? (
          <PlaceAutocomplete
            onPlaceSelect={onSelectPlace}
            onClear={onClearPlace}
            placeholder="Search for your business..."
            ariaLabelledBy="add-location-address-label"
          />
        ) : (
          <input
            aria-labelledby="add-location-address-label"
            className="input"
            type="url"
            value={googleMapsUrl}
            onChange={(e) => onMapsUrlChange(e.target.value)}
            placeholder="https://maps.google.com/..."
            autoComplete="url"
          />
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onToggleInputMode}
          style={{ marginTop: 8, fontSize: 12, padding: '6px 10px' }}
        >
          {inputMode === 'autocomplete' ? 'Paste Google Maps URL' : 'Use Google search'}
        </button>
        {placeIdDuplicateError && (
          <p className="field-error" style={{ marginTop: 4 }}>
            {placeIdDuplicateError}
          </p>
        )}
      </div>
    </div>
  );
}
