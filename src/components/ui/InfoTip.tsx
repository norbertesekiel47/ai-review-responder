'use client';

import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useDisclosurePopover } from '@/components/ui/useDisclosurePopover';

/**
 * The repo's one "this device has a real pointer" predicate. A tap emits a
 * synthetic `mouseenter` on many touch
 * browsers; opening on that would let the click which follows toggle the tip
 * straight shut. `(pointer: fine)` additionally excludes a coarse pointer that
 * reports hover, which is the hybrid-device case.
 */
const HOVER_CAPABLE = '(hover: hover) and (pointer: fine)';

export interface InfoTipProps {
  /** What the tip explains. Builds the trigger's accessible name. */
  subject: string;
  /**
   * Which edge of the trigger the panel grows from. `start` is the default and
   * right for a tip near the start of its row.
   *
   * Pass `end` when the trigger sits in the RIGHT part of a wide row. The panel
   * is 18rem and anchored to the trigger, so a `start`-aligned tip in a
   * right-hand column runs past the canvas, which `.main { overflow: clip }`
   * then cuts with no scrollbar and no cue. Measured on the hero's third stat:
   * the panel ran to 897px inside a 769px viewport, and was still overflowing
   * at 1000px. Screenshots at 390px and 1440px straddle that band and miss it.
   */
  align?: 'start' | 'end';
  /** The explanation. One or two plain sentences — this is not a panel. */
  children: ReactNode;
}

/**
 * A small trigger beside a headline that reveals what a number means.
 *
 * Hover previews it where a real pointer exists, a click or tap pins it,
 * `Escape` closes it and returns focus to the trigger. `aria-describedby`
 * announces the explanation to a screen reader, and only while the panel is in
 * the accessibility tree, so the reference never dangles.
 *
 * Both elements are inline `<span>`s, so a tip is legal inside a heading or a
 * label.
 *
 * Dismissal, ids and focus restoration come from `useDisclosurePopover`, the
 * shared core this and `useMenuPopover` both build on. It does NOT use the
 * menu hook: that one `preventDefault`s Arrow/Home/End to rove between
 * `menuitem` rows before it checks whether any exist, and a tip has none — so
 * reusing it would swallow arrow-key page scrolling. A test named "does not
 * swallow arrow keys while it is open" pins that.
 *
 * Hover is this component's own layer on top of the shared PINNED state: the
 * core knows nothing about pointers, and a menu must not acquire hover-open
 * behaviour by sharing a hook with a tip.
 */
export function InfoTip({ subject, align = 'start', children }: InfoTipProps) {
  // The disclosure hook owns PINNED — the durable half of open. Hover is a
  // second, transient input this component adds on top, which is why `open`
  // below is derived rather than read straight off the hook.
  const {
    open: pinned,
    containerRef,
    triggerRef,
    panelId,
    close: unpin,
    closeAndRestoreFocus: unpinAndRestoreFocus,
    openPopover: pin,
  } = useDisclosurePopover<HTMLButtonElement, HTMLSpanElement, HTMLSpanElement>('info-tip');

  const [hovering, setHovering] = useState(false);
  const hasHover = useMediaQuery(HOVER_CAPABLE);

  const open = pinned || (hasHover && hovering);

  const close = useCallback(() => {
    unpin();
    setHovering(false);
  }, [unpin]);

  const closeAndRestoreFocus = useCallback(() => {
    setHovering(false);
    unpinAndRestoreFocus();
  }, [unpinAndRestoreFocus]);

  const toggle = useCallback(() => {
    if (pinned) closeAndRestoreFocus();
    else pin();
  }, [closeAndRestoreFocus, pin, pinned]);

  // The hook's own outside-pointer listener only runs while PINNED. A tip that
  // is merely hover-open needs the same dismissal, and `mouseleave` cannot be
  // relied on when the pointer lands somewhere that steals focus.
  useEffect(() => {
    if (!hovering) return;
    function handlePointerDown(event: Event) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setHovering(false);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [containerRef, hovering]);

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
      // tip must not stop the page scrolling, which is the whole reason this
      // component does not use `useMenuPopover`'s key handler.
      if (event.key === 'Tab') close();
    },
    [close, closeAndRestoreFocus, open],
  );

  return (
    // The hover handlers belong to the CONTAINER, not the trigger. The panel
    // sits 8px below the trigger, so handlers on the button alone would fire
    // `mouseleave` the moment the pointer travelled toward the text — leaving
    // hover-revealed content that can never be read. WCAG 2.1 SC 1.4.13
    // (Hoverable) requires it to survive the pointer moving over it.
    <span
      className={`info-tip${align === 'end' ? ' info-tip--end' : ''}`}
      ref={containerRef}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        className="info-tip-trigger"
        ref={triggerRef}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={open ? panelId : undefined}
        onClick={toggle}
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
