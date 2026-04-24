// Playwright equivalent of __alethia__/crud-flow.alethia

import { test, expect } from '@playwright/test';

test('anvil tasks crud', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('Email').fill('alice@company.com');
  await page.getByLabel('Team').fill('platform');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.getByText('Review pending deployments')).toBeVisible();
  await page.locator('#new-task-input').fill('Write v0.2 release notes');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Write v0.2 release notes', { exact: true })).toBeVisible();
});
