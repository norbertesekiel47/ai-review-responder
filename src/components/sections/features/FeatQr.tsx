'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from '@/hooks/useReveal';

// A QR-like glyph drawn from a fixed bit pattern, labelled as a sample and
// not scannable. It stands in for the real per-location PNG the dashboard
// renders (docs/context/review-qr.md): a placeholder that says "a code goes
// here", never a fake code that pretends to resolve.
const QR_ROWS = [
  '1111111010011111111',
  '1000001001101000001',
  '1011101110101011101',
  '1011101010001011101',
  '1011101101101011101',
  '1000001011001000001',
  '1111111010101111111',
  '0000000110100000000',
  '1101011001010111011',
  '0110100101101001100',
  '1010111010110110101',
  '0000000101001011010',
  '1111111011010110011',
  '1000001010101001100',
  '1011101100110111011',
  '1011101001011010110',
  '1011101110100101101',
  '1000001010011100010',
  '1111111001101011101',
] as const;

const QR_FACTS = [
  'One identical code per location, for every customer',
  'Straight to Google’s review form: no page of ours in between, no data capture',
  'Re-pointable server-side, so a printed code never goes stale',
  'Scans counted on your dashboard',
];

export function FeatQr({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();
  return (
    <section ref={innerRef} id="f-qr" aria-label="Review QR: the code on the counter" className="rw-dl-band is-tight">
      <div className="rw-dl-col">
        <div className="feat-ch is-split">
          <FeatIntro
            n="04"
            kicker="Review QR · on the counter"
            bar="var(--rw-sage-bar)"
            group="Request"
            title="A code on the counter. A review on Google."
            lede="One printable code per location. A customer scans it and lands on your Google review form, with nothing of ours in between. Download the PNG or print it from your dashboard and put it where the happy customers are: the counter, the menu, the invoice, the mirror."
          >
            <ul className="rw-dl-bul">
              {QR_FACTS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </FeatIntro>
          <div ref={cardRef} className={cn('feat-ch-ar rw-dl-rv', cardSeen && 'is-in')}>
            <div className="rw-dl-card feat-qr-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-sage-bar)' }} />
                <span>Counter card · sample · Your Business</span>
                <span className="rw-dl-cap-tail">print view</span>
              </div>
              <div className="feat-qr-stage">
                <div className="feat-qr-glyph" role="img" aria-label="Sample QR code, not scannable">
                  <svg viewBox="0 0 19 19" shapeRendering="crispEdges" aria-hidden="true">
                    {QR_ROWS.flatMap((row, y) =>
                      Array.from(row).map((bit, x) =>
                        bit === '1' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null
                      )
                    )}
                  </svg>
                </div>
                <div className="feat-qr-copy">
                  <p className="feat-qr-headline">Enjoyed your visit?</p>
                  <p className="feat-qr-sub">Scan to leave us a review on Google. It takes a minute and it helps more than you know.</p>
                  <p className="feat-qr-route" aria-label="Scan route">
                    <span>scan</span>
                    <span aria-hidden="true">→</span>
                    <span>RepWorth redirect</span>
                    <span aria-hidden="true">→</span>
                    <span>Google review form</span>
                  </p>
                </div>
              </div>
              <p className="rw-dl-fine">Sample card. The real code is generated per location from your dashboard.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
