import { defineConfig } from 'vitest/config';

/**
 * Three tiers (002 §12.1):
 *   unit     — no external process, milliseconds
 *   contract — in-memory SQLite + adapter stubs, validates every response against the vendored
 *              official OpenAPI schema and against the SiteOps consumer's mapping rules
 *   e2e      — requires `pnpm compose:up` (real pageserver / safekeeper / compute containers)
 */
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'contract', include: ['tests/contract/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          // compute containers pull an image and run basebackup on first start
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
