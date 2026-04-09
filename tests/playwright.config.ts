import { defineConfig } from '@playwright/test';
import { resolveBackendBaseUrl } from './backend/base-url';

export default defineConfig({
  testDir: './backend',
  globalSetup: './backend/global-setup.ts',
  globalTeardown: './backend/global-teardown.ts',
  workers: 1,
  use: {
    baseURL: resolveBackendBaseUrl(),
  },
});
