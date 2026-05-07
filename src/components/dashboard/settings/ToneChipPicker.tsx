'use client';

import { Icon } from '@/components/dashboard/Icon';

const TONES: { id: string; label: string; canonical: string; preview: string }[] = [
  { id: 'warm', label: 'Warm & friendly', canonical: 'warm, friendly', preview: "Thanks so much for the kind words! It really means the world to our little team." },
  { id: 'witty', label: 'Warm + witty', canonical: 'warm, witty, occasionally cheeky', preview: "We're absolutely chuffed you enjoyed the oat latte — Marco will be insufferable about this all week." },
  { id: 'professional', label: 'Professional', canonical: 'professional', preview: 'Thank you for taking the time to share your experience. We are delighted you enjoyed your visit.' },
  { id: 'casual', label: 'Casual', canonical: 'casual', preview: "Aw thanks! So happy you had a good one. Pop in any time — coffee's on us." },
  { id: 'concise', label: 'Concise', canonical: 'concise', preview: 'Thank you. Glad you enjoyed it. See you next time.' },
];

const FALLBACK_PREVIEW = 'Thanks for the kind review — we appreciate you taking the time.';

export function inferActiveTone(tone: string): string {
  const lower = tone.toLowerCase();
  if (lower.includes('witty') || lower.includes('cheeky')) return 'witty';
  if (lower.includes('professional')) return 'warm'; // "professional + friendly" lands here
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
  const active = inferActiveTone(tone);
  const preview = TONES.find((t) => t.id === active)?.preview ?? FALLBACK_PREVIEW;

  return (
    <div>
      <div className="tone-grid">
        {TONES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tone-chip ${active === t.id ? 'active' : ''}`}
            onClick={() => onChange(t.canonical)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className={`tone-chip ${active === 'custom' ? 'active' : ''}`}
          onClick={() => onChange(tone || 'custom')}
        >
          Custom…
        </button>
      </div>

      {active === 'custom' && (
        <div className="field" style={{ marginTop: 12 }}>
          <textarea
            className="textarea"
            maxLength={100}
            value={tone}
            onChange={(e) => onChange(e.target.value)}
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
