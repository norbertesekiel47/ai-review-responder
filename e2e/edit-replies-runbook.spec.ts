/**
 * Edit Existing Replies — Manual Testing Runbook (Scenarios 0 & 1)
 *
 * Scenario 0: Prerequisites — login works, past-replies page loads, data visible
 * Scenario 1: Phase-A inertness — EDIT_REPLIES_ENABLED=true → Edit CTAs visible;
 *              flags-OFF API 503 check is done via a direct curl after server restart.
 *
 * Run: npx playwright test e2e/edit-replies-runbook.spec.ts --headed
 *
 * Account: configured via E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD (see .env.example).
 * Location: Tanicia (business_id: 019e4e19-1c5a-72b8-b2a1-3301152e78c7)
 */

import { test, expect, type Page } from '@playwright/test';
import { OWNER_EMAIL, OWNER_PASSWORD, isOwnerE2eConfigured } from './helpers/test-owner';

const TEST_EMAIL = OWNER_EMAIL;
const TEST_PASSWORD = OWNER_PASSWORD;
const _BUSINESS_ID = '019e4e19-1c5a-72b8-b2a1-3301152e78c7';

// Warm up the dev server before the first test so the login page is compiled.
// In Next.js dev mode the first request to any page triggers on-demand compilation
// which can take 20-40s. Without warmup, the first test times out.
test.beforeAll(async ({ browser }) => {
  if (!isOwnerE2eConfigured) return;
  const page = await browser.newPage();
  try {
    await page.goto('/login', { waitUntil: 'networkidle', timeout: 60_000 });
  } catch {
    // Warmup failure is non-fatal — test will retry on its own.
  } finally {
    await page.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function login(page: Page) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  // Fill in credentials
  const emailField = page.locator('input[type="email"], input[name="email"]').first();
  const passwordField = page.locator('input[type="password"]').first();
  await emailField.fill(TEST_EMAIL);
  await passwordField.fill(TEST_PASSWORD);

  const submitBtn = page.locator('button[type="submit"]').first();
  await submitBtn.scrollIntoViewIfNeeded();
  await submitBtn.click();

  // waitUntil:'commit' triggers as soon as the URL changes (not waiting for full load).
  // This avoids timeouts when Next.js dev mode is still compiling after a hot-reload.
  await page.waitForURL((url) => !url.pathname.includes('/login'), {
    timeout: 20_000,
    waitUntil: 'commit',
  });
}

async function goToPastReplies(page: Page) {
  await page.goto('/dashboard/past-replies');
  await page.waitForLoadState('networkidle');
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 0 — Prerequisites
// ──────────────────────────────────────────────────────────────────────────────

test.describe('Scenario 0 — Prerequisites', () => {
  test.skip(!isOwnerE2eConfigured, 'E2E owner creds not configured — set E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD');
  test('0-A: login succeeds and redirects to dashboard', async ({ page }) => {
    await login(page);

    const url = page.url();
    expect(url).not.toContain('/login');
    // Should land on some dashboard page
    expect(url).toMatch(/\/dashboard/);

    await page.screenshot({ path: '/tmp/e2e-s0-a-after-login.png', fullPage: true });
    console.log('✅ Logged in. URL:', url);
  });

  test('0-B: /dashboard/past-replies loads without error redirect', async ({ page }) => {
    await login(page);

    // page.goto with 'commit' — don't block on slow dev-mode chunk recompilation
    const response = await page.goto('/dashboard/past-replies', { waitUntil: 'commit' });
    await page.waitForTimeout(3000); // let RSC hydrate

    const httpStatus = response?.status() ?? 0;
    const url = page.url();

    console.log(`page.goto response: HTTP ${httpStatus}, URL: ${url}`);

    // Must not redirect to login or onboarding
    expect(url).not.toContain('/login');
    expect(url).not.toContain('/onboarding');

    // HTTP status must be 200
    expect(httpStatus).toBe(200);

    console.log(`✅ Past replies page loaded OK. HTTP ${httpStatus} URL:`, url);
  });

  test('0-C: posted replies are visible on the page', async ({ page }) => {
    await login(page);
    await goToPastReplies(page);

    // There should be at least one reply card. The page might use cards, list items, etc.
    // Look for known review text from the DB.
    const bodyText = await page.locator('body').textContent() ?? '';

    // We know this review exists: "Great Resort"
    // And this reply: "Dear Norbert, Thank you for taking the time..."
    const hasKnownContent =
      bodyText.includes('Great Resort') ||
      bodyText.includes('Thank you for') ||
      bodyText.includes('tanicia') ||
      bodyText.includes('Tanicia') ||
      bodyText.includes('Dear Norbert');

    await page.screenshot({ path: '/tmp/e2e-s0-c-replies-visible.png', fullPage: true });

    if (!hasKnownContent) {
      console.log('⚠️ Known review text not found. Page content snippet:', bodyText.slice(0, 500));
    }

    expect(hasKnownContent).toBe(true);
    console.log('✅ Posted replies are visible on the page.');
  });

  test('0-D: page structure has review cards or reply entries', async ({ page }) => {
    await login(page);
    await goToPastReplies(page);

    // Check the page has meaningful content — not empty or loading spinner
    await page.waitForTimeout(2000); // let lazy data load

    const _screenshot = await page.screenshot({ path: '/tmp/e2e-s0-d-page-structure.png', fullPage: true });

    // Look for elements that suggest reply cards are rendered
    const cards = await page.locator('[data-testid], article, [role="listitem"], .card').count();
    const bodyText = await page.locator('body').textContent() ?? '';

    const hasReplies =
      bodyText.includes('Posted') ||
      bodyText.includes('Edit') ||
      bodyText.includes('Tanicia') ||
      bodyText.includes('Thank you') ||
      cards > 0;

    console.log(`Card-like elements found: ${cards}`);
    console.log(`Body text snippet: ${bodyText.slice(0, 400)}`);

    expect(hasReplies).toBe(true);
    console.log('✅ Reply cards/entries are present in the page structure.');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Phase-A inertness (flags currently ON = EDIT_REPLIES_ENABLED=true)
// ──────────────────────────────────────────────────────────────────────────────

test.describe('Scenario 1 — Edit CTAs visible with EDIT_REPLIES_ENABLED=true', () => {
  test.skip(!isOwnerE2eConfigured, 'E2E owner creds not configured — set E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD');
  test('1-A: /dashboard/past-replies shows Edit button(s) when flag is ON', async ({ page }) => {
    await login(page);
    await goToPastReplies(page);
    await page.waitForTimeout(2000);

    const bodyText = await page.locator('body').textContent() ?? '';

    // With EDIT_REPLIES_ENABLED=true, Edit CTAs should be present somewhere on the page.
    const hasEditCta =
      bodyText.toLowerCase().includes('edit') ||
      (await page.locator('button, a').filter({ hasText: /edit/i }).count()) > 0;

    await page.screenshot({ path: '/tmp/e2e-s1-a-edit-ctas.png', fullPage: true });

    console.log('Edit CTA found in page:', hasEditCta);
    console.log('Body snippet:', bodyText.slice(0, 600));

    expect(hasEditCta).toBe(true);
    console.log('✅ Edit CTAs are visible with EDIT_REPLIES_ENABLED=true.');
  });

  test('1-B: PAST_REPLIES_VIEW_ENABLED=true — page does not show "feature disabled" message', async ({ page }) => {
    await login(page);
    await goToPastReplies(page);

    const bodyText = await page.locator('body').textContent() ?? '';
    const isDisabled =
      bodyText.toLowerCase().includes('feature_disabled') ||
      bodyText.toLowerCase().includes('feature disabled') ||
      bodyText.toLowerCase().includes('coming soon');

    expect(isDisabled).toBe(false);
    console.log('✅ Page is not showing "feature disabled" — flags are active.');
  });

  test('1-C: API route /api/dashboard/past-replies/draft returns 4xx/2xx (not 503) when flag is ON', async ({ page }) => {
    await login(page);

    // Grab cookies so we can fire an authenticated API request
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    // POST to /draft — should NOT return 503 feature_disabled
    const response = await page.evaluate(async (cookie) => {
      const res = await fetch('/api/dashboard/past-replies/draft', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ reviewId: 'nonexistent-id' }),
      });
      return { status: res.status, body: await res.text() };
    }, cookieHeader);

    console.log('/draft response with flag ON:', response.status, response.body.slice(0, 200));

    // 503 means feature_disabled — that's wrong when flag is ON
    expect(response.status).not.toBe(503);
    // Expect 400 (bad request) or 404 (review not found) or 401/403 (auth)
    expect([400, 401, 403, 404, 422].includes(response.status)).toBe(true);

    console.log('✅ /draft does NOT return 503 — feature flag is active.');
  });

  test('1-D: Copilot historical reviews expose Edit without a tier lock', async ({ page }) => {
    await login(page);
    await goToPastReplies(page);
    await page.waitForTimeout(2000);

    const bodyText = await page.locator('body').textContent() ?? '';
    await page.screenshot({ path: '/tmp/e2e-s1-d-lock-badges.png', fullPage: true });

    const hasEditLock = bodyText.toLowerCase().includes('editing unavailable');
    const editButtons = await page.getByRole('button', { name: /edit reply/i }).count();
    expect(hasEditLock).toBe(false);
    expect(editButtons).toBeGreaterThan(0);
    console.log('📸 Screenshot saved to /tmp/e2e-s1-d-lock-badges.png');
  });
});
