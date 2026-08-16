import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssDeclarations, cssVarReferences } from './helpers/css-tokens';

// Design-token single-source guard (refactor/design-tokens-single-source, 2026-06).
//
// The Island (marketing / public) color palette is owned EXCLUSIVELY by
// src/app/globals.css, which loads on every route. The Console (authenticated
// app) token file must NOT re-declare those names. Doing so reintroduced the
// --rw-sage / --rw-sage-soft collision, where one token name meant #D2E0D3 on
// public pages but #97B3AE inside the dashboard — decided only by CSS load order.
// Background + "which palette when": docs/design/README.md
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');
const GLOBALS = 'src/app/globals.css';
const TOKENS = 'src/app/(authenticated)/_styles/tokens.css';
const THEME = 'src/app/(authenticated)/_styles/theme.css';
const CONSOLE_SCOPED = 'src/app/(authenticated)/_styles/console.css';

// A DECLARATION (`  --rw-x: …`) at line start — never a usage (`var(--rw-x)`) or
// a mention inside a comment.
const declares = (css: string, token: string): boolean =>
  new RegExp(`^\\s*${token}\\s*:`, 'm').test(css);

const tokenHex = (css: string, token: string): string => {
  const value = css.match(new RegExp(`^\\s*${token}\\s*:\\s*(#[0-9a-f]{6})`, 'im'))?.[1];
  if (!value) throw new Error(`Missing six-digit color value for ${token}`);
  return value;
};

const relativeLuminance = (hex: string): number => {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrastRatio = (foreground: string, background: string): number => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
};

// The brand FONT FAMILIES. Same rule as the colors below, one tier up: they are
// brand-wide, globals.css owns them, and it loads on every route. tokens.css
// re-declared display/body/mono on `:root` with the Island values (plus a
// consumer-less `--rw-font-sans` alias) until the three-tier split; because
// globals.css loads FIRST, the duplicate silently won on every authenticated
// route. The Console's two legitimate overrides are elsewhere: display + body
// are `localFont` variables bound on the `.rw-console` element itself
// ((authenticated)/layout.tsx), and mono is a scoped `.rw-console` override in
// console.css. An override inside the scope is the sanctioned mechanism; a
// `:root` re-declaration is not (docs/design/README.md rule 2).
const BRAND_FONT_TOKENS = [
  '--rw-font-display',
  '--rw-font-body',
  '--rw-font-serif',
  '--rw-font-mono',
  '--rw-font-sans',
];

// The Island color palette. Single authoritative owner = globals.css.
const ISLAND_COLOR_TOKENS = [
  '--rw-sage',
  '--rw-teal',
  '--rw-teal-strong',
  '--rw-peach',
  '--rw-pink',
  '--rw-beige',
  '--rw-cream',
  '--rw-ink',
  '--rw-ink-soft',
];

describe('design tokens: Island palette is single-sourced in globals.css', () => {
  const globals = read(GLOBALS);
  const tokens = read(TOKENS);

  it.each(ISLAND_COLOR_TOKENS)('globals.css owns %s', (token) => {
    expect(declares(globals, token), `${token} must be declared in ${GLOBALS}`).toBe(true);
  });

  it.each(ISLAND_COLOR_TOKENS)('the Console token file does NOT re-declare %s', (token) => {
    expect(
      declares(tokens, token),
      `${token} is re-declared in ${TOKENS}. Island colors belong to ${GLOBALS} only — ` +
        `re-declaring them reintroduces the cross-file collision (see docs/design/README.md).`,
    ).toBe(false);
  });

  it('the --rw-sage collision is closed: base in globals, -deep/-soft/-line in Console', () => {
    // Bare sage base is owned by globals.css and absent from the Console file.
    expect(declares(globals, '--rw-sage')).toBe(true);
    expect(declares(tokens, '--rw-sage')).toBe(false);
    // The Warm Editorial sage family is Console-owned and not in globals.css.
    expect(declares(tokens, '--rw-sage-deep')).toBe(true);
    expect(declares(tokens, '--rw-sage-soft')).toBe(true);
    expect(declares(globals, '--rw-sage-deep')).toBe(false);
  });

  // The declaration matcher above is line-anchored and cannot see a token
  // written mid-line, so the font/theme guards below use the shared
  // non-line-anchored parser (helpers/css-tokens.ts) instead.
  const tokenDeclarations = cssDeclarations(tokens);

  it.each(BRAND_FONT_TOKENS)('globals.css owns the brand family %s', (token) => {
    if (token === '--rw-font-sans') return; // deleted alias, zero consumers
    expect(
      cssDeclarations(globals).has(token),
      `${token} must be declared in ${GLOBALS}`,
    ).toBe(true);
  });

  it.each(BRAND_FONT_TOKENS)('the Console token file does NOT re-declare %s', (token) => {
    expect(
      tokenDeclarations.has(token),
      `${token} is re-declared in ${TOKENS}. The font families are brand-wide and belong to ` +
        `${GLOBALS} only. The Console overrides display/body via localFont on the .rw-console ` +
        `element and mono via a scoped .rw-console rule in ${CONSOLE_SCOPED} — never here.`,
    ).toBe(false);
  });

  it('keeps the Console mono override scoped to .rw-console', () => {
    // Not a "delete it" rule — a "put it where it belongs" one. The Console has
    // always rendered mono in the system stack rather than the brand JetBrains
    // Mono, and the scoped override is what preserves that without a second
    // `:root` owner.
    expect(read(CONSOLE_SCOPED)).toMatch(
      /\.rw-console\s*\{[\s\S]*?--rw-font-mono\s*:\s*ui-monospace/,
    );
  });

  it('the Console @theme file references only tokens the Console token file declares', () => {
    const theme = read(THEME);
    const foreign = cssVarReferences(theme).filter((token) => !tokenDeclarations.has(token));

    expect(
      foreign,
      `${THEME} references ${foreign.join(', ')}, which ${TOKENS} does not declare. The Console ` +
        `utility export may only name Console-owned tokens — an Island token belongs in the ` +
        `${GLOBALS} @theme block (docs/design/README.md rule 2).`,
    ).toEqual([]);
  });

  it('app-only tokens the Console surface needs stay in the Console file', () => {
    for (const token of ['--rw-star', '--rw-white', '--rw-text', '--rw-focus']) {
      expect(declares(tokens, token), `${token} must stay in ${TOKENS}`).toBe(true);
    }
  });

  it('keeps Console text, semantic fills, and focus indicators above WCAG AA contrast', () => {
    const surface = tokenHex(tokens, '--rw-app-surface');
    const darkOverlay = tokenHex(tokens, '--rw-app-text');

    expect(contrastRatio(tokenHex(tokens, '--rw-app-text-soft'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-sage-deep'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-blush-deep'), tokenHex(tokens, '--rw-blush-soft')))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-danger'), tokenHex(tokens, '--rw-danger-soft')))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-violet'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-star'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-on-accent'), tokenHex(tokens, '--rw-accent-600')))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-on-accent'), tokenHex(tokens, '--rw-green-800')))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-on-dark-muted'), darkOverlay)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-info-fg-soft'), tokenHex(tokens, '--rw-info-bg')))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-warning-fg'), tokenHex(tokens, '--rw-warning-bg')))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-green-800'), tokenHex(tokens, '--rw-success-bg')))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex(tokens, '--rw-focus'), surface)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the add-location inline action on the accessible Console link token', () => {
    const step = read('src/app/(authenticated)/dashboard/add-location/wizard/steps/Step2GoogleBusiness.tsx');
    const wizardCss = read('src/app/(authenticated)/_styles/wizard.css');

    expect(step).toContain('className="wizard-inline-link"');
    expect(step).not.toContain('#0D9488');
    expect(wizardCss).toMatch(/\.wizard-inline-link\s*\{[\s\S]*?color:\s*var\(--rw-accent-fg\)/);
  });

  it('keeps repeated settings feedback colors behind semantic Console tokens', () => {
    const settingsSources = [
      read('src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx'),
      read('src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx'),
      read('src/app/(authenticated)/settings/profile/ProfileClient.tsx'),
      read('src/app/(authenticated)/settings/voice/VoiceClient.tsx'),
      read('src/app/(authenticated)/settings/voice/VoiceReportCard.tsx'),
      read('src/components/dashboard/settings/CancelSubscriptionPanel.tsx'),
      read('src/components/dashboard/settings/DeleteDataOffboardingModal.tsx'),
      read('src/components/dashboard/settings/DeleteDataPanel.tsx'),
    ].join('\n');

    expect(settingsSources).not.toMatch(/#(?:FCA5A5|991B1B|B91C1C|DC2626|1F2937|4B5563)\b/i);
  });

  it('uses distinct opacity-only motion for live status and loading skeletons', () => {
    const consoleCss = read('src/app/(authenticated)/_styles/console.css');

    expect(consoleCss).toContain('@keyframes rw-live-pulse');
    expect(consoleCss).toContain('@keyframes rw-skeleton-pulse');
    expect(consoleCss).not.toMatch(/\.dashboard-skeleton\s*\{[^}]*animation:\s*pulse\b/);
  });

  it('keeps posted-response entrance motion off layout-driving properties', () => {
    const consoleCss = read('src/app/(authenticated)/_styles/console.css');
    const keyframes = consoleCss.match(/@keyframes postedResponseIn\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(keyframes).toContain('transform:');
    expect(keyframes).toContain('opacity:');
    expect(keyframes).not.toMatch(/(?:max-)?height\s*:/);
  });

  it('keeps authenticated transitions explicit and touch targets hybrid-device aware', () => {
    const authenticatedCss = [
      read('src/app/(authenticated)/_styles/console.css'),
      read('src/app/(authenticated)/_styles/past-replies.css'),
      read('src/app/(authenticated)/_styles/settings.css'),
      read('src/app/(authenticated)/_styles/wizard.css'),
    ].join('\n');

    expect(authenticatedCss).not.toMatch(/transition:\s*all\b/);
    expect(authenticatedCss).not.toContain('@media (pointer: coarse)');
    expect(authenticatedCss.match(/@media \(any-pointer: coarse\)/g)).toHaveLength(4);
  });

  it('uses the opaque surface token instead of repeated white literals', () => {
    const authenticatedCss = [
      read('src/app/(authenticated)/_styles/console.css'),
      read('src/app/(authenticated)/_styles/past-replies.css'),
      read('src/app/(authenticated)/_styles/settings.css'),
      read('src/app/(authenticated)/_styles/wizard.css'),
    ].join('\n');

    expect(authenticatedCss).not.toMatch(/#fff(?:fff)?\b/i);
  });

  it('does not fabricate KPI trend lines from aggregate totals', () => {
    const valueKpiGrid = read('src/components/dashboard/kpi/ValueKpiGrid.tsx');

    expect(valueKpiGrid).not.toContain('Sparkline');
    expect(valueKpiGrid).not.toContain('synthesizeSpark');
    expect(read('src/app/(authenticated)/_styles/console.css')).not.toContain('.kpi-spark');
  });

  it('loads page-specific authenticated CSS only from the routes that need it', () => {
    const rootLayout = read('src/app/(authenticated)/layout.tsx');

    for (const stylesheet of ['past-replies.css', 'settings.css', 'wizard.css']) {
      expect(rootLayout, `${stylesheet} must not ship in the root authenticated layout`).not.toContain(stylesheet);
    }
    expect(read('src/app/(authenticated)/settings/layout.tsx')).toContain('settings.css');
    expect(read('src/app/(authenticated)/dashboard/add-location/page.tsx')).toContain('wizard.css');
    expect(read('src/app/(authenticated)/dashboard/reviews/history/page.tsx')).toContain('past-replies.css');
  });

  it('gives the authenticated shell one named main landmark and a skip link', () => {
    const rootLayout = read('src/app/(authenticated)/layout.tsx');

    expect(rootLayout).toContain('className="skip-link" href="#main-content"');
    expect(rootLayout).toContain('<main className="main" id="main-content">');
    expect(read('src/components/dashboard/timeline/TimelineContent.tsx')).not.toContain('<main');
  });

  it('keeps legacy cool-gray and blue focus literals out of authenticated UI sources', () => {
    const authenticatedUi = [
      read('src/app/(authenticated)/_styles/console.css'),
      read('src/app/(authenticated)/_styles/past-replies.css'),
      read('src/app/(authenticated)/_styles/settings.css'),
      read('src/app/(authenticated)/_styles/wizard.css'),
    ].join('\n');

    expect(authenticatedUi).not.toMatch(/#(?:6B7280|374151|F3F4F6|F9FAFB|D1D5DB|9C8E7E)\b/i);
    expect(authenticatedUi).not.toMatch(/rgba\(59\s*,\s*130\s*,\s*246/i);
  });
});
