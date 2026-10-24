import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeAll(async () => mkdir(new URL('../screenshots/', import.meta.url), { recursive: true }));

const cookieContract = 'Use one transport, an httpOnly session cookie set by POST /api/login. GET /api/me reads it. Same-origin fetch sends it, and no Authorization header is used.';
for (const fixture of [
  { file: 's2-dibs', oracle: '6/6', handshake: true, review: /all three charter interfaces conform/i },
  { file: 's2-none', oracle: '5/6', handshake: false, review: /auth\.session violates/i },
]) {
  test(`${fixture.file} replay shows run evidence and projector views`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/?replay=/fixtures/${fixture.file}.json`);
    await expect(page.getByText('REPLAY', { exact: true })).toBeVisible();
    if (fixture.handshake) {
      await expect(page.locator('.handshake-count').getByText('HANDSHAKE 2/2', { exact: true })).toBeVisible();
      await expect(page.locator('.final-contract').getByText(cookieContract, { exact: true })).toBeVisible();
      await expect(page.getByText(/REV 1 REJECTED/)).toBeVisible();
    } else {
      await expect(page.locator('.handshake-count')).toHaveCount(0);
    }
    await page.screenshot({ path: new URL(`../screenshots/${fixture.file}.png`, import.meta.url).pathname });

    await page.getByRole('tab', { name: 'Handoff + Scorecard' }).click();
    await expect(page.getByRole('heading', { name: 'Handoff' })).toBeInViewport();
    await expect(page.getByRole('heading', { name: 'Scorecard' })).toBeInViewport();
    await expect(page.locator('.oracle-score').getByText(fixture.oracle, { exact: true })).toBeVisible();
    await expect(page.getByText(fixture.review)).toBeVisible();
    if (fixture.handshake) {
      await expect(page.locator('.clause-verdict.conforms')).toHaveCount(3);
    } else {
      await expect(page.locator('.root-cause')).toContainText('ROOT CAUSE · CODEX');
      await expect(page.locator('.root-cause')).toContainText('The server expects Authorization: Bearer, but the UI never sends it.');
      await expect(page.getByText('CHECK 6 · UI · Please log in first', { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: new URL(`../screenshots/${fixture.file}-handoff.png`, import.meta.url).pathname });
  });
}
