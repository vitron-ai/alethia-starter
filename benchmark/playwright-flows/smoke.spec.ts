// Playwright equivalent of __alethia__/smoke.alethia
//
// Both frameworks test the same five-step flow against the same Anvil app.
// The benchmark harness (compare.mjs) runs each N times and compares wall
// time. Keep the assertions semantically identical to the Alethia version
// so we're measuring framework overhead, not test-logic differences.

import { test, expect } from '@playwright/test';

test('anvil smoke', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await expect(page.getByText('Anvil', { exact: false })).toBeVisible();
  await expect(page.getByText('Sign in to the operations console')).toBeVisible();
  await expect(page.getByText('Email')).toBeVisible();
  await expect(page.getByText('Team')).toBeVisible();
});
