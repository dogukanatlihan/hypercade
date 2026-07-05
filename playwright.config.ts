import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  retries: 1,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5217',
    viewport: { width: 420, height: 780 }, // portrait-first, phone-ish
  },
  webServer: [
    {
      command: 'npx vite client --port 5217 --strictPort',
      url: 'http://localhost:5217',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npx tsx server/index.ts',
      url: 'http://localhost:8787/healthz',
      reuseExistingServer: true,
      timeout: 30_000,
      env: { HYPERCADE_DB: 'server/data/smoke.db', NODE_ENV: 'test' },
    },
  ],
});
