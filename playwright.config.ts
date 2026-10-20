import { defineConfig, devices } from '@playwright/test';

const baseURL = `http://127.0.0.1:${process.env.WEB_PORT ?? 4173}`;

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    env: { PRICING_PLAYWRIGHT_TEST: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
