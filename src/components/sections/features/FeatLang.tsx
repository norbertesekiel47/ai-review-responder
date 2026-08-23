'use client';

import { type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from './useReveal';

const FEATURE_LANGS = [
  { code: 'ES', name: 'Español' },
  { code: 'VI', name: 'Tiếng Việt' },
  { code: 'ZH', name: '中文' },
  { code: 'TL', name: 'Tagalog' },
  { code: 'KO', name: '한국어' },
  { code: '30+', name: 'languages' },
];

/* ================== 07 LANGUAGES (split chapter: text + chips left, sample right) ================== */
export function FeatLang({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();
  return (
    <section ref={innerRef} id="f-lang" aria-label="Multilingual support" className="rw-dl-band">
      <div className="rw-dl-col">
        <div className="feat-ch is-split">
          <FeatIntro
            n="07"
            kicker="Reach"
            bar="var(--rw-sage-bar)"
            group="Craft and proof"
            title="Multilingual, automatically."
            lede="RepWorth detects the language of every review and responds in the same language. No setup, no toggles. Your customers feel heard in their own words."
          >
            <div className="rw-dl-chips feat-lang-chips">
              {FEATURE_LANGS.map((l) => (
                <span key={l.code} className="rw-dl-chip">
                  <span>{l.code}</span>
                  {l.name}
                </span>
              ))}
            </div>
          </FeatIntro>

          <div ref={cardRef} className={cn('feat-ch-ar rw-dl-rv', cardSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span>Sample reviewer</span>
                <span
                  className="rw-dl-stars"
                  aria-label="5 out of 5 stars"
                >
                  <span aria-hidden="true">★★★★★</span>
                </span>
                <span className="rw-dl-cap-tail">detected: ES</span>
              </div>
              <div className="rw-dl-quote">
                &ldquo;La mejor enchilada que he comido en años. El mole es auténtico. Volvería
                todos los fines de semana si pudiera.&rdquo;
              </div>
              <div className="rw-dl-arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M19 12l-7 7-7-7" />
                </svg>
              </div>
              <div className="rw-dl-reply">
                <div className="rw-dl-reply-lbl">Your reply · ES · auto-generated</div>
                <p>
                  &ldquo;¡Muchísimas gracias! Nos alegra mucho que la enchilada y el mole te hayan
                  parecido auténticos. Te esperamos el fin de semana que quieras. ¡Hasta
                  pronto!&rdquo;
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
