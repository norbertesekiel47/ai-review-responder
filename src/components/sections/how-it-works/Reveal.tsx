'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      const id = window.setTimeout(() => setSeen(true), delay);
      return () => window.clearTimeout(id);
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          window.setTimeout(() => setSeen(true), delay);
          io.disconnect();
        }
      },
      { threshold: 0.05, rootMargin: '0px 0px -50px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay, seen]);
  return (
    <div ref={ref} className={`hiw-reveal ${seen ? 'is-in' : ''}`}>
      {children}
    </div>
  );
}
