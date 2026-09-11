'use client';

import Image from 'next/image';
import { useInView } from 'motion/react';
import { useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo } from './ambient-motion';

/** Reuse the authored clips, loading them only while their scene is visible.
 *  Shared by the problem house and the watchdog pair. */
export function BrandClip({ id, className = '' }: { id: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '80px 0px', amount: 0.05 });
  const reducedMotion = usePrefersReducedMotion();
  const [failedId, setFailedId] = useState<string | null>(null);
  const base = id === 'house' ? '/problem/problem-diagram' : `/agents/${id}`;

  return <div ref={ref} className={`rw-lp-syn-m-clip ${className}`} data-brand-clip={id} aria-hidden="true">
    {inView && !reducedMotion && failedId !== id
      ? <AmbientVideo key={id} src={`${base}.mp4`} poster={`${base}.jpg`} preload="none" tabIndex={-1} onError={() => setFailedId(id)} />
      : <Image src={`${base}.jpg`} alt="" fill sizes="(max-width: 700px) 40vw, 420px" unoptimized />}
  </div>;
}
