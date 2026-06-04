'use client';

import { useEffect, useRef } from 'react';

export function useFocusTrap(open: boolean, onEscape: () => void) {
  const panelRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Initialized to onEscape; kept current by the sync effect below.
  const onEscapeRef = useRef(onEscape);

  // Keep the latest onEscape without re-attaching the keydown listener, so the
  // handler installed on [open] always calls the current callback.
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  // Focus capture / move-in / Tab-trap / Esc / restore.
  useEffect(() => {
    if (!open) return;

    // Capture the element that triggered the open BEFORE moving focus.
    openerRef.current = document.activeElement as HTMLElement | null;

    // Move focus into the panel.
    const panel = panelRef.current;
    if (panel) {
      const tabbableSelector =
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const firstTabbable = panel.querySelector<HTMLElement>(tabbableSelector);
      if (firstTabbable) {
        firstTabbable.focus();
      } else {
        panel.focus();
      }
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscapeRef.current();
        return;
      }

      if (e.key === 'Tab' && panel) {
        const tabbableSelector =
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const tabbable = Array.from(panel.querySelectorAll<HTMLElement>(tabbableSelector));
        if (tabbable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = tabbable[0]!;
        const last = tabbable[tabbable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      // Restore focus to the element that opened the drawer.
      openerRef.current?.focus();
    };
  }, [open]);

  return { panelRef };
}
