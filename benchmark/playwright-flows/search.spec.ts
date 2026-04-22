// Playwright equivalent of __alethia__/search-flow.alethia

import { test, expect } from '@playwright/test';

test('atlas task search flow', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('Email').fill('alice@company.com');
  await page.getByLabel('Team').fill('platform');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Tasks' }).click();

  await expect(page.getByText('Review pending deployments')).toBeVisible();
  await expect(page.getByText('Audit Q2 access logs')).toBeVisible();
  await expect(page.getByText('Rotate Vault credentials')).toBeVisible();

  await page.locator('#task-search').fill('Vault');
  await expect(page.getByText('Rotate Vault credentials')).toBeVisible();
  await expect(page.getByText('Review pending deployments')).not.toBeVisible();
  await expect(page.getByText('Audit Q2 access logs')).not.toBeVisible();

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Review pending deployments')).toBeVisible();
  await expect(page.getByText('Audit Q2 access logs')).toBeVisible();
});
