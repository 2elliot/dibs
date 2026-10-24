import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4150', browserName: 'chromium', viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' },
  webServer: { command: 'npm run dev -w @dibs/dashboard -- --host 127.0.0.1', url: 'http://127.0.0.1:4150', reuseExistingServer: !process.env.CI, timeout: 30_000 },
});
