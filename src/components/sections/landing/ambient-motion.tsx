'use client';

import {
  type ComponentPropsWithoutRef,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Ambient motion — the page's single pause control, and the video element that
 * obeys it.
 *
 * ── Why this exists (WCAG 2.2.2, Level A) ─────────────────────────────────
 * Eight clips auto-start and loop indefinitely on this page: the hero
 * backdrop, the CTA backdrop, and six agent avatars. Three CSS animations do
 * the same (the hero scroll cue, and the fleet's pulse and flow). 2.2.2
 * requires that any motion which starts automatically and runs for more than
 * five seconds can be paused, and every one of these runs forever.
 *
 * `prefers-reduced-motion` is already handled thoroughly across this page and
 * is NOT a substitute. It is a static, OS-level preference: it cannot be
 * changed for one page, it is invisible to a visitor who does not know it
 * exists, and vestibular discomfort is frequently situational. 2.2.2 asks for
 * a control on the page, and this is it.
 *
 * ── Why one control instead of per-video controls ─────────────────────────
 * Native `controls` on eight decorative background clips would put eight
 * chrome bars over the composition and add eight tab stops to reach a control
 * nobody wants. One toggle satisfies 2.2.2 for all of them, is a single tab
 * stop, and is the only honest affordance for a video the visitor cannot see
 * the edges of.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 * "Ambient" is precise: decorative motion nobody asked for. The explainer film
 * in the fleet lightbox is deliberately NOT governed here — it is behind a
 * click, carries native `controls`, and is the one clip on the page that is
 * meant to be watched.
 */

interface AmbientMotionState {
  paused: boolean;
  toggle: () => void;
}

const AmbientMotionContext = createContext<AmbientMotionState | null>(null);

/**
 * Read-only access, for the clips themselves and for whichever element carries
 * the paused state into CSS.
 *
 * Returns `false` outside a provider rather than throwing, so an `AmbientVideo`
 * can be rendered in isolation — in a test, or in a section mounted on its own
 * — and simply plays, which is the pre-existing behaviour.
 */
export function useAmbientMotionPaused(): boolean {
  return useContext(AmbientMotionContext)?.paused ?? false;
}

/**
 * Full access, for the control. Throws outside a provider: a toggle that
 * renders happily and silently governs nothing is exactly the failure this
 * whole module exists to prevent.
 */
function useAmbientMotion(): AmbientMotionState {
  const state = useContext(AmbientMotionContext);
  if (!state) {
    throw new Error('AmbientMotionToggle must be rendered inside AmbientMotionProvider');
  }
  return state;
}

export function AmbientMotionProvider({ children }: { children: React.ReactNode }) {
  const [paused, setPaused] = useState(false);
  const toggle = useCallback(() => setPaused((value) => !value), []);
  const value = useMemo(() => ({ paused, toggle }), [paused, toggle]);

  return <AmbientMotionContext.Provider value={value}>{children}</AmbientMotionContext.Provider>;
}

/**
 * A decorative, looping, muted background clip.
 *
 * The four attributes that define the category — `autoPlay`, `loop`, `muted`,
 * `playsInline` — are baked in rather than passed, so a call site cannot create
 * an ambient video that is silently exempt from the pause control by forgetting
 * one of them. `controls` is excluded for the same reason: a background clip
 * with its own chrome is a different component, not a variant of this one.
 */
type AmbientVideoProps = Omit<
  ComponentPropsWithoutRef<'video'>,
  'autoPlay' | 'controls' | 'loop' | 'muted' | 'playsInline'
>;

export function AmbientVideo(props: AmbientVideoProps) {
  const paused = useAmbientMotionPaused();
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    if (paused) {
      video.pause();
      return;
    }

    // `play()` rejects when the browser declines the request or the element is
    // torn down mid-call. The clip is decorative and muted, so a rejection is
    // not a condition worth surfacing — but it IS an unhandled rejection if
    // left uncaught, which the worker's crash-net would be right to complain
    // about were this server code.
    void video.play().catch(() => {});
  }, [paused]);

  return (
    <video
      {...props}
      ref={ref}
      // Mirrors `paused` rather than being hard-coded `true`: a clip that
      // mounts while the page is paused (an avatar scrolled into view after
      // the visitor hit pause) must never get a frame of motion first.
      autoPlay={!paused}
      loop
      muted
      playsInline
    />
  );
}

/** Two bars when playing (press to pause), a triangle when paused. */
function ToggleGlyph({ paused }: { paused: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      {paused ? (
        <path d="M9 7.5l8 4.5-8 4.5V7.5z" fill="currentColor" />
      ) : (
        <>
          <rect x="9" y="7.5" width="2.25" height="9" rx="0.5" fill="currentColor" />
          <rect x="13.75" y="7.5" width="2.25" height="9" rx="0.5" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * The control.
 *
 * It is rendered inside the nav's markup but styled `position: fixed` from
 * 901px up, so on a wide viewport it floats at the bottom-left and stays
 * reachable while the avatars and the CTA backdrop are looping further down.
 * Below 901px there is no free corner to float into — the hero copy runs to
 * within ~36px of the bottom edge — so it stays docked in the nav. The full
 * measurement and the trade-off are written up in landing-experience.css.
 *
 * It is deliberately NOT folded into `ChapterRail`: that is a `<nav
 * aria-label="Page sections">`, and a media control is not a page section.
 */
export function AmbientMotionToggle() {
  const { paused, toggle } = useAmbientMotion();
  const label = paused ? 'Play background motion' : 'Pause background motion';

  return (
    <button
      type="button"
      className="rw-lp-motion-toggle"
      onClick={toggle}
      // The accessible name changes with the state, which is the WAI-ARIA
      // pattern for a play/pause control. Deliberately NOT `aria-pressed`:
      // that would announce "Pause, pressed" for a button whose label already
      // says what the next press does, which reads as a contradiction.
      title={label}
    >
      <span className="sr-only">{label}</span>
      <ToggleGlyph paused={paused} />
    </button>
  );
}
