'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

const HOVER_QUERY = '(hover: hover)';

function subscribeHover(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(HOVER_QUERY);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

function hoverSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(HOVER_QUERY).matches;
}

function serverHoverSnapshot(): boolean {
  return false;
}

/**
 * Whether the device has a hover-capable pointer.
 *
 * A tap emits a synthetic `mouseenter` on many touch browsers. Opening on that
 * would let the click which follows toggle the tip straight shut, so hover is
 * bound only where a real pointer exists. Mirrors `usePrefersReducedMotion`:
 * `useSyncExternalStore`, `false` on the server, live on a change.
 */
function useHasHover(): boolean {
  return useSyncExternalStore(subscribeHover, hoverSnapshot, serverHoverSnapshot);
}

export interface InfoTipProps {
  /** What the tip explains. Builds the trigger's accessible name. */
  subject: string;
  /** The explanation. One or two plain sentences — this is not a panel. */
  children: ReactNode;
}

/**
 * A small trigger beside a headline that reveals what a number means.
 *
 * Hover previews it where a pointer exists, a click or tap pins it, `Escape`
 * closes it and returns focus to the trigger. `aria-describedby` announces the
 * explanation to a screen reader, and only while the panel is in the
 * accessibility tree, so the reference never dangles.
 *
 * Both elements are inline `<span>`s, so a tip is legal inside a heading.
 *
 * Dismissal is owned here rather than by `useMenuPopover`. That hook is the
 * Console's single owner of *menu* behavior (`aria-haspopup="menu"`); it
 * preventDefaults Arrow/Home/End to rove between `menuitem` rows before it
 * checks whether any exist. A tip has none, so reusing it would swallow
 * arrow-key page scrolling for no gain, and would be the first import from
 * `components/dashboard/` into `components/ui/`.
 */
export function InfoTip({ subject, children }: InfoTipProps) {
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasHover = useHasHover();
  const panelId = `info-tip-${useId().replace(/:/g, '')}`;

  const open = pinned || (hasHover && hovering);

  const close = useCallback(() => {
    setPinned(false);
    setHovering(false);
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    close();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [close]);

  const toggle = useCallback(() => {
    if (pinned) closeAndRestoreFocus();
    else setPinned(true);
  }, [closeAndRestoreFocus, pinned]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setPinned(false);
        setHovering(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLSpanElement>) => {
      if (!open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      // Tab leaves on purpose: focus moves onward, so pulling it back to the
      // trigger would fight the user. Every other key falls through — an open
      // tip must not stop the page scrolling.
      if (event.key === 'Tab') close();
    },
    [close, closeAndRestoreFocus, open],
  );

  return (
    <span className="info-tip" ref={containerRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="info-tip-trigger"
        ref={triggerRef}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={open ? panelId : undefined}
        onClick={toggle}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
          <path
            d="M8 7.1v4.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        <span className="sr-only">What {subject} means</span>
      </button>
      <span className="info-tip-panel" id={panelId} hidden={!open}>
        {children}
      </span>
    </span>
  );
}
