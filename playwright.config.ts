import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/fixture-server.mjs',
    url: 'http://localhost:8765/fixtures/youtube.html',
    reuseExistingServer: !process.env.CI,
  },
});
