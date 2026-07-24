'use client';

// Voice Report Card section (ticket #540): what voice learning inferred from
// the owner's own edits. States: loading, error, pre-activation progress
// (N of 5), detected traits, zero-trait fallback. Presentation-only — all
// derivation lives in the report-card route + voice-report-card module.

import { useEffect, useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { SettingsSkeleton } from '@/components/dashboard/settings/SettingsSkeleton';

interface TraitSnippet {
  before: string;
  after: string;
}

interface RegisterTrait {
  key: string;
  name: string;
  claim: string;
  snippet: TraitSnippet;
}

interface ReportCardResponse {
  activationThreshold: number;
  editedCount: number;
  activated: boolean;
  traits: RegisterTrait[];
  fallbackSnippet: TraitSnippet | null;
}

const SNIPPET_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 4,
};

function SnippetBlock({ snippet }: { snippet: TraitSnippet }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          background: 'var(--rw-recess)',
          border: '1px solid var(--rw-app-border-soft)',
          borderRadius: 8,
          padding: '10px 12px',
        }}
      >
        <div style={{ ...SNIPPET_LABEL_STYLE, color: 'var(--rw-app-text-muted)' }}>Draft</div>
        <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, margin: 0 }}>
          {snippet.before}
        </p>
      </div>
      <div
        style={{
          background: 'var(--rw-sage-soft)',
          borderLeft: '3px solid var(--rw-sage-deep)',
          borderRadius: 8,
          padding: '10px 12px',
        }}
      >
        <div style={{ ...SNIPPET_LABEL_STYLE, color: 'var(--rw-sage-deep)' }}>Your edit</div>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--rw-app-text)', lineHeight: 1.5, margin: 0 }}>
          {snippet.after}
        </p>
      </div>
    </div>
  );
}

function ProgressDots({ editedCount, threshold }: { editedCount: number; threshold: number }) {
  const filled = Math.min(editedCount, threshold);
  return (
    <div
      role="img"
      aria-label={`${filled} of ${threshold} edited replies`}
      style={{ display: 'flex', gap: 8 }}
    >
      {Array.from({ length: threshold }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: i < filled ? 'var(--rw-accent-600)' : 'transparent',
            border: `1.5px solid ${i < filled ? 'var(--rw-accent-600)' : 'var(--rw-app-border)'}`,
          }}
        />
      ))}
    </div>
  );
}

// Parent renders this keyed by locationId, so a location switch remounts the
// component with fresh loading state — no synchronous setState-in-effect reset.
export function VoiceReportCard({ locationId }: { locationId: string }) {
  const [data, setData] = useState<ReportCardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/settings/voice/report-card?locationId=${encodeURIComponent(locationId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load your voice report card.');
        return (await res.json()) as ReportCardResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon sage">
          <Icon name="trend" size={18} />
        </div>
        <div>
          <div className="set-section-title">Voice Report Card</div>
          <div className="set-section-sub">What RepWorth has learned from your own edits.</div>
        </div>
      </div>

      <LiveRegion message={error ?? ''} level="assertive" />

      {error ? (
        <p style={{ fontSize: 13, color: '#B91C1C', margin: 0 }}>{error}</p>
      ) : !data ? (
        <SettingsSkeleton rows={2} />
      ) : !data.activated ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ProgressDots editedCount={data.editedCount} threshold={data.activationThreshold} />
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, margin: 0 }}>
            <strong style={{ color: 'var(--rw-app-text)' }}>
              {data.editedCount} of {data.activationThreshold} edited replies.
            </strong>{' '}
            Only replies you&apos;ve edited and posted count. The report card switches on by
            itself &mdash; keep editing drafts that don&apos;t sound like you.
          </p>
        </div>
      ) : data.traits.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {data.traits.map((trait) => (
            <div key={trait.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--rw-app-text-muted)',
                }}
              >
                {trait.name}
              </div>
              <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--rw-app-text)', margin: 0 }}>
                {trait.claim}
              </p>
              <SnippetBlock snippet={trait.snippet} />
            </div>
          ))}
        </div>
      ) : data.fallbackSnippet ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, margin: 0 }}>
            You&apos;ve edited {data.editedCount} replies &mdash; no consistent pattern stands out
            yet.
          </p>
          <SnippetBlock snippet={data.fallbackSnippet} />
        </div>
      ) : null}
    </div>
  );
}
