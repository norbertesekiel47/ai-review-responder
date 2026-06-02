'use client';

import Link from 'next/link';
import { useRef, useSyncExternalStore } from 'react';
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';
import { Hero } from './Hero';
import { TickerBar } from './TickerBar';
import { Features } from './Features';
import { VoiceDial } from './VoiceDial';
import { TimelineSection } from './TimelineSection';

interface LandingContentProps {
  comingSoon?: boolean;
  selfServeEnabled?: boolean;
}

const SECTIONS = [
  { id: 'rw-hero', label: 'Top' },
  { id: 'rw-features', label: 'Features' },
  { id: 'rw-voice', label: 'Voice' },
  { id: 'rw-timeline', label: 'Timing' },
  { id: 'rw-cta', label: 'Join waitlist' },
];

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 24;
  window.scrollTo({ top: y, behavior: 'smooth' });
}

// Active section is a read-only projection of the scroll position. Modeling it
// as an external store (vs. a mount effect that seeds state) avoids the extra
// render the seed would queue, while getServerSnapshot keeps SSR deterministic.
function subscribeToScroll(onChange: () => void): () => void {
  window.addEventListener('scroll', onChange, { passive: true });
  return () => window.removeEventListener('scroll', onChange);
}

function getActiveSectionFromScroll(): string {
  const mid = window.scrollY + window.innerHeight * 0.35;
  let cur = 'rw-hero';
  for (const { id } of SECTIONS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const top = el.getBoundingClientRect().top + window.scrollY;
    if (top <= mid) cur = id;
  }
  return cur;
}

const ACTIVE_SECTION_SERVER_SNAPSHOT = 'rw-hero';

export function LandingContent({
  comingSoon = false,
  selfServeEnabled = false,
}: LandingContentProps) {
  const active = useSyncExternalStore(
    subscribeToScroll,
    getActiveSectionFromScroll,
    () => ACTIVE_SECTION_SERVER_SNAPSHOT,
  );
  const ctaRef = useRef<HTMLElement>(null);

  return (
    <div className="rw-landing">
      <MarqueeBackground />

      <div className="rw-dot-nav" aria-label="Section navigation">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={active === id ? 'active' : ''}
            onClick={() => scrollToSection(id)}
            aria-label={label}
            title={label}
          />
        ))}
      </div>

      <div className="rw-island-wrap">
        <div className="rw-island">
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />

          <Hero
            onBook={() => scrollToSection('rw-cta')}
            onTry={() => scrollToSection('rw-timeline')}
            primaryCtaLabel={comingSoon ? 'Coming soon' : 'Join waitlist'}
            primaryCtaDisabled={comingSoon}
          />
          <TickerBar />
          <Features />
          <VoiceDial />
          <TimelineSection />

          {comingSoon ? (
            <section ref={ctaRef} className="rw-cta" id="rw-cta">
              <h2>Launching soon</h2>
              <p>We&apos;ll be in touch.</p>
            </section>
          ) : (
            <section ref={ctaRef} className="rw-cta" id="rw-cta">
              <h2>Join the early access waitlist.</h2>
              <p>
                Tell us about your business and we&apos;ll reach out when early access opens for your area.
              </p>
              <LeadIntakeForm intent="waitlist" source="landing" tone="onTeal" />
            </section>
          )}

          <footer className="rw-foot">
            <span suppressHydrationWarning>© {new Date().getFullYear()} RepWorth. All rights reserved.</span>
            <span>
              <Link href="/legal/privacy">Privacy</Link>
              <Link href="/legal/terms">Terms &amp; Conditions</Link>
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}
