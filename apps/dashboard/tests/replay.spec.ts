import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeAll(async () => mkdir(new URL('../screenshots/', import.meta.url), { recursive: true }));

for (const fixture of [
  { file: 's2-dibs', label: 'S2 / dibs / trial 1', oracle: '6/6', handshake: true, review: 'Conforms to the agreed session boundary.' },
  { file: 's2-none', label: 'S2 / None / trial 1', oracle: '4/6', handshake: false, review: 'The API route accepts the wrong session source.' },
]) {
  test(`${fixture.file} replay shows run evidence`, async ({ page }) => {
    await page.goto(`/?replay=/fixtures/${fixture.file}.json`);
    await expect(page.getByText('REPLAY', { exact: true })).toBeVisible();
    await expect(page.locator('.oracle-score').getByText(fixture.oracle, { exact: true })).toBeVisible();
    await expect(page.getByText(fixture.review, { exact: true })).toBeVisible();
    if (fixture.handshake) await expect(page.locator('.handshake-count').getByText('HANDSHAKE 2/2', { exact: true })).toBeVisible();
    if (fixture.handshake) await expect(page.getByText(/REV 1 REJECTED/)).toBeVisible();
    await page.screenshot({ path: new URL(`../screenshots/${fixture.file}.png`, import.meta.url).pathname });
  });
}
