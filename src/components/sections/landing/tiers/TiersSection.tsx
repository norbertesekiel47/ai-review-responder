'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useInView } from 'motion/react';
import { useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo, useAmbientMotionPaused } from '../ambient-motion';
import { GOVERNOR_NOTE, LEAD_IN, PRICING_LINK_LABEL, TIERS } from './tiers-copy';

type Mode = 'autopilot' | 'copilot';
interface Transition { to: Mode; sequence: number; start: number }
const ORDER: readonly Mode[] = ['copilot', 'autopilot'];
const LEVER_DURATION_SECONDS = 0.7;
// The film into Autopilot holds the left endpoint until ~2.2s of its 5.04s
// source. Skip that lead-in so selecting Autopilot starts the swing immediately.
const AUTOPILOT_MOTION_START = 0.44;
// Copilot is the lever at the left, over the approval tray; Autopilot is the
// lever at the right, over the dispatch desk. Each poster is its settled
// endpoint; each transition film ends on that endpoint.
const LEVER_MEDIA = {
  copilot: { position: 'left', poster: '/tiers/lever-copilot.webp', transition: '/tiers/lever-to-copilot.mp4' },
  autopilot: { position: 'right', poster: '/tiers/lever-autopilot.webp', transition: '/tiers/lever-to-autopilot.mp4' },
} as const;

function ModeActivity({ mode }: { mode: Mode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.05 });
  const reduced = usePrefersReducedMotion();
  const [failed, setFailed] = useState(false);
  return <div ref={ref} className="rw-lp-final-mode-activity" data-station={mode} aria-hidden="true">
    {inView && !reduced && !failed ? <AmbientVideo data-mode-activity={mode} src={`/tiers/activity-${mode}.mp4`} poster={LEVER_MEDIA[mode].poster} preload="none" onError={() => setFailed(true)} /> : null}
  </div>;
}

/**
 * Section 7 — owner controls. A light paper band: the editorial heading on the
 * left; the dispatch scene and the Copilot/Autopilot selector on the right.
 * The selector explains the two plans — it changes no subscription. This
 * section is the page's door to /pricing.
 *
 * Lever timing: the source film plays at `duration / 0.7`, so every swing
 * takes 0.7s. Reversing mid-swing resumes the inverse film at the matching
 * frame. After the lever settles, only the selected side station animates.
 */
export function TiersSection({ primaryCtaHref, primaryCtaLabel }: {
  primaryCtaHref: string; primaryCtaLabel: string;
}) {
  const [mode, setMode] = useState<Mode>('copilot');
  const [transition, setTransition] = useState<Transition | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sequence = useRef(0);
  const reduced = usePrefersReducedMotion();
  const paused = useAmbientMotionPaused();
  const selected = TIERS.find(tier => tier.id === mode);
  const lever = LEVER_MEDIA[mode];
  if (!selected) throw new Error(`Unknown approval mode: ${mode}`);

  function choose(next: Mode) {
    if (next === mode) return;
    const video = videoRef.current;
    // The inverse clip contains the same frames in reverse order. Reversing
    // midway through a click transition therefore resumes at the same frame.
    const start = video && Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, 1 - video.currentTime / video.duration) : 0;
    sequence.current += 1;
    setMode(next);
    setTransition(reduced || paused ? null : { to: next, sequence: sequence.current, start });
  }

  return (
    <section className="rw-lp-final-owner" data-mode={mode} aria-labelledby="rw-lp-final-owner-heading">
      <div className="rw-lp-final-owner-grid">
        <header className="rw-lp-final-owner-heading">
          <p className="rw-lp-final-owner-eyebrow">Your business. Your bounds.</p>
          <h2 id="rw-lp-final-owner-heading">A little more freedom.<br /><em>Always your decision.</em></h2>
          <p>{LEAD_IN}</p>
        </header>
        <div className="rw-lp-final-owner-scene">
          <div className="rw-lp-final-owner-picture" data-lever-position={lever.position}>
            <Image src={lever.poster} alt={`The dispatch desk with its brass lever set to the ${lever.position} for ${selected.name}.`} fill unoptimized sizes="(max-width: 760px) 100vw, 90vw" />
            {transition && !reduced && !paused ? (
              <video key={transition.sequence} ref={videoRef} data-lever-transition={transition.to} src={LEVER_MEDIA[transition.to].transition} poster={LEVER_MEDIA[transition.to === 'autopilot' ? 'copilot' : 'autopilot'].poster} muted playsInline preload="auto" aria-hidden="true"
                onLoadedMetadata={event => {
                  const clip = event.currentTarget;
                  const motionStart = transition.to === 'autopilot' ? AUTOPILOT_MOTION_START : 0;
                  clip.currentTime = Math.max(transition.start, motionStart) * clip.duration;
                  clip.playbackRate = clip.duration / LEVER_DURATION_SECONDS;
                  void clip.play().catch(() => setTransition(null));
                }}
                onEnded={() => setTransition(null)} onError={() => setTransition(null)} />
            ) : <ModeActivity key={mode} mode={mode} />}
          </div>
          <div className="rw-lp-final-owner-scene-caption"><span>{mode === 'copilot' ? 'At the approval tray: a draft waits for your say-so.' : 'At the dispatch desk: one reply, within your bounds.'}</span><span aria-hidden="true">Brass lever · {lever.position}</span></div>
        </div>
        <div className="rw-lp-final-owner-controls">
          <div className="rw-lp-final-owner-selector" aria-label="Explore approval modes">
            {ORDER.map(id => <button type="button" key={id} aria-pressed={mode === id} aria-controls="rw-lp-final-mode-detail" onClick={() => choose(id)}><span aria-hidden="true">{id === 'copilot' ? '←' : '→'}</span><strong>{id === 'autopilot' ? 'Autopilot' : 'Copilot'}</strong><small>{id === 'autopilot' ? 'Within your bounds' : 'Your approval, every time'}</small></button>)}
          </div>
          <div id="rw-lp-final-mode-detail" className="rw-lp-final-owner-detail" aria-live="polite" aria-atomic="true"><p className="rw-lp-final-owner-eyebrow">{selected.name}</p><h3>{selected.claim}</h3><p>{selected.body}</p></div>
          <div className="rw-lp-final-owner-bounds" aria-label="Autopilot safeguards"><strong>Autopilot safeguards</strong><span>Positive reviews</span><span>Your rating band</span><span>Your daily cap</span><span>Time to veto</span><span>Judge reviews every auto-post</span></div>
        </div>
        <footer className="rw-lp-final-owner-footer"><div><p>Start on Copilot. Move the lever when you are ready, and move it back any time.</p><p>{GOVERNOR_NOTE}</p></div><div className="rw-lp-final-owner-links"><Link href={primaryCtaHref}>{primaryCtaLabel}<span aria-hidden="true">↗</span></Link><Link href="/pricing">{PRICING_LINK_LABEL} <span aria-hidden="true">↗</span></Link></div></footer>
      </div>
    </section>
  );
}
