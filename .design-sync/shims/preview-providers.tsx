// Context a landing/island component needs when it renders alone in a preview
// card. Mirrors the composition root `LandingExperience.tsx` uses in
// production — same providers, same options — so a card renders what the page
// renders. Not a component of the design system; it exists only as
// `cfg.provider`.
import type { ReactNode } from 'react';
import { LazyMotion, domAnimation } from 'motion/react';
import { AmbientMotionProvider } from '@/components/sections/landing/ambient-motion';

/**
 * `strict` matches production: every landing component imports `m.*`, never
 * `motion.*`, and strict mode is what keeps that honest.
 */
export function PreviewProviders({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <AmbientMotionProvider>{children}</AmbientMotionProvider>
    </LazyMotion>
  );
}
