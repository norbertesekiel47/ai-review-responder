import { test, expect } from '@playwright/test';
import {
  seedApprovalFlow,
  cleanupApprovalFlow,
  getResponse,
  getOutboxEntriesForBusiness,
  type SeedData,
} from './seed';

// Skip entire suite if no test DB configured
const hasTestDb = !!process.env.TEST_DATABASE_POOL_URL;

test.describe('Approval flow E2E', () => {
  test.skip(!hasTestDb, 'TEST_DATABASE_POOL_URL not set — skipping E2E approval tests');

  // ── a. Happy path: approve ──────────────────────────────────────────
  test('approve: click Approve → response status becomes approved', async ({ page }) => {
    let data: SeedData | undefined;
    try {
      data = await seedApprovalFlow();

      await page.goto(`/approve/${data.rawToken}`);

      // Wait for the approval client to load and render buttons
      const approveBtn = page.getByRole('button', { name: 'Approve' });
      await expect(approveBtn).toBeVisible({ timeout: 10_000 });

      await approveBtn.click();

      // Success message appears
      await expect(page.getByText('approved', { exact: false })).toBeVisible({ timeout: 5_000 });

      // Verify DB state
      const resp = await getResponse(data.responseId);
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe('approved');
      expect(resp!.approved_text).toBe(
        'Thank you for your kind words! We look forward to seeing you again.',
      );
    } finally {
      if (data) await cleanupApprovalFlow(data);
    }
  });

  // ── b. Edit flow ────────────────────────────────────────────────────
  test('edit: modify text → Save & Approve → edited_text stored with edit_distance', async ({ page }) => {
    let data: SeedData | undefined;
    try {
      data = await seedApprovalFlow();

      await page.goto(`/approve/${data.rawToken}`);

      // Wait for buttons to load
      const editBtn = page.getByRole('button', { name: 'Edit' });
      await expect(editBtn).toBeVisible({ timeout: 10_000 });

      // Enter edit mode
      await editBtn.click();

      // Find the textarea and modify it
      const textarea = page.locator('textarea');
      await expect(textarea).toBeVisible();
      await textarea.fill('Modified response text for E2E test');

      // Click Save & Approve
      const saveBtn = page.getByRole('button', { name: 'Save & Approve' });
      await saveBtn.click();

      // Success message
      await expect(page.getByText('approved', { exact: false })).toBeVisible({ timeout: 5_000 });

      // Verify DB state
      const resp = await getResponse(data.responseId);
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe('edited');
      expect(resp!.edited_text).toBe('Modified response text for E2E test');
      expect(resp!.edit_distance).toBeGreaterThan(0);
    } finally {
      if (data) await cleanupApprovalFlow(data);
    }
  });

  // ── c. Expired token ────────────────────────────────────────────────
  test('expired: see expiration error message', async ({ page }) => {
    let data: SeedData | undefined;
    try {
      data = await seedApprovalFlow({
        expiresAt: new Date(Date.now() - 3600_000), // 1 hour in the past
      });

      await page.goto(`/approve/${data.rawToken}`);

      // Server renders error page for expired links
      await expect(
        page.getByText('expired', { exact: false }),
      ).toBeVisible({ timeout: 5_000 });
    } finally {
      if (data) await cleanupApprovalFlow(data);
    }
  });

  // ── d. Regenerate ───────────────────────────────────────────────────
  test('regenerate: click Regenerate → old response superseded, outbox entry created', async ({ page }) => {
    let data: SeedData | undefined;
    try {
      data = await seedApprovalFlow();

      await page.goto(`/approve/${data.rawToken}`);

      // Wait for buttons
      const regenBtn = page.getByRole('button', { name: 'Regenerate' });
      await expect(regenBtn).toBeVisible({ timeout: 10_000 });

      await regenBtn.click();

      // Success message about new response / check email
      await expect(
        page.getByText(/generat|email/i),
      ).toBeVisible({ timeout: 5_000 });

      // Verify DB: old response is superseded
      const resp = await getResponse(data.responseId);
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe('superseded');

      // Verify outbox: generate_response entry created
      const outbox = await getOutboxEntriesForBusiness(data.businessId);
      const genEntry = outbox.find((e) => e.topic === 'generate_response');
      expect(genEntry).toBeDefined();
    } finally {
      if (data) await cleanupApprovalFlow(data);
    }
  });

  // ── e. Already consumed ─────────────────────────────────────────────
  test('consumed: see already-used error message', async ({ page }) => {
    let data: SeedData | undefined;
    try {
      data = await seedApprovalFlow({
        consumedAt: new Date(), // already consumed
      });

      await page.goto(`/approve/${data.rawToken}`);

      // Server renders error page for consumed links
      await expect(
        page.getByText('already been approved', { exact: false }),
      ).toBeVisible({ timeout: 5_000 });
    } finally {
      if (data) await cleanupApprovalFlow(data);
    }
  });
});
