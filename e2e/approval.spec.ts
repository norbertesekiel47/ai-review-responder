import { test, expect } from '@playwright/test';

// E2E tests for the approval flow.
// These require a running Next.js dev server + worker + database with seeded test data.
// Full E2E setup will be implemented when the approval flow is testable end-to-end
// with all supporting workers running.
//
// For now, this file documents the test scenarios to be implemented:
//
// 1. Navigate to /approve/{rawToken} → see review + response → click Approve → success
// 2. Navigate → edit response text → click Edit & Approve → success
// 3. Navigate to expired link → see "This link has expired"
// 4. Navigate → click Regenerate → see "check your email" message
// 5. Navigate to already-approved link → see "Already approved"

test.describe('Approval flow', () => {
  test.skip('approve flow — requires seeded test data', async ({ page }) => {
    // Setup: create test business + review + response + approval link in DB
    // Navigate to /approve/{rawToken}
    // Verify review card and response are displayed
    // Click Approve
    // Verify success message
    await page.goto('/approve/test-token');
    await expect(page.getByText('Review a draft response')).toBeVisible();
  });
});
