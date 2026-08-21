'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * The hero's blurred "wash" loop (Daylight Gallery II). The blurred still is
 * the poster and the reduced-motion / no-video fallback; the video fades in
 * only once it reports `canplay`. Background tabs never fire `canplay`, so a
 * `visibilitychange` listener replays a paused loop when the tab returns
 * (see docs/design/daylight-ii/demo4-daylight-v2.src.html). Decorative only —
 * the wrapper is aria-hidden and the media carry empty alt/no audio.
 */
export function HeroWash() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const video = videoRef.current;
    if (!video) return;

    const onCanPlay = () => {
      readyRef.current = true;
      setReady(true);
      video.play().catch(() => {});
    };
    const onVisibilityChange = () => {
      if (!document.hidden && readyRef.current && video.paused) {
        video.play().catch(() => {});
      }
    };

    video.addEventListener('canplay', onCanPlay, { once: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    video.load();
    return () => {
      video.removeEventListener('canplay', onCanPlay);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [prefersReducedMotion]);

  return (
    <div className="hiw-wash" aria-hidden="true">
      {/* Plain <img>: a blurred decorative backdrop gains nothing from the
          next/image pipeline, and the poster must paint before hydration. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/hero-wash-poster.jpg"
        alt=""
        className={ready ? 'is-hidden' : undefined}
      />
      {!prefersReducedMotion && (
        <video
          ref={videoRef}
          className={ready ? 'is-on' : undefined}
          muted
          loop
          playsInline
          preload="auto"
          poster="/images/hero-wash-poster.jpg"
        >
          <source src="/video/hero-wash-loop.mp4" type="video/mp4" />
        </video>
      )}
    </div>
  );
}
