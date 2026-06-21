'use client';

import { useRef, useSyncExternalStore } from 'react';
import { SiteShell } from '@/components/ui/SiteShell';
import { LeadIntakeForm } from '../lead-intake/LeadIntakeForm';
import { Hero } from './Hero';
import { TickerBar } from './TickerBar';
import { Features } from './Features';
import { VoiceDial } from './VoiceDial';
import { TimelineSection } from './TimelineSection';

interface LandingContentProps {
  comingSoon?: boolean;
  selfServeEnabled?: boolean;
  trialEnabled?: boolean;
  trialDays?: number;
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
  trialEnabled = false,
  trialDays = 30,
}: LandingContentProps) {
  const active = useSyncExternalStore(
    subscribeToScroll,
    getActiveSectionFromScroll,
    () => ACTIVE_SECTION_SERVER_SNAPSHOT,
  );
  const ctaRef = useRef<HTMLElement>(null);

  return (
    <SiteShell
      scope="rw-landing"
      comingSoon={comingSoon}
      selfServeEnabled={selfServeEnabled}
      overlay={
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
      }
    >

          <Hero
            onBook={() => scrollToSection('rw-cta')}
            primaryCtaLabel={
              comingSoon
                ? 'Coming soon'
                : trialEnabled
                  ? `Start your ${trialDays}-day free trial`
                  : 'Join waitlist'
            }
            primaryCtaDisabled={comingSoon}
            // When the trial is live (which requires self-serve signup to also be
            // on — see (public)/page.tsx), the CTA goes to /signup to actually
            // start a trial, instead of scrolling to the early-access waitlist.
            primaryCtaHref={trialEnabled ? '/signup' : undefined}
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
    </SiteShell>
  );
}
