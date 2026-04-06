import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 15000,
  use: {
    baseURL: 'http://localhost:5199',
    headless: true,
  },
  webServer: {
    command: 'VITE_PORT=5199 npm run dev',
    port: 5199,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
