'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useDisclosurePopover } from '@/components/ui/useDisclosurePopover';

/** Which item takes focus when the menu opens. `selected` prefers the
 *  `aria-checked` row and falls back to the first, which is what a radio-style
 *  picker wants; a plain action menu passes `first`. */
export type MenuOpenFocus = 'first' | 'last' | 'selected';

export interface MenuPopover<Trigger extends HTMLElement> {
  open: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  triggerRef: React.RefObject<Trigger | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  triggerId: string;
  menuId: string;
  /** Close and leave focus where it is — the path a navigating menu item takes,
   *  because pulling focus back to the trigger fights the route change. */
  close: () => void;
  /** Close and hand focus back to the trigger — the Escape/select path. */
  closeAndRestoreFocus: () => void;
  openMenu: (focus?: MenuOpenFocus) => void;
  toggle: () => void;
  /** ArrowDown / ArrowUp on the trigger open the menu at either end. */
  onTriggerKeyDown: (event: ReactKeyboardEvent<Trigger>) => void;
  /** Escape, Tab, and roving Arrow/Home/End inside the open menu. */
  onMenuKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * The keyboard, focus, and dismissal behavior shared by every Console popover
 * menu (`aria-haspopup="menu"`). Two callers today: the location switcher and
 * the sidebar account menu.
 *
 * **This is the MENU layer.** Open state, stable ids, outside-pointer
 * dismissal and close-with-focus-restored now live in `useDisclosurePopover`,
 * because a tip needs those four and needs none of the menu behaviour below.
 * What stays here is what makes a menu a menu: which item takes focus on open,
 * ArrowDown/ArrowUp on the trigger, and the roving Arrow/Home/End inside it.
 *
 * That split is load-bearing, not tidiness. `onMenuKeyDown` `preventDefault`s
 * Arrow/Home/End BEFORE it checks whether any item exists — correct for a
 * menu, and it would swallow arrow-key page scrolling for a popover that has
 * no items. `InfoTip` is exactly that popover, which is why #1086 could not
 * reuse this hook and why the shared half was extracted instead.
 *
 * Items are discovered from the DOM by `role^="menuitem"` rather than from a
 * prop, so a caller can mix `menuitem`, `menuitemradio`, links, and buttons in
 * one menu without registering anything.
 */
export function useMenuPopover<Trigger extends HTMLElement>(
  idPrefix: string,
): MenuPopover<Trigger> {
  const {
    open,
    containerRef,
    triggerRef,
    panelRef: menuRef,
    triggerId,
    panelId: menuId,
    close,
    closeAndRestoreFocus,
    openPopover,
  } = useDisclosurePopover<Trigger>(idPrefix, 'menu');

  const focusOnOpenRef = useRef<MenuOpenFocus>('selected');

  const getMenuItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  }, [menuRef]);

  const openMenu = useCallback(
    (focus: MenuOpenFocus = 'selected') => {
      focusOnOpenRef.current = focus;
      openPopover();
    },
    [openPopover],
  );

  // Deliberately NOT the disclosure hook's `toggle`: opening through
  // `openMenu()` is what resets `focusOnOpenRef` to 'selected'. Without that, a
  // menu once opened with ArrowDown would keep landing on the first item on
  // every later open.
  const toggle = useCallback(() => {
    if (open) closeAndRestoreFocus();
    else openMenu();
  }, [closeAndRestoreFocus, open, openMenu]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = getMenuItems();
      const selected = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      const target =
        focusOnOpenRef.current === 'first'
          ? items[0]
          : focusOnOpenRef.current === 'last'
            ? items.at(-1)
            : selected ?? items[0];
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [getMenuItems, menuRef, open]);

  const onTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<Trigger>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
    },
    [openMenu],
  );

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      // Tab leaves the menu on purpose: the focus moves onward, so restoring it
      // to the trigger would fight the user.
      if (event.key === 'Tab') {
        close();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

      event.preventDefault();
      const items = getMenuItems();
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (current + 1) % items.length
              : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    },
    [close, closeAndRestoreFocus, getMenuItems],
  );

  return {
    open,
    containerRef,
    triggerRef,
    menuRef,
    triggerId,
    menuId,
    close,
    closeAndRestoreFocus,
    openMenu,
    toggle,
    onTriggerKeyDown,
    onMenuKeyDown,
  };
}
