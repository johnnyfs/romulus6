import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './backend',
  globalSetup: './backend/global-setup.ts',
  globalTeardown: './backend/global-teardown.ts',
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8000',
  },
});
