'use client';

import { useRef } from 'react';
import { motion, useScroll, useTransform } from 'motion/react';

export interface PageSection {
  ref: React.RefObject<HTMLDivElement | null>;
  label: string;
}

interface PageShellProps {
  sections: PageSection[];
  children: React.ReactNode;
}

export function PageShell({ sections, children }: PageShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const bgY1 = useTransform(scrollYProgress, [0, 1], [0, -300]);
  const bgY2 = useTransform(scrollYProgress, [0, 1], [0, -500]);
  const bgY3 = useTransform(scrollYProgress, [0, 1], [0, -200]);
  const bgY4 = useTransform(scrollYProgress, [0, 1], [0, -400]);

  return (
    <div ref={containerRef} className="min-h-screen bg-[#D2E0D3] relative">
      {/* Parallax background */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 backdrop-blur-sm bg-[#D2E0D3]/80" />
        {[
          { style: { y: bgY1 }, className: 'absolute top-20 left-10 w-64 h-80', dots: 5 },
          { style: { y: bgY2 }, className: 'absolute top-[500px] right-20 w-72 h-64', dots: 4 },
          { style: { y: bgY3 }, className: 'absolute top-[1000px] left-[15%] w-56 h-72', dots: 5 },
          { style: { y: bgY4 }, className: 'absolute top-[1400px] right-[10%] w-64 h-56', dots: 5 },
        ].map((card, i) => (
          <motion.div
            key={i}
            style={card.style}
            className={`${card.className} bg-white/40 backdrop-blur-md rounded-3xl shadow-xl p-6 border border-white/60`}
          >
            <div className="flex gap-1 mb-3">
              {Array.from({ length: card.dots }).map((_, j) => (
                <div key={j} className="w-4 h-4 bg-[#F2C3B9]/60 rounded-full" />
              ))}
            </div>
            <div className="space-y-2">
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-full" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-5/6" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-4/6" />
            </div>
          </motion.div>
        ))}
      </div>

      {/* Right dot navigation (desktop only) */}
      {sections.length > 0 && (
        <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-[#97B3AE]/20">
          {sections.map(({ ref, label }) => (
            <button
              key={label}
              onClick={() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              aria-label={`Go to ${label}`}
              className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125"
            />
          ))}
        </div>
      )}

      {/* Island wrapper */}
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <motion.div
          className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl overflow-hidden"
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}
