// @vitest-environment jsdom
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LandingExperience } from '../LandingExperience';

// The page CHROME — nav, the mobile menu, the one `<main>` landmark, the
// footer. The eight narrative sections are stubbed: each is covered by its own
// suite, and rendering them here would make this a slow page snapshot instead
// of a test of the three things `LandingChrome` actually decides —
//
//   1. which doors the nav offers (the self-serve flag branch)
//   2. the menu's open/closed state and its `hidden` panel
//   3. Escape closing the menu and returning focus to the trigger
//
// The flag branch appears TWICE — once in the nav row, once in the menu panel —
// and the file's own comment says the two must never drift into offering
// different doors. Both are asserted below.

function stubSection(testId: string) {
  return { default: () => createElement('div', { 'data-testid': testId }) };
}

vi.mock('../hero/HeroSection', () => ({ HeroSection: stubSection('hero').default }));
vi.mock('../problem/ProblemSection', () => ({ ProblemSection: stubSection('problem').default }));
vi.mock('../fleet/FleetSection', () => ({ FleetSection: stubSection('fleet').default }));
vi.mock('../personas/PersonasSection', () => ({ PersonasSection: stubSection('personas').default }));
vi.mock('../watchdogs/WatchdogsSection', () => ({
  WatchdogsSection: stubSection('watchdogs').default,
}));
vi.mock('../tiers/TiersSection', () => ({ TiersSection: stubSection('tiers').default }));
vi.mock('../future/FutureSection', () => ({ FutureSection: stubSection('future').default }));
vi.mock('../cta/CtaSection', () => ({ CtaSection: stubSection('cta').default }));
vi.mock('../footer/LandingFooter', () => ({ LandingFooter: stubSection('footer').default }));

const LEAD_CAPTURE = {
  primaryCtaHref: '/get-started',
  primaryCtaLabel: 'Get early access',
};

describe('LandingExperience chrome', () => {
  it('renders one main landmark holding the section stack', () => {
    render(<LandingExperience {...LEAD_CAPTURE} selfServeEnabled={false} />);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    for (const id of ['hero', 'problem', 'fleet', 'personas', 'watchdogs', 'tiers', 'future', 'cta']) {
      expect(within(main).getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });

  it('offers the lead-capture CTA and no auth pair when self-serve is off', () => {
    render(<LandingExperience {...LEAD_CAPTURE} selfServeEnabled={false} />);
    // One while the menu is shut: the panel carries `hidden`, so its copy of
    // the branch is out of the accessibility tree until the menu opens.
    expect(screen.getAllByRole('link', { name: 'Get early access' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();

    // Two once it opens — the nav pill and the panel's link. Both halves of
    // the branch are asserted because the file's own rule is that the nav row
    // and the menu must never drift into offering different doors.
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getAllByRole('link', { name: 'Get early access' })).toHaveLength(2);
  });

  it('offers the auth pair and no lead-capture CTA when self-serve is on', () => {
    render(<LandingExperience {...LEAD_CAPTURE} selfServeEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getAllByRole('link', { name: 'Log in' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Sign up' })).toHaveLength(2);
    // Never both — with self-serve on, `primaryCtaHref` IS `/signup`, so a
    // second differently-labelled link to it would be two doors to one room.
    expect(screen.queryByRole('link', { name: 'Get early access' })).not.toBeInTheDocument();
  });

  it('opens and closes the menu panel from its trigger', () => {
    render(<LandingExperience {...LEAD_CAPTURE} selfServeEnabled={false} />);
    const trigger = screen.getByRole('button', { name: 'Open menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('closes the menu on Escape and returns focus to the trigger', () => {
    render(<LandingExperience {...LEAD_CAPTURE} selfServeEnabled={false} />);
    const trigger = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(trigger);

    fireEvent.keyDown(window, { key: 'Escape' });

    const reopened = screen.getByRole('button', { name: 'Open menu' });
    expect(reopened).toHaveAttribute('aria-expanded', 'false');
    // Focus must come back, or a keyboard user is left on a panel that is gone.
    expect(reopened).toHaveFocus();
  });

  it('leaves other keys alone while the menu is open', () => {
    render(<LandingExperience {...LEAD_CAPTURE} selfServeEnabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
