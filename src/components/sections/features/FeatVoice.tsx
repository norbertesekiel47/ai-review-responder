'use client';

import { type RefObject } from 'react';
import { useReveal } from './useReveal';

const VOICE_BARS = [
  { h: 85, op: 0.8, d: '80ms' },
  { h: 72, op: 0.7, d: '160ms' },
  { h: 61, op: 0.6, d: '240ms' },
  { h: 48, op: 0.55, d: '320ms' },
  { h: 35, op: 0.45, d: '400ms' },
  { h: 28, op: 0.4, d: '480ms' },
  { h: 18, op: 0.35, d: '560ms' },
  { h: 12, op: 1, d: '640ms', anno: true },
];

/* ================== 08 VOICE ================== */
export function FeatVoice({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [chartRef, chartSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-voice"
      aria-label="Voice learning"
      className="px-8 md:px-16 py-20 bg-rw-ink text-white relative overflow-hidden"
    >
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.6) 1px, transparent 1.5px)',
          backgroundSize: '3px 3px',
        }}
        aria-hidden
      />
      <div className="relative grid md:grid-cols-12 gap-10 items-end">
        <div ref={headRef} className={`rw-reveal md:col-span-5 ${headSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-white/20 block mb-4">08</span>
          <p className="rw-label-mono text-xs uppercase text-rw-peach mb-3">Over time</p>
          <h2 className="text-4xl md:text-5xl font-medium leading-tight mb-4">
            It learns your <span className="rw-display-serif text-rw-peach">voice</span>, edit by edit.
          </h2>
          <p className="text-white/70 max-w-md leading-relaxed">
            Every time you tweak a draft, RepWorth notices the change. Your warmth level, your phrasing,
            the way you handle a complaint. The aim is drafts you approve untouched.
          </p>
        </div>

        <div ref={chartRef} className={`rw-reveal md:col-span-7 ${chartSeen ? 'in' : ''}`}>
          <div className="flex items-baseline justify-between mb-5">
            <p className="rw-label-mono text-xs uppercase text-white/50">% of drafts edited by owner</p>
            <p className="rw-label-mono text-xs text-rw-peach">the curve we aim for</p>
          </div>
          <div className="relative h-48">
            <div className="absolute inset-0 flex flex-col justify-between">
              <div className="border-t border-white/10" />
              <div className="border-t border-white/10" />
              <div className="border-t border-white/10" />
              <div className="border-t border-white/10" />
            </div>
            <div className="absolute inset-0 flex items-end gap-3 px-1">
              {VOICE_BARS.map((b) => (
                <div
                  key={b.d}
                  className="rw-voice-bar flex-1 rounded-t relative"
                  style={{
                    height: `${b.h}%`,
                    background: `rgba(242,195,185,${b.op})`,
                    ['--bar-d' as string]: b.d,
                  }}
                >
                  {b.anno && (
                    <div className="rw-voice-anno absolute -top-10 left-1/2 -translate-x-1/2 bg-rw-peach text-rw-ink rounded-lg px-2 py-1 rw-label-mono text-[10px] whitespace-nowrap">
                      the goal: hands-off
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-between mt-3 rw-label-mono text-[10px] text-white/50">
            {['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'].map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <p className="mt-3 text-[10px] italic text-white/50">
            Illustrative target, not live performance data.
          </p>
        </div>
      </div>
    </section>
  );
}
