'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/dashboard/Icon';

const TONES: { id: string; label: string; canonical: string; preview: string }[] = [
  { id: 'warm', label: 'Warm & friendly', canonical: 'warm, friendly', preview: "Thanks so much for the kind words! It really means the world to our little team." },
  { id: 'witty', label: 'Warm + witty', canonical: 'warm, witty, occasionally cheeky', preview: "We're absolutely chuffed you enjoyed the oat latte — Marco will be insufferable about this all week." },
  { id: 'professional', label: 'Professional', canonical: 'professional', preview: 'Thank you for taking the time to share your experience. We are delighted you enjoyed your visit.' },
  { id: 'casual', label: 'Casual', canonical: 'casual', preview: "Aw thanks! So happy you had a good one. Pop in any time — coffee's on us." },
  { id: 'concise', label: 'Concise', canonical: 'concise', preview: 'Thank you. Glad you enjoyed it. See you next time.' },
];

const FALLBACK_PREVIEW = 'Thanks for the kind review — we appreciate you taking the time.';

/**
 * Best-effort guess of which preset tone matches an existing string. Used to
 * highlight a chip on first render. The picker tracks active mode in local
 * state so it can switch to "custom" regardless of what `tone` infers to.
 */
export function inferActiveTone(tone: string): string {
  const lower = tone.toLowerCase();
  if (lower.includes('witty') || lower.includes('cheeky')) return 'witty';
  if (lower.includes('professional')) return 'professional';
  if (lower.includes('warm') || lower.includes('friendly')) return 'warm';
  if (lower.includes('casual')) return 'casual';
  if (lower.includes('concise')) return 'concise';
  return 'custom';
}

interface Props {
  tone: string;
  onChange: (next: string) => void;
}

export function ToneChipPicker({ tone, onChange }: Props) {
  // Local mode override so clicking "Custom…" always reveals the textarea,
  // even when the current tone string would otherwise infer to a preset.
  const [override, setOverride] = useState<string | null>(null);

  // Track the last value we wrote so we can tell when `tone` changed
  // externally (e.g. parent called Discard, or initial fetch resolved).
  // External changes drop the override so the chip strip reflects truth.
  const lastWrittenRef = useRef(tone);
  useEffect(() => {
    if (tone !== lastWrittenRef.current) {
      setOverride(null);
      lastWrittenRef.current = tone;
    }
  }, [tone]);

  const active = override ?? inferActiveTone(tone);
  const preview = TONES.find((t) => t.id === active)?.preview ?? FALLBACK_PREVIEW;

  const pickPreset = (id: string, canonical: string) => {
    setOverride(id);
    lastWrittenRef.current = canonical;
    onChange(canonical);
  };

  const pickCustom = () => {
    setOverride('custom');
    // Don't clobber the existing tone — the user may want to edit it.
    // lastWrittenRef stays as-is; tone hasn't changed.
  };

  const handleCustomTyping = (next: string) => {
    lastWrittenRef.current = next;
    onChange(next);
  };

  return (
    <div>
      <div className="tone-grid">
        {TONES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tone-chip ${active === t.id ? 'active' : ''}`}
            onClick={() => pickPreset(t.id, t.canonical)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className={`tone-chip ${active === 'custom' ? 'active' : ''}`}
          onClick={pickCustom}
        >
          Custom…
        </button>
      </div>

      {active === 'custom' && (
        <div className="field" style={{ marginTop: 12 }}>
          <textarea
            aria-label="Custom response tone"
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
