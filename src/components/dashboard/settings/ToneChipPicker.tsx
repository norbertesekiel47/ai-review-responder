'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { inferActiveTone } from '@/components/dashboard/settings/ToneChipPicker.helpers';

const TONES: { id: string; label: string; canonical: string; preview: string }[] = [
  { id: 'warm', label: 'Warm & friendly', canonical: 'warm, friendly', preview: "Thanks so much for the kind words! It really means the world to our little team." },
  { id: 'witty', label: 'Warm + witty', canonical: 'warm, witty, occasionally cheeky', preview: "We're absolutely chuffed you enjoyed the oat latte — Marco will be insufferable about this all week." },
  { id: 'professional', label: 'Professional', canonical: 'professional', preview: 'Thank you for taking the time to share your experience. We are delighted you enjoyed your visit.' },
  { id: 'casual', label: 'Casual', canonical: 'casual', preview: "Aw thanks! So happy you had a good one. Pop in any time — coffee's on us." },
  { id: 'concise', label: 'Concise', canonical: 'concise', preview: 'Thank you. Glad you enjoyed it. See you next time.' },
];

const CUSTOM_ID = 'custom';

/** Every chip in tab order — the five presets, then Custom. One is checked. */
const CHIP_IDS = [...TONES.map((t) => t.id), CUSTOM_ID];

const FALLBACK_PREVIEW = 'Thanks for the kind review — we appreciate you taking the time.';

interface Props {
  tone: string;
  onChange: (next: string) => void;
}

/**
 * Arrow-key movement inside the radiogroup: right/down = next, left/up =
 * previous (wrapping), Home/End = first/last. Returns null for any other key.
 */
export function nextChipIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function ToneChipPicker({ tone, onChange }: Props) {
  // Local mode override so clicking "Custom…" always reveals the textarea,
  // even when the current tone string would otherwise infer to a preset.
  const [override, setOverride] = useState<string | null>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Track the last value we wrote so we can tell when `tone` changed externally
  // (e.g. parent called Discard, or initial fetch resolved) vs. by our own
  // handlers. An external change drops the override so the chip strip reflects
  // truth. This is React's "adjust state during render when a prop changes"
  // pattern — the reset lands in the same commit as the prop change (no effect,
  // no stale-UI flash); React bails out before committing the discarded render.
  // react-doctor-disable-next-line react-doctor/no-derived-useState, react-doctor/rerender-state-only-in-handlers -- react.dev "adjust state during render" prev-value pattern: lastWritten IS read during render (the comparison below gates the override reset) and must be state, not a ref — refs must not be written during render, and the setState-during-render re-render bail-out is the point
  const [lastWritten, setLastWritten] = useState(tone);
  if (tone !== lastWritten) {
    setLastWritten(tone);
    setOverride(null);
  }

  const active = override ?? inferActiveTone(tone);
  const preview = TONES.find((t) => t.id === active)?.preview ?? FALLBACK_PREVIEW;

  const pickPreset = (id: string, canonical: string) => {
    setOverride(id);
    setLastWritten(canonical);
    onChange(canonical);
  };

  const pickCustom = () => {
    setOverride(CUSTOM_ID);
    // Don't clobber the existing tone — the user may want to edit it.
    // lastWritten stays as-is; tone hasn't changed.
  };

  const pick = (id: string) => {
    if (id === CUSTOM_ID) {
      pickCustom();
      return;
    }
    const preset = TONES.find((t) => t.id === id);
    if (preset) pickPreset(preset.id, preset.canonical);
  };

  const handleCustomTyping = (next: string) => {
    setLastWritten(next);
    onChange(next);
  };

  // Native radio semantics: the arrow keys both move focus AND select, so a
  // keyboard user hears "Professional, selected, 3 of 6" as they move — not
  // six independent toggles.
  const onGroupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = CHIP_IDS.indexOf(active);
    const next = nextChipIndex(event.key, current < 0 ? 0 : current, CHIP_IDS.length);
    if (next === null) return;
    event.preventDefault();
    const id = CHIP_IDS[next];
    if (id === undefined) return;
    pick(id);
    chipRefs.current[next]?.focus();
  };

  const renderChip = (id: string, label: string, index: number) => {
    const checked = active === id;
    return (
      <button
        key={id}
        ref={(node) => {
          chipRefs.current[index] = node;
        }}
        type="button"
        role="radio"
        aria-checked={checked}
        // Roving tabindex: Tab lands on the selected chip; arrows move within.
        tabIndex={checked ? 0 : -1}
        className={`tone-chip ${checked ? 'active' : ''}`}
        onClick={() => pick(id)}
      >
        {label}
      </button>
    );
  };

  return (
    <div>
      <div
        className="tone-grid"
        role="radiogroup"
        aria-label="Reply tone"
        onKeyDown={onGroupKeyDown}
      >
        {TONES.map((t, index) => renderChip(t.id, t.label, index))}
        {renderChip(CUSTOM_ID, 'Custom…', TONES.length)}
      </div>

      {active === CUSTOM_ID && (
        <div className="field" style={{ marginTop: 12 }}>
          <textarea
            aria-label="Custom reply tone"
            className="textarea"
            maxLength={100}
            value={tone}
            onChange={(e) => handleCustomTyping(e.target.value)}
            placeholder="e.g. warm, witty, occasionally cheeky"
          />
          <div className="field-counter">{tone.length}/100</div>
        </div>
      )}

      <div className="tone-preview" key={active + preview}>
        <div className="tone-preview-eyebrow">
          <Icon name="sparkle" size={11} className="sparkle-icon" /> Sample reply preview
        </div>
        <span className="tone-preview-text">&ldquo;{preview}&rdquo;</span>
      </div>
    </div>
  );
}
