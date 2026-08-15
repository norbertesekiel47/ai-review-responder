'use client';

import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { type RefObject } from 'react';
import { useReveal } from './useReveal';

const FEATURE_LANGS = [
  { code: 'ES', name: 'Español' },
  { code: 'VI', name: 'Tiếng Việt' },
  { code: 'ZH', name: '中文' },
  { code: 'TL', name: 'Tagalog' },
  { code: 'KO', name: '한국어' },
  { code: '+14', name: 'more' },
];

/* ================== 07 LANGUAGES ================== */
export function FeatLang({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    <section
      ref={innerRef}
      id="f-lang"
      aria-label="Multilingual support"
      className="px-8 md:px-16 py-20 bg-gradient-to-b from-white to-rw-cream/50 relative"
    >
      <div className="grid md:grid-cols-12 gap-10 items-start">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-5 ${leftSeen ? 'in' : ''}`}>
          <div className="flex items-start gap-6 mb-8">
            <span className="rw-num-tag text-7xl leading-none text-rw-peach/80">07</span>
            <div>
              <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Reach</p>
              <h2 className="text-4xl md:text-[2.75rem] font-medium text-rw-ink leading-tight">
                Multilingual, <span className="rw-display-serif text-rw-teal-strong">automatically</span>.
              </h2>
            </div>
          </div>
          <p className="text-rw-ink-soft max-w-md leading-relaxed mb-8">
            RepWorth detects the language of every review and responds in the same language. No
            setup, no toggles. Your customers feel heard in their own words.
          </p>
          <div className="grid grid-cols-3 gap-2 max-w-md">
            {FEATURE_LANGS.map((l, i) => (
              <div
                key={l.code}
                className="rw-lang-chip bg-white rounded-2xl p-3 border border-rw-teal/15 text-center"
                style={{
                  ['--chip-d' as string]: `${80 + i * 90}ms`,
                  // The `.rw-lang-chip` base rule sets opacity:0 and relies on the
                  // `rw-chip-pop` reveal animation to fade in. That animation is not
                  // disabled under reduced motion in globals.css, so force the chip
                  // visible here to avoid invisible chips when motion is reduced.
                  ...(prefersReducedMotion ? { opacity: 1 } : {}),
                }}
              >
                <p className="rw-label-mono text-[10px] text-rw-ink-soft mb-0.5">{l.code}</p>
                <p className={`text-sm font-medium ${l.name === 'more' ? 'text-rw-teal-strong' : ''}`}>
                  {l.name}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-7 ${rightSeen ? 'in' : ''}`}>
          <div className="bg-white rounded-3xl p-6 border border-rw-teal/15 shadow-sm max-w-md">
            <div className="flex items-center gap-2 mb-3">
              <div
                className="size-8 rounded-full"
                style={{ background: 'linear-gradient(135deg, #F2C3B9, #D6CBBF)' }}
                aria-hidden
              />
              <div>
                <p className="text-xs font-medium text-rw-ink">Sample reviewer</p>
                <div className="flex gap-0.5 text-[10px]" aria-label="5 out of 5 stars">
                  <span className="text-rw-teal" aria-hidden="true">★★★★★</span>
                </div>
              </div>
              <span className="ml-auto rw-label-mono text-[10px] text-rw-ink-soft">detected: ES</span>
            </div>
            <p className="text-sm text-rw-ink leading-relaxed">
              &ldquo;La mejor enchilada que he comido en años. El mole es auténtico. Volvería todos los
              fines de semana si pudiera.&rdquo;
            </p>
          </div>

          <svg className="ml-16 my-2 w-8 h-16 text-rw-teal/40" viewBox="0 0 32 64" fill="none" aria-hidden>
            <path
              d="M16 0 V 48 M10 44 L 16 52 L 22 44"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray="3 4"
            />
          </svg>

          <div
            className="ml-16 md:ml-24 rounded-3xl p-6 border border-rw-teal/25 max-w-md"
            style={{ background: 'rgba(151,179,174,0.08)' }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="rw-label-mono text-[10px] uppercase text-rw-teal-strong">Your reply · ES</span>
              <span className="ml-auto rw-label-mono text-[10px] text-rw-ink-soft">auto-generated</span>
            </div>
            <p className="text-sm text-rw-ink leading-relaxed">
              &ldquo;¡Muchísimas gracias! El mole es la receta de mi abuela; tardan tres días
              en prepararlo. Nos alegra mucho que lo hayas disfrutado. ¡Hasta pronto!&rdquo;
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
