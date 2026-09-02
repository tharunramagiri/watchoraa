import { defineConfig } from 'vitest/config';

// Server tests live in src/routes, src/services, src/lib. This config exists
// so vitest does NOT walk up and load the frontend's root vitest.config.ts
// (which imports vitest from the root node_modules that the server CI job
// does not install).
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
  },
});
