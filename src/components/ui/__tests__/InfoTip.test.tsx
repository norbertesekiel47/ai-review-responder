// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoTip } from '../InfoTip';

const SUBJECT = 'Average rating';
const EXPLANATION = 'The mean star rating of every review in this period.';
const TRIGGER_NAME = `What ${SUBJECT} means`;

function renderTip() {
  return render(<InfoTip subject={SUBJECT}>{EXPLANATION}</InfoTip>);
}

function trigger() {
  return screen.getByRole('button', { name: TRIGGER_NAME });
}

/** The panel is always in the DOM; `hidden` is what closes it. */
function panel() {
  const id = trigger().getAttribute('aria-controls');
  expect(id).toBeTruthy();
  const node = document.getElementById(id as string);
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

/** The repo's one hover-capability predicate, shared with agent-flip-card. */
const HOVER_CAPABLE = '(hover: hover) and (pointer: fine)';

const realMatchMedia = window.matchMedia;

/** Report `matches: true` for one query only, `false` for every other. */
function stubMediaQuery(trueQuery: string) {
  window.matchMedia = ((query: string) => ({
    matches: query === trueQuery,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('InfoTip', () => {
  it('names its subject in the trigger accessible name', () => {
    renderTip();
    expect(trigger()).toBeInTheDocument();
  });

  it('keeps the explanation out of the accessibility tree until it opens', () => {
    renderTip();
    expect(panel()).toHaveAttribute('hidden');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(EXPLANATION)).not.toBeVisible();
  });

  // The touch contract: hover never fires on a phone, so the tip must be
  // reachable by tap alone. A click IS the tap in jsdom. Both paths are
  // asserted here because the promise names both.
  it('the tip opens on click as well as hover, so a touch device can reach it', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTip();

    // Default stub reports no hover: the click path stands on its own.
    await user.click(trigger());
    expect(panel()).not.toHaveAttribute('hidden');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(EXPLANATION)).toBeVisible();
    unmount();

    stubMediaQuery(HOVER_CAPABLE);
    renderTip();
    await user.hover(trigger());
    expect(panel()).not.toHaveAttribute('hidden');
  });

  it('closes on a second click and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    renderTip();

    await user.click(trigger());
    await user.click(trigger());

    expect(panel()).toHaveAttribute('hidden');
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('the tip is reachable by keyboard and closes on Escape', async () => {
    const user = userEvent.setup();
    renderTip();

    await user.tab();
    expect(trigger()).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(panel()).not.toHaveAttribute('hidden');

    // Escape is pressed while focus is still on the trigger — a tip has no
    // items to move focus into, unlike a menu.
    await user.keyboard('{Escape}');

    expect(panel()).toHaveAttribute('hidden');
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  // What this proves, precisely: the TRIGGER carries the description, and only
  // while the panel is in the accessibility tree. The trigger's accessible
  // name — "What <subject> means" — is what ties it to the number beside it;
  // there is no `aria-describedby` from the number itself, because the number
  // is not focusable. A screen reader announces `aria-describedby` on focus,
  // so a focus-mode user who opens the tip with the trigger already focused
  // hears the panel on the NEXT focus, not on the keypress. That limit is
  // recorded in this branch's deviations file rather than hidden here.
  it('the tip is associated with the element it describes', async () => {
    const user = userEvent.setup();
    renderTip();

    const button = trigger();
    const panelId = button.getAttribute('aria-controls');

    // The trigger names its subject, which is the link to the number.
    expect(button).toHaveAccessibleName(`What ${SUBJECT} means`);
    // Closed: no dangling description pointing at a node outside the a11y tree.
    expect(button).not.toHaveAttribute('aria-describedby');

    await user.click(button);

    expect(trigger()).toHaveAttribute('aria-describedby', panelId as string);
    expect(trigger()).toHaveAccessibleDescription(EXPLANATION);
    expect(panel()).toHaveTextContent(EXPLANATION);
  });

  it('closes when a click lands outside it', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoTip subject={SUBJECT}>{EXPLANATION}</InfoTip>
        <button type="button">Elsewhere</button>
      </div>,
    );

    await user.click(trigger());
    expect(panel()).not.toHaveAttribute('hidden');

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(panel()).toHaveAttribute('hidden');
  });

  it('closes on Tab so focus leaves cleanly', async () => {
    const user = userEvent.setup();
    renderTip();

    await user.click(trigger());
    expect(panel()).not.toHaveAttribute('hidden');

    await user.tab();

    expect(panel()).toHaveAttribute('hidden');
  });

  // Regression guard. The Console's menu popover preventDefaults Arrow/Home/End
  // to rove between `menuitem` rows. A tip has none, so swallowing those keys
  // would stop the page scrolling for no gain.
  it('does not swallow arrow keys while it is open', async () => {
    const user = userEvent.setup();
    renderTip();

    await user.click(trigger());

    expect(fireEvent.keyDown(trigger(), { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(trigger(), { key: 'End' })).toBe(true);
    expect(panel()).not.toHaveAttribute('hidden');
  });

  describe('where the device reports a hover-capable pointer', () => {
    it('reveals on hover and hides again on leave', async () => {
      stubMediaQuery(HOVER_CAPABLE);
      const user = userEvent.setup();
      renderTip();

      await user.hover(trigger());
      expect(panel()).not.toHaveAttribute('hidden');

      await user.unhover(trigger());
      expect(panel()).toHaveAttribute('hidden');
    });

    // WCAG 2.1 SC 1.4.13 (Hoverable): content revealed on hover must not
    // disappear when the pointer moves onto it. An 8px gap sits between the
    // trigger and the panel, so binding the handlers to the button alone made
    // the explanation unreadable — it vanished as soon as you reached for it.
    it('stays open when the pointer moves from the trigger onto the panel', async () => {
      stubMediaQuery(HOVER_CAPABLE);
      const user = userEvent.setup();
      renderTip();

      await user.hover(trigger());
      expect(panel()).not.toHaveAttribute('hidden');

      // One continuous pointer move, trigger -> panel. `user.pointer` sets
      // `relatedTarget` to the panel, which is how a real browser reports it;
      // `unhover()` would instead report a move to `document.body` and prove
      // nothing about the transition that actually matters.
      await user.pointer([{ target: trigger() }, { target: panel() }]);

      expect(panel()).not.toHaveAttribute('hidden');
    });

    it('pins on click, so leaving with the pointer does not close it', async () => {
      stubMediaQuery(HOVER_CAPABLE);
      const user = userEvent.setup();
      renderTip();

      await user.click(trigger());
      await user.unhover(trigger());

      expect(panel()).not.toHaveAttribute('hidden');
    });
  });

  describe('where the device reports no hover', () => {
    // A tap emits a synthetic mouseenter on many touch browsers. If that
    // opened the tip, the click that follows would toggle it straight shut.
    it('ignores a synthetic hover', async () => {
      stubMediaQuery('(hover: none)');
      const user = userEvent.setup();
      renderTip();

      await user.hover(trigger());

      expect(panel()).toHaveAttribute('hidden');
    });

    it('still opens on tap', async () => {
      stubMediaQuery('(hover: none)');
      const user = userEvent.setup();
      renderTip();

      await user.click(trigger());

      expect(panel()).not.toHaveAttribute('hidden');
    });
  });

  // A right-hand tip anchors its panel to the trigger's END edge so it grows
  // inward. Measured before this existed: the hero's third-column panel ran to
  // 897px inside a 769px viewport and was still overflowing at 1000px, where
  // `.main { overflow: clip }` cuts it with no scrollbar. The CSS keys off the
  // modifier class, so the class IS the contract.
  describe('align', () => {
    it('defaults to start, with no modifier class', () => {
      const { container } = render(<InfoTip subject={SUBJECT}>{EXPLANATION}</InfoTip>);

      const tip = container.querySelector('.info-tip');
      expect(tip).not.toBeNull();
      expect(tip).not.toHaveClass('info-tip--end');
    });

    it('marks an end-aligned tip so the panel grows inward', () => {
      const { container } = render(
        <InfoTip subject={SUBJECT} align="end">{EXPLANATION}</InfoTip>,
      );

      expect(container.querySelector('.info-tip')).toHaveClass('info-tip--end');
    });
  });
});
