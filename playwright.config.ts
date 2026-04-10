import { defineConfig } from '@playwright/test'

/**
 * Playwright E2E tests for interview pipeline.
 * Runs against a staging/preview deployment — no local server needed.
 *
 * Usage:
 *   TEST_URL=https://staging.interviewprep.guru npm run test:e2e
 *   TEST_URL=http://localhost:3000 npm run test:e2e          # local dev
 *   npm run test:e2e:ui                                       # interactive UI
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: process.env.TEST_URL || 'https://staging.interviewprep.guru',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    permissions: ['microphone', 'camera'],
  },
})
