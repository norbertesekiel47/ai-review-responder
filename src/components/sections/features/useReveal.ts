import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    if (seen) return;
    // Reduced motion: skip the IntersectionObserver entrance entirely and render
    // the final (revealed) frame on the next tick. This also guarantees children
    // gated on `.rw-reveal.in` (lang chips, voice bars, comp rows, etc.) become
    // visible. Deferred via setTimeout to avoid a synchronous setState in-effect.
    if (prefersReducedMotion) {
      const id = window.setTimeout(() => setSeen(true), 0);
      return () => window.clearTimeout(id);
    }
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setSeen(true)),
      { threshold: 0.08, rootMargin: '0px 0px -80px 0px' }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, prefersReducedMotion]);
  return [ref, seen] as const;
}
