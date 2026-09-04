'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface DisclosurePopover<
  Trigger extends HTMLElement,
  Container extends HTMLElement = HTMLDivElement,
  Panel extends HTMLElement = HTMLDivElement,
> {
  open: boolean;
  /** Wraps trigger AND panel. Outside-dismissal is measured against this. */
  containerRef: React.RefObject<Container | null>;
  triggerRef: React.RefObject<Trigger | null>;
  panelRef: React.RefObject<Panel | null>;
  triggerId: string;
  panelId: string;
  /** Close and leave focus where it is — the path a navigating item takes,
   *  because pulling focus back to the trigger fights the route change. */
  close: () => void;
  /** Close and hand focus back to the trigger — the Escape/select path. */
  closeAndRestoreFocus: () => void;
  openPopover: () => void;
  toggle: () => void;
}

/**
 * The dismissal, focus-restoration and identity shared by every Console
 * popover — a menu, a tip, anything that opens beside its trigger and must
 * close again.
 *
 * It owns exactly four things and deliberately no more: open state, stable
 * ids, outside-pointer dismissal, and close-with-focus-restored. It has no
 * opinion about what is inside the panel, so it imposes no `menuitem`, no
 * roving keys, and no ARIA. Callers layer that on.
 *
 * **Outside dismissal listens on `pointerdown`, not `mousedown`.** iOS Safari
 * synthesises mouse events from a tap only for elements it treats as
 * clickable, so a tap on a plain `<div>` or `<p>` — most of the dashboard
 * body — fires no `mousedown` and the popover stays open. `pointerdown` covers
 * mouse, touch and pen with one listener.
 *
 * Consumers: `useMenuPopover` (which adds the menu layer) and `InfoTip`.
 */
export function useDisclosurePopover<
  Trigger extends HTMLElement,
  Container extends HTMLElement = HTMLDivElement,
  Panel extends HTMLElement = HTMLDivElement,
>(
  idPrefix: string,
  /**
   * The middle segment of the panel's id. `useMenuPopover` passes `'menu'` so
   * its ids stay byte-identical to the ones it minted before this seam existed
   * — an id is a public surface once it is in `aria-controls`.
   */
  panelIdSegment = 'panel',
): DisclosurePopover<Trigger, Container, Panel> {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<Container>(null);
  const triggerRef = useRef<Trigger>(null);
  const panelRef = useRef<Panel>(null);
  const rawId = useId().replace(/:/g, '');
  const triggerId = `${idPrefix}-trigger-${rawId}`;
  const panelId = `${idPrefix}-${panelIdSegment}-${rawId}`;

  const close = useCallback(() => setOpen(false), []);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const openPopover = useCallback(() => setOpen(true), []);

  const toggle = useCallback(() => {
    if (open) closeAndRestoreFocus();
    else setOpen(true);
  }, [closeAndRestoreFocus, open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: Event) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  return {
    open,
    containerRef,
    triggerRef,
    panelRef,
    triggerId,
    panelId,
    close,
    closeAndRestoreFocus,
    openPopover,
    toggle,
  };
}
