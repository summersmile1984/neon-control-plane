import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, CONTROL_PLANE_ENV, CP_PORT, OIDC_PORT } from './tests/browser/env';

/**
 * Console browser suite (design 004). Drives the real control plane over HTTP(S) with the fake OIDC
 * provider beside it; no in-process fakes. Login, keys and membership need only `pnpm dev`; project
 * lifecycle cases skip when the storage layer (compose) is not up.
 *
 *   pnpm test:browser
 *
 * Browsers: uses the system Chrome by default to avoid a download; set PW_CHANNEL=chromium to use
 * the bundled build.
 */
export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'console',
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'chrome' },
    },
  ],
  webServer: [
    {
      command: 'tsx tests/browser/oidc-provider.ts',
      port: OIDC_PORT,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev',
      port: CP_PORT,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { ...CONTROL_PLANE_ENV },
    },
  ],
});
