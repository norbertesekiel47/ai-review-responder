'use client';

import { useRef, type RefObject } from 'react';
import { LazyMotion, domAnimation, m, useScroll, useTransform } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface PageSection {
  ref: RefObject<HTMLDivElement | null>;
  label: string;
}

interface PageShellProps {
  sections: PageSection[];
  children: React.ReactNode;
  /** Tailwind max-width class for the island. Defaults to 'max-w-5xl'. */
  maxWidthClassName?: string;
}

export function PageShell({ sections, children, maxWidthClassName = 'max-w-5xl' }: PageShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  // Hooks must run unconditionally; we choose whether to *apply* the parallax
  // transform below so reduced-motion users get a static background.
  const bgY1 = useTransform(scrollYProgress, [0, 1], [0, -300]);
  const bgY2 = useTransform(scrollYProgress, [0, 1], [0, -500]);
  const bgY3 = useTransform(scrollYProgress, [0, 1], [0, -200]);
  const bgY4 = useTransform(scrollYProgress, [0, 1], [0, -400]);

  return (
    <LazyMotion features={domAnimation}>
      <div ref={containerRef} className="min-h-screen bg-rw-sage relative">
      {/* Parallax background */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 backdrop-blur-sm bg-rw-sage/80" />
        {[
          { style: { y: bgY1 }, className: 'absolute top-20 left-10 w-64 h-80', dots: 5 },
          { style: { y: bgY2 }, className: 'absolute top-[500px] right-20 w-72 h-64', dots: 4 },
          { style: { y: bgY3 }, className: 'absolute top-[1000px] left-[15%] w-56 h-72', dots: 5 },
          { style: { y: bgY4 }, className: 'absolute top-[1400px] right-[10%] w-64 h-56', dots: 5 },
        ].map((card) => (
          <m.div
            key={card.className}
            style={prefersReducedMotion ? undefined : card.style}
            className={`${card.className} bg-white/40 backdrop-blur-md rounded-3xl shadow-xl p-6 border border-white/60`}
          >
            <div className="flex gap-1 mb-3">
              {Array.from({ length: card.dots }).map((_, j) => (
                <div key={j} className="size-4 bg-rw-peach/60 rounded-full" />
              ))}
            </div>
            <div className="space-y-2">
              <div className="h-3 bg-rw-ink/20 rounded w-full" />
              <div className="h-3 bg-rw-ink/20 rounded w-5/6" />
              <div className="h-3 bg-rw-ink/20 rounded w-4/6" />
            </div>
          </m.div>
        ))}
      </div>

      {/* Right dot navigation (desktop only) */}
      {sections.length > 0 && (
        <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-rw-teal/20">
          {sections.map(({ ref, label }) => (
            <button
              key={label}
              type="button"
              onClick={() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              aria-label={`Go to ${label}`}
              className="relative size-3 rounded-full bg-rw-teal/30 hover:bg-rw-teal transition-all hover:scale-125 focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2 after:absolute after:left-1/2 after:top-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:h-11 after:w-11 after:content-['']"
            />
          ))}
        </div>
      )}

      {/* Island wrapper */}
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <m.div
          className={`w-full ${maxWidthClassName} bg-white rounded-[3rem] shadow-2xl`}
          initial={prefersReducedMotion ? false : { opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.8, ease: 'easeOut' }}
        >
          {children}
        </m.div>
      </div>
      </div>
    </LazyMotion>
  );
}
