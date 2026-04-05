import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  globalSetup: './backend/global-setup.ts',
  globalTeardown: './backend/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:8000',
  },
});
