'use client';

import Image from 'next/image';
import { useInView, useMotionValueEvent, useScroll } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo } from '../ambient-motion';
import { LEAD_IN, PERSONAS } from './personas-copy';

/** Station names, in PERSONAS order — the same four the fleet pills use. */
const STATION_NAMES = ['The reply desk', 'The lookout', 'The report room', 'The outbox'];

/** An agent's authored clip over its still. The page's pause control governs
 *  playback; the clip unmounts offscreen so a long page never keeps every film
 *  decoding. A failed source keeps its still and cannot suppress another
 *  agent's clip. */
function AgentClip({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.01 });
  const reducedMotion = usePrefersReducedMotion();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <div ref={ref} className="rw-lp-syn-l-media" aria-hidden="true">
      <Image src={`${source}.jpg`} alt="" fill sizes="(max-width: 760px) 90vw, 38vw" />
      {inView && !reducedMotion && failedSource !== source ? (
        <AmbientVideo
          key={source}
          src={`${source}.mp4`}
          poster={`${source}.jpg`}
          preload="none"
          onError={() => setFailedSource(source)}
        />
      ) : null}
    </div>
  );
}

/**
 * Section 4 — the agents that act. Copy alternates around a tall central CRT
 * on desktop; the CRT shows whichever agent's paragraph sits on the reading
 * line. On phones the CRT is a sticky strip with four numbered controls below
 * its arch.
 */
export function PersonasSection() {
  const ref = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const articles = useRef<Array<HTMLElement | null>>([]);
  const [active, setActive] = useState(0);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start center', 'end center'],
  });
  const syncActiveAgent = useCallback(() => {
    // Read the actual copy position: equal scroll quarters select the next
    // character too early on phones, where paragraph heights are different.
    // The phone's sticky screen changes height with the viewport. Measure its
    // edge so rotating a phone or enlarging text keeps the selected TV aligned
    // with the paragraph the visitor can actually read beneath it.
    const stageBottom = stageRef.current?.getBoundingClientRect().bottom ?? 0;
    const readingLine = window.innerWidth <= 760
      ? Math.min(window.innerHeight * 0.8, Math.max(0, stageBottom) + 64)
      : window.innerHeight * 0.5;
    let selected = 0;
    articles.current.forEach((article, index) => {
      if (article && article.getBoundingClientRect().top <= readingLine)
        selected = index;
    });
    setActive(selected);
  }, []);
  useMotionValueEvent(scrollYProgress, 'change', syncActiveAgent);
  useEffect(() => {
    window.addEventListener('resize', syncActiveAgent);
    return () => window.removeEventListener('resize', syncActiveAgent);
  }, [syncActiveAgent]);
  const current = PERSONAS[active];
  if (!current) return null;
  return (
    <div className="rw-lp-synthesis-loop">
      <section className="rw-lp-syn-l-agents" aria-labelledby="rw-lp-agents-heading">
        <div className="rw-lp-syn-l-inner">
          <header className="rw-lp-syn-l-section-heading">
            <p className="rw-lp-syn-l-eyebrow">The agents that act</p>
            <h2 id="rw-lp-agents-heading">
              One job each.
              <br />
              <em>And a fixed limit.</em>
            </h2>
            <p>{LEAD_IN}</p>
          </header>
          <div className="rw-lp-syn-l-gallery" ref={ref}>
            <div className="rw-lp-syn-l-gallery-stage" ref={stageRef}>
              <div className="rw-lp-syn-l-gallery-sticky">
                <div className="rw-lp-syn-l-aperture">
                  <span className="rw-lp-syn-l-aperture-caption">A small team. A clear purpose.</span>
                  <AgentClip source={`/agents/${current.id}`} />
                  <div className="rw-lp-syn-l-plinth" />
                  <span className="rw-lp-syn-l-current">
                    0{active + 1} / 04 <strong>{current.name}</strong>
                  </span>
                </div>
                <nav aria-label="Explore the four acting agents" className="rw-lp-syn-l-agent-tabs">
                  {PERSONAS.map((agent, i) => (
                    <a
                      href={`#rw-lp-agent-${agent.id}`}
                      key={agent.id}
                      aria-current={active === i ? 'true' : undefined}
                      onClick={() => setActive(i)}
                    >
                      <span>0{i + 1}</span>
                      <span className="sr-only">{agent.name}</span>
                    </a>
                  ))}
                </nav>
              </div>
            </div>
            {PERSONAS.map((agent, i) => (
              <article
                key={agent.id}
                ref={(element) => {
                  articles.current[i] = element;
                }}
                id={`rw-lp-agent-${agent.id}`}
                className="rw-lp-syn-l-agent"
                data-active={active === i}
                style={{ gridRow: i + 1, gridColumn: i % 2 === 0 ? 1 : 3 }}
              >
                <span className="rw-lp-syn-l-number">0{i + 1}</span>
                <p className="rw-lp-syn-l-eyebrow">{STATION_NAMES[i]}</p>
                <h3>{agent.name}.</h3>
                <p className="rw-lp-syn-l-claim">{agent.tagline}</p>
                <p>{agent.body}</p>
                <p className="rw-lp-syn-l-permission">
                  <span aria-hidden="true">↳</span> {agent.publishLabel}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
