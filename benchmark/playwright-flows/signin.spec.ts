// Playwright equivalent of __alethia__/signin-flow.alethia

import { test, expect } from '@playwright/test';

test('anvil signin happy-path', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('Email').fill('alice@company.com');
  await page.getByLabel('Team').fill('platform');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Welcome')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
});
